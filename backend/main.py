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

def _save_games_to_firestore(date_str: str, games: list[dict]) -> None:
    """Persist the full merged game list to Firestore for instant cold-start loads."""
    db = _init_firestore()
    if not db or not games:
        return
    try:
        db.collection("nba_games").document(date_str).set(
            {"games": games, "updated_at": fb_firestore.SERVER_TIMESTAMP},
            merge=True,
        )
    except Exception as e:
        logging.warning(f"Firestore games write failed: {e}")


def _persist_analysis_to_firestore(date_str: str, game_id: str, analysis: dict) -> None:
    """Update a single game's analysis inside the cached game list in Firestore."""
    db = _init_firestore()
    if not db:
        return
    try:
        doc_ref = db.collection("nba_games").document(date_str)
        doc = doc_ref.get()
        if not doc.exists:
            return
        games = doc.to_dict().get("games", [])
        updated = False
        for g in games:
            gid = re.sub(r'-\d{8}$', '', g.get("id", ""))
            if gid == game_id:
                g["analysis"] = analysis
                # Also update odds if analysis found them
                lines = analysis.get("lines") or {}
                for k in ("homeOdds", "awayOdds", "spread", "ou"):
                    mapped = {"homeOdds": "homeOdds", "awayOdds": "awayOdds", "spread": "spread", "ou": "ou"}
                    val = lines.get(k)
                    if val:
                        g[k] = val
                updated = True
                break
        if updated:
            doc_ref.set(
                {"games": games, "updated_at": fb_firestore.SERVER_TIMESTAMP},
                merge=True,
            )
    except Exception as e:
        logging.warning(f"Firestore analysis persist failed: {e}")


def _load_games_from_firestore(date_str: str) -> list[dict] | None:
    """Load the full game list from Firestore. Returns None if not found."""
    db = _init_firestore()
    if not db:
        return None
    try:
        doc = db.collection("nba_games").document(date_str).get()
        if doc.exists:
            data = doc.to_dict()
            games = data.get("games")
            if games:
                return games
    except Exception as e:
        logging.warning(f"Firestore games read failed: {e}")
    return None


# ── DAILY PICKS PERSISTENCE ────────────────────────────────────────────────────

def _save_pick_to_firestore(date_str: str, pick_data: dict) -> None:
    """Save or update a pick entry for a game in the daily_picks collection."""
    db = _init_firestore()
    if not db:
        return
    try:
        doc_ref = db.collection("daily_picks").document(date_str)
        doc = doc_ref.get()
        picks = doc.to_dict().get("picks", []) if doc.exists else []
        game_id = pick_data["game_id"]
        existing_idx = next((i for i, p in enumerate(picks) if p.get("game_id") == game_id), None)
        if existing_idx is not None:
            existing = picks[existing_idx]
            # Preserve any already-scored result fields
            for field in ("result_bet", "result_ou", "final_away", "final_home", "scored_at"):
                if field in existing and field not in pick_data:
                    pick_data[field] = existing[field]
            picks[existing_idx] = pick_data
        else:
            picks.append(pick_data)
        doc_ref.set({"picks": picks, "updated_at": fb_firestore.SERVER_TIMESTAMP}, merge=True)
    except Exception as e:
        logging.warning(f"Firestore pick save failed: {e}")


def _score_pick(pick: dict, away_score: int, home_score: int) -> dict:
    """Given final scores, compute result_bet and result_ou for a pick. Returns updated pick."""
    pick = dict(pick)
    combined = away_score + home_score

    # Score O/U
    ou_line = pick.get("ou_line")
    ou_direction = (pick.get("ou_direction") or "").upper()
    if ou_line and ou_direction in ("OVER", "UNDER"):
        try:
            line = float(ou_line)
            if combined > line:
                actual = "OVER"
            elif combined < line:
                actual = "UNDER"
            else:
                actual = "PUSH"
            pick["result_ou"] = "PUSH" if actual == "PUSH" else ("HIT" if actual == ou_direction else "MISS")
        except (ValueError, TypeError):
            pass

    # Score Best Bet (spread or ML)
    bet_team = (pick.get("bet_team") or "").upper()
    bet_is_spread = pick.get("bet_is_spread", False)
    spread_line = pick.get("spread_line") or ""
    away_abbr = (pick.get("away") or "").upper()
    home_abbr = (pick.get("home") or "").upper()

    if bet_team:
        if bet_is_spread and spread_line:
            m = re.match(r'^([A-Z]+)\s*([-+]?\d+\.?\d*)$', spread_line.strip().upper())
            if m:
                fav_abbr = m.group(1)
                line_val = float(m.group(2))  # negative = favored
                fav_score = home_score if fav_abbr == home_abbr else away_score
                dog_score = away_score if fav_abbr == home_abbr else home_score
                actual_margin = fav_score - dog_score
                needed = abs(line_val)
                if actual_margin > needed:
                    fav_covered, push = True, False
                elif actual_margin < needed:
                    fav_covered, push = False, False
                else:
                    fav_covered, push = False, True

                if push:
                    pick["result_bet"] = "PUSH"
                elif bet_team == fav_abbr:
                    pick["result_bet"] = "HIT" if fav_covered else "MISS"
                else:
                    pick["result_bet"] = "HIT" if not fav_covered else "MISS"
        else:
            # ML bet — did the picked team win?
            if bet_team == home_abbr:
                won = home_score > away_score
            else:
                won = away_score > home_score
            pick["result_bet"] = "HIT" if won else "MISS"

    pick["final_away"] = away_score
    pick["final_home"] = home_score
    pick["scored_at"] = datetime.now(timezone.utc).isoformat()
    return pick


def _score_picks_for_date(date_str: str, final_games: list[dict]) -> None:
    """Score any unscored picks against final game results for the given date."""
    db = _init_firestore()
    if not db:
        return
    try:
        doc_ref = db.collection("daily_picks").document(date_str)
        doc = doc_ref.get()
        if not doc.exists:
            return
        picks = doc.to_dict().get("picks", [])
        if not picks:
            return
        final_by_id = {
            re.sub(r'-\d{8}$', '', g["id"]): g
            for g in final_games if g.get("status") == "final"
        }
        updated = False
        for pick in picks:
            # Skip already scored picks
            if pick.get("result_bet") is not None or pick.get("result_ou") is not None:
                continue
            game_id = pick.get("game_id", "")
            base_id = re.sub(r'-\d{8}$', '', game_id)
            game = final_by_id.get(base_id) or final_by_id.get(game_id)
            if not game:
                continue
            away_score = int(game.get("awayScore") or 0)
            home_score = int(game.get("homeScore") or 0)
            if away_score == 0 and home_score == 0:
                continue
            scored = _score_pick(pick, away_score, home_score)
            pick.update(scored)
            updated = True
        if updated:
            doc_ref.set({"picks": picks, "updated_at": fb_firestore.SERVER_TIMESTAMP}, merge=True)
    except Exception as e:
        logging.warning(f"Firestore picks scoring failed: {e}")


def _load_picks_from_firestore(date_str: str) -> list[dict]:
    """Load picks for a given date from Firestore."""
    db = _init_firestore()
    if not db:
        return []
    try:
        doc = db.collection("daily_picks").document(date_str).get()
        if doc.exists:
            return doc.to_dict().get("picks", [])
    except Exception as e:
        logging.warning(f"Firestore picks read failed: {e}")
    return []


GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"
ESPN_INJURIES_URL   = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries"
ESPN_STANDINGS_URL  = "https://site.api.espn.com/apis/v2/sports/basketball/nba/standings"

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
# Keyed by date_str → game_id → odds dict. Each date only contains its own games.
_sticky_odds: dict[str, dict[str, dict]] = {}


def _get_sticky(date_str: str, game_id: str) -> dict:
    """Get sticky odds for a specific game on a specific date."""
    return _sticky_odds.get(date_str, {}).get(game_id, {})


_OPENING_FIELDS = ("spread", "ou", "homeOdds", "awayOdds", "homeSpreadOdds", "awaySpreadOdds")


def _set_sticky(date_str: str, game_id: str, odds: dict) -> None:
    """Set sticky odds for a specific game on a specific date, then persist.

    On first write, snapshots the values as opening_* so we can track movement.
    """
    existing = _sticky_odds.get(date_str, {}).get(game_id, {})

    # Snapshot opening odds on first write — never overwrite them
    if not existing:
        for f in _OPENING_FIELDS:
            if odds.get(f):
                odds[f"opening_{f}"] = odds[f]
    else:
        for f in _OPENING_FIELDS:
            opening_key = f"opening_{f}"
            if opening_key in existing:
                odds[opening_key] = existing[opening_key]
            elif odds.get(f) and opening_key not in odds:
                odds[opening_key] = odds[f]

    _sticky_odds.setdefault(date_str, {})[game_id] = odds
    _save_odds_to_firestore(date_str, _sticky_odds.get(date_str, {}))


async def fetch_espn_standings(client: httpx.AsyncClient) -> dict[str, dict]:
    """
    Fetch team standings from ESPN (record, ppg, opp ppg, streak, seed, L10).
    Cached for 30 minutes. Replaces the broken stats.nba.com API.
    """
    cached = cache_get("espn_standings")
    if cached is not None:
        return cached

    try:
        r = await client.get(ESPN_STANDINGS_URL, timeout=10)
        data = r.json()
    except Exception as e:
        logging.warning(f"ESPN standings fetch failed: {e}")
        return {}

    teams: dict[str, dict] = {}
    for conf in data.get("children", []):
        for entry in conf.get("standings", {}).get("entries", []):
            abbr = norm_abbr(entry.get("team", {}).get("abbreviation", ""))
            if not abbr:
                continue
            stats_map = {s["name"]: s for s in entry.get("stats", [])}
            teams[abbr] = {
                "wins":     int(stats_map.get("wins", {}).get("value", 0)),
                "losses":   int(stats_map.get("losses", {}).get("value", 0)),
                "seed":     int(stats_map.get("playoffSeed", {}).get("value", 0)),
                "ppg":      float(stats_map.get("avgPointsFor", {}).get("value", 0)),
                "opp_ppg":  float(stats_map.get("avgPointsAgainst", {}).get("value", 0)),
                "diff":     float(stats_map.get("differential", {}).get("value", 0)),
                "streak":   stats_map.get("streak", {}).get("displayValue", ""),
                "l10":      stats_map.get("Last Ten Games", {}).get("displayValue", ""),
            }
    cache_set("espn_standings", teams, ttl=1800)
    logging.info(f"ESPN standings: loaded {len(teams)} teams")
    return teams


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

            # Extract team records from scoreboard (e.g. "42-13")
            for side, prefix in [(home, "home"), (away, "away")]:
                for rec in side.get("records", []):
                    if rec.get("type") == "total":
                        g[f"{prefix}_record"] = rec.get("summary", "")
                        break

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


ESPN_SUMMARY_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary"


async def _fetch_one_espn_summary(client: httpx.AsyncClient, espn_id: str) -> dict:
    """Fetch a single game summary — returns pickcenter odds + predictor win prob."""
    try:
        r = await client.get(ESPN_SUMMARY_URL, params={"event": espn_id}, timeout=10)
        return r.json()
    except Exception:
        return {}


async def enrich_games_from_espn_summary(client: httpx.AsyncClient, games: list[dict]) -> None:
    """
    Batch-fetch ESPN /summary for each game to get:
    - DraftKings moneylines from pickcenter (scoreboard no longer has them)
    - ESPN BPI predictor win probabilities
    Mutates games in-place. Cached via the normal espn_games cache.
    """
    tasks = []
    game_map: list[tuple[dict, str]] = []  # (game, espn_id)
    for g in games:
        espn_id = g.get("espn_id")
        if not espn_id:
            continue
        # Skip if already enriched (games list is cached and mutated in-place)
        if g.get("espn_home_win_prob") is not None:
            continue
        tasks.append(_fetch_one_espn_summary(client, espn_id))
        game_map.append((g, espn_id))

    if not tasks:
        return

    results = await asyncio.gather(*tasks, return_exceptions=True)
    for (g, espn_id), result in zip(game_map, results):
        if isinstance(result, Exception) or not isinstance(result, dict):
            continue

        home_abbr = g["home"]
        away_abbr = g["away"]

        # Extract moneylines + open/close lines from pickcenter (DraftKings)
        for pc in result.get("pickcenter", []):
            hto = pc.get("homeTeamOdds", {})
            ato = pc.get("awayTeamOdds", {})
            hml = hto.get("moneyLine")
            aml = ato.get("moneyLine")
            if hml is not None and not g.get("espn_homeOdds"):
                g["espn_homeOdds"] = _fmt_american(hml)
                if g["espn_homeOdds"] == "—":
                    g["espn_homeOdds"] = None
            if aml is not None and not g.get("espn_awayOdds"):
                g["espn_awayOdds"] = _fmt_american(aml)
                if g["espn_awayOdds"] == "—":
                    g["espn_awayOdds"] = None
            # Spread odds
            hso = hto.get("spreadOdds")
            aso = ato.get("spreadOdds")
            if hso is not None:
                g["espn_homeSpreadOdds"] = _fmt_american(hso)
            if aso is not None:
                g["espn_awaySpreadOdds"] = _fmt_american(aso)

            # Opening lines from DraftKings (structured open/close data)
            ml = pc.get("moneyline", {})
            ps = pc.get("pointSpread", {})
            tot = pc.get("total", {})

            # Opening moneyline
            open_hml = ml.get("home", {}).get("open", {}).get("odds")
            open_aml = ml.get("away", {}).get("open", {}).get("odds")
            if open_hml:
                g["espn_opening_homeOdds"] = str(open_hml)
            if open_aml:
                g["espn_opening_awayOdds"] = str(open_aml)

            # Opening spread — store just the numeric value (home perspective)
            open_spread_line = ps.get("home", {}).get("open", {}).get("line")
            if open_spread_line is not None:
                g["espn_opening_spread"] = str(open_spread_line)

            # Opening total
            open_total = tot.get("over", {}).get("open", {}).get("line", "")
            if open_total:
                # ESPN formats as "o227.5" — strip the prefix
                g["espn_opening_ou"] = re.sub(r'^[ou]', '', str(open_total))

            break  # first provider is enough

        # Extract ESPN BPI predictor win probability
        predictor = result.get("predictor", {})
        home_pred = predictor.get("homeTeam", {})
        away_pred = predictor.get("awayTeam", {})
        try:
            home_proj = float(home_pred.get("gameProjection", 0))
            if home_proj > 0:
                g["espn_home_win_prob"] = home_proj
        except (ValueError, TypeError):
            pass


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
        if result:
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

    # Build team context block from ESPN standings: record, ppg, opp ppg, L10, streak, rest
    team_ctx = ""
    if team_stats or rest_days:
        today_abbrs = sorted({a for g in games for a in (g["home"], g["away"])})
        rows = []
        for abbr in today_abbrs:
            ts = (team_stats or {}).get(abbr, {})
            rd = (rest_days or {}).get(abbr)
            parts = []
            w, l = ts.get("wins"), ts.get("losses")
            if w is not None and l is not None and (w + l) > 0:
                parts.append(f"{w}-{l}")
            seed = ts.get("seed")
            if seed:
                parts.append(f"#{seed} seed")
            ppg = ts.get("ppg")
            opp = ts.get("opp_ppg")
            if ppg:
                parts.append(f"{ppg:.1f} ppg")
            if opp:
                parts.append(f"{opp:.1f} opp")
            diff = ts.get("diff")
            if diff is not None and diff != 0:
                parts.append(f"{diff:+.1f} diff")
            l10 = ts.get("l10")
            if l10:
                parts.append(f"L10 {l10}")
            streak = ts.get("streak")
            if streak:
                parts.append(streak)
            if rd is not None:
                parts.append("B2B" if rd == 0 else f"{rd}d rest")
            if parts:
                rows.append(f"  {abbr}: {', '.join(parts)}")
        if rows:
            team_ctx = "\nTEAM CONTEXT (ESPN standings + rest):\n" + "\n".join(rows)

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
        ds = date_str or datetime.now(timezone.utc).strftime("%Y%m%d")
        o = odds_map.get(base_id) or odds_map.get(gid) or {}
        sticky = _get_sticky(ds, base_id) or _get_sticky(ds, gid)

        spread          = g.get("espn_spread")   or o.get("spread")          or sticky.get("spread")
        ou              = g.get("espn_ou")        or o.get("ou")              or sticky.get("ou")
        homeOdds        = g.get("espn_homeOdds")  or o.get("homeOdds")        or sticky.get("homeOdds")
        awayOdds        = g.get("espn_awayOdds")  or o.get("awayOdds")        or sticky.get("awayOdds")
        homeSpreadOdds  = g.get("espn_homeSpreadOdds") or o.get("homeSpreadOdds") or sticky.get("homeSpreadOdds")
        awaySpreadOdds  = g.get("espn_awaySpreadOdds") or o.get("awaySpreadOdds") or sticky.get("awaySpreadOdds")

        # Persist under base_id so both today and tomorrow lookups can find it
        if any([spread, ou, homeOdds]):
            _set_sticky(ds, base_id, {k: v for k, v in {
                "spread": spread, "ou": ou, "homeOdds": homeOdds, "awayOdds": awayOdds,
                "homeSpreadOdds": homeSpreadOdds, "awaySpreadOdds": awaySpreadOdds,
            }.items() if v})

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

        # Fallback: use ESPN BPI predictor win probability
        if home_prob == 50.0 and away_prob == 50.0:
            espn_home_prob = g.get("espn_home_win_prob")
            if espn_home_prob is not None:
                home_prob = round(espn_home_prob, 1)
                away_prob = round(100 - espn_home_prob, 1)

        # Build result without espn_* fields
        base = {k: v for k, v in g.items() if not k.startswith("espn_")}

        # Opening lines: prefer ESPN pickcenter open/close, fall back to sticky snapshot
        opening = {}
        for f in _OPENING_FIELDS:
            val = g.get(f"espn_opening_{f}") or sticky.get(f"opening_{f}")
            if val:
                opening[f"opening_{f}"] = val

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
            **opening,
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
        date_odds = _sticky_odds.setdefault(date_str, {})
        for g in games:
            key = re.sub(r'-\d{8}$', '', g["id"])
            for espn_field, out_field in [("espn_homeOdds","homeOdds"),("espn_awayOdds","awayOdds"),
                                          ("espn_spread","spread"),("espn_ou","ou")]:
                val = g.get(espn_field)
                if val and date_odds.get(key, {}).get(out_field) != val:
                    date_odds.setdefault(key, {})[out_field] = val
                    changed = True
        if changed:
            _save_odds_to_firestore(date_str, date_odds)
    except Exception as e:
        logging.warning(f"Background odds refresh failed: {e}")


async def _full_espn_refresh(date_str: str, date_param: str | None) -> list[dict]:
    """Fetch ESPN games, enrich with summary data, merge odds, save to Firestore."""
    # Sync sticky odds from Firestore
    if time.time() - _firestore_last_synced.get(date_str, 0) > FIRESTORE_SYNC_TTL:
        stored = _load_odds_from_firestore(date_str)
        if stored:
            _sticky_odds.setdefault(date_str, {}).update(stored)
        _firestore_last_synced[date_str] = time.time()

    async with httpx.AsyncClient() as client:
        games = await fetch_espn_games(client, date_param)
        if games:
            await enrich_games_from_espn_summary(client, games)

    if not games:
        return []

    merged = _merge_odds(games, {}, date_str)

    # Persist full game state to Firestore for instant loads
    _save_games_to_firestore(date_str, merged)

    # Auto-score any picks whose games are now final
    _score_picks_for_date(date_str, merged)

    return merged


@app.get("/api/games")
async def get_games(date: Optional[str] = None):
    """Fetch games for a given date (YYYYMMDD). Defaults to today."""
    date_str = date or datetime.now(timezone.utc).strftime("%Y%m%d")

    # ── 1. Try serving from Firestore cache (instant, survives container restarts)
    cached_games = _load_games_from_firestore(date_str)
    if cached_games:
        # Serve cached immediately, refresh in background
        asyncio.create_task(_full_espn_refresh(date_str, date))
        return {
            "games": cached_games,
            "source": "live",
            "odds_updated_at": _odds_updated_at.get(date_str),
        }

    # ── 2. No Firestore cache — first load of the day, fetch everything
    merged = await _full_espn_refresh(date_str, date)

    if not merged:
        return {"games": MOCK_GAMES, "source": "mock"}

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

    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    today_odds = _sticky_odds.get(today, {})
    info: dict = {
        "espn_game_ids": espn_ids,
        "sticky_odds_keys": list(today_odds.keys()),
        "dk_cache_fresh": cache_get("dk_game_lines") is not None,
        "matched": [k for k in today_odds if k in espn_ids],
        "unmatched_espn": [k for k in espn_ids if k not in today_odds],
    }
    return info


@app.get("/api/picks/{date_str}")
async def get_picks(date_str: str):
    """Get saved daily picks + hit stats for a given date (YYYYMMDD)."""
    # Attempt to score any pending picks using cached game data
    games_cached = _load_games_from_firestore(date_str)
    if games_cached:
        _score_picks_for_date(date_str, games_cached)

    picks = _load_picks_from_firestore(date_str)
    scored_bet = [p for p in picks if p.get("result_bet") in ("HIT", "MISS")]
    scored_ou  = [p for p in picks if p.get("result_ou")  in ("HIT", "MISS")]
    hits_bet   = sum(1 for p in scored_bet if p["result_bet"] == "HIT")
    hits_ou    = sum(1 for p in scored_ou  if p["result_ou"]  == "HIT")

    hit_pct_bet = round(hits_bet / len(scored_bet) * 100, 1) if scored_bet else None
    hit_pct_ou  = round(hits_ou  / len(scored_ou)  * 100, 1) if scored_ou  else None

    return {
        "date":         date_str,
        "picks":        picks,
        "hit_pct_bet":  hit_pct_bet,
        "hit_pct_ou":   hit_pct_ou,
        "hits_bet":     hits_bet,
        "hits_ou":      hits_ou,
        "total_picks":  len(picks),
        "scored_bet":   len(scored_bet),
        "scored_ou":    len(scored_ou),
    }


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

    # Build matchup list + team set for the prompt so Gemini uses correct abbreviations
    playing_teams: set[str] = set()
    matchup_lines: list[str] = []
    for g in games:
        away = g.get("away", "").upper()
        home = g.get("home", "").upper()
        if away:
            playing_teams.add(away)
        if home:
            playing_teams.add(home)
        if away and home:
            matchup_lines.append(f"{g.get('awayName', away)} ({away}) @ {g.get('homeName', home)} ({home})")

    games_block = "\n".join(matchup_lines) if matchup_lines else "Check today's NBA schedule"

    prompt = (
        f"Search for NBA player props available right now on DraftKings or FanDuel for {today_str}.\n"
        f"Today's games:\n{games_block}\n\n"
        f"Use ONLY these team abbreviations: {', '.join(sorted(playing_teams))}.\n"
        f"Return the top 50 props, with at least 5 props per game. "
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
        # Normalize team abbreviations Gemini returned (e.g. "GS" → "GSW", "PHO" → "PHX")
        for p in props:
            p["team"] = norm_abbr(p.get("team", ""))
        if playing_teams:
            before = len(props)
            props = [p for p in props if p["team"] in playing_teams]
            dropped = before - len(props)
            if dropped:
                logging.info(f"Filtered {dropped} props for teams not playing today")
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
            fetch_espn_standings(client),
        )
        # Enrich with summary data (moneylines + BPI win prob) for the analysis prompt
        if espn_games:
            await enrich_games_from_espn_summary(client, espn_games)

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
    sticky = _get_sticky(today_date, base_game_id) or _get_sticky(today_date, req.game_id)
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

    # Persist lines + analysis to Firestore so next page load is instant
    date_str = re.sub(r'.*-(\d{8})$', r'\1', req.game_id) if re.search(r'-\d{8}$', req.game_id) else datetime.now(timezone.utc).strftime("%Y%m%d")
    lines = analysis.get("lines") or {}
    if any(v for v in lines.values() if v):
        entry = {k: v for k, v in {
            "awayOdds": lines.get("awayOdds"),
            "homeOdds": lines.get("homeOdds"),
            "spread":   lines.get("spread"),
            "ou":       lines.get("ou"),
        }.items() if v}
        existing = _get_sticky(date_str, base_game_id)
        _set_sticky(date_str, base_game_id, {**existing, **entry})

    # Update the cached game list in Firestore with analysis results
    _persist_analysis_to_firestore(date_str, base_game_id, analysis)

    # Save pick snapshot for pre-game analysis (not live re-analysis)
    if not is_live and analysis.get("best_bet"):
        ou_text = (analysis.get("ou") or "").strip()
        ou_dir_m = re.match(r'^(OVER|UNDER)', ou_text, re.IGNORECASE)
        ou_dir = ou_dir_m.group(1).upper() if ou_dir_m else None
        # Strip numeric O/U line from the ou_lean text, e.g. "OVER 224.5 — ..." → "224.5"
        ou_line_m = re.search(r'(OVER|UNDER)\s+(\d+\.?\d*)', ou_text, re.IGNORECASE)
        ou_line_val = lines.get("ou") or (ou_line_m.group(2) if ou_line_m else None)
        pick_data = {
            "game_id":      base_game_id,
            "away":         game["away"],
            "home":         game["home"],
            "away_name":    game.get("awayName", game["away"]),
            "home_name":    game.get("homeName", game["home"]),
            "best_bet":     analysis.get("best_bet"),
            "bet_team":     analysis.get("bet_team"),
            "bet_is_spread": analysis.get("bet_is_spread", False),
            "spread_line":  lines.get("spread"),
            "ou":           analysis.get("ou"),
            "ou_line":      ou_line_val,
            "ou_direction": ou_dir,
            "dubl_score_bet": analysis.get("dubl_score_bet"),
            "dubl_score_ou":  analysis.get("dubl_score_ou"),
            "saved_at":     datetime.now(timezone.utc).isoformat(),
        }
        _save_pick_to_firestore(date_str, pick_data)

    return {"analysis": analysis}


@app.post("/api/chat")
async def chat(req: ChatRequest):
    key = get_effective_key(req.api_key)

    today_date = datetime.now(timezone.utc).strftime("%Y%m%d")

    async with httpx.AsyncClient() as client:
        espn_games, injuries, team_stats = await asyncio.gather(
            fetch_espn_games(client),
            fetch_espn_injuries(client),
            fetch_espn_standings(client),
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
