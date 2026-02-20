from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import httpx
import os
import pathlib

app = FastAPI(title="NBA Edge API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"

SYSTEM_PROMPT = """You are a sharp NBA betting analyst. Today is Feb 19, 2026.
LIVE: DET leads NYK 104-88 (Q4 7:21), TOR leads CHI 74-64 (Q3 5:09), SAS leads PHX 61-49 (Half).
TONIGHT: BOS@GSW (BOS -175, 67.8% win), ORL@SAC (ORL -255, 76.1%), DEN@LAC (DEN -125, 62.4%).
LEADERS: West – OKC 42-14, SAS 38-16, DEN 35-20. East – DET 40-13, BOS 35-19, NYK 35-20.
Give sharp, direct betting analysis. Use betting terminology (ATS, ML, O/U, value, etc.).
Be concise. Always note entertainment-only disclaimer briefly at end."""

GAMES = [
    {
        "id": "nyk-det",
        "status": "live",
        "quarter": 4,
        "clock": "7:21",
        "home": "NYK", "away": "DET",
        "homeName": "Knicks", "awayName": "Pistons",
        "homeScore": 88, "awayScore": 104,
        "homeWinProb": 18, "awayWinProb": 82,
        # Live moneylines & total
        "homeOdds": "+480", "awayOdds": "-700",
        "ou": "202.5", "ouDir": "OVER",
        "spread": "DET -16.5",
        "analysis": {
            "best_bet": "DET ML (-700) — only for those already in. Live cover at -16.5 is where the value is. Pistons have dominated every quarter.",
            "ou": "OVER 202.5 — both teams are still pushing. Currently at 192 combined, averaging 24+ pts per remaining Q4 minute.",
            "props": "Cade Cunningham has 28 pts, 7 ast with 7:21 left. Hammering his points OVER for any remaining live props."
        },
    },
    {
        "id": "chi-tor",
        "status": "live",
        "quarter": 3,
        "clock": "5:09",
        "home": "CHI", "away": "TOR",
        "homeName": "Bulls", "awayName": "Raptors",
        "homeScore": 64, "awayScore": 74,
        "homeWinProb": 28, "awayWinProb": 72,
        "homeOdds": "+280", "awayOdds": "-380",
        "ou": "218.5", "ouDir": "UNDER",
        "spread": "TOR -10.5",
        "analysis": {
            "best_bet": "TOR ML or -10.5 spread. Raptors have a 10-point lead in Q3 with Scottie Barnes controlling the game.",
            "ou": "UNDER 218.5 — Both defenses tightened in Q3. Only 138 pts with ~17 mins left. Pace suggests landing under 220.",
            "props": "Scottie Barnes 25+ pts is live. He has 19 in Q3 and Toronto keeps running plays through him."
        },
    },
    {
        "id": "sas-phx",
        "status": "live",
        "quarter": 2,
        "clock": "Halftime",
        "home": "SAS", "away": "PHX",
        "homeName": "Spurs", "awayName": "Suns",
        "homeScore": 61, "awayScore": 49,
        "homeWinProb": 67, "awayWinProb": 33,
        "homeOdds": "-230", "awayOdds": "+185",
        "ou": "228.5", "ouDir": "OVER",
        "spread": "SAS -12.5",
        "analysis": {
            "best_bet": "SAS ML at -230 has value given Wembanyama's dominant first half (22 pts, 9 reb). Spurs are running PHX off the floor.",
            "ou": "OVER 228.5 — 110 combined at half. SAS offense is clicking at 61 pts, second half should open up.",
            "props": "Victor Wembanyama 30+ pts live is in play. He has 22 with a full second half ahead against a depleted PHX defense."
        },
    },
    {
        "id": "cle-bkn",
        "status": "final",
        "home": "CLE", "away": "BKN",
        "homeName": "Cavaliers", "awayName": "Nets",
        "homeScore": 112, "awayScore": 84,
        "homeWinProb": 100, "awayWinProb": 0,
        "homeOdds": None, "awayOdds": None,
        "ou": None, "spread": None,
        "analysis": {
            "best_bet": "CLE covered easily as -9 favorites. Mobley & Mitchell combined for 58 pts.",
            "ou": "Final 196 — went UNDER 214.5 total. BKN's offense completely shut down in the second half.",
            "props": "Donovan Mitchell scored 31. Anyone who had his points OVER 27.5 cashed comfortably."
        },
    },
    {
        "id": "cha-hou",
        "status": "final",
        "home": "CHA", "away": "HOU",
        "homeName": "Hornets", "awayName": "Rockets",
        "homeScore": 101, "awayScore": 105,
        "homeWinProb": 0, "awayWinProb": 100,
        "homeOdds": None, "awayOdds": None,
        "ou": None, "spread": None,
        "analysis": {
            "best_bet": "HOU ML cashed. Rockets won outright as slight road favorites (-130). Şengün delivered the game-winner.",
            "ou": "Final 206 — went UNDER 214 total. Low-scoring fourth quarter kept it just under.",
            "props": "Alperen Şengün: 24 pts, 14 reb, 6 ast. His PRA OVER 38.5 hit with room to spare."
        },
    },
    {
        "id": "lal-dal",
        "status": "final",
        "home": "LAL", "away": "DAL",
        "homeName": "Lakers", "awayName": "Mavericks",
        "homeScore": 124, "awayScore": 104,
        "homeWinProb": 100, "awayWinProb": 0,
        "homeOdds": None, "awayOdds": None,
        "ou": None, "spread": None,
        "analysis": {
            "best_bet": "LAL blowout — covered -7 by +13. LeBron's triple-double sealed it.",
            "ou": "OVER 224.5 cashed — 228 combined. Lakers' up-tempo pace in the second half did it.",
            "props": "LeBron James: 28 pts, 12 reb, 11 ast. Triple-double OVER props were the play of the night."
        },
    },
    {
        "id": "gsw-bos",
        "status": "upcoming",
        "home": "GSW", "away": "BOS",
        "homeName": "Warriors", "awayName": "Celtics",
        "time": "7:00 PM PT",
        "homeWinProb": 32.2, "awayWinProb": 67.8,
        "homeOdds": "+148", "awayOdds": "-175",
        "spread": "BOS -5.5", "ou": "224.5",
        "analysis": {
            "best_bet": "BOS -5.5 ATS — Celtics are 8-2 ATS on the road this season. GSW ranks 24th in defensive efficiency. Tatum likely goes off.",
            "ou": "LEAN OVER 224.5 — Warriors play at a top-5 pace, Celtics have the firepower. Both teams averaging 118+ PPG in Feb.",
            "props": "Jayson Tatum OVER 27.5 pts (-115) is the top prop. He's averaging 31.2 in last 5 road games and GSW gives up 118+ at home."
        },
    },
    {
        "id": "sac-orl",
        "status": "upcoming",
        "home": "SAC", "away": "ORL",
        "homeName": "Kings", "awayName": "Magic",
        "time": "7:00 PM PT",
        "homeWinProb": 23.9, "awayWinProb": 76.1,
        "homeOdds": "+210", "awayOdds": "-255",
        "spread": "ORL -7", "ou": "215.0",
        "analysis": {
            "best_bet": "ORL ML (-255) — Magic are the 2nd-best team by net rating. Banchero is a mismatch nightmare for SAC who ranks 29th in defense.",
            "ou": "LEAN UNDER 215 — Orlando plays elite team defense (4th in points allowed). Kings without key bench pieces tonight.",
            "props": "Paolo Banchero OVER 24.5 pts (-118) — has 28+ in 4 of last 5 games, and SAC has no answer for him at the 4."
        },
    },
    {
        "id": "lac-den",
        "status": "upcoming",
        "home": "LAC", "away": "DEN",
        "homeName": "Clippers", "awayName": "Nuggets",
        "time": "7:30 PM PT",
        "homeWinProb": 37.6, "awayWinProb": 62.4,
        "homeOdds": "+105", "awayOdds": "-125",
        "spread": "DEN -3", "ou": "221.5",
        "analysis": {
            "best_bet": "DEN -3 ATS — Nuggets are 7-1-1 ATS as road favorites this season. Jokić in a must-win stretch for playoff seeding.",
            "ou": "OVER 221.5 — Jokić demands double teams and opens up shooters. LAC allows 117+ PPG at home, DEN scores 118+.",
            "props": "Nikola Jokić OVER 12.5 reb (-130) — double-doubles in 8 straight, and LAC ranks 28th in reb defense. Hammer it."
        },
    },
]

STANDINGS = {
    "East": [
        {"abbr":"DET","team":"Detroit Pistons","w":40,"l":13,"pct":".755","streak":"W3","gb":"-"},
        {"abbr":"BOS","team":"Boston Celtics","w":35,"l":19,"pct":".648","streak":"W2","gb":"5.5"},
        {"abbr":"NYK","team":"New York Knicks","w":35,"l":20,"pct":".636","streak":"L1","gb":"6.0"},
        {"abbr":"CLE","team":"Cleveland Cavaliers","w":35,"l":21,"pct":".625","streak":"W4","gb":"6.5"},
        {"abbr":"TOR","team":"Toronto Raptors","w":32,"l":23,"pct":".582","streak":"W1","gb":"9.5"},
        {"abbr":"PHI","team":"Philadelphia 76ers","w":30,"l":25,"pct":".545","streak":"L2","gb":"12.0"},
        {"abbr":"ORL","team":"Orlando Magic","w":28,"l":25,"pct":".528","streak":"W5","gb":"13.0"},
        {"abbr":"MIA","team":"Miami Heat","w":29,"l":27,"pct":".518","streak":"L1","gb":"13.5"},
    ],
    "West": [
        {"abbr":"OKC","team":"OKC Thunder","w":42,"l":14,"pct":".750","streak":"W6","gb":"-"},
        {"abbr":"SAS","team":"San Antonio Spurs","w":38,"l":16,"pct":".704","streak":"W3","gb":"3.0"},
        {"abbr":"DEN","team":"Denver Nuggets","w":35,"l":20,"pct":".636","streak":"W2","gb":"6.5"},
        {"abbr":"HOU","team":"Houston Rockets","w":34,"l":20,"pct":".630","streak":"W1","gb":"7.0"},
        {"abbr":"LAL","team":"Los Angeles Lakers","w":33,"l":21,"pct":".611","streak":"L2","gb":"8.0"},
        {"abbr":"MIN","team":"Minnesota T-Wolves","w":34,"l":22,"pct":".607","streak":"W3","gb":"8.0"},
        {"abbr":"PHX","team":"Phoenix Suns","w":32,"l":23,"pct":".582","streak":"L3","gb":"9.5"},
        {"abbr":"GSW","team":"Golden State Warriors","w":29,"l":26,"pct":".527","streak":"W1","gb":"12.5"},
    ],
}

PROPS = [
    {
        "player": "Paolo Banchero",
        "team": "ORL", "pos": "F",
        "game": "SAC vs ORL",
        "prop": "Points 24.5+",
        "rec": "OVER",
        "line": 24.5,
        "conf": 74,
        "edge_score": 85,
        "l5": 80, "l10": 70, "l15": 67,
        "streak": 4,
        "avg": 26.8,
        "odds": "-118",
        "reason": "28+ pts in 4 of last 5. SAC defense ranks 29th overall.",
    },
    {
        "player": "Jayson Tatum",
        "team": "BOS", "pos": "F",
        "game": "GSW vs BOS",
        "prop": "Points 27.5+",
        "rec": "OVER",
        "line": 27.5,
        "conf": 72,
        "edge_score": 81,
        "l5": 80, "l10": 70, "l15": 73,
        "streak": 3,
        "avg": 31.2,
        "odds": "-115",
        "reason": "Averaging 31.2 PPG last 5 road games. GSW allows 118+ PPG at home.",
    },
    {
        "player": "Nikola Jokić",
        "team": "DEN", "pos": "C",
        "game": "LAC vs DEN",
        "prop": "Rebounds 12.5+",
        "rec": "OVER",
        "line": 12.5,
        "conf": 68,
        "edge_score": 74,
        "l5": 80, "l10": 70, "l15": 60,
        "streak": 4,
        "avg": 13.4,
        "odds": "-130",
        "reason": "Double-doubles in 8 straight. LAC ranks 28th in reb defense.",
    },
    {
        "player": "Alperen Şengün",
        "team": "HOU", "pos": "C",
        "game": "Recent Form",
        "prop": "Pts+Reb+Ast 38.5+",
        "rec": "OVER",
        "line": 38.5,
        "conf": 65,
        "edge_score": 69,
        "l5": 60, "l10": 60, "l15": 53,
        "streak": 2,
        "avg": 40.1,
        "odds": "-110",
        "reason": "Triple-double threat in 3 of last 4. Massive usage rate at center.",
    },
    {
        "player": "Stephen Curry",
        "team": "GSW", "pos": "G",
        "game": "GSW vs BOS",
        "prop": "3PM 4.5",
        "rec": "UNDER",
        "line": 4.5,
        "conf": 61,
        "edge_score": 63,
        "l5": 60, "l10": 50, "l15": 47,
        "streak": 2,
        "avg": 3.8,
        "odds": "+105",
        "reason": "BOS limits 3PA aggressively. Curry shooting 37% from 3 in February.",
    },
]


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


@app.get("/api/games")
def get_games():
    return {"games": GAMES}

@app.get("/api/standings")
def get_standings():
    return {"standings": STANDINGS}

@app.get("/api/props")
def get_props():
    return {"props": PROPS}


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
    game = next((g for g in GAMES if g["id"] == req.game_id), None)
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")

    if game["status"] == "upcoming":
        prompt = (
            f"Betting analysis: {game['awayName']} @ {game['homeName']}. "
            f"Win probs: {game['away']} {game['awayWinProb']}%, {game['home']} {game['homeWinProb']}%. "
            f"Spread: {game['spread']}. O/U: {game['ou']}. ML: {game['away']} {game['awayOdds']} / {game['home']} {game['homeOdds']}. "
            f"Give: (1) Best bet (2) O/U lean (3) Top player prop. 4-5 sentences total."
        )
    else:
        prompt = (
            f"Live betting: {game['awayName']} {game['awayScore']} @ {game['homeName']} {game['homeScore']} "
            f"(Q{game.get('quarter','?')} {game.get('clock','')}). "
            f"Win prob: {game['away']} {game['awayWinProb']}%, {game['home']} {game['homeWinProb']}%. "
            f"Give: (1) Best live bet (2) Total lean (3) Player to target. Sharp and brief."
        )

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{GEMINI_URL}?key={key}",
            json={
                "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
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
    contents = [
        {"role": "model" if m.role == "assistant" else "user", "parts": [{"text": m.content}]}
        for m in req.messages
    ]
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{GEMINI_URL}?key={key}",
            json={
                "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
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


STATIC_DIR = pathlib.Path(__file__).parent / "static"
if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        return FileResponse(str(STATIC_DIR / "index.html"))
