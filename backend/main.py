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
ODDS_API_KEY   = os.getenv("ODDS_API_KEY", "").strip()   # strip() prevents HF Secrets trailing-newline bug

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"
ESPN_INJURIES_URL   = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries"
ODDS_API_BASE       = "https://api.the-odds-api.com/v4"

# ── CACHE ─────────────────────────────────────────────────────────────────────
_cache: dict = {}
CACHE_TTL = 60  # seconds


def cache_get(key: str):
    entry = _cache.get(key)
    if entry and time.time() - entry["ts"] < CACHE_TTL:
        return entry["data"]
    return None


def cache_set(key: str, data):
    _cache[key] = {"ts": time.time(), "data": data}


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


# Sticky odds: pre-game lines that persist even after game goes live/final
_sticky_odds: dict[str, dict] = {}


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
                            # Spread: find the home team's line
                            if "spread" not in odds_data:
                                for o in outcomes:
                                    participant = o.get("participant") or o.get("label", "")
                                    abbr = any_name_to_abbr(participant)
                                    if abbr == home_abbr:
                                        ln = o.get("line", 0)
                                        if ln:
                                            odds_data["spread"] = f"{home_abbr} {_sign(ln)}"
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

    cache_set("dk_game_lines", result)
    return result


async def fetch_odds(client: httpx.AsyncClient) -> dict:
    """
    Fetch NBA odds. Tries The Odds API first (requires ODDS_API_KEY),
    then falls back to DraftKings game lines (free, works live too).
    All fetched odds are saved to sticky cache for use by live/final games.
    """
    if ODDS_API_KEY:
        cached = cache_get("odds")
        if cached is not None:
            return cached

        try:
            r = await client.get(
                f"{ODDS_API_BASE}/sports/basketball_nba/odds/",
                params={
                    "apiKey": ODDS_API_KEY,
                    "regions": "us",
                    "markets": "h2h,spreads,totals",
                    "oddsFormat": "american",
                },
                timeout=10,
            )
            events = r.json()
        except Exception:
            events = []

        if isinstance(events, list) and events:
            result: dict = {}
            for ev in events:
                if not isinstance(ev, dict):
                    continue
                home_full = ev.get("home_team", "")
                away_full = ev.get("away_team", "")
                home = full_name_to_abbr(home_full)
                away = full_name_to_abbr(away_full)
                key  = f"{away.lower()}-{home.lower()}"
                odds_data: dict = {}
                for bm in ev.get("bookmakers", []):
                    if bm["key"] not in ("draftkings", "fanduel", "betmgm"):
                        continue
                    for market in bm.get("markets", []):
                        mk = market["key"]
                        outcomes = {o["name"]: o["price"] for o in market.get("outcomes", [])}
                        if mk == "h2h":
                            odds_data["homeOdds"] = _fmt_american(outcomes.get(home_full, 0))
                            odds_data["awayOdds"] = _fmt_american(outcomes.get(away_full, 0))
                        elif mk == "spreads":
                            for o in market.get("outcomes", []):
                                if full_name_to_abbr(o["name"]) == home:
                                    odds_data["spread"] = f"{home} {_sign(o['point'])}"
                        elif mk == "totals":
                            for o in market.get("outcomes", []):
                                if o["name"] == "Over":
                                    odds_data["ou"] = str(o["point"])
                    break
                if odds_data:
                    result[key] = odds_data
                    _sticky_odds[key] = {**_sticky_odds.get(key, {}), **odds_data}
            if result:
                cache_set("odds", result)
                return result

    # Fall back to DraftKings (free, no key, shows live game lines too)
    return await fetch_draftkings_game_lines(client)


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
def build_system_prompt(games: list, injuries: set) -> str:
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

    return (
        "You are a sharp NBA betting analyst writing for serious bettors who want actionable picks, not fluff. "
        "Never say obvious things like 'both teams can score' or 'it should be a close game'. "
        "Always cite specific edges: matchup advantages, pace differentials, recent ATS records, "
        "key injuries, rest advantages, or defensive rankings.\n"
        f"LIVE GAMES: {live_str}\n"
        f"TONIGHT: {up_str}\n"
        f"{injury_note}\n"
        "Respond with EXACTLY the three labeled lines requested. No preamble, no disclaimer, no extra text."
    )


def parse_gemini_analysis(text: str) -> dict:
    """Parse structured Gemini response into best_bet / ou / props / dubl scores."""
    stoppers = "BEST_BET:|OU_LEAN:|PLAYER_PROP:|DUBL_SCORE_BET:|DUBL_SCORE_OU:|$"

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

    return {
        "best_bet":       extract("BEST_BET"),
        "ou":             extract("OU_LEAN"),
        "props":          extract("PLAYER_PROP"),
        "dubl_score_bet": extract_score("DUBL_SCORE_BET"),
        "dubl_score_ou":  extract_score("DUBL_SCORE_OU"),
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

def _merge_odds(espn_games: list[dict], odds_map: dict) -> list[dict]:
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

        spread   = g.get("espn_spread")   or o.get("spread")   or sticky.get("spread")
        ou       = g.get("espn_ou")        or o.get("ou")       or sticky.get("ou")
        homeOdds = g.get("espn_homeOdds")  or o.get("homeOdds") or sticky.get("homeOdds")
        awayOdds = g.get("espn_awayOdds")  or o.get("awayOdds") or sticky.get("awayOdds")

        # Persist under base_id so both today and tomorrow lookups can find it
        if any([spread, ou, homeOdds]):
            _sticky_odds[base_id] = {k: v for k, v in {
                "spread": spread, "ou": ou, "homeOdds": homeOdds, "awayOdds": awayOdds
            }.items() if v}

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
            "spread": spread,
            "ou": ou,
            "ouDir": None,
            "analysis": {"best_bet": None, "ou": None, "props": None},
        })
    return result


@app.get("/api/games")
async def get_games(date: Optional[str] = None):
    """Fetch games for a given date (YYYYMMDD). Defaults to today."""
    async with httpx.AsyncClient() as client:
        games, odds_map = await asyncio.gather(
            fetch_espn_games(client, date),
            fetch_odds(client),
        )

    if not games:
        return {"games": MOCK_GAMES, "source": "mock"}

    return {"games": _merge_odds(games, odds_map), "source": "live"}


@app.get("/api/debug")
async def debug_odds():
    """Diagnostic endpoint — odds key status, ESPN game IDs, and odds match check."""
    async with httpx.AsyncClient() as client:
        espn_games = await fetch_espn_games(client)

    espn_ids = [g["id"] for g in espn_games]

    info: dict = {
        "odds_api_key_set": bool(ODDS_API_KEY),
        "espn_game_ids": espn_ids,
        "sticky_odds_keys": list(_sticky_odds.keys()),
        "odds_api_cache_fresh": cache_get("odds") is not None,
    }

    if ODDS_API_KEY:
        async with httpx.AsyncClient() as client:
            try:
                r = await client.get(
                    f"{ODDS_API_BASE}/sports/basketball_nba/odds/",
                    params={"apiKey": ODDS_API_KEY, "regions": "us",
                            "markets": "h2h,spreads,totals", "oddsFormat": "american"},
                    timeout=10,
                )
                events = r.json()
                if isinstance(events, list):
                    odds_keys = []
                    for ev in events:
                        h = full_name_to_abbr(ev.get("home_team", "")).lower()
                        a = full_name_to_abbr(ev.get("away_team", "")).lower()
                        odds_keys.append(f"{a}-{h}")
                    info["odds_api_game_count"] = len(events)
                    info["odds_api_keys"] = odds_keys
                    info["matched_ids"] = [k for k in odds_keys if k in espn_ids]
                    info["unmatched_espn"] = [k for k in espn_ids if k not in odds_keys]
                    info["unmatched_odds"] = [k for k in odds_keys if k not in espn_ids]
                    info["sample_odds"] = [
                        {"key": odds_keys[i],
                         "bookmakers": len(ev.get("bookmakers", [])),
                         "home": ev.get("home_team"), "away": ev.get("away_team")}
                        for i, ev in enumerate(events[:5])
                    ]
                else:
                    info["odds_api_error"] = events
            except Exception as e:
                info["odds_api_exception"] = str(e)
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
                "l5":         int(p.get("l5", 50)),
                "l10":        int(p.get("l10", 50)),
                "l15":        int(p.get("l15", 50)),
                "streak":     int(p.get("streak", 0)),
                "avg":        float(p.get("avg", line)),
                "edge_score": float(p.get("edge_score", 3.0)),
                "matchup":    str(p.get("matchup", "")),
                "reason":     str(p.get("reason", "")),
            })
        except Exception:
            continue
    return out


async def fetch_odds_api_player_props(client: httpx.AsyncClient) -> list[dict]:
    """Fetch real player props from The Odds API — actual bookmaker lines + odds."""
    if not ODDS_API_KEY:
        return []
    cached = cache_get("player_props_odds")
    if cached is not None:
        return cached

    # 1. Get today's events
    try:
        r = await client.get(
            f"{ODDS_API_BASE}/sports/basketball_nba/events",
            params={"apiKey": ODDS_API_KEY},
            timeout=10,
        )
        events = r.json()
    except Exception as e:
        logging.warning(f"Odds API events fetch failed: {e}")
        return []

    if not isinstance(events, list) or not events:
        logging.warning("Odds API returned no NBA events")
        return []

    prop_markets = "player_points,player_rebounds,player_assists,player_threes"
    stat_names = {
        "player_points": "Points",
        "player_rebounds": "Rebounds",
        "player_assists": "Assists",
        "player_threes": "3PM",
    }
    props_out: list[dict] = []

    # 2. Get player prop odds for each event (limit to 8 events to conserve quota)
    for ev in events[:8]:
        event_id = ev.get("id", "")
        home_full = ev.get("home_team", "")
        away_full = ev.get("away_team", "")
        matchup = f"{full_name_to_abbr(away_full)} @ {full_name_to_abbr(home_full)}"

        try:
            r = await client.get(
                f"{ODDS_API_BASE}/sports/basketball_nba/events/{event_id}/odds",
                params={
                    "apiKey": ODDS_API_KEY,
                    "regions": "us",
                    "markets": prop_markets,
                    "oddsFormat": "american",
                    "bookmakers": "draftkings,fanduel",
                },
                timeout=10,
            )
            data = r.json()
        except Exception as e:
            logging.warning(f"Odds API player props failed for event {event_id}: {e}")
            continue

        if isinstance(data, dict) and "error" in data:
            logging.warning(f"Odds API player props error: {data}")
            break   # likely plan doesn't support player props, stop trying

        for bm in data.get("bookmakers", []) if isinstance(data, dict) else []:
            bm_name = bm.get("title", bm.get("key", ""))
            for market in bm.get("markets", []):
                stat_key = market.get("key", "")
                stat = stat_names.get(stat_key, stat_key)

                # Group outcomes by player description (Over/Under pairs)
                by_player: dict[str, dict] = {}
                for o in market.get("outcomes", []):
                    name = o.get("description", "")
                    if not name:
                        continue
                    side = o.get("name", "").lower()  # "over" / "under"
                    by_player.setdefault(name, {})[side] = {
                        "price": o.get("price", 0),
                        "point": o.get("point", 0),
                    }

                for player_name, sides in by_player.items():
                    over  = sides.get("over", {})
                    under = sides.get("under", {})
                    line = over.get("point") or under.get("point")
                    if not line:
                        continue
                    over_price  = over.get("price", -110)
                    under_price = under.get("price", -110)
                    rec = "OVER" if over_price >= under_price else "UNDER"

                    over_fmt  = _fmt_american(over_price)
                    under_fmt = _fmt_american(under_price)
                    props_out.append({
                        "player":     player_name,
                        "team":       "",
                        "pos":        "",
                        "stat":       stat,
                        "prop":       f"{stat} O/U {line}",
                        "line":       float(line),
                        "over_odds":  over_fmt,
                        "under_odds": under_fmt,
                        "odds":       over_fmt if rec == "OVER" else under_fmt,
                        "rec":        rec,
                        "l5": 0, "l10": 0, "l15": 0,
                        "streak":     0,
                        "avg":        float(line),
                        "edge_score": min(5.0, max(1.0, round(abs(over_price - under_price) / 20 + 1.0, 1))),
                        "matchup":    matchup,
                        "reason":     f"Live {bm_name} line",
                    })
            break  # one bookmaker per event is enough

    if props_out:
        logging.info(f"Odds API player props: got {len(props_out)} props from {len(events)} events")
        cache_set("player_props_odds", props_out)
    else:
        logging.warning("Odds API player props: no props returned (plan may not support player props)")
    return props_out


async def fetch_gemini_props(client: httpx.AsyncClient, key: str, games: list[dict]) -> list[dict]:
    """Use Gemini with Google Search grounding to get real NBA player prop lines."""
    today_str = datetime.now(timezone.utc).strftime("%B %d, %Y")

    _PROPS_JSON_SCHEMA = (
        '{"player":"Full Name","team":"ABBR","pos":"G","stat":"Points","line":27.5,'
        '"over_odds":"-115","under_odds":"+105","rec":"OVER","l5":80,"l10":70,'
        '"l15":65,"streak":3,"avg":28.2,"edge_score":4.2,"matchup":"LAL @ GSW",'
        '"reason":"Brief reason"}'
    )

    prompt = (
        f"Search for the top 50 NBA player props for {today_str}. "
        "Include at least one prop per game. "
        "Only standard over/under props: points, rebounds, assists, 3-pointers made, blocks, steals. "
        "No parlays, no first basket, no combined stats.\n\n"
        f"Schema per element:\n{_PROPS_JSON_SCHEMA}\n\n"
        "- over_odds/under_odds: American odds strings like \"-115\" or \"+105\"\n"
        "- l5/l10/l15: integer hit-rate % for OVER in last 5/10/15 games (0-100)\n"
        "- streak: consecutive games OVER the line (0 if none)\n"
        "- avg: player season average for this stat\n"
        "- edge_score: float 1.0-5.0 your confidence in this pick\n"
        "IMPORTANT: Output ONLY the JSON array. Start with [ and end with ]. "
        "No explanations, no preamble, no markdown fences."
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
            timeout=45,
        )
        data = resp.json()
        if "error" in data:
            logging.warning(f"Gemini props error: {data['error']['message']}")
            return []
        # Grounded responses may split across multiple parts — join all text parts
        parts = data["candidates"][0]["content"]["parts"]
        text = " ".join(p.get("text", "") for p in parts if "text" in p)
        props = _parse_gemini_props_json(text)
        if props:
            logging.info(f"Gemini search-grounded props: got {len(props)} props")
        else:
            logging.warning(f"Gemini search grounding returned no parseable props: {text[:300]}")
        return props
    except Exception as e:
        logging.warning(f"Gemini search-grounded props failed: {e}")
        return []


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

        # 1. Gemini first — rich stats (L5/L10/L15, streak, avg, edge_score)
        if GEMINI_API_KEY:
            espn_games = await fetch_espn_games(client)
            # Run Gemini + Odds API in parallel so we can cross-check odds
            gemini_task = asyncio.create_task(
                fetch_gemini_props(client, GEMINI_API_KEY, espn_games or [])
            )
            odds_task = asyncio.create_task(
                fetch_odds_api_player_props(client)
            ) if ODDS_API_KEY else None

            gemini_props = await gemini_task
            live_props = await odds_task if odds_task else []

            if gemini_props:
                # Build a lookup: (player_lower, stat_lower) -> live prop
                live_index: dict[tuple, dict] = {}
                for lp in live_props:
                    key = (lp["player"].lower(), lp["stat"].lower())
                    live_index[key] = lp

                # Cross-check: overwrite odds+line with live bookmaker data where available
                verified = 0
                for gp in gemini_props:
                    key = (gp["player"].lower(), gp["stat"].lower())
                    if key in live_index:
                        lp = live_index[key]
                        gp["over_odds"]  = lp["over_odds"]
                        gp["under_odds"] = lp["under_odds"]
                        gp["line"]       = lp["line"]
                        gp["prop"]       = lp["prop"]
                        # Update the recommended-side odds to match
                        gp["odds"] = gp["over_odds"] if gp["rec"] == "OVER" else gp["under_odds"]
                        verified += 1

                props  = gemini_props
                source = "gemini" if verified == 0 else f"gemini+odds({verified} verified)"

            elif live_props:
                # Gemini returned nothing — fall back to Odds API alone
                props  = live_props
                source = "odds_api"

        elif ODDS_API_KEY:
            # No Gemini key — use Odds API only
            props  = await fetch_odds_api_player_props(client)
            source = "odds_api" if props else "none"

        # 3. Last resort: PrizePicks
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

    async with httpx.AsyncClient() as client:
        espn_games, injuries = await asyncio.gather(
            fetch_espn_games(client, req.date),
            fetch_espn_injuries(client),
        )

    games_to_search = espn_games if espn_games else MOCK_GAMES
    game = next((g for g in games_to_search if g["id"] == req.game_id), None)
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")

    system_prompt = build_system_prompt(games_to_search, injuries)
    is_live  = game["status"] == "live"
    is_final = game["status"] == "final"

    if is_final:
        raise HTTPException(status_code=400, detail="Game is already over.")

    # Resolve odds: sticky cache (populated by get_games) → ESPN embedded → N/A
    # Strip date suffix so tomorrow game IDs (e.g. orl-phx-20260221) find cached odds
    base_game_id = re.sub(r'-\d{8}$', '', req.game_id)
    sticky = _sticky_odds.get(base_game_id) or _sticky_odds.get(req.game_id) or {}
    ou_line   = sticky.get("ou")       or game.get("espn_ou")       or "N/A"
    spread_ln = sticky.get("spread")   or game.get("espn_spread")   or "N/A"
    away_ml   = sticky.get("awayOdds") or game.get("espn_awayOdds") or "N/A"
    home_ml   = sticky.get("homeOdds") or game.get("espn_homeOdds") or "N/A"

    if is_live:
        prompt = (
            f"Live: {game['awayName']} {game.get('awayScore',0)} "
            f"@ {game['homeName']} {game.get('homeScore',0)} "
            f"(Q{game.get('quarter','?')} {game.get('clock','')}).\n"
            "Search for this game's player statistical over/under lines for tonight.\n"
            "Respond with EXACTLY these 5 labeled lines, no other text:\n"
            "BEST_BET: [team bet ONLY — moneyline or live spread, never a player prop. State the exact line and why right now]\n"
            f"OU_LEAN: [OVER or UNDER {ou_line} — project the final score with pace/foul situation/current scoring rate reasoning]\n"
            "PLAYER_PROP: [Use the actual current over/under line you found. Format: 'Player OVER/UNDER X.X Stat — 1 sentence reason']\n"
            "DUBL_SCORE_BET: [single float 1.0-5.0 — confidence in the Best Bet, where 5.0 = strongest edge]\n"
            "DUBL_SCORE_OU: [single float 1.0-5.0 — confidence in the O/U lean, where 5.0 = strongest edge]"
        )
    else:
        prompt = (
            f"Pre-game: {game['awayName']} ({away_ml}) @ {game['homeName']} ({home_ml}). "
            f"Spread: {spread_ln}. O/U: {ou_line}.\n"
            "Search for this game's player statistical over/under lines for tonight.\n"
            "Respond with EXACTLY these 5 labeled lines, no other text:\n"
            "BEST_BET: [team bet ONLY — ATS or ML, never a player prop. State the exact line and give 2 specific reasons: matchup edge, recent form, pace, injury impact, or schedule spot]\n"
            f"OU_LEAN: [OVER or UNDER {ou_line} — must cite at least one of: pace (pts/100 possessions), defensive rank, recent scoring trend, or injury to key scorer. 1-2 sentences]\n"
            "PLAYER_PROP: [Use the actual current over/under line you found. Format: 'Player OVER/UNDER X.X Stat — 1 sentence reason']\n"
            "DUBL_SCORE_BET: [single float 1.0-5.0 — confidence in the Best Bet, where 5.0 = strongest edge]\n"
            "DUBL_SCORE_OU: [single float 1.0-5.0 — confidence in the O/U lean, where 5.0 = strongest edge]"
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
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    return {"analysis": parse_gemini_analysis(text)}


@app.post("/api/chat")
async def chat(req: ChatRequest):
    key = get_effective_key(req.api_key)

    async with httpx.AsyncClient() as client:
        espn_games = await fetch_espn_games(client)
        injuries   = await fetch_espn_injuries(client)

    system_prompt = build_system_prompt(
        espn_games if espn_games else MOCK_GAMES,
        injuries,
    )

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
    return {
        "status": "ok",
        "has_server_key": bool(GEMINI_API_KEY),
        "has_odds_key": bool(ODDS_API_KEY),
    }


USER_STATIC_DIR = pathlib.Path(__file__).parent / "user_static"
USER_STATIC_DIR.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=USER_STATIC_DIR), name="user_static")

STATIC_DIR = pathlib.Path(__file__).parent / "static"
if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        return FileResponse(str(STATIC_DIR / "index.html"))
