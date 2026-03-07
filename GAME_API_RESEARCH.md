# Game API Research — New Game Types for DublPlay

## Current Architecture

DublPlay's wager system is **game-agnostic**. The chess.com integration works by:
1. Both players play on chess.com (external, not embedded)
2. Server polls chess.com's public API to find the matching game
3. Determines winner from API response
4. Settles wager automatically

**Key insight**: We don't embed games. We verify results via external APIs.

---

## BEST OPTION: PaperGames.io Developer API

**https://developers.papergames.io/**

PaperGames.io is a game platform with a **developer API specifically designed for embedding games and getting results via webhooks**. This is exactly the DublPlay use case.

### Available Games
- Tic Tac Toe
- Connect 4
- Battleship
- Gomoku
- Chess

### How It Works (Perfect fit for DublPlay)

1. **Create game session** — `POST` with API key (`X-Api-Key` header)
   ```json
   {
     "gameType": "Connect4",
     "language": "en",
     "inactivityTimeout": 30,
     "timerTimeout": 60
   }
   ```

2. **Get embeddable URLs back**
   ```json
   {
     "uid": "wdnH6gXc1",
     "playUrl": "https://papergames.io/en/r/wdnH6gXc1/embed/play",
     "watchUrl": "https://papergames.io/en/r/wdnH6gXc1/embed"
   }
   ```

3. **Embed `playUrl` in iframe/WebView** for both players
   - Pass `?username=PlayerName&externalUserId=YOUR_USER_ID` as query params
   - `externalUserId` maps their players to your DublPlay users

4. **Receive `game.finished` webhook** when game ends
   - Payload includes `players` array with `externalId`, `name`, `score`
   - Compare scores → determine winner → settle wager

### Configuration Options
- `inactivityTimeout` — time per turn in seconds (0 = infinite)
- `timerTimeout` — total time per player in seconds (0 = infinite)
- `boardSize` — game-specific (e.g. "3x3", "5x5" for Tic Tac Toe)
- `maxGames` — max games per session (odd values recommended: 1, 3, 5)

### Webhook Events
- `game.started` — triggered when a game begins (can fire multiple times per session)
- `game.finished` — triggered when a game ends, includes player scores

### Integration with DublPlay Wager Flow
1. Wager accepted + both paid → status `active`
2. Server creates PaperGames session via API
3. Both players get `playUrl` in the app (iframe/WebView)
4. Players play the game in-app
5. `game.finished` webhook hits your server
6. Compare `players[].score` by `externalId` → determine winner
7. Settle wager (credit wallet, record transaction)

**This replaces polling** — instead of cron job polling like chess.com, you get a push notification via webhook.

### Docs
- Introduction: https://developers.papergames.io/docs/intro/
- Getting Started: https://developers.papergames.io/docs/getting-started/
- Create Game Session: https://developers.papergames.io/docs/create-game-session/
- Webhooks: https://developers.papergames.io/docs/webhooks/
- Integration Flow: https://developers.papergames.io/docs/integration-flow/

---

## MAJOR FIND: PlayStrategy.org — Full API, 30+ Strategy Games

**https://playstrategy.org/api**

PlayStrategy.org is a **free, open-source, Lichess-fork** that supports 30+ strategy games with a **full REST/JSON API** — same quality and pattern as Lichess. No auth required for public game data.

### Available Games (30+)
- **Chess variants**: Chess, Chess960, Crazyhouse, Three-check, Five-check, King of the Hill, Racing Kings, Atomic, Antichess, Horde, No Castling
- **Draughts/Checkers**: International, American/English, Frisian, Russian, Brazilian, Antidraughts, Bestemshe, Dameo
- **Asian games**: Shogi, Mini Shogi, Xiangqi, Mini Xiangqi
- **Go**: 9x9, 13x13, 19x19
- **Classic board games**: Othello, Grand Othello, Backgammon, Nackgammon, Lines of Action, Amazons, Oware
- **Other**: Breakthrough, Mini Breakthrough, Abalone, Togyzqumalaq, Frysk!

### Key API Endpoints for DublPlay

```
# Get all games for a user (filter by opponent!)
GET /api/games/user/{username}?opponent={opponent}&rated=true

# Export a single game result
GET /game/export/{gameId}

# Stream games between specific users (real-time!)
POST /api/stream/games-by-users

# Challenge system
POST /api/challenge/{username}

# Get user profile/rating
GET /api/user/{username}
```

### How It Works for DublPlay
1. Both players link their PlayStrategy username
2. Player A challenges Player B on PlayStrategy (any of the 30+ games)
3. DublPlay server polls `GET /api/games/user/{playerA}?opponent={playerB}`
4. Game result includes winner → settle wager
5. OR use streaming endpoint for real-time notification

### Why This Is Huge
- **30+ games from ONE integration** — chess, checkers, backgammon, Go, shogi, othello, etc.
- Same polling pattern as chess.com (already built)
- Free, no API key required for public data
- Open source (can inspect/verify)
- Full challenge system built in

### API Docs & Source
- API Reference: https://playstrategy.org/api
- OpenAPI Spec: https://github.com/Mind-Sports-Games/api
- Source Code: https://playstrategy.org/source

---

## Lidraughts.org — Draughts/Checkers API (Lichess Fork)

**https://lidraughts.org/api**

Free, open-source draughts (checkers) server — another Lichess fork with the same API pattern.

### Available Games
- International Draughts (10x10)
- American/English Draughts (8x8)
- Frisian Draughts
- Antidraughts
- Russian Draughts
- Brazilian Draughts
- Breakthrough
- Frysk!

### API
- Same RESTful pattern as Lichess
- Get user games, game results, challenge system
- No auth for public data
- Docs: https://lidraughts.org/api
- GitHub: https://github.com/RoepStoep/lidraughts-api

### DublPlay Integration
Same pattern as chess.com/Lichess — poll for recent games between two users, check winner.

---

## Lishogi.org — Shogi (Japanese Chess) API

**https://lishogi.org/api**

Free, open-source shogi server — another Lichess fork.

### Available Games
- Shogi (Japanese Chess)
- Mini Shogi

### API
- Same RESTful pattern as Lichess
- Docs: https://lishogi.org/api
- Developer page: https://lishogi.org/developers

---

## Board Game Arena — Unofficial Internal Endpoints

**https://boardgamearena.com**

BGA has **no official public API**, but has internal AJAX endpoints that return JSON. BGA explicitly says scraping violates TOS. However, the game history page (`/gamestats`) shows results filterable by player, game, date, and opponent.

### 500+ Games Available
Checkers, Chess, Catan (via BGA), and hundreds more board games.

### Known Internal Endpoints (Undocumented, Against TOS)
```
# Get game history (returns JSON despite .html extension)
/gamestats/gamestats/getGames.html?player_id=X&start_date=Y&end_date=Z&page=1

# Game review/results
/gamereview?table={table_id}

# Replay logs
/archive/archive/logs.html?table={table_id}
```

### Parameters for getGames.html
- `player_id` — player whose history to retrieve
- `start_date` / `end_date` — date range
- `page` — pagination (10 results per page)
- `finished` — filter for finished games
- `game_id` — filter by specific game
- `opponent_id` — filter by opponent

### Response
JSON with table IDs, player info, scores, winners.

### Caveats
- Requires authenticated session (login + CSRF token)
- Against TOS to scrape
- Rate limited, may return 503
- Only validated accounts (2+ finished games, 1+ day old) can access replays
- 10 results per page, painful pagination

### Verdict
**Risky but technically possible.** Could work as a "link your BGA account" integration where users authorize DublPlay to check their game history. The gamestats page filters by player AND opponent which is exactly what we need. But TOS issues make this a gray area.

---

## All Platforms Investigated

### Has Usable Public API ✅

| Platform | Games | API Type | Auth Required? | Can Verify 1v1 Winner? | Notes |
|----------|-------|----------|---------------|----------------------|-------|
| **Chess.com** | Chess | REST | No | ✅ Yes | Already integrated |
| **PaperGames.io** | TicTacToe, Connect4, Battleship, Gomoku, Chess | REST + Webhooks | API key | ✅ Yes | Embeddable + webhook results |
| **PlayStrategy.org** | **30+ games** (Chess, Checkers, Backgammon, Go, Shogi, Othello, etc.) | REST/JSON | No (public data) | ✅ Yes | **BIGGEST BANG FOR BUCK** — one integration, 30+ games |
| **Lichess** | Chess | REST | Optional | ✅ Yes | Redundant with Chess.com |
| **Lidraughts.org** | 8+ Draughts/Checkers variants | REST | No | ✅ Yes | Lichess fork for checkers |
| **Lishogi.org** | Shogi, Mini Shogi | REST | No | ✅ Yes | Lichess fork for Japanese chess |
| **Riot Games** | LoL, Valorant, TFT | REST | API key | ✅ Yes (cross-ref match IDs) | Key expires daily unless registered |
| **FreeBoardGames.org** | 40+ board games | WebSocket + REST | No | ⚠️ Possible | Open source, self-hostable |
| **Open Trivia DB** | Trivia | REST | No | ❌ Question API only | Would need custom UI for 1v1 |
| **The Trivia API** | Trivia | REST | No | ❌ Question API only | Supports "fixed quizzes" |

### Has Internal/Unofficial Endpoints ⚠️

| Platform | Games | Can Get Results? | Risk |
|----------|-------|-----------------|------|
| **Board Game Arena** | 500+ board games | ✅ Yes (internal JSON endpoints) | Against TOS, requires auth session |
| **Colonist.io** | Catan | ⚠️ Undocumented `/api/profile/{username}` | Unreliable, no official support |
| **PlayOK** | Chess, Checkers, Backgammon, Go, etc. | ⚠️ Game archives downloadable (PGN/SGF) | No API, manual download only |
| **Yucata** | 190+ board games | ⚠️ Can export to JSON via bookmarklet | No official API, unofficial tools break regularly |

### No Usable API ❌

| Platform | Why Not |
|----------|---------|
| **Buzzinga** | Event/classroom Jeopardy tool. No API |
| **Sporcle** | No public API |
| **Words With Friends** | No official API. Reverse-engineered lib is fragile |
| **8 Ball Pool (Miniclip)** | No public API. Results locked in app |
| **Tabletopia** | No developer API (2500+ games but no way to get results) |
| **BuddyBoardGames** | No API (14 games: Azul, Battleship, Checkers, Chess, Connect4, Uno, Yahtzee, etc.) |
| **Bloob.io** | No API, no documented result tracking |
| **Board Game Online** | No API, in-memory state only |
| **netgames.io** | No API, no database, no accounts — pure in-memory state |
| **Plinkod** | No API |
| **Gamezop** | B2B publisher platform — requires partnership deal |
| **CrazyGames** | SDK for game devs publishing TO their platform |
| **Poki** | Publisher SDK, no score callbacks |
| **GameDistribution** | Analytics only, not for consumers |
| **PlayingCards.io** | No formal API. Room-based sandbox |
| **Backgammon Galaxy** | No public API (good analysis tools but locked in platform) |

---

## Recommended Path (Updated)

### Phase 1: PlayStrategy.org Integration (HIGHEST PRIORITY)
- **30+ games from ONE integration**: Chess, Checkers, Backgammon, Go, Shogi, Othello, etc.
- Same polling pattern as chess.com (code reuse!)
- Free, no API key needed
- Both players link PlayStrategy username → challenge each other → DublPlay verifies result
- **Effort**: Low — reuse chess.com polling logic, just point at different API
- **Games added**: ~30

### Phase 2: PaperGames.io Integration
- Add Connect 4, Battleship, Gomoku, Tic Tac Toe as embedded games
- Better UX (play in-app) but more work (WebView + webhooks)
- **Effort**: Medium
- **Games added**: 5

### Phase 3: Self-Reported Results (Any Game)
- Generic "custom game" wager type
- Both players report who won → if they agree, auto-settle
- If they disagree → dispute resolution
- **Effort**: Low
- **Games added**: Unlimited (pool, Smash Bros, pickup basketball, anything)

### Phase 4: Lidraughts + Lishogi + Riot Games
- Lidraughts for checkers specialists
- Lishogi for shogi community
- Riot for League/Valorant wagers
- **Effort**: Low each (same pattern as chess.com)
- **Games added**: 10+ variants + LoL/Valorant/TFT

### Phase 5: Board Game Arena (If TOS allows)
- Contact BGA about partnership/authorized API access
- If approved: 500+ games instantly
- **Effort**: Medium (auth session management, pagination)
- **Games added**: 500+

---

## API Reference Links

### Official, Free, Public APIs
- **PlayStrategy.org API**: https://playstrategy.org/api (30+ games)
- **PaperGames.io Developer Docs**: https://developers.papergames.io/
- **Chess.com API**: https://www.chess.com/news/view/published-data-api
- **Lichess API**: https://lichess.org/api
- **Lidraughts API**: https://lidraughts.org/api (draughts/checkers)
- **Lishogi API**: https://lishogi.org/api (shogi)
- **Riot Developer Portal**: https://developer.riotgames.com/apis
- **Open Trivia DB**: https://opentdb.com/api_config.php
- **The Trivia API**: https://the-trivia-api.com/
- **FreeBoardGames.org**: https://www.freeboardgames.org/ (open source)

### Unofficial/Internal (Use at own risk)
- **BGA internal endpoints**: `/gamestats/gamestats/getGames.html` (against TOS)
- **Colonist.io**: `/api/profile/{username}` (undocumented, unreliable)
- **Yucata export**: https://github.com/yucata-de/YucataPlayLoggerForBGG (bookmarklet)
- **BGA scraper**: https://github.com/advoet/bga (Python module)
- **BGA export stats**: https://github.com/oliverosz/bga-export-stats (bookmarklets)
