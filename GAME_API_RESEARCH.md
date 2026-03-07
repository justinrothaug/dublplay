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

## Other Platforms Investigated

### Has Usable Public API ✅

| Platform | Game Type | API | Can Verify 1v1? | Notes |
|----------|-----------|-----|-----------------|-------|
| **Chess.com** | Chess | REST, no auth | ✅ Yes | Already integrated |
| **PaperGames.io** | TicTacToe, Connect4, Battleship, Gomoku, Chess | REST + Webhooks, API key | ✅ Yes | **BEST OPTION** — embeddable + webhook results |
| **Lichess** | Chess | REST, optional auth | ✅ Yes | Also chess — redundant |
| **Riot Games** | LoL, Valorant, TFT | REST, API key required | ✅ Yes (cross-reference match IDs) | Key expires daily unless registered. Rate limit: 20 req/s, 100 req/2min |
| **Open Trivia DB** | Trivia | REST, no auth | ❌ Question API only | Free, 4000+ questions. Would need a thin UI |
| **The Trivia API** | Trivia | REST, no auth | ❌ Question API only | Supports "fixed quizzes" for fair competition |
| **FreeBoardGames.org** | 40+ board games | Open source, has backend API | ⚠️ Possible | Open source (can self-host), has WebSocket backend. Could fork/embed but requires work |

### No Usable API ❌

| Platform | Why Not |
|----------|---------|
| **Buzzinga** | Event/classroom Jeopardy tool. No API, no result callbacks |
| **Sporcle** | No public API whatsoever |
| **Words With Friends** | No official API. Unofficial Java lib (sidoh/wwf_api) is reverse-engineered, fragile |
| **8 Ball Pool (Miniclip)** | No public API. Results locked in app |
| **Board Game Arena** | No public API. Admin explicitly said scraping violates TOS. Internal `getGames.html` endpoint exists but unsanctioned |
| **Colonist.io** | No API. Community requesting since 2020, still "under consideration" |
| **Tabletopia** | No developer API |
| **Yucata** | No developer API |
| **BuddyBoardGames** | No API, no embed capability |
| **Gamezop** | B2B publisher platform — requires partnership deal. Games 404 without it |
| **CrazyGames** | SDK for game devs publishing TO their platform, not for consuming results |
| **Poki** | Same — publisher SDK, no score callbacks to parent page |
| **GameDistribution** | Same — `sendEvent()` sends to their analytics, not to your app |
| **PlayingCards.io** | No formal API. Room-based card game sandbox |

---

## Recommended Path

### Phase 1: PaperGames.io Integration (Immediate)
- Add Connect 4, Battleship, Gomoku, Tic Tac Toe as wagerable games
- Embed in WebView, use webhooks for auto-settlement
- Same wallet/payment flow as chess, just different game source
- **Effort**: Low-medium — similar to chess.com integration but cleaner (webhooks vs polling)

### Phase 2: Self-Reported Results (Any Game)
- Add a generic "custom game" wager type
- Both players report who won → if they agree, auto-settle
- If they disagree → dispute resolution (admin review, screenshot proof)
- **Pros**: Works for literally any game (pool, trivia, Smash Bros, pickup basketball)
- **Effort**: Low — add a "report result" UI + confirmation flow

### Phase 3: More Integrations (Future)
- Riot Games API for League/Valorant wagers
- Trivia via question APIs
- FreeBoardGames.org (open source, could self-host for more game variety)

---

## API Reference Links

- **PaperGames.io Developer Docs**: https://developers.papergames.io/
- Chess.com API: https://www.chess.com/news/view/published-data-api
- Lichess API: https://lichess.org/api
- Riot Developer Portal: https://developer.riotgames.com/apis
- Open Trivia DB: https://opentdb.com/api_config.php
- The Trivia API: https://the-trivia-api.com/
- FreeBoardGames.org: https://www.freeboardgames.org/ (open source)
