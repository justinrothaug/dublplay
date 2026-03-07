# Game API Research — New Game Types for DublPlay

## Current Architecture

DublPlay's wager system is **game-agnostic**. The chess.com integration works by:
1. Both players play on chess.com (external, not embedded)
2. Server polls chess.com's public API to find the matching game
3. Determines winner from API response
4. Settles wager automatically

**Key insight**: We don't embed games. We verify results via external APIs.

---

## Platforms Investigated

### Has Usable Public API ✅

| Platform | Game Type | API | Can Verify 1v1? | Notes |
|----------|-----------|-----|-----------------|-------|
| **Chess.com** | Chess | REST, no auth | ✅ Yes | Already integrated |
| **Lichess** | Chess | REST, optional auth | ✅ Yes | Also chess — redundant |
| **Riot Games** | LoL, Valorant, TFT | REST, API key required | ✅ Yes (cross-reference match IDs) | Key expires daily unless you register a product with Riot for approval. Rate limit: 20 req/s, 100 req/2min |
| **Open Trivia DB** | Trivia | REST, no auth | ❌ No game platform — question API only | Free, 4000+ questions. Would need a thin UI to show questions + record answers |
| **The Trivia API** | Trivia | REST, no auth | ❌ Same — question API only | Supports "fixed quizzes" so both players get identical questions |

### No Usable API ❌

| Platform | Why Not |
|----------|---------|
| **Buzzinga** | Event/classroom Jeopardy tool. No API, no result callbacks |
| **Sporcle** | No public API whatsoever |
| **Words With Friends** | No official API. Unofficial Java lib exists (sidoh/wwf_api) but reverse-engineered, fragile |
| **8 Ball Pool (Miniclip)** | No public API. Results locked in app |
| **Board Game Arena** | No embed API, no result callbacks, closed platform |
| **Gamezop** | B2B publisher platform — requires partnership deal. Games 404 without it |
| **CrazyGames** | SDK is for game devs publishing TO their platform, not for consuming results |
| **Poki** | Same — publisher SDK, no score callbacks to parent page |
| **GameDistribution** | Same — `sendEvent()` sends to their analytics, not to your app |

### Why "Embeddable Games" Don't Exist

Cross-origin iframe sandboxing prevents reading data from third-party game iframes. Game platforms (Poki, CrazyGames, GameDistribution) are built for game **developers** to publish, not for third-party apps to consume results. No platform exposes a "who won?" callback to the embedding page.

---

## Realistic Options for New Game Types

### Option 1: Self-Reported Results (Any Game)
- Both players report who won
- If they agree → auto-settle
- If they disagree → dispute resolution (admin review, screenshot proof, etc.)
- **Pros**: Works for literally any game (pool, trivia, Smash Bros, pickup basketball)
- **Cons**: Honor system, potential for disputes
- **Effort**: Low — add a "report result" UI + confirmation flow

### Option 2: Riot Games API (League of Legends / Valorant / TFT)
- Same pattern as chess.com: players play on Riot's platform, server verifies via API
- Cross-reference both players' match histories to find shared games
- Determine winner from match data
- **Pros**: Automated like chess.com, huge player base
- **Cons**: API key management (expires daily without registered product), rate limits, Riot approval process
- **Effort**: Medium — new service similar to `chesscom.service.ts`

### Option 3: Trivia via Question API (OpenTDB / The Trivia API)
- Fetch questions from free API, show to both players, compare scores server-side
- NOT "building a game" — it's showing a form with multiple choice questions
- The Trivia API supports "fixed quizzes" so both players get identical questions
- **Pros**: Fully controlled, no external platform dependency, auto-settled
- **Cons**: Requires a UI for displaying questions (minimal though — buttons + timer)
- **Effort**: Medium — thin React view + server-side scoring

### Recommended Path
1. **Start with self-reported results** — unlocks ANY game type immediately
2. **Add Riot Games integration** — automated verification for a huge gaming audience
3. **Consider trivia later** — if there's demand, the question APIs make it straightforward

---

## API Reference Links

- Chess.com API: https://www.chess.com/news/view/published-data-api
- Lichess API: https://lichess.org/api
- Riot Developer Portal: https://developer.riotgames.com/apis
- Open Trivia DB: https://opentdb.com/api_config.php
- The Trivia API: https://the-trivia-api.com/
- GameDistribution Embed: https://github.com/GameDistribution/gd-embed-game
- Gamezop Multiplayer Docs: https://docs.platform.gamezop.com/publishers/gamezop/advanced/multiplayer-games/receive-winners-data
