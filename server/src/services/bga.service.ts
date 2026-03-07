// Board Game Arena integration
// Uses BGA's internal AJAX endpoints which return JSON.
// Requires BGA_SESSION_COOKIE env var for authenticated API calls.

const BGA_BASE = 'https://en.boardgamearena.com';

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

const bgaIdCache = new Map<string, string>();

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'DublPlay/1.0' };
  const cookie = process.env.BGA_SESSION_COOKIE;
  if (cookie) headers['Cookie'] = cookie;
  return headers;
}

function hasCookie(): boolean {
  return !!process.env.BGA_SESSION_COOKIE;
}

// Resolve BGA username to numeric player ID
export async function resolvePlayerId(bgaUsername: string): Promise<string | null> {
  // Decode any URL-encoded characters first
  const decoded = decodeURIComponent(bgaUsername).trim();
  const lower = decoded.toLowerCase();
  const cached = bgaIdCache.get(lower);
  if (cached) return cached;

  if (!hasCookie()) {
    console.warn('BGA: Cannot resolve player ID without BGA_SESSION_COOKIE env var');
    return null;
  }

  try {
    const res = await fetch(
      `${BGA_BASE}/player/player/findPlayer.html?q=${encodeURIComponent(decoded)}&start=0&count=5`,
      { headers: getHeaders(), redirect: 'follow' },
    );
    if (!res.ok) {
      console.error(`BGA: findPlayer failed ${res.status} for "${decoded}"`);
      return null;
    }
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch {
      console.error(`BGA: findPlayer returned non-JSON for "${decoded}": ${text.substring(0, 200)}`);
      return null;
    }

    // Check for BGA error response
    if (data.status === '0' || data.error) {
      console.error(`BGA: findPlayer error for "${decoded}": ${data.error || 'unknown'}`);
      return null;
    }

    const items = data.data?.items || data.items || [];
    for (const item of items) {
      if ((item.fullname || item.name || '').toLowerCase() === lower) {
        const id = String(item.id);
        bgaIdCache.set(lower, id);
        console.log(`BGA: Resolved "${decoded}" -> ${id}`);
        return id;
      }
    }
    if (items.length > 0) {
      const id = String(items[0].id);
      bgaIdCache.set(lower, id);
      console.log(`BGA: Resolved "${decoded}" -> ${id} (first result)`);
      return id;
    }
    console.warn(`BGA: No results for "${decoded}"`);
    return null;
  } catch (err) {
    console.error(`BGA: resolvePlayerId error for "${decoded}":`, err);
    return null;
  }
}

// Fetch finished games for a player (uses numeric player IDs)
export async function fetchRecentGames(
  bgaPlayerId: string,
  opponentId?: string,
): Promise<BGATableResult[]> {
  if (!hasCookie()) {
    console.warn('BGA: Cannot fetch games without BGA_SESSION_COOKIE env var');
    return [];
  }

  try {
    const params = new URLSearchParams({
      player: bgaPlayerId,
      finished: '1',
      updateStats: '0',
    });
    if (opponentId) params.set('opponent_id', opponentId);

    const url = `${BGA_BASE}/gamestats/gamestats/getGames.html?${params}`;
    console.log(`BGA: Fetching ${url}`);
    const res = await fetch(url, { headers: getHeaders(), redirect: 'follow' });
    if (!res.ok) {
      console.error(`BGA: getGames failed ${res.status}`);
      return [];
    }

    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch {
      console.error(`BGA: getGames non-JSON response: ${text.substring(0, 200)}`);
      return [];
    }

    if (data.status === '0' || data.error) {
      console.error(`BGA: getGames error: ${data.error || 'unknown'} (code ${data.code})`);
      return [];
    }

    let tables = data.data?.tables;
    if (tables && !Array.isArray(tables)) tables = Object.values(tables);
    console.log(`BGA: Got ${tables?.length || 0} tables`);
    return tables || [];
  } catch (err) {
    console.error('BGA: fetchRecentGames error:', err);
    return [];
  }
}

export function findMatchingGame(
  tables: BGATableResult[],
  player1Id: string,
  player2Id: string,
  afterTimestamp: number,
): BGATableResult | null {
  for (const table of tables) {
    if (table.end < afterTimestamp) continue;
    const playerIds = Object.keys(table.players || {});
    if (playerIds.includes(player1Id) && playerIds.includes(player2Id)) {
      return table;
    }
  }
  return null;
}

export function getResultForChallenger(
  table: BGATableResult,
  challengerId: string,
): 'challenger_win' | 'opponent_win' | 'draw' {
  const challenger = table.players?.[challengerId];
  if (!challenger) return 'draw';

  if (challenger.rank === 1) {
    const rank1Count = Object.values(table.players).filter((p) => p.rank === 1).length;
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
