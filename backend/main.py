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

# Static game/standings data (in production, replace with live sportsbook API)
GAMES = [
    {"id":"nyk-det","status":"live","quarter":4,"clock":"7:21","home":"NYK","away":"DET","homeName":"Knicks","awayName":"Pistons","homeScore":88,"awayScore":104,"homeWinProb":18,"awayWinProb":82},
    {"id":"chi-tor","status":"live","quarter":3,"clock":"5:09","home":"CHI","away":"TOR","homeName":"Bulls","awayName":"Raptors","homeScore":64,"awayScore":74,"homeWinProb":28,"awayWinProb":72},
    {"id":"sas-phx","status":"live","quarter":2,"clock":"Half","home":"SAS","away":"PHX","homeName":"Spurs","awayName":"Suns","homeScore":61,"awayScore":49,"homeWinProb":67,"awayWinProb":33},
    {"id":"cle-bkn","status":"final","home":"CLE","away":"BKN","homeName":"Cavaliers","awayName":"Nets","homeScore":112,"awayScore":84},
    {"id":"cha-hou","status":"final","home":"CHA","away":"HOU","homeName":"Hornets","awayName":"Rockets","homeScore":101,"awayScore":105},
    {"id":"lal-dal","status":"final","home":"LAL","away":"DAL","homeName":"Lakers","awayName":"Mavericks","homeScore":124,"awayScore":104},
    {"id":"gsw-bos","status":"upcoming","home":"GSW","away":"BOS","homeName":"Warriors","awayName":"Celtics","time":"7:00 PM PT","homeWinProb":32.2,"awayWinProb":67.8,"homeOdds":"+148","awayOdds":"-175","spread":"BOS -5.5","ou":"224.5"},
    {"id":"sac-orl","status":"upcoming","home":"SAC","away":"ORL","homeName":"Kings","awayName":"Magic","time":"7:00 PM PT","homeWinProb":23.9,"awayWinProb":76.1,"homeOdds":"+210","awayOdds":"-255","spread":"ORL -7","ou":"215.0"},
    {"id":"lac-den","status":"upcoming","home":"LAC","away":"DEN","homeName":"Clippers","awayName":"Nuggets","time":"7:30 PM PT","homeWinProb":37.6,"awayWinProb":62.4,"homeOdds":"+105","awayOdds":"-125","spread":"DEN -3","ou":"221.5"},
]

STANDINGS = {
    "East": [
        {"abbr":"DET","team":"Detroit Pistons","w":40,"l":13,"pct":".755","streak":"W3"},
        {"abbr":"BOS","team":"Boston Celtics","w":35,"l":19,"pct":".648","streak":"W2"},
        {"abbr":"NYK","team":"New York Knicks","w":35,"l":20,"pct":".636","streak":"L1"},
        {"abbr":"CLE","team":"Cleveland Cavaliers","w":35,"l":21,"pct":".625","streak":"W4"},
        {"abbr":"TOR","team":"Toronto Raptors","w":32,"l":23,"pct":".582","streak":"W1"},
        {"abbr":"PHI","team":"Philadelphia 76ers","w":30,"l":25,"pct":".545","streak":"L2"},
        {"abbr":"ORL","team":"Orlando Magic","w":28,"l":25,"pct":".528","streak":"W5"},
        {"abbr":"MIA","team":"Miami Heat","w":29,"l":27,"pct":".518","streak":"L1"},
    ],
    "West": [
        {"abbr":"OKC","team":"OKC Thunder","w":42,"l":14,"pct":".750","streak":"W6"},
        {"abbr":"SAS","team":"San Antonio Spurs","w":38,"l":16,"pct":".704","streak":"W3"},
        {"abbr":"DEN","team":"Denver Nuggets","w":35,"l":20,"pct":".636","streak":"W2"},
        {"abbr":"HOU","team":"Houston Rockets","w":34,"l":20,"pct":".630","streak":"W1"},
        {"abbr":"LAL","team":"Los Angeles Lakers","w":33,"l":21,"pct":".611","streak":"L2"},
        {"abbr":"MIN","team":"Minnesota T-Wolves","w":34,"l":22,"pct":".607","streak":"W3"},
        {"abbr":"PHX","team":"Phoenix Suns","w":32,"l":23,"pct":".582","streak":"L3"},
        {"abbr":"GSW","team":"Golden State Warriors","w":29,"l":26,"pct":".527","streak":"W1"},
    ],
}

PROPS = [
    {"player":"Jayson Tatum","team":"BOS","game":"GSW vs BOS","prop":"Points","line":27.5,"rec":"OVER","conf":72,"reason":"Averaging 31.2 PPG last 5 road games. GSW allows 118+ PPG at home."},
    {"player":"Nikola Jokić","team":"DEN","game":"LAC vs DEN","prop":"Rebounds","line":12.5,"rec":"OVER","conf":68,"reason":"Double-doubles in 8 straight. LAC ranks 28th in reb defense."},
    {"player":"Paolo Banchero","team":"ORL","game":"SAC vs ORL","prop":"Points","line":24.5,"rec":"OVER","conf":74,"reason":"28+ pts in 4 of last 5. SAC defense ranks 29th overall."},
    {"player":"Stephen Curry","team":"GSW","game":"GSW vs BOS","prop":"3PM","line":4.5,"rec":"UNDER","conf":61,"reason":"BOS limits 3PA aggressively. Curry shooting 37% from 3 in February."},
    {"player":"Alperen Şengün","team":"HOU","game":"Recent Form","prop":"Pts+Reb+Ast","line":38.5,"rec":"OVER","conf":65,"reason":"Triple-double threat in 3 of last 4. Massive usage rate at center."},
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


def get_effective_key(request_key: str) -> str:
    key = request_key or GEMINI_API_KEY
    if not key:
        raise HTTPException(status_code=400, detail="No Gemini API key provided. Set GEMINI_API_KEY env var or pass in request.")
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


@app.post("/api/analyze")
async def analyze_game(req: AnalyzeRequest):
    key = get_effective_key(req.api_key)
    game = next((g for g in GAMES if g["id"] == req.game_id), None)
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")

    if game["status"] == "upcoming":
        prompt = (f"Betting analysis: {game['awayName']} @ {game['homeName']}. "
                  f"Win probs: {game['away']} {game['awayWinProb']}%, {game['home']} {game['homeWinProb']}%. "
                  f"Spread: {game['spread']}. O/U: {game['ou']}. ML: {game['away']} {game['awayOdds']} / {game['home']} {game['homeOdds']}. "
                  f"Best play in 3-4 sentences.")
    else:
        prompt = (f"Live betting: {game['awayName']} {game['awayScore']} @ {game['homeName']} {game['homeScore']} "
                  f"(Q{game.get('quarter','?')} {game.get('clock','')}). "
                  f"Win prob: {game['away']} {game['awayWinProb']}%, {game['home']} {game['homeWinProb']}%. "
                  f"Any live value? Brief and sharp.")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{GEMINI_URL}?key={key}",
            json={
                "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {"maxOutputTokens": 400, "temperature": 0.75},
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


# ── Serve React build (production) ───────────────────────────────────────────
STATIC_DIR = pathlib.Path(__file__).parent / "static"
if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        """Catch-all: serve index.html for React Router."""
        index = STATIC_DIR / "index.html"
        return FileResponse(str(index))

