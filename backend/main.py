from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import httpx
import os
import re
import json
import logging
import pathlib
import time
import asyncio
from datetime import datetime, timedelta, timezone
from typing import Optional

app = FastAPI(title="dublplay API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()

# ── FIREBASE / FIRESTORE ───────────────────────────────────────────────────────
try:
    import firebase_admin
    from firebase_admin import credentials as fb_credentials, firestore as fb_firestore
    _FIREBASE_AVAILABLE = True
except ImportError:
    _FIREBASE_AVAILABLE = False

_firestore_db = None
# Timestamp (time.time()) of the last Firestore sync per date — replaces the
# one-shot set so multiple replicas re-sync every FIRESTORE_SYNC_TTL seconds.
_firestore_last_synced: dict[str, float] = {}
FIRESTORE_SYNC_TTL = 300  # re-read Firestore every 5 minutes per replica
# ISO-string timestamp of when odds were last written to Firestore, keyed by date
_odds_updated_at: dict[str, str] = {}


def _init_firestore():
    """Initialize and return the Firestore client (singleton)."""
    global _firestore_db
    if not _FIREBASE_AVAILABLE or _firestore_db is not None:
        return _firestore_db
    try:
        try:
            app = firebase_admin.get_app()
        except ValueError:
            sa_env = os.getenv("FIREBASE_CREDENTIALS", "").strip()
            if sa_env:
                cred = fb_credentials.Certificate(json.loads(sa_env))
            elif pathlib.Path("firebase-service-account.json").exists():
                cred = fb_credentials.Certificate("firebase-service-account.json")
            else:
                cred = fb_credentials.ApplicationDefault()
            app = firebase_admin.initialize_app(cred)
        _firestore_db = fb_firestore.client(app)
        logging.info("Firestore connected for NBA odds persistence.")
    except Exception as e:
        logging.warning(f"Firestore init failed (falling back to in-memory only): {e}")
        _firestore_db = None
    return _firestore_db


def _load_odds_from_firestore(date_str: str) -> dict:
    """Read saved odds for a given date (YYYYMMDD) from the nba_odds collection."""
    db = _init_firestore()
    if not db:
        return {}
    try:
        doc = db.collection("nba_odds").document(date_str).get()
        if doc.exists:
            data = doc.to_dict()
            ts = data.get("updated_at")
            if ts is not None:
                # Firestore Timestamp → datetime; fallback to str coercion
                try:
                    _odds_updated_at[date_str] = ts.isoformat()
                except AttributeError:
                    _odds_updated_at[date_str] = str(ts)
            return data.get("odds", {})
    except Exception as e:
        logging.warning(f"Firestore read failed: {e}")
    return {}


def _save_odds_to_firestore(date_str: str, odds: dict) -> None:
    """Persist odds dict for a given date to Firestore. Only writes if odds is non-empty."""
    db = _init_firestore()
    if not db or not odds:
        return
    try:
        db.collection("nba_odds").document(date_str).set(
            {"odds": odds, "updated_at": fb_firestore.SERVER_TIMESTAMP},
            merge=True,
        )
        # Record the save time in memory (server timestamp lands a few ms later,
        # this is close enough for display purposes)
        _odds_updated_at[date_str] = datetime.now(timezone.utc).isoformat()
    except Exception as e:
        logging.warning(f"Firestore write failed: {e}")

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"
ESPN_INJURIES_URL   = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries"
NBA_STATS_URL       = "https://stats.nba.com/stats/leaguedashteamstats"
NBA_STATS_HEADERS   = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer":    "https://www.nba.com/",
    "Accept":     "application/json, text/plain, */*",
    "Origin":     "https://www.nba.com",
}


def _current_nba_season() -> str:
    now = datetime.now(timezone.utc)
    y = now.year
    return f"{y}-{str(y + 1)[-2:]}" if now.month >= 10 else f"{y - 1}-{str(y)[-2:]}"

# ── CACHE ─────────────────────────────────────────────────────────────────────
_cache: dict = {}
CACHE_TTL = 60  # seconds


def cache_get(key: str):
    entry = _cache.get(key)
    if entry and time.time() - entry["ts"] < entry.get("ttl", CACHE_TTL):
        return entry["data"]
    return None


def cache_set(key: str, data, ttl: int = CACHE_TTL):
    _cache[key] = {"ts": time.time(), "data": data, "ttl": ttl}


# ── ESPN HELPERS ──────────────────────────────────────────────────────────────
def espn_status_to_app(status_name: str) -> str:
    if status_name in ("STATUS_IN_PROGRESS", "STATUS_HALFTIME"):
        return "live"
    if status_name == "STATUS_FINAL":
        return "final"
    return "upcoming"


TEAM_ABBR_MAP = {
    "GS": "GSW", "SA": "SAS", "NY": "NYK", "NO": "NOP",
    "OKC": "OKC", "BKN": "BKN",
    "WSH": "WAS",   # ESPN uses WSH; Odds API maps to WAS
    "UTAH": "UTA",  # ESPN uses UTAH; Odds API maps to UTA
    "PHO": "PHX",   # ESPN alternate for Phoenix
}

# Full NBA team names as returned by The Odds API → ESPN abbreviations
NBA_FULL_TO_ABBR: dict[str, str] = {
    "Atlanta Hawks": "ATL",
    "Boston Celtics": "BOS",
    "Brooklyn Nets": "BKN",
    "Charlotte Hornets": "CHA",
    "Chicago Bulls": "CHI",
    "Cleveland Cavaliers": "CLE",
    "Dallas Mavericks": "DAL",
    "Denver Nuggets": "DEN",
    "Detroit Pistons": "DET",
    "Golden State Warriors": "GSW",
    "Houston Rockets": "HOU",
    "Indiana Pacers": "IND",
    "LA Clippers": "LAC",
    "Los Angeles Clippers": "LAC",
    "Los Angeles Lakers": "LAL",
    "Memphis Grizzlies": "MEM",
    "Miami Heat": "MIA",
    "Milwaukee Bucks": "MIL",
    "Minnesota Timberwolves": "MIN",
    "New Orleans Pelicans": "NOP",
    "New York Knicks": "NYK",
    "Oklahoma City Thunder": "OKC",
    "Orlando Magic": "ORL",
    "Philadelphia 76ers": "PHI",
    "Phoenix Suns": "PHX",
    "Portland Trail Blazers": "POR",
    "Sacramento Kings": "SAC",
    "San Antonio Spurs": "SAS",
    "Toronto Raptors": "TOR",
    "Utah Jazz": "UTA",
    "Washington Wizards": "WAS",
}


def norm_abbr(raw: str) -> str:
    return TEAM_ABBR_MAP.get(raw.upper(), raw.upper())


def full_name_to_abbr(full_name: str) -> str:
    """Convert a full NBA team name (from The Odds API) to ESPN abbreviation."""
    if full_name in NBA_FULL_TO_ABBR:
        return NBA_FULL_TO_ABBR[full_name]
    return norm_abbr(full_name[:3].upper())


# Nickname/city → abbreviation for DraftKings which may use short names
TEAM_NICKNAME_TO_ABBR: dict[str, str] = {
    "Hawks": "ATL", "Celtics": "BOS", "Nets": "BKN", "Hornets": "CHA",
    "Bulls": "CHI", "Cavaliers": "CLE", "Mavericks": "DAL", "Nuggets": "DEN",
    "Pistons": "DET", "Warriors": "GSW", "Rockets": "HOU", "Pacers": "IND",
    "Clippers": "LAC", "Lakers": "LAL", "Grizzlies": "MEM", "Heat": "MIA",
    "Bucks": "MIL", "Timberwolves": "MIN", "Pelicans": "NOP", "Knicks": "NYK",
    "Thunder": "OKC", "Magic": "ORL", "76ers": "PHI", "Sixers": "PHI",
    "Suns": "PHX", "Trail Blazers": "POR", "Blazers": "POR", "Kings": "SAC",
    "Spurs": "SAS", "Raptors": "TOR", "Jazz": "UTA", "Wizards": "WAS",
}


def any_name_to_abbr(name: str) -> str:
    """Handle full team names, nicknames, and abbreviations from any source."""
    if not name:
        return ""
    name = name.strip()
    if name in NBA_FULL_TO_ABBR:
        return NBA_FULL_TO_ABBR[name]
    parts = name.split()
    if parts:
        # Try last word (e.g., "Celtics", "Warriors")
        if parts[-1] in TEAM_NICKNAME_TO_ABBR:
            return TEAM_NICKNAME_TO_ABBR[parts[-1]]
        # Try last two words (e.g., "Trail Blazers")
        if len(parts) >= 2:
            two = f"{parts[-2]} {parts[-1]}"
            if two in TEAM_NICKNAME_TO_ABBR:
                return TEAM_NICKNAME_TO_ABBR[two]
    if len(name) <= 3:
        return norm_abbr(name.upper())
    return norm_abbr(name[:3].upper())


# Sticky odds: pre-game lines that persist in memory and in Firestore.
# _sticky_odds is the hot in-memory cache; Firestore is the durable backing store.
_sticky_odds: dict[str, dict] = {}


def _save_sticky_odds() -> None:
    """Write current in-memory odds to Firestore under today's date."""
    date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
    _save_odds_to_firestore(date_str, _sticky_odds)


async def fetch_nba_team_stats(client: httpx.AsyncClient) -> dict[str, dict]:
    """
    Fetch season advanced stats (offRtg, defRtg, pace) + last-10 record for all teams.
    Cached for 30 minutes — season averages barely move day to day.
    Returns dict keyed by team abbreviation.
    """
    cached = cache_get("nba_team_stats")
    if cached is not None:
        return cached

    season = _current_nba_season()
    base_params = {
        "LeagueID": "00", "Season": season, "SeasonType": "Regular Season",
        "PerMode": "PerGame", "PaceAdjust": "N", "PlusMinus": "N", "Rank": "N",
    }

    try:
        r_adv, r_l10 = await asyncio.gather(
            client.get(NBA_STATS_URL, params={**base_params, "MeasureType": "Advanced", "LastNGames": 0},
                       headers=NBA_STATS_HEADERS, timeout=10),
            client.get(NBA_STATS_URL, params={**base_params, "MeasureType": "Base", "LastNGames": 10},
                       headers=NBA_STATS_HEADERS, timeout=10),
        )
    except Exception as e:
        logging.warning(f"NBA Stats API fetch failed: {e}")
        return {}

    def _parse(resp, *fields):
        try:
            rs = resp.json()["resultSets"][0]
            headers, rows = rs["headers"], rs["rowSet"]
        except Exception:
            return {}
        out = {}
        for row in rows:
            d = dict(zip(headers, row))
            abbr = norm_abbr(d.get("TEAM_ABBREVIATION", ""))
            if abbr:
                out[abbr] = {f: d.get(f) for f in fields}
        return out

    adv = _parse(r_adv, "OFF_RATING", "DEF_RATING", "PACE")
    l10 = _parse(r_l10, "W", "L")
    merged = {abbr: {**adv.get(abbr, {}), **l10.get(abbr, {})} for abbr in set(adv) | set(l10)}
    cache_set("nba_team_stats", merged, ttl=1800)
    return merged


async def fetch_team_rest_days(
    client: httpx.AsyncClient, today_abbrs: set[str], today_date: str
) -> dict[str, int]:
    """
    Return days of rest for each team playing today.
    0 = back-to-back (played yesterday), 1 = 1 day rest, 2 = 2 days rest.
    Checks ESPN scoreboard for the previous 3 days.
    """
    cache_key = f"rest_{today_date}"
    cached = cache_get(cache_key)
    if cached is not None:
        return cached

    today_dt = datetime.strptime(today_date, "%Y%m%d").replace(tzinfo=timezone.utc)
    rest: dict[str, int] = {}
    for days_back in range(1, 4):
        if len(rest) >= len(today_abbrs):
            break
        check_date = (today_dt - timedelta(days=days_back)).strftime("%Y%m%d")
        try:
            r = await client.get(ESPN_SCOREBOARD_URL, params={"dates": check_date}, timeout=8)
            events = r.json().get("events", [])
        except Exception:
            continue
        for event in events:
            try:
                for c in event["competitions"][0]["competitors"]:
                    abbr = norm_abbr(c["team"]["abbreviation"])
                    if abbr in today_abbrs and abbr not in rest:
                        rest[abbr] = days_back - 1  # yesterday → 0 (B2B), 2 days ago → 1, etc.
            except Exception:
                continue

    cache_set(cache_key, rest, ttl=3600)
    return rest


async def fetch_espn_games(client: httpx.AsyncClient, date_str: str | None = None) -> list[dict]:
    """Fetch NBA games from ESPN unofficial scoreboard API for a given date (YYYYMMDD)."""
    cache_key = f"espn_games_{date_str or 'today'}"
    cached = cache_get(cache_key)
    if cached is not None:
        return cached

    params = {}
    if date_str:
        params["dates"] = date_str

    try:
        r = await client.get(ESPN_SCOREBOARD_URL, params=params, timeout=10)
        data = r.json()
    except Exception:
        return []

    games = []
    for event in data.get("events", []):
        try:
            comp = event["competitions"][0]
            status = event["status"]
            status_name = status["type"]["name"]
            app_status = espn_status_to_app(status_name)

            competitors = comp["competitors"]
            home = next(c for c in competitors if c["homeAway"] == "home")
            away = next(c for c in competitors if c["homeAway"] == "away")

            home_abbr = norm_abbr(home["team"]["abbreviation"])
            away_abbr = norm_abbr(away["team"]["abbreviation"])
            game_id = f"{away_abbr.lower()}-{home_abbr.lower()}"
            if date_str:
                game_id = f"{game_id}-{date_str}"

            g = {
                "id": game_id,
                "espn_id": event["id"],
                "status": app_status,
                "home": home_abbr,
                "away": away_abbr,
                "homeName": home["team"]["shortDisplayName"],
                "awayName": away["team"]["shortDisplayName"],
                "homeScore": int(home.get("score") or 0),
                "awayScore": int(away.get("score") or 0),
            }

            if app_status == "live":
                period = status.get("period", 1)
                clock  = status.get("displayClock", "")
                halftime = status_name == "STATUS_HALFTIME"
                g["quarter"] = period
                g["clock"]   = "Halftime" if halftime else clock

            if app_status == "upcoming":
                g["time"] = event.get("date", "")  # raw ISO timestamp, frontend localizes

            # Parse ESPN embedded odds (ESPN BET supplies spread/total/ML for upcoming games)
            espn_odds_list = comp.get("odds", [])
            espn_spread = espn_ou = espn_homeOdds = espn_awayOdds = None
            if espn_odds_list and isinstance(espn_odds_list, list):
                eo = espn_odds_list[0]
                # Spread: "details" = away team's spread e.g. "MEM -5" or "-5"
                details = eo.get("details", "")
                if details and details.strip():
                    parts = details.strip().split()
                    try:
                        away_val = float(parts[-1])
                        if len(parts) >= 2:
                            # "TEAM ±X" — check if named team is home or away
                            tok = parts[0]
                            tok_abbr = any_name_to_abbr(tok) if len(tok) > 2 else norm_abbr(tok)
                            home_val = away_val if tok_abbr == home_abbr else -away_val
                        else:
                            home_val = -away_val  # bare number = away perspective
                        espn_spread = f"{home_abbr} {_sign(home_val)}"
                    except (ValueError, IndexError):
                        pass
                ou_raw = eo.get("overUnder")
                espn_ou = str(ou_raw) if ou_raw is not None else None
                hml = eo.get("homeTeamOdds", {}).get("moneyLine")
                aml = eo.get("awayTeamOdds", {}).get("moneyLine")
                espn_homeOdds = _fmt_american(hml) if hml else None
                espn_awayOdds = _fmt_american(aml) if aml else None
                if espn_homeOdds == "—": espn_homeOdds = None
                if espn_awayOdds == "—": espn_awayOdds = None

            g["espn_spread"]    = espn_spread
            g["espn_ou"]        = espn_ou
            g["espn_homeOdds"]  = espn_homeOdds
            g["espn_awayOdds"]  = espn_awayOdds

            games.append(g)
        except Exception:
            continue

    cache_set(cache_key, games)
    return games


async def fetch_espn_injuries(client: httpx.AsyncClient) -> set[str]:
    """Return set of player names currently listed as OUT/Doubtful."""
    cached = cache_get("espn_injuries")
    if cached is not None:
        return cached

    out_players: set[str] = set()
    try:
        r = await client.get(ESPN_INJURIES_URL, timeout=10)
        data = r.json()
        for team_entry in data.get("injuries", []):
            for inj in team_entry.get("injuries", []):
                status = inj.get("status", "").lower()
                if any(s in status for s in ("out", "doubtful", "injured reserve", "ir")):
                    name = inj.get("athlete", {}).get("displayName", "")
                    if name:
                        out_players.add(name.lower())
    except Exception:
        pass

    cache_set("espn_injuries", out_players)
    return out_players


async def fetch_draftkings_game_lines(client: httpx.AsyncClient) -> dict:
    """
    Parse NBA game lines (spread/total/ML) from DraftKings public eventgroup.
    No API key. Works for upcoming AND live games. Saves to sticky cache.
    """
    cached = cache_get("dk_game_lines")
    if cached is not None:
        return cached

    try:
        r = await client.get(
            "https://sportsbook.draftkings.com//sites/US-SB/api/v5/eventgroups/42648",
            params={"format": "json"},
            headers={"User-Agent": "Mozilla/5.0 (compatible)"},
            timeout=15,
        )
        data = r.json()
    except Exception:
        return {}

    event_group = data.get("eventGroup", {})
    result: dict = {}

    for event in event_group.get("events", []):
        # DK convention: teamName1 = away, teamName2 = home
        team1 = event.get("teamName1", "")
        team2 = event.get("teamName2", "")
        away_abbr = any_name_to_abbr(team1)
        home_abbr = any_name_to_abbr(team2)
        if not away_abbr or not home_abbr:
            continue
        key = f"{away_abbr.lower()}-{home_abbr.lower()}"

        odds_data: dict = {}
        for cat in event.get("offerCategories", []):
            cat_name = cat.get("name", "").lower()
            if "player" in cat_name or "prop" in cat_name:
                continue
            for sub in cat.get("offerSubcategoryDescriptors", []):
                for offer_row in sub.get("offers", []):
                    offers = offer_row if isinstance(offer_row, list) else [offer_row]
                    for offer in offers:
                        outcomes = offer.get("outcomes", [])
                        if len(outcomes) < 2:
                            continue
                        labels_lower = [o.get("label", "").lower() for o in outcomes]

                        # Total: Over/Under
                        if "over" in labels_lower and "under" in labels_lower:
                            if "ou" not in odds_data:
                                for o in outcomes:
                                    if o.get("label", "").lower() == "over":
                                        pt = o.get("line") or o.get("points")
                                        if pt:
                                            odds_data["ou"] = str(pt)
                            continue

                        has_line = any(o.get("line") not in (None, 0, 0.0) for o in outcomes)
                        if has_line:
                            # Spread: find the home/away lines and their odds
                            if "spread" not in odds_data:
                                for o in outcomes:
                                    participant = o.get("participant") or o.get("label", "")
                                    abbr = any_name_to_abbr(participant)
                                    if abbr == home_abbr:
                                        ln = o.get("line", 0)
                                        if ln:
                                            odds_data["spread"] = f"{home_abbr} {_sign(ln)}"
                                        sp_odds = _fmt_american(o.get("oddsAmerican"))
                                        if sp_odds != "—":
                                            odds_data["homeSpreadOdds"] = sp_odds
                                    elif abbr == away_abbr:
                                        sp_odds = _fmt_american(o.get("oddsAmerican"))
                                        if sp_odds != "—":
                                            odds_data["awaySpreadOdds"] = sp_odds
                        else:
                            # Moneyline: map participants to home/away
                            for o in outcomes:
                                participant = o.get("participant") or o.get("label", "")
                                abbr = any_name_to_abbr(participant)
                                odds_val = _fmt_american(o.get("oddsAmerican"))
                                if odds_val == "—":
                                    continue
                                if abbr == home_abbr and "homeOdds" not in odds_data:
                                    odds_data["homeOdds"] = odds_val
                                elif abbr == away_abbr and "awayOdds" not in odds_data:
                                    odds_data["awayOdds"] = odds_val

        if odds_data:
            result[key] = odds_data
            # Persist so live/final games still show the line
            _sticky_odds[key] = {**_sticky_odds.get(key, {}), **odds_data}

    if result:
        _save_sticky_odds()
    cache_set("dk_game_lines", result)
    return result


async def fetch_odds(client: httpx.AsyncClient) -> dict:
    """Fetch NBA game odds from DraftKings (free scrape, no key required)."""
    return await fetch_draftkings_game_lines(client)


async def fetch_gemini_odds(client: httpx.AsyncClient, games: list[dict]) -> dict:
    """
    Ask Gemini + Google Search for NBA moneylines for the given games.
    games should already be filtered to only those missing moneylines.
    """
    if not GEMINI_API_KEY:
        return {}
    if not games:
        return {}

    lines = "\n".join(f"{g['awayName']} @ {g['homeName']}" for g in games)
    prompt = (
        f"Search for today's NBA moneyline odds for these games:\n{lines}\n\n"
        "I need ONLY the moneyline (who is favored and by how much). "
        "Return ONLY a raw JSON array — no markdown, no explanation. "
        "Each element must have: {\"away\":\"ABBR\",\"home\":\"ABBR\","
        "\"awayOdds\":\"+110\",\"homeOdds\":\"-130\"} "
        "Use 3-letter NBA team abbreviations (e.g. BKN, ATL, LAL, GSW). "
        "Use American odds format. You MUST include awayOdds and homeOdds for every game."
    )
    try:
        resp = await client.post(
            f"{GEMINI_URL}?key={GEMINI_API_KEY}",
            json={
                "systemInstruction": {"parts": [{"text":
                    "You retrieve sports odds. Output only a raw JSON array. No markdown fences."}]},
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "tools": [{"google_search": {}}],
                "generationConfig": {"maxOutputTokens": 2000, "temperature": 0},
            },
            timeout=25,
        )
        text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        text = re.sub(r"```(?:json)?\s*", "", text).strip().rstrip("`").strip()
        data = json.loads(text)
        result: dict = {}
        for item in data:
            away = (item.get("away") or "").upper()
            home = (item.get("home") or "").upper()
            if not away or not home:
                continue
            key = f"{away.lower()}-{home.lower()}"
            entry = {k: str(item[k]) for k in ("awayOdds", "homeOdds", "spread", "ou") if item.get(k)}
            if entry:
                result[key] = entry
                _sticky_odds[key] = {**_sticky_odds.get(key, {}), **entry}
        if result:
            _save_sticky_odds()
            cache_set("odds", result)
        return result
    except Exception:
        return {}


async def fetch_gemini_historical_odds(client: httpx.AsyncClient, games: list[dict]) -> dict:
    """
    For final games missing pre-game lines, ask Gemini + Google Search to find them.
    Returns odds_map keyed by game id (same format as other odds sources).
    """
    if not GEMINI_API_KEY:
        return {}
    missing = [
        g for g in games
        if g.get("status") == "final" and not g.get("spread") and not g.get("ou")
    ]
    if not missing:
        return {}

    lines = "\n".join(
        f"{g['awayName']} @ {g['homeName']} (final score {g.get('awayScore',0)}-{g.get('homeScore',0)})"
        for g in missing
    )
    prompt = (
        f"Search for the pre-game NBA betting lines for these games that just finished:\n{lines}\n\n"
        "Find the closing spread, over/under total, and moneyline odds that were available "
        "BEFORE each game tipped off today. "
        "Return ONLY a raw JSON array — no markdown, no explanation. "
        'Each element: {"away":"ABBR","home":"ABBR",'
        '"awayOdds":"+110","homeOdds":"-130",'
        '"spread":"HOME -2.5","ou":"225.5"} '
        "Use American odds format (e.g. -110, +240). "
        "Only include games where you found real pre-game lines."
    )
    try:
        resp = await client.post(
            f"{GEMINI_URL}?key={GEMINI_API_KEY}",
            json={
                "systemInstruction": {"parts": [{"text":
                    "You retrieve sports betting odds. Output only a raw JSON array. No markdown fences."}]},
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "tools": [{"google_search": {}}],
                "generationConfig": {"maxOutputTokens": 2000, "temperature": 0},
            },
            timeout=25,
        )
        text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        text = re.sub(r"```(?:json)?\s*", "", text).strip().rstrip("`").strip()
        data = json.loads(text)
        result: dict = {}
        for item in data:
            away = (item.get("away") or "").upper()
            home = (item.get("home") or "").upper()
            if not away or not home:
                continue
            key = f"{away.lower()}-{home.lower()}"
            entry = {k: str(item[k]) for k in ("awayOdds", "homeOdds", "spread", "ou") if item.get(k)}
            if entry:
                result[key] = entry
                _sticky_odds[key] = {**_sticky_odds.get(key, {}), **entry}
        if result:
            _save_sticky_odds()
        return result
    except Exception:
        return {}


async def fetch_prizepicks_props(client: httpx.AsyncClient) -> list[dict]:
    """
    Fetch NBA player props from PrizePicks public API — no key required.
    Returns real lines posted for today's games.
    PrizePicks league_id 7 = NBA.
    """
    cached = cache_get("pp_props")
    if cached is not None:
        return cached

    STAT_MAP = {
        "Points": "Points",
        "Rebounds": "Rebounds",
        "Assists": "Assists",
        "3-PT Made": "3PM",
        "Pts+Rebs+Asts": "PRA",
        "Pts+Ast": "PA",
        "Pts+Reb": "PR",
        "Reb+Ast": "RA",
        "Blocks": "Blocks",
        "Steals": "Steals",
        "Turnovers": "Turnovers",
        "Fantasy Score": "Fantasy",
    }

    try:
        r = await client.get(
            "https://api.prizepicks.com/projections",
            params={"league_id": "7", "per_page": "250", "single_stat": "true"},
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate, br",
                "Origin": "https://app.prizepicks.com",
                "Referer": "https://app.prizepicks.com/board",
                "Sec-Fetch-Dest": "empty",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Site": "same-site",
                "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"',
                "Connection": "keep-alive",
            },
            timeout=15,
        )
        if r.status_code != 200:
            import logging
            logging.warning(f"PrizePicks API returned {r.status_code}: {r.text[:200]}")
            return []
        data = r.json()
    except Exception as e:
        import logging
        logging.warning(f"PrizePicks fetch error: {e}")
        return []

    # Build player lookup from "included" array
    players: dict[str, dict] = {}
    for item in data.get("included", []):
        if item.get("type") == "new_player":
            pid = item["id"]
            attrs = item.get("attributes", {})
            players[pid] = {
                "name": attrs.get("name", ""),
                "team": attrs.get("team", "—"),
                "pos":  attrs.get("position", "—"),
            }

    props_out: list[dict] = []
    for proj in data.get("data", []):
        if proj.get("type") != "projection":
            continue
        attrs = proj.get("attributes", {})
        # Skip lines that are explicitly pulled (injured reserve, suspended, etc.)
        if attrs.get("status") in ("injured_reserve", "suspended", "out"):
            continue

        raw_stat = attrs.get("stat_type", "")
        stat = STAT_MAP.get(raw_stat, raw_stat)
        line = attrs.get("line_score")
        if not line:
            continue

        pid = (proj.get("relationships", {})
                   .get("new_player", {})
                   .get("data", {})
                   .get("id", ""))
        player_info = players.get(pid, {})
        player_name = player_info.get("name", "")
        if not player_name:
            continue

        team     = player_info.get("team", "—")
        pos      = player_info.get("pos",  "—")
        matchup  = attrs.get("description", "—")   # "ORL @ CHA" style

        # PrizePicks doesn't publish vig odds — standard lines are -120/-100 ish
        over_odds = "-115"

        props_out.append({
            "player":     player_name,
            "team":       team,
            "pos":        pos,
            "game":       matchup,
            "prop":       f"{stat} {line}+",
            "rec":        "OVER",
            "line":       line,
            "conf":       62,
            "edge_score": 65,
            "l5": 60, "l10": 55, "l15": 52,
            "streak":     0,
            "avg":        line,
            "odds":       over_odds,
            "reason":     f"PrizePicks real line · {matchup}",
        })

    cache_set("pp_props", props_out)
    return props_out




def _fmt_american(price) -> str:
    if not price:
        return "—"
    try:
        p = int(price)
        return f"+{p}" if p > 0 else str(p)
    except Exception:
        return str(price)


def _sign(val) -> str:
    try:
        v = float(val)
        return f"+{v}" if v > 0 else str(v)
    except Exception:
        return str(val)


# ── SYSTEM PROMPT (built dynamically) ─────────────────────────────────────────
def build_system_prompt(
    games: list,
    injuries: set,
    team_stats: dict | None = None,
    rest_days: dict | None = None,
) -> str:
    injury_note = ""
    if injuries:
        injury_note = f"\nKEY INJURIES (OUT/Doubtful): {', '.join(sorted(injuries)[:8])}."

    live = [g for g in games if g["status"] == "live"]
    upcoming = [g for g in games if g["status"] == "upcoming"]

    live_str = ", ".join(
        f"{g['awayName']} {g.get('awayScore',0)} @ {g['homeName']} {g.get('homeScore',0)} (Q{g.get('quarter','?')} {g.get('clock','')})"
        for g in live
    ) if live else "None"

    up_str = ", ".join(
        f"{g['awayName']}@{g['homeName']}"
        for g in upcoming
    ) if upcoming else "None"

    # Build team context block: offRtg, defRtg, pace, last-10, rest
    team_ctx = ""
    if team_stats or rest_days:
        today_abbrs = sorted({a for g in games for a in (g["home"], g["away"])})
        rows = []
        for abbr in today_abbrs:
            ts = (team_stats or {}).get(abbr, {})
            rd = (rest_days or {}).get(abbr)
            parts = []
            if ts.get("OFF_RATING") is not None:
                parts.append(f"oRtg {ts['OFF_RATING']:.1f}")
            if ts.get("DEF_RATING") is not None:
                parts.append(f"dRtg {ts['DEF_RATING']:.1f}")
            if ts.get("PACE") is not None:
                parts.append(f"pace {ts['PACE']:.1f}")
            w, l = ts.get("W"), ts.get("L")
            if w is not None and l is not None:
                parts.append(f"L10 {int(w)}-{int(l)}")
            if rd is not None:
                parts.append("B2B" if rd == 0 else f"{rd}d rest")
            if parts:
                rows.append(f"  {abbr}: {', '.join(parts)}")
        if rows:
            team_ctx = "\nTEAM CONTEXT (season stats + rest):\n" + "\n".join(rows)

    return (
        "You are a sharp NBA betting analyst writing for serious bettors who want actionable picks, not fluff. "
        "Never say obvious things like 'both teams can score' or 'it should be a close game'. "
        "Always cite specific edges: matchup advantages, pace differentials, recent ATS records, "
        "key injuries, rest advantages, or defensive rankings.\n"
        f"LIVE GAMES: {live_str}\n"
        f"TONIGHT: {up_str}\n"
        f"{injury_note}"
        f"{team_ctx}\n"
        "Respond with EXACTLY the three labeled lines requested. No preamble, no disclaimer, no extra text."
    )


def parse_gemini_analysis(text: str) -> dict:
    """Parse structured Gemini response into best_bet / ou / props / dubl scores."""
    stoppers = "AWAY_ML:|HOME_ML:|SPREAD_LINE:|OU_LINE:|BEST_BET:|BET_TEAM:|BET_TYPE:|OU_LEAN:|PLAYER_PROP:|PROP_STATUS:|DUBL_SCORE_BET:|DUBL_REASONING_BET:|DUBL_SCORE_OU:|DUBL_REASONING_OU:|$"

    def extract(marker: str) -> str | None:
        m = re.search(rf'{marker}:\s*(.*?)(?={stoppers})', text, re.DOTALL | re.IGNORECASE)
        if not m:
            return None
        return m.group(1).strip().replace("**", "").strip() or None

    def extract_score(marker: str) -> float | None:
        m = re.search(rf'{marker}:\s*([0-9]+(?:\.[0-9]+)?)', text, re.IGNORECASE)
        if not m:
            return None
        try:
            return round(min(5.0, max(1.0, float(m.group(1)))), 1)
        except ValueError:
            return None

    away_ml     = extract("AWAY_ML")
    home_ml     = extract("HOME_ML")
    spread_line = extract("SPREAD_LINE")
    ou_line     = extract("OU_LINE")

    raw_prop_status = extract("PROP_STATUS") or ""
    prop_on_track = (
        True  if re.search(r'\bon\s+track\b', raw_prop_status, re.IGNORECASE) else
        False if re.search(r'\bfading\b',    raw_prop_status, re.IGNORECASE) else
        None
    )

    bet_type_raw = (extract("BET_TYPE") or "").upper()
    return {
        "best_bet":           extract("BEST_BET"),
        "bet_team":           (extract("BET_TEAM") or "").strip().split()[0].upper() or None,
        "bet_is_spread":      "SPREAD" in bet_type_raw,
        "ou":                 extract("OU_LEAN"),
        "props":              extract("PLAYER_PROP"),
        "prop_status":        raw_prop_status or None,
        "prop_on_track":      prop_on_track,
        "dubl_score_bet":     extract_score("DUBL_SCORE_BET"),
        "dubl_reasoning_bet": extract("DUBL_REASONING_BET"),
        "dubl_score_ou":      extract_score("DUBL_SCORE_OU"),
        "dubl_reasoning_ou":  extract("DUBL_REASONING_OU"),
        "lines": {
            "awayOdds": away_ml,
            "homeOdds": home_ml,
            "spread":   spread_line,
            "ou":       ou_line,
        } if any([away_ml, home_ml, spread_line, ou_line]) else None,
    }


# ── FALLBACK MOCK DATA (used when live APIs unavailable) ──────────────────────
MOCK_GAMES = [
    {
        "id": "nyk-det", "status": "live", "quarter": 4, "clock": "7:21",
        "home": "NYK", "away": "DET", "homeName": "Knicks", "awayName": "Pistons",
        "homeScore": 88, "awayScore": 104, "homeWinProb": 18, "awayWinProb": 82,
        "homeOdds": "+480", "awayOdds": "-700", "ou": "202.5", "ouDir": "OVER", "spread": "DET -16.5",
        "analysis": {
            "best_bet": "DET ML (-700) — only for those already in. Live cover at -16.5 is where the value is.",
            "ou": "OVER 202.5 — both teams still pushing, averaging 24+ pts per remaining Q4 minute.",
            "props": "Cade Cunningham has 28 pts, 7 ast with 7:21 left. Hammering his points OVER for any remaining live props.",
        },
    },
    {
        "id": "gsw-bos", "status": "upcoming",
        "home": "GSW", "away": "BOS", "homeName": "Warriors", "awayName": "Celtics",
        "time": "7:00 PM PT", "homeWinProb": 43.5, "awayWinProb": 56.5,
        "homeOdds": "+110", "awayOdds": "-130", "spread": "BOS -2.5", "ou": "219.5",
        "injuryAlert": "⚠️ Tatum OUT (Achilles)",
        "analysis": {
            "best_bet": "GSW +2.5 ATS — massive line move after Tatum scratched. Lean GSW to cover.",
            "ou": "UNDER 219.5 — Without Tatum, BOS offense loses its ceiling. Expect a slower game.",
            "props": "Jaylen Brown OVER 30.5 pts — inherits full usage with Tatum out.",
        },
    },
]


# ── PYDANTIC MODELS ───────────────────────────────────────────────────────────
class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    api_key: str = ""

class AnalyzeRequest(BaseModel):
    game_id: str
    api_key: str = ""
    date: Optional[str] = None  # YYYYMMDD for non-today dates

class ParlayRequest(BaseModel):
    odds: list[str]


def american_to_decimal(odds_str: str) -> float:
    o = int(odds_str.replace("+", ""))
    return (o / 100) + 1 if o > 0 else (100 / abs(o)) + 1


def decimal_to_american(decimal: float) -> str:
    if decimal >= 2.0:
        return f"+{int(round((decimal - 1) * 100))}"
    return f"{int(round(-100 / (decimal - 1)))}"


def get_effective_key(request_key: str) -> str:
    key = request_key or GEMINI_API_KEY
    if not key:
        raise HTTPException(status_code=400, detail="No Gemini API key provided.")
    return key


# ── ENDPOINTS ─────────────────────────────────────────────────────────────────

def _merge_odds(espn_games: list[dict], odds_map: dict, date_str: str | None = None) -> list[dict]:
    """
    Merge odds into ESPN game list.
    Priority: ESPN embedded odds > Odds API/DK > sticky cache.
    Uses g.get() (not pop) to avoid mutating the shared ESPN cache.
    Tomorrow game IDs include a date suffix (e.g. orl-phx-20260221) but
    the odds_map keys do not — strip it before lookup.
    """
    result = []
    for g in espn_games:
        gid = g["id"]
        # Strip YYYYMMDD suffix so tomorrow games match odds_map keys
        base_id = re.sub(r'-\d{8}$', '', gid)
        o = odds_map.get(base_id) or odds_map.get(gid) or {}
        sticky = _sticky_odds.get(base_id) or _sticky_odds.get(gid) or {}

        spread          = g.get("espn_spread")   or o.get("spread")          or sticky.get("spread")
        ou              = g.get("espn_ou")        or o.get("ou")              or sticky.get("ou")
        homeOdds        = g.get("espn_homeOdds")  or o.get("homeOdds")        or sticky.get("homeOdds")
        awayOdds        = g.get("espn_awayOdds")  or o.get("awayOdds")        or sticky.get("awayOdds")
        homeSpreadOdds  = o.get("homeSpreadOdds") or sticky.get("homeSpreadOdds")
        awaySpreadOdds  = o.get("awaySpreadOdds") or sticky.get("awaySpreadOdds")

        # Persist under base_id so both today and tomorrow lookups can find it
        if any([spread, ou, homeOdds]):
            _sticky_odds[base_id] = {k: v for k, v in {
                "spread": spread, "ou": ou, "homeOdds": homeOdds, "awayOdds": awayOdds,
                "homeSpreadOdds": homeSpreadOdds, "awaySpreadOdds": awaySpreadOdds,
            }.items() if v}
            _save_odds_to_firestore(
                date_str or datetime.now(timezone.utc).strftime("%Y%m%d"),
                _sticky_odds,
            )

        home_prob = away_prob = 50.0
        if homeOdds and awayOdds:
            try:
                hd = american_to_decimal(homeOdds)
                ad = american_to_decimal(awayOdds)
                total = (1/hd) + (1/ad)
                home_prob = round((1/hd) / total * 100, 1)
                away_prob = round((1/ad) / total * 100, 1)
            except Exception:
                pass

        # Build result without espn_* fields
        base = {k: v for k, v in g.items() if not k.startswith("espn_")}
        result.append({
            **base,
            "homeWinProb": home_prob,
            "awayWinProb": away_prob,
            "homeOdds": homeOdds,
            "awayOdds": awayOdds,
            "homeSpreadOdds": homeSpreadOdds,
            "awaySpreadOdds": awaySpreadOdds,
            "spread": spread,
            "ou": ou,
            "ouDir": None,
            "analysis": {"best_bet": None, "ou": None, "props": None},
        })
    return result


async def _background_refresh_odds(date_str: str) -> None:
    """
    Re-fetch ESPN games and persist any newly available ESPN BET odds to sticky/Firestore.
    Runs after the response has already been sent so it never blocks the user.
    """
    try:
        async with httpx.AsyncClient() as client:
            games = await fetch_espn_games(client, date_str)
        if not games:
            return
        changed = False
        for g in games:
            key = re.sub(r'-\d{8}$', '', g["id"])
            for espn_field, out_field in [("espn_homeOdds","homeOdds"),("espn_awayOdds","awayOdds"),
                                          ("espn_spread","spread"),("espn_ou","ou")]:
                val = g.get(espn_field)
                if val and _sticky_odds.get(key, {}).get(out_field) != val:
                    _sticky_odds.setdefault(key, {})[out_field] = val
                    changed = True
        if changed:
            _save_odds_to_firestore(date_str, _sticky_odds)
    except Exception as e:
        logging.warning(f"Background odds refresh failed: {e}")


@app.get("/api/games")
async def get_games(date: Optional[str] = None):
    """Fetch games for a given date (YYYYMMDD). Defaults to today."""
    date_str = date or datetime.now(timezone.utc).strftime("%Y%m%d")

    # ── 1. Sync Firestore → memory (TTL-based so all replicas stay aligned) ─────
    if time.time() - _firestore_last_synced.get(date_str, 0) > FIRESTORE_SYNC_TTL:
        stored = _load_odds_from_firestore(date_str)
        if stored:
            _sticky_odds.update(stored)
        _firestore_last_synced[date_str] = time.time()

    # ── 2. Fetch ESPN games (includes embedded ESPN BET odds) ──────────────────
    async with httpx.AsyncClient() as client:
        games = await fetch_espn_games(client, date)

    if not games:
        return {"games": MOCK_GAMES, "source": "mock"}

    # ── 3. Background refresh of ESPN odds
    asyncio.create_task(_background_refresh_odds(date_str))

    # ── 4. Merge ESPN + sticky (lines from analyze_game are persisted there)
    merged = _merge_odds(games, {}, date_str)

    return {
        "games": merged,
        "source": "live",
        "odds_updated_at": _odds_updated_at.get(date_str),
    }


@app.get("/api/debug")
async def debug_odds():
    """Diagnostic endpoint — odds key status, ESPN game IDs, and odds match check."""
    async with httpx.AsyncClient() as client:
        espn_games = await fetch_espn_games(client)

    espn_ids = [g["id"] for g in espn_games]

    info: dict = {
        "espn_game_ids": espn_ids,
        "sticky_odds_keys": list(_sticky_odds.keys()),
        "dk_cache_fresh": cache_get("dk_game_lines") is not None,
        "matched": [k for k in _sticky_odds if k in espn_ids],
        "unmatched_espn": [k for k in espn_ids if k not in _sticky_odds],
    }
    return info


def _parse_gemini_props_json(text: str) -> list[dict]:
    """Parse Gemini response text into normalized props list."""
    match = re.search(r'\[[\s\S]*\]', text)
    if not match:
        logging.warning(f"No JSON array in Gemini props response: {text[:300]}")
        return []
    raw_json = match.group()
    # Gemini sometimes embeds literal control characters inside string values,
    # which is invalid JSON. Replace all control chars with a space — structural
    # whitespace becomes a space (still valid), and embedded newlines in strings
    # are sanitized too.
    raw_json = re.sub(r'[\x00-\x1f\x7f]', ' ', raw_json)
    try:
        raw = json.loads(raw_json)
    except Exception as e:
        logging.warning(f"Gemini props JSON parse failed: {e}")
        return []

    VALID_STATS = {"points", "rebounds", "assists", "3pm", "blocks", "steals",
                   "pts", "reb", "ast", "blk", "stl", "threes", "three-pointers"}
    out = []
    for p in raw:
        try:
            line = float(p.get("line", 0))
            stat = str(p.get("stat", ""))
            # Drop non-standard prop types (first basket, triple-double, combined, etc.)
            if stat.lower() not in VALID_STATS and "+" in stat:
                continue
            if any(kw in stat.lower() for kw in ("basket", "triple", "double", "combo", "score first")):
                continue
            rec  = str(p.get("rec", "OVER")).upper()
            over_o  = str(p.get("over_odds", "-115"))
            under_o = str(p.get("under_odds", "+105"))
            out.append({
                "player":     str(p.get("player", "")),
                "team":       str(p.get("team", "")),
                "pos":        str(p.get("pos", "")),
                "stat":       stat,
                "prop":       f"{stat} O/U {line}",
                "line":       line,
                "over_odds":  over_o,
                "under_odds": under_o,
                "odds":       over_o if rec == "OVER" else under_o,
                "rec":        rec,
                "avg":        float(p["avg"]) if p.get("avg") is not None else None,
                "edge_score": float(p["edge_score"]) if p.get("edge_score") is not None else None,
                "matchup":    str(p.get("matchup", "")),
                "reason":     str(p.get("reason", "")),
            })
        except Exception:
            continue
    # Deduplicate on (player, stat) — keep highest edge_score
    seen: dict[tuple, dict] = {}
    for p in out:
        key = (p["player"].lower(), p["stat"].lower())
        if key not in seen or (p.get("edge_score") or 0) > (seen[key].get("edge_score") or 0):
            seen[key] = p
    return list(seen.values())




_gemini_props_cache: list[dict] = []
_gemini_props_cache_ts: float = 0
PROPS_CACHE_TTL = 1800  # re-fetch from Gemini at most once per 30 minutes


async def fetch_gemini_props(client: httpx.AsyncClient, key: str, games: list[dict]) -> list[dict]:
    """Use Gemini with Google Search grounding to get real NBA player prop lines."""
    global _gemini_props_cache, _gemini_props_cache_ts
    if _gemini_props_cache and time.time() - _gemini_props_cache_ts < PROPS_CACHE_TTL:
        return _gemini_props_cache

    today_str = datetime.now(timezone.utc).strftime("%B %d, %Y")

    _PROPS_JSON_SCHEMA = (
        '{"player":"Full Name","team":"ABBR","pos":"G","stat":"Points","line":27.5,'
        '"over_odds":"-115","under_odds":"+105","rec":"OVER","avg":28.2,'
        '"edge_score":4.2,"matchup":"LAL @ GSW","reason":"Brief reason"}'
    )

    # Build set of team abbreviations playing today for post-parse filtering
    playing_teams: set[str] = set()
    for g in games:
        if g.get("away"):
            playing_teams.add(g["away"].upper())
        if g.get("home"):
            playing_teams.add(g["home"].upper())

    prompt = (
        f"Search for NBA player props available right now on DraftKings or FanDuel for {today_str}. "
        f"Return the top 50 props, with at least 5 props per game being played today. "
        "Only include players actually playing today. "
        "Only standard props: points, rebounds, assists, 3-pointers made, blocks, steals. "
        "Do not guess or make up any data — only return props you find in your search.\n\n"
        f"Return ONLY a raw JSON array. Schema per element:\n{_PROPS_JSON_SCHEMA}\n\n"
        "- edge_score: float 1.0-5.0, your judgment of the prop's value (matchup, line value, player form). Not derived from hit rates — just your analysis.\n"
        "Start with [ and end with ]. No markdown, no explanation."
    )

    try:
        resp = await client.post(
            f"{GEMINI_URL}?key={key}",
            json={
                "systemInstruction": {
                    "parts": [{"text": (
                        "You are a JSON data API. You NEVER explain what you are about to do. "
                        "You NEVER say 'Okay' or 'I will'. You NEVER use markdown code fences. "
                        "Your entire response is always a raw JSON array starting with [ and ending with ]."
                    )}]
                },
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "tools": [{"google_search": {}}],
                "generationConfig": {"maxOutputTokens": 8000, "temperature": 0.2},
            },
            timeout=60,
        )
        data = resp.json()
        if "error" in data:
            logging.warning(f"Gemini props error: {data['error']['message']}")
            return _gemini_props_cache  # return stale cache on error rather than nothing
        # Grounded responses may split across multiple parts — join all text parts
        parts = data["candidates"][0]["content"]["parts"]
        text = " ".join(p.get("text", "") for p in parts if "text" in p)
        props = _parse_gemini_props_json(text)
        if playing_teams:
            before = len(props)
            props = [p for p in props if p.get("team", "").upper() in playing_teams]
            dropped = before - len(props)
            if dropped:
                logging.warning(f"Dropped {dropped} props for teams not playing today")
        if props:
            logging.info(f"Gemini search-grounded props: got {len(props)} props")
            _gemini_props_cache = props
            _gemini_props_cache_ts = time.time()
        else:
            logging.warning(f"Gemini search grounding returned no parseable props: {text[:300]}")
        return props or _gemini_props_cache
    except Exception as e:
        logging.warning(f"Gemini search-grounded props failed: {e!r}")
        return _gemini_props_cache  # return stale cache rather than empty


@app.get("/api/props")
async def get_props():
    async with httpx.AsyncClient() as client:
        injuries = set()
        try:
            injuries = await fetch_espn_injuries(client)
        except Exception:
            pass

        props: list[dict] = []
        source = "none"

        # Gemini search grounding — rich stats + real lines
        if GEMINI_API_KEY:
            espn_games = await fetch_espn_games(client)
            props = await fetch_gemini_props(client, GEMINI_API_KEY, espn_games or [])
            if props:
                source = "gemini"

        # Last resort: PrizePicks public API
        if not props:
            try:
                props = await fetch_prizepicks_props(client)
                if props:
                    source = "prizepicks"
            except Exception:
                pass

    filtered = [p for p in props if p.get("player", "").lower() not in injuries]
    return {"props": filtered, "source": source, "injured_out": sorted(injuries)}


@app.get("/api/injuries")
async def get_injuries():
    async with httpx.AsyncClient() as client:
        injured = await fetch_espn_injuries(client)
    return {"injured_out": sorted(injured)}


@app.post("/api/parlay")
def calculate_parlay(req: ParlayRequest):
    if len(req.odds) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 legs")
    try:
        decimals = [american_to_decimal(o) for o in req.odds]
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid odds format")
    combined = 1.0
    for d in decimals:
        combined *= d
    return {
        "legs": len(req.odds),
        "combined_odds": decimal_to_american(combined),
        "combined_decimal": round(combined, 3),
        "implied_prob": round((1 / combined) * 100, 1),
        "payout_per_100": round((combined - 1) * 100, 2),
    }


@app.post("/api/analyze")
async def analyze_game(req: AnalyzeRequest):
    key = get_effective_key(req.api_key)

    today_date = req.date or datetime.now(timezone.utc).strftime("%Y%m%d")

    async with httpx.AsyncClient() as client:
        espn_games, injuries, team_stats = await asyncio.gather(
            fetch_espn_games(client, req.date),
            fetch_espn_injuries(client),
            fetch_nba_team_stats(client),
        )

    games_to_search = espn_games if espn_games else MOCK_GAMES
    game = next((g for g in games_to_search if g["id"] == req.game_id), None)
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")

    today_abbrs = {g["home"] for g in games_to_search} | {g["away"] for g in games_to_search}
    async with httpx.AsyncClient() as client:
        rest_days = await fetch_team_rest_days(client, today_abbrs, today_date)

    system_prompt = build_system_prompt(games_to_search, injuries, team_stats, rest_days)
    is_live  = game["status"] == "live"
    is_final = game["status"] == "final"

    if is_final:
        raise HTTPException(status_code=400, detail="Game is already over.")

    # Resolve odds: ESPN embedded (freshest) → sticky cache → N/A
    # Strip date suffix so tomorrow game IDs (e.g. orl-phx-20260221) find cached odds
    base_game_id = re.sub(r'-\d{8}$', '', req.game_id)
    sticky = _sticky_odds.get(base_game_id) or _sticky_odds.get(req.game_id) or {}
    ou_line   = game.get("espn_ou")       or sticky.get("ou")       or "N/A"
    spread_ln = game.get("espn_spread")   or sticky.get("spread")   or "N/A"
    away_ml   = game.get("espn_awayOdds") or sticky.get("awayOdds") or "N/A"
    home_ml   = game.get("espn_homeOdds") or sticky.get("homeOdds") or "N/A"

    if is_live:
        prompt = (
            f"Live: {game['awayName']} {game.get('awayScore',0)} @ {game['homeName']} {game.get('homeScore',0)} "
            f"(Q{game.get('quarter','?')} {game.get('clock','')}).\n"
            "Search for this game's current betting lines AND player prop lines.\n"
            "Respond with EXACTLY these labeled lines, no other text:\n"
            f"AWAY_ML: [current {game['away']} moneyline from your search, e.g. +175]\n"
            f"HOME_ML: [current {game['home']} moneyline from your search, e.g. -210]\n"
            f"SPREAD_LINE: [current spread from your search, e.g. {game['away']} +5.5]\n"
            "OU_LINE: [current O/U total from your search, e.g. 228.5]\n"
            "BEST_BET: [Pick the AWAY_ML, HOME_ML, or SPREAD_LINE you wrote above — NEVER a player prop. "
            "Look at the AWAY_ML, HOME_ML, and SPREAD_LINE you already wrote above. Compare those exact prices: what is the ML price vs -110 spread juice, and how many points of protection does the spread actually give? Use those numbers to decide which is better value, then pick it. "
            "Format: 'TEAM LINE — 1-2 sentence live edge reason (score situation, foul trouble, pace).']\n"
            f"BET_TEAM: [{game['away']} or {game['home']} — abbreviation only]\n"
            "BET_TYPE: [SPREAD or ML — which did you recommend in BEST_BET?]\n"
            "OU_LEAN: [Use the OU_LINE you wrote above. Format: 'OVER/UNDER [that number] — 1-2 sentence reason citing pace, fouls, or scoring rate']\n"
            "PLAYER_PROP: [Player prop line from your search. Format: 'Player OVER/UNDER X.X Stat — 1 sentence reason']\n"
            "PROP_STATUS: [Search for the player's current stat line in this game. "
            "Is their stat OVER or UNDER pace vs the line? "
            "Format: 'ON TRACK — X [stat] through Q[N]' or 'FADING — X [stat] through Q[N]']\n"
            "DUBL_SCORE_BET: [float 1.0-5.0 — value score vs live price. Heavy favorite (-400+) scores lower even if likely.]\n"
            "DUBL_REASONING_BET: [1 sentence about the EXACT bet you chose in BEST_BET — if you picked the spread, explain the spread; if you picked the ML, explain the ML. Do NOT mention the other bet type.]\n"
            "DUBL_SCORE_OU: [float 1.0-5.0 — value score: pace/foul/scoring edge vs -110 juice]\n"
            "DUBL_REASONING_OU: [1 sentence: key live stat driving the lean]"
        )
    else:
        prompt = (
            f"Pre-game: {game['awayName']} @ {game['homeName']}.\n"
            "Search for this game's current betting lines AND player prop lines.\n"
            "Respond with EXACTLY these labeled lines, no other text:\n"
            f"AWAY_ML: [current {game['away']} moneyline from your search, e.g. +175]\n"
            f"HOME_ML: [current {game['home']} moneyline from your search, e.g. -210]\n"
            f"SPREAD_LINE: [current spread you found, e.g. {game['away']} +5.5]\n"
            "OU_LINE: [current O/U total from your search, e.g. 228.5]\n"
            "BEST_BET: [Pick the AWAY_ML, HOME_ML, or SPREAD_LINE you wrote above — NEVER a player prop. "
            "Look at the AWAY_ML, HOME_ML, and SPREAD_LINE you already wrote above. Compare those exact prices: what is the ML price vs -110 spread juice, and how many points of protection does the spread actually give? Use those numbers to decide which is better value, then pick it. "
            "Format: 'TEAM LINE — 2-sentence reason (matchup, recent form, pace, injury, schedule spot).']\n"
            f"BET_TEAM: [{game['away']} or {game['home']} — abbreviation only]\n"
            "BET_TYPE: [SPREAD or ML — which did you recommend in BEST_BET?]\n"
            "OU_LEAN: [Use the OU_LINE you wrote above. Format: 'OVER/UNDER [that number] — 1-2 sentence reason citing pace, defensive rank, scoring trend, or injury']\n"
            "PLAYER_PROP: [Player prop line from your search. Format: 'Player OVER/UNDER X.X Stat — 1 sentence reason']\n"
            "DUBL_SCORE_BET: [float 1.0-5.0 — value score vs price. Heavy favorite (-500+) scores lower.]\n"
            "DUBL_REASONING_BET: [1 sentence about the EXACT bet you chose in BEST_BET — if you picked the spread, explain the spread; if you picked the ML, explain the ML. Do NOT mention the other bet type.]\n"
            "DUBL_SCORE_OU: [float 1.0-5.0 — value score: statistical/situational edge vs -110 juice]\n"
            "DUBL_REASONING_OU: [1 sentence: key stat or factor driving the lean]"
        )

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{GEMINI_URL}?key={key}",
            json={
                "system_instruction": {"parts": [{"text": system_prompt}]},
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "tools": [{"google_search": {}}],
                "generationConfig": {"maxOutputTokens": 800, "temperature": 0.7},
            },
            timeout=30,
        )
    data = resp.json()
    if "error" in data:
        raise HTTPException(status_code=400, detail=data["error"]["message"])
    parts = data["candidates"][0]["content"]["parts"]
    text = " ".join(p.get("text", "") for p in parts if "text" in p)
    analysis = parse_gemini_analysis(text)

    # Persist any lines Gemini found back to sticky so /api/games shows real win prob
    lines = analysis.get("lines") or {}
    if any(v for v in lines.values() if v):
        date_str = re.sub(r'.*-(\d{8})$', r'\1', req.game_id) if re.search(r'-\d{8}$', req.game_id) else datetime.now(timezone.utc).strftime("%Y%m%d")
        entry = {k: v for k, v in {
            "awayOdds": lines.get("awayOdds"),
            "homeOdds": lines.get("homeOdds"),
            "spread":   lines.get("spread"),
            "ou":       lines.get("ou"),
        }.items() if v}
        _sticky_odds[base_game_id] = {**_sticky_odds.get(base_game_id, {}), **entry}
        _save_odds_to_firestore(date_str, _sticky_odds)

    return {"analysis": analysis}


@app.post("/api/chat")
async def chat(req: ChatRequest):
    key = get_effective_key(req.api_key)

    today_date = datetime.now(timezone.utc).strftime("%Y%m%d")

    async with httpx.AsyncClient() as client:
        espn_games, injuries, team_stats = await asyncio.gather(
            fetch_espn_games(client),
            fetch_espn_injuries(client),
            fetch_nba_team_stats(client),
        )

    games = espn_games if espn_games else MOCK_GAMES
    today_abbrs = {g["home"] for g in games} | {g["away"] for g in games}
    async with httpx.AsyncClient() as client:
        rest_days = await fetch_team_rest_days(client, today_abbrs, today_date)

    system_prompt = build_system_prompt(games, injuries, team_stats, rest_days)

    contents = [
        {"role": "model" if m.role == "assistant" else "user", "parts": [{"text": m.content}]}
        for m in req.messages
    ]
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{GEMINI_URL}?key={key}",
            json={
                "system_instruction": {"parts": [{"text": system_prompt}]},
                "contents": contents,
                "generationConfig": {"maxOutputTokens": 600, "temperature": 0.75},
            },
            timeout=30,
        )
    data = resp.json()
    if "error" in data:
        raise HTTPException(status_code=400, detail=data["error"]["message"])
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    return {"reply": text}


@app.get("/health")
def health():
    return {"status": "ok", "has_server_key": bool(GEMINI_API_KEY)}


USER_STATIC_DIR = pathlib.Path(__file__).parent / "user_static"
USER_STATIC_DIR.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=USER_STATIC_DIR), name="user_static")

STATIC_DIR = pathlib.Path(__file__).parent / "static"
if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        return FileResponse(str(STATIC_DIR / "index.html"))
