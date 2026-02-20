from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import httpx
import os
import pathlib
import time
import asyncio
from typing import Optional

app = FastAPI(title="dublplay API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
ODDS_API_KEY   = os.getenv("ODDS_API_KEY", "")

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
}


def norm_abbr(raw: str) -> str:
    return TEAM_ABBR_MAP.get(raw.upper(), raw.upper())


async def fetch_espn_games(client: httpx.AsyncClient) -> list[dict]:
    """Fetch today's NBA games from ESPN unofficial scoreboard API."""
    cached = cache_get("espn_games")
    if cached is not None:
        return cached

    try:
        r = await client.get(ESPN_SCOREBOARD_URL, timeout=10)
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
                g["time"] = event.get("date", "")[:16].replace("T", " ") + " UTC"

            games.append(g)
        except Exception:
            continue

    cache_set("espn_games", games)
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


async def fetch_odds(client: httpx.AsyncClient) -> dict:
    """
    Fetch NBA odds from The Odds API.
    Returns dict keyed by rough game id -> {spread, ou, homeOdds, awayOdds}.
    Requires ODDS_API_KEY env var.
    """
    if not ODDS_API_KEY:
        return {}

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
        return {}

    result = {}
    for ev in events:
        if not isinstance(ev, dict):
            continue
        home = norm_abbr(ev.get("home_team", "")[:3].upper())
        away = norm_abbr(ev.get("away_team", "")[:3].upper())
        key  = f"{away.lower()}-{home.lower()}"

        odds_data: dict = {}
        for bm in ev.get("bookmakers", []):
            if bm["key"] not in ("draftkings", "fanduel", "betmgm"):
                continue
            for market in bm.get("markets", []):
                mk = market["key"]
                outcomes = {o["name"]: o["price"] for o in market.get("outcomes", [])}
                if mk == "h2h":
                    odds_data["homeOdds"] = _fmt_american(outcomes.get(ev.get("home_team", ""), 0))
                    odds_data["awayOdds"] = _fmt_american(outcomes.get(ev.get("away_team", ""), 0))
                elif mk == "spreads":
                    for o in market.get("outcomes", []):
                        if norm_abbr(o["name"][:3].upper()) == home:
                            odds_data["spread"] = f"{home} {_sign(o['point'])}"
                elif mk == "totals":
                    for o in market.get("outcomes", []):
                        if o["name"] == "Over":
                            odds_data["ou"] = str(o["point"])
            break  # first matching bookmaker is enough

        if odds_data:
            result[key] = odds_data

    cache_set("odds", result)
    return result


async def fetch_draftkings_props(client: httpx.AsyncClient) -> list[dict]:
    """
    Fetch NBA player props from DraftKings public sportsbook JSON endpoint.
    No API key required. DraftKings automatically removes lines for
    scratched/injured players, so OUT players simply won't appear.
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

    props_out: list[dict] = []

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

    for event in event_group.get("events", [])[:10]:
        event_id   = event.get("eventId")
        team1      = event.get("teamName1", "")
        team2      = event.get("teamName2", "")
        matchup    = f"{team1} vs {team2}"

        # Collect category + subcategory IDs that look like player props
        prop_subs = []
        for cat in event.get("offerCategories", []):
            cat_name = cat.get("name", "").lower()
            if "player" not in cat_name and "prop" not in cat_name:
                continue
            cat_id = cat.get("offerCategoryId")
            for sub in cat.get("offerSubcategoryDescriptors", []):
                sub_id   = sub.get("offerSubcategoryId")
                sub_name = sub.get("name", "").lower()
                # Map subcategory name to prop type
                prop_type = None
                for kw, label in PROP_KEYWORDS.items():
                    if kw in sub_name:
                        prop_type = label
                        break
                if prop_type and sub_id:
                    prop_subs.append((cat_id, sub_id, prop_type))

        for cat_id, sub_id, prop_type in prop_subs:
            try:
                r2 = await client.get(
                    f"https://sportsbook.draftkings.com//sites/US-SB/api/v5/events/{event_id}"
                    f"/categories/{cat_id}/subcategories/{sub_id}",
                    params={"format": "json"},
                    headers={"User-Agent": "Mozilla/5.0 (compatible)"},
                    timeout=10,
                )
                sub_data = r2.json()
            except Exception:
                continue

            # Parse the nested offers structure
            for offer_cat in sub_data.get("eventGroup", {}).get("offerCategories", []):
                for sub_desc in offer_cat.get("offerSubcategoryDescriptors", []):
                    for offer_row in sub_desc.get("offers", []):
                        for offer in (offer_row if isinstance(offer_row, list) else [offer_row]):
                            outcomes = offer.get("outcomes", [])
                            if len(outcomes) < 2:
                                continue
                            player_name = outcomes[0].get("participant") or outcomes[0].get("label", "")
                            if not player_name:
                                continue

                            over_out  = next((o for o in outcomes if o.get("label","").lower() == "over"),  None)
                            under_out = next((o for o in outcomes if o.get("label","").lower() == "under"), None)
                            if not over_out and not under_out:
                                continue

                            line = (over_out or under_out).get("line", 0)
                            over_odds  = _fmt_american(over_out.get("oddsAmerican")  if over_out  else None)
                            under_odds = _fmt_american(under_out.get("oddsAmerican") if under_out else None)

                            # Pick better side by smaller absolute odds (closer to even)
                            rec = "OVER"
                            if over_out and under_out:
                                ov = abs(int(over_out.get("oddsAmerican", -9999) or -9999))
                                un = abs(int(under_out.get("oddsAmerican", -9999) or -9999))
                                rec = "OVER" if ov <= un else "UNDER"
                            elif under_out:
                                rec = "UNDER"

                            props_out.append({
                                "player":     player_name,
                                "team":       "—",
                                "pos":        "—",
                                "game":       matchup,
                                "prop":       f"{prop_type} {line}+",
                                "rec":        rec,
                                "line":       line,
                                "conf":       60,
                                "edge_score": 60,
                                "l5": 60, "l10": 55, "l15": 50,
                                "streak":     0,
                                "avg":        line,
                                "odds":       over_odds if rec == "OVER" else under_odds,
                                "reason":     f"Live DraftKings line · {matchup}",
                            })

    cache_set("dk_props", props_out)
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
        "You are a sharp NBA betting analyst.\n"
        f"LIVE: {live_str}\n"
        f"TONIGHT: {up_str}\n"
        f"{injury_note}\n"
        "Give sharp, direct betting analysis. Use betting terminology (ATS, ML, O/U, value).\n"
        "Be concise. Note entertainment-only disclaimer briefly at end."
    )


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

MOCK_PROPS = [
    {
        "player": "Paolo Banchero", "team": "ORL", "pos": "F", "game": "SAC vs ORL",
        "prop": "Points 24.5+", "rec": "OVER", "line": 24.5, "conf": 74, "edge_score": 85,
        "l5": 80, "l10": 70, "l15": 67, "streak": 4, "avg": 26.8, "odds": "-118",
        "reason": "28+ pts in 4 of last 5. SAC defense ranks 29th overall.",
    },
    {
        "player": "Jaylen Brown", "team": "BOS", "pos": "F", "game": "GSW vs BOS",
        "prop": "Points 30.5+", "rec": "OVER", "line": 30.5, "conf": 70, "edge_score": 79,
        "l5": 60, "l10": 60, "l15": 53, "streak": 0, "avg": 27.4, "odds": "-110",
        "reason": "Tatum OUT — Brown becomes the #1 option with full usage bump.",
    },
    {
        "player": "Nikola Jokić", "team": "DEN", "pos": "C", "game": "LAC vs DEN",
        "prop": "Rebounds 12.5+", "rec": "OVER", "line": 12.5, "conf": 68, "edge_score": 74,
        "l5": 80, "l10": 70, "l15": 60, "streak": 4, "avg": 13.4, "odds": "-130",
        "reason": "Double-doubles in 8 straight. LAC ranks 28th in reb defense.",
    },
    {
        "player": "Alperen Şengün", "team": "HOU", "pos": "C", "game": "Recent Form",
        "prop": "Pts+Reb+Ast 38.5+", "rec": "OVER", "line": 38.5, "conf": 65, "edge_score": 69,
        "l5": 60, "l10": 60, "l15": 53, "streak": 2, "avg": 40.1, "odds": "-110",
        "reason": "Triple-double threat in 3 of last 4. Massive usage rate at center.",
    },
    {
        "player": "Stephen Curry", "team": "GSW", "pos": "G", "game": "GSW vs BOS",
        "prop": "3PM 4.5", "rec": "UNDER", "line": 4.5, "conf": 61, "edge_score": 63,
        "l5": 60, "l10": 50, "l15": 47, "streak": 2, "avg": 3.8, "odds": "+105",
        "reason": "BOS limits 3PA aggressively. Curry shooting 37% from 3 in February.",
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

@app.get("/api/games")
async def get_games():
    async with httpx.AsyncClient() as client:
        espn_games = await fetch_espn_games(client)
        odds_map   = await fetch_odds(client)

    if not espn_games:
        # Fall back to mock data if ESPN is unreachable
        return {"games": MOCK_GAMES, "source": "mock"}

    # Merge odds into ESPN game data
    result = []
    for g in espn_games:
        gid = g["id"]
        o   = odds_map.get(gid, {})

        # Win probs — derive from moneyline if available
        home_prob = away_prob = 50.0
        if o.get("homeOdds") and o.get("awayOdds"):
            try:
                hd = american_to_decimal(o["homeOdds"])
                ad = american_to_decimal(o["awayOdds"])
                total = (1/hd) + (1/ad)
                home_prob = round((1/hd) / total * 100, 1)
                away_prob = round((1/ad) / total * 100, 1)
            except Exception:
                pass

        result.append({
            **g,
            "homeWinProb": home_prob,
            "awayWinProb": away_prob,
            "homeOdds": o.get("homeOdds"),
            "awayOdds": o.get("awayOdds"),
            "spread": o.get("spread"),
            "ou": o.get("ou"),
            "ouDir": None,
            "analysis": {
                "best_bet": "Click REFRESH ↺ for a live Gemini analysis.",
                "ou": None,
                "props": None,
            },
        })

    return {"games": result, "source": "live"}


@app.get("/api/props")
async def get_props():
    async with httpx.AsyncClient() as client:
        # Run injury fetch + DraftKings props in parallel
        injuries, dk_props = await asyncio.gather(
            fetch_espn_injuries(client),
            fetch_draftkings_props(client),
            return_exceptions=True,
        )
    if isinstance(injuries, Exception):
        injuries = set()
    if isinstance(dk_props, Exception):
        dk_props = []

    if dk_props:
        # DraftKings already removes injured players' lines automatically,
        # but we double-filter with ESPN injuries as a safety net
        filtered = [
            p for p in dk_props
            if p["player"].lower() not in injuries
        ]
        return {"props": filtered, "source": "draftkings", "injured_out": sorted(injuries)}

    # Fall back to mock props, filtered by ESPN injuries
    filtered_mock = [
        p for p in MOCK_PROPS
        if p["player"].lower() not in injuries
    ]
    return {"props": filtered_mock, "source": "mock", "injured_out": sorted(injuries)}


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
        espn_games = await fetch_espn_games(client)
        injuries   = await fetch_espn_injuries(client)

    games_to_search = espn_games if espn_games else MOCK_GAMES
    game = next((g for g in games_to_search if g["id"] == req.game_id), None)
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")

    system_prompt = build_system_prompt(games_to_search, injuries)
    is_live  = game["status"] == "live"
    is_final = game["status"] == "final"

    if is_final:
        raise HTTPException(status_code=400, detail="Game is already over.")

    if is_live:
        prompt = (
            f"Live betting: {game['awayName']} {game.get('awayScore',0)} "
            f"@ {game['homeName']} {game.get('homeScore',0)} "
            f"(Q{game.get('quarter','?')} {game.get('clock','')}).\n"
            f"Give: (1) Best live bet (2) Total lean (3) Player to target. Sharp and brief."
        )
    else:
        prompt = (
            f"Pre-game betting analysis: {game['awayName']} @ {game['homeName']}.\n"
            f"Spread: {game.get('spread','N/A')}. O/U: {game.get('ou','N/A')}. "
            f"ML: {game.get('awayOdds','N/A')} / {game.get('homeOdds','N/A')}.\n"
            f"Give: (1) Best bet (2) O/U lean (3) Top player prop. 4-5 sentences total."
        )

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{GEMINI_URL}?key={key}",
            json={
                "system_instruction": {"parts": [{"text": system_prompt}]},
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {"maxOutputTokens": 350, "temperature": 0.75},
            },
            timeout=30,
        )
    data = resp.json()
    if "error" in data:
        raise HTTPException(status_code=400, detail=data["error"]["message"])
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    return {"analysis": text}


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
