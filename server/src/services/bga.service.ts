// Board Game Arena — uses internal undocumented endpoints
// Requires authenticated session. Results are scraped from the gamestats page.
// NOTE: BGA does not have an official public API. This uses their internal
// AJAX endpoints which return JSON. Use responsibly.

interface BGATableResult {
  table_id: string;
  game_name: string;
  players: Record<string, BGAPlayerResult>;
  end: number; // unix timestamp
  gamestart: string;
  scores: Record<string, string>;
}

interface BGAPlayerResult {
  player_id: string;
  fullname: string;
  rank: number;
  score: string;
}

// BGA session cookie management
let bgaSessionCookie: string | null = null;

async function ensureBGASession(): Promise<string | null> {
  if (bgaSessionCookie) return bgaSessionCookie;
  bgaSessionCookie = process.env.BGA_SESSION_COOKIE || null;
  return bgaSessionCookie;
}

// Resolve BGA username to numeric player ID
const bgaIdCache = new Map<string, string>();

export async function resolvePlayerId(bgaUsername: string): Promise<string | null> {
  const lower = bgaUsername.toLowerCase();
  const cached = bgaIdCache.get(lower);
  if (cached) return cached;

  try {
    const cookie = await ensureBGASession();
    if (!cookie) return null;

    // Use BGA's player search endpoint
    const url = `https://boardgamearena.com/player/player/findPlayer.html?q=${encodeURIComponent(bgaUsername)}&start=0&count=5`;
    const res = await fetch(url, {
      headers: { Cookie: cookie, 'User-Agent': 'DublPlay/1.0' },
    });
    if (!res.ok) {
      console.error(`BGA: findPlayer failed ${res.status} for ${bgaUsername}`);
      return null;
    }
    const data: any = await res.json();
    const items = data.data?.items || data.items || [];
    for (const item of items) {
      const name = (item.fullname || item.name || '').toLowerCase();
      if (name === lower) {
        const id = String(item.id);
        bgaIdCache.set(lower, id);
        return id;
      }
    }
    // If no exact match, use first result
    if (items.length > 0) {
      const id = String(items[0].id);
      bgaIdCache.set(lower, id);
      console.log(`BGA: Resolved ${bgaUsername} -> ${id} (first result, not exact match)`);
      return id;
    }
    console.warn(`BGA: Could not resolve player ID for ${bgaUsername}`);
    return null;
  } catch (err) {
    console.error(`BGA: resolvePlayerId error for ${bgaUsername}:`, err);
    return null;
  }
}

export async function fetchRecentGames(
  bgaPlayerId: string,
  opponentId?: string,
): Promise<BGATableResult[]> {
  try {
    const cookie = await ensureBGASession();
    if (!cookie) {
      console.warn('BGA: No session cookie configured. Set BGA_SESSION_COOKIE env var.');
      return [];
    }

    // Primary: gamestats endpoint with numeric IDs
    const params = new URLSearchParams({
      player: bgaPlayerId,
      finished: '1',
      updateStats: '0',
    });
    if (opponentId) {
      params.set('opponent_id', opponentId);
    }

    const url = `https://boardgamearena.com/gamestats/gamestats/getGames.html?${params}`;
    console.log(`BGA: Fetching games: ${url}`);
    const res = await fetch(url, {
      headers: {
        Cookie: cookie,
        'User-Agent': 'DublPlay/1.0',
      },
    });

    if (!res.ok) {
      console.error(`BGA: getGames failed with status ${res.status}`);
      return await fetchRecentGamesViaTableManager(bgaPlayerId, cookie);
    }

    const text = await res.text();
    console.log(`BGA: Raw response (first 500 chars): ${text.substring(0, 500)}`);

    let data: any;
    try { data = JSON.parse(text); } catch {
      console.error('BGA: Failed to parse JSON response');
      return await fetchRecentGamesViaTableManager(bgaPlayerId, cookie);
    }

    // BGA returns tables as either an array or an object keyed by table_id
    let tables = data.data?.tables;
    if (tables && !Array.isArray(tables)) {
      tables = Object.values(tables);
    }
    console.log(`BGA: Got ${tables?.length || 0} tables from gamestats`);

    if (!tables || tables.length === 0) {
      return await fetchRecentGamesViaTableManager(bgaPlayerId, cookie);
    }

    return tables;
  } catch (err) {
    console.error('BGA: fetchRecentGames error:', err);
    return [];
  }
}

// Fallback: use tablemanager endpoint
async function fetchRecentGamesViaTableManager(bgaPlayerId: string, cookie: string): Promise<BGATableResult[]> {
  try {
    const url = `https://boardgamearena.com/tablemanager/tablemanager/tableinfos.html?playerfilter=${bgaPlayerId}&status=finished&nbmax=20`;
    console.log(`BGA: Trying tablemanager fallback: ${url}`);
    const res = await fetch(url, {
      headers: { Cookie: cookie, 'User-Agent': 'DublPlay/1.0' },
    });
    if (!res.ok) {
      console.error(`BGA: tablemanager failed with status ${res.status}`);
      return [];
    }
    const data: any = await res.json();
    let tables = data.data?.tables;
    if (tables && !Array.isArray(tables)) {
      tables = Object.values(tables);
    }
    console.log(`BGA: Got ${tables?.length || 0} tables from tablemanager`);
    return tables || [];
  } catch (err) {
    console.error('BGA: tablemanager fallback error:', err);
    return [];
  }
}

function findPlayerEntry(players: Record<string, BGAPlayerResult>, username: string): BGAPlayerResult | null {
  // First try by key (numeric ID), then by fullname (username)
  if (players[username]) return players[username];
  const lower = username.toLowerCase();
  for (const p of Object.values(players)) {
    if ((p.fullname || '').toLowerCase() === lower) return p;
  }
  return null;
}

export function findMatchingGame(
  tables: BGATableResult[],
  player1: string,
  player2: string,
  afterTimestamp: number,
): BGATableResult | null {
  for (const table of tables) {
    if (table.end < afterTimestamp) continue;

    const hasP1 = findPlayerEntry(table.players, player1) !== null;
    const hasP2 = findPlayerEntry(table.players, player2) !== null;

    if (hasP1 && hasP2) {
      return table;
    }
  }
  return null;
}

export function getResultForChallenger(
  table: BGATableResult,
  challengerBgaId: string,
): 'challenger_win' | 'opponent_win' | 'draw' {
  const players = table.players || {};
  const challenger = findPlayerEntry(players, challengerBgaId);

  if (!challenger) return 'draw';

  // rank 1 = winner in BGA
  if (challenger.rank === 1) {
    // Check if there's a tie (multiple rank 1 players)
    const rank1Count = Object.values(players).filter((p) => p.rank === 1).length;
    if (rank1Count > 1) return 'draw';
    return 'challenger_win';
  }

  return 'opponent_win';
}


// Fast 2-player games on BGA
export const BGA_GAMES: Record<string, string> = {
  checkers: 'Checkers',
  connect4: 'Connect 4',
  battleship: 'Battleship',
  sevenwonders: 'Seven Wonders Duel',
  patchwork: 'Patchwork',
  jaipur: 'Jaipur',
  hex: 'Hex',
};
