from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import httpx
import os
import re
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


async def fetch_draftkings_props(client: httpx.AsyncClient) -> list[dict]:
    """
    Fetch NBA player props from DraftKings public sportsbook JSON endpoint.
    Strategy:
      1. Parse inline offers from the eventgroup (same structure as game lines).
      2. If a prop subcategory has no inline offers, fetch it separately and try
         both known DK response structures.
    No API key required.
    """
    cached = cache_get("dk_props")
    if cached is not None:
        return cached

    PROP_KEYWORDS = {
        "points": "Points", "point": "Points",
        "rebounds": "Rebounds", "rebound": "Rebounds",
        "assists": "Assists", "assist": "Assists",
        "threes": "3PM", "3-pointers": "3PM", "three": "3PM",
        "blocks": "Blocks", "steals": "Steals",
        "pts + reb + ast": "PRA", "pra": "PRA",
    }

    try:
        r = await client.get(
            "https://sportsbook.draftkings.com//sites/US-SB/api/v5/eventgroups/42648",
            params={"format": "json"},
            headers={"User-Agent": "Mozilla/5.0 (compatible)"},
            timeout=15,
        )
        data = r.json()
    except Exception:
        return []

    event_group = data.get("eventGroup", {})
    props_out: list[dict] = []

    def _parse_offers(offers_list: list, prop_type: str, matchup: str) -> list[dict]:
        """Parse a list of offer rows into standardised prop dicts."""
        results = []
        for offer_row in offers_list:
            for offer in (offer_row if isinstance(offer_row, list) else [offer_row]):
                outcomes = offer.get("outcomes", [])
                if len(outcomes) < 2:
                    continue
                player_name = outcomes[0].get("participant") or outcomes[0].get("label", "")
                if not player_name or player_name.lower() in ("over", "under"):
                    continue
                over_out  = next((o for o in outcomes if o.get("label", "").lower() == "over"),  None)
                under_out = next((o for o in outcomes if o.get("label", "").lower() == "under"), None)
                if not over_out and not under_out:
                    continue
                line = (over_out or under_out).get("line", 0)
                over_odds  = _fmt_american(over_out.get("oddsAmerican")  if over_out  else None)
                under_odds = _fmt_american(under_out.get("oddsAmerican") if under_out else None)
                rec = "OVER"
                if over_out and under_out:
                    ov = abs(int(over_out.get("oddsAmerican", -9999) or -9999))
                    un = abs(int(under_out.get("oddsAmerican", -9999) or -9999))
                    rec = "OVER" if ov <= un else "UNDER"
                elif under_out:
                    rec = "UNDER"
                results.append({
                    "player": player_name, "team": "—", "pos": "—", "game": matchup,
                    "prop": f"{prop_type} {line}+", "rec": rec, "line": line,
                    "conf": 60, "edge_score": 60, "l5": 60, "l10": 55, "l15": 50,
                    "streak": 0, "avg": line,
                    "odds": over_odds if rec == "OVER" else under_odds,
                    "reason": f"Live DraftKings line · {matchup}",
                })
        return results

    def _walk_offer_categories(eg: dict, prop_type: str, matchup: str) -> list[dict]:
        """Walk both known DK response structures to find offers."""
        found = []
        # Structure A: eventGroup.offerCategories[].offerSubcategoryDescriptors[].offers
        for oc in eg.get("offerCategories", []):
            for sd in oc.get("offerSubcategoryDescriptors", []):
                found.extend(_parse_offers(sd.get("offers", []), prop_type, matchup))
        # Structure B: eventGroup.events[].offerCategories[].offerSubcategoryDescriptors[].offers
        for ev in eg.get("events", []):
            for oc in ev.get("offerCategories", []):
                for sd in oc.get("offerSubcategoryDescriptors", []):
                    found.extend(_parse_offers(sd.get("offers", []), prop_type, matchup))
        return found

    for event in event_group.get("events", [])[:10]:
        event_id = event.get("eventId")
        matchup  = f"{event.get('teamName1', '')} vs {event.get('teamName2', '')}"
        needs_fetch: list[tuple] = []  # (cat_id, sub_id, prop_type) with no inline offers

        for cat in event.get("offerCategories", []):
            cat_name = cat.get("name", "").lower()
            if "player" not in cat_name and "prop" not in cat_name:
                continue
            cat_id = cat.get("offerCategoryId")

            for sub in cat.get("offerSubcategoryDescriptors", []):
                sub_name  = sub.get("name", "").lower()
                sub_id    = sub.get("offerSubcategoryId")
                prop_type = next((label for kw, label in PROP_KEYWORDS.items() if kw in sub_name), None)
                if not prop_type:
                    continue

                inline_offers = sub.get("offers", [])
                if inline_offers:
                    # Offers are embedded inline in the eventgroup — parse directly
                    props_out.extend(_parse_offers(inline_offers, prop_type, matchup))
                elif sub_id and cat_id and event_id:
                    needs_fetch.append((cat_id, sub_id, prop_type))

        # Fetch subcategories that had no inline data (cap at 6 per event)
        for cat_id, sub_id, prop_type in needs_fetch[:6]:
            try:
                r2 = await client.get(
                    f"https://sportsbook.draftkings.com//sites/US-SB/api/v5/events/{event_id}"
                    f"/categories/{cat_id}/subcategories/{sub_id}",
                    params={"format": "json"},
                    headers={"User-Agent": "Mozilla/5.0 (compatible)"},
                    timeout=10,
                )
                sub_data = r2.json()
                eg = sub_data.get("eventGroup", {})
                props_out.extend(_walk_offer_categories(eg, prop_type, matchup))
            except Exception:
                continue

    cache_set("dk_props", props_out)
    return props_out


# ── STAR PLAYER PROP LINES (fallback when DK unavailable) ─────────────────────
# Approximate 2024-25 season lines used to show real game matchups when DK fails
TEAM_STAR_PROPS: dict[str, list[tuple]] = {
    "BOS": [("Jaylen Brown", "Points", 23.5, "-112"), ("Jayson Tatum", "Points", 27.5, "-110")],
    "NYK": [("Jalen Brunson", "Points", 25.5, "-115"), ("Karl-Anthony Towns", "Points", 21.5, "-110")],
    "MIL": [("Giannis Antetokounmpo", "Points", 29.5, "-118"), ("Damian Lillard", "Points", 24.5, "-112")],
    "CLE": [("Donovan Mitchell", "Points", 24.5, "-115"), ("Evan Mobley", "Rebounds", 8.5, "-115")],
    "IND": [("Tyrese Haliburton", "Assists", 9.5, "-112"), ("Pascal Siakam", "Points", 21.5, "-110")],
    "ORL": [("Paolo Banchero", "Points", 24.5, "-112"), ("Franz Wagner", "Points", 20.5, "-110")],
    "MIA": [("Tyler Herro", "Points", 21.5, "-112"), ("Bam Adebayo", "Rebounds", 9.5, "-115")],
    "CHI": [("Zach LaVine", "Points", 22.5, "-110"), ("Nikola Vucevic", "Rebounds", 10.5, "-112")],
    "ATL": [("Trae Young", "Assists", 10.5, "-115"), ("Jalen Johnson", "Points", 20.5, "-110")],
    "TOR": [("Scottie Barnes", "Points", 18.5, "-110"), ("Immanuel Quickley", "Assists", 6.5, "-108")],
    "DET": [("Cade Cunningham", "Points", 23.5, "-112"), ("Cade Cunningham", "Assists", 6.5, "-110")],
    "CHA": [("LaMelo Ball", "Points", 23.5, "-112"), ("LaMelo Ball", "Assists", 6.5, "-112")],
    "PHI": [("Tyrese Maxey", "Points", 25.5, "-112"), ("Joel Embiid", "Rebounds", 10.5, "-115")],
    "BKN": [("Cam Thomas", "Points", 22.5, "-110"), ("Nic Claxton", "Rebounds", 9.5, "-110")],
    "WAS": [("Kyle Kuzma", "Points", 18.5, "-110"), ("Jordan Poole", "Points", 18.5, "-110")],
    "OKC": [("Shai Gilgeous-Alexander", "Points", 29.5, "-115"), ("Jalen Williams", "Points", 22.5, "-112")],
    "DEN": [("Nikola Jokic", "Points", 27.5, "-115"), ("Nikola Jokic", "Rebounds", 11.5, "-118")],
    "MIN": [("Anthony Edwards", "Points", 26.5, "-112"), ("Rudy Gobert", "Rebounds", 11.5, "-115")],
    "UTA": [("Lauri Markkanen", "Points", 21.5, "-112"), ("Walker Kessler", "Rebounds", 10.5, "-115")],
    "POR": [("Anfernee Simons", "Points", 20.5, "-110"), ("Jerami Grant", "Points", 18.5, "-110")],
    "SAC": [("De'Aaron Fox", "Points", 25.5, "-112"), ("Domantas Sabonis", "Rebounds", 12.5, "-118")],
    "GSW": [("Stephen Curry", "Points", 28.5, "-115"), ("Stephen Curry", "3PM", 3.5, "-115")],
    "LAL": [("LeBron James", "Points", 24.5, "-110"), ("Anthony Davis", "Rebounds", 11.5, "-115")],
    "LAC": [("James Harden", "Assists", 8.5, "-115"), ("Kawhi Leonard", "Points", 22.5, "-112")],
    "PHX": [("Devin Booker", "Points", 26.5, "-115"), ("Kevin Durant", "Points", 27.5, "-112")],
    "NOP": [("Brandon Ingram", "Points", 23.5, "-112"), ("CJ McCollum", "Points", 19.5, "-110")],
    "DAL": [("Luka Doncic", "Points", 32.5, "-115"), ("Kyrie Irving", "Points", 24.5, "-112")],
    "HOU": [("Alperen Sengun", "Points", 19.5, "-112"), ("Jalen Green", "Points", 22.5, "-112")],
    "MEM": [("Ja Morant", "Points", 24.5, "-112"), ("Desmond Bane", "Points", 19.5, "-110")],
    "SAS": [("Victor Wembanyama", "Points", 23.5, "-112"), ("Victor Wembanyama", "Rebounds", 9.5, "-115")],
}


def generate_game_props(games: list) -> list[dict]:
    """
    Generate estimated props from today's actual ESPN game data.
    Used as a fallback when DraftKings API is unavailable so the Props tab
    always shows real game matchups instead of stale mock data.
    """
    props_out = []
    for game in games:
        if game.get("status") == "final":
            continue
        away = game.get("away", "")
        home = game.get("home", "")
        matchup = f"{game.get('awayName', away)} vs {game.get('homeName', home)}"
        for abbr in [away, home]:
            for player, stat, line, odds in TEAM_STAR_PROPS.get(abbr, [])[:1]:
                props_out.append({
                    "player": player, "team": abbr, "pos": "—", "game": matchup,
                    "prop": f"{stat} {line}+", "rec": "OVER", "line": line,
                    "conf": 60, "edge_score": 65, "l5": 60, "l10": 57, "l15": 53,
                    "streak": 0, "avg": line, "odds": odds,
                    "reason": f"Estimated line — live DraftKings data unavailable · {matchup}",
                })
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
        "key injuries, rest advantages, or defensive rankings. "
        "For player props, always name a real starter with a realistic line and a stats-based reason.\n"
        f"LIVE GAMES: {live_str}\n"
        f"TONIGHT: {up_str}\n"
        f"{injury_note}\n"
        "Respond with EXACTLY the three labeled lines requested. No preamble, no disclaimer, no extra text."
    )


def parse_gemini_analysis(text: str) -> dict:
    """Parse structured Gemini response into best_bet / ou / props."""
    def extract(marker: str) -> str | None:
        m = re.search(
            rf'{marker}:\s*(.*?)(?=BEST_BET:|OU_LEAN:|PLAYER_PROP:|$)',
            text, re.DOTALL | re.IGNORECASE,
        )
        if not m:
            return None
        return m.group(1).strip().replace("**", "").strip() or None

    return {
        "best_bet": extract("BEST_BET"),
        "ou":       extract("OU_LEAN"),
        "props":    extract("PLAYER_PROP"),
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


@app.get("/api/props")
async def get_props():
    async with httpx.AsyncClient() as client:
        injuries, dk_props, espn_games = await asyncio.gather(
            fetch_espn_injuries(client),
            fetch_draftkings_props(client),
            fetch_espn_games(client),
            return_exceptions=True,
        )
    if isinstance(injuries, Exception):
        injuries = set()
    if isinstance(dk_props, Exception):
        dk_props = []
    if isinstance(espn_games, Exception):
        espn_games = []

    if dk_props:
        # DraftKings already removes injured players' lines automatically,
        # but we double-filter with ESPN injuries as a safety net
        filtered = [p for p in dk_props if p["player"].lower() not in injuries]
        return {"props": filtered, "source": "draftkings", "injured_out": sorted(injuries)}

    # Fall back to estimated props based on today's REAL game matchups
    # (never show stale mock data with wrong game names)
    game_props = generate_game_props(espn_games) if espn_games else []
    filtered = [p for p in game_props if p["player"].lower() not in injuries]
    return {"props": filtered, "source": "estimated", "injured_out": sorted(injuries)}


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
            "Respond with EXACTLY these 3 labeled lines, no other text:\n"
            "BEST_BET: [specific live bet — team, current line if known, sharp reason why right now]\n"
            f"OU_LEAN: [OVER or UNDER {ou_line} — project the final score with pace/foul situation/current scoring rate reasoning]\n"
            "PLAYER_PROP: [REQUIRED — format EXACTLY like: 'Ja Morant OVER 24.5 Points' — real player in this game, realistic line, 1 sentence reason. Writing N/A is not allowed.]"
        )
    else:
        prompt = (
            f"Pre-game: {game['awayName']} ({away_ml}) @ {game['homeName']} ({home_ml}). "
            f"Spread: {spread_ln}. O/U: {ou_line}.\n"
            "Respond with EXACTLY these 3 labeled lines, no other text:\n"
            "BEST_BET: [your top pick ATS or ML — state the exact line, give 2 specific reasons: matchup edge, recent form, pace, injury impact, or schedule spot]\n"
            f"OU_LEAN: [OVER or UNDER {ou_line} — must cite at least one of: pace (pts/100 possessions), defensive rank, recent scoring trend, or injury to key scorer. 1-2 sentences]\n"
            "PLAYER_PROP: [REQUIRED — format EXACTLY like: 'Anthony Edwards OVER 27.5 Points' — must be a real starter in this game, a realistic line, and 1 sentence with a stats-based reason. Writing N/A is never acceptable.]"
        )

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{GEMINI_URL}?key={key}",
            json={
                "system_instruction": {"parts": [{"text": system_prompt}]},
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {"maxOutputTokens": 500, "temperature": 0.7},
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


STATIC_DIR = pathlib.Path(__file__).parent / "static"
if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        return FileResponse(str(STATIC_DIR / "index.html"))
