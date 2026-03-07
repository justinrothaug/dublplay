// Board Game Arena integration
// Uses BGA's AJAX endpoints (requires valid BGA_SESSION_COOKIE).
// When cookie is expired, the poll will fail gracefully and users can report results manually.

const BGA_BASE = 'https://en.boardgamearena.com';

export interface BGATableResult {
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
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  const cookie = process.env.BGA_SESSION_COOKIE;
  if (cookie) headers['Cookie'] = cookie;
  return headers;
}

function hasCookie(): boolean {
  return !!process.env.BGA_SESSION_COOKIE;
}

// Resolve BGA username to numeric player ID
export async function resolvePlayerId(bgaUsername: string): Promise<string | null> {
  const decoded = decodeURIComponent(bgaUsername).trim();
  const lower = decoded.toLowerCase();
  const cached = bgaIdCache.get(lower);
  if (cached) return cached;

  if (!hasCookie()) {
    console.warn('BGA: No BGA_SESSION_COOKIE set');
    return null;
  }

  try {
    const res = await fetch(
      `${BGA_BASE}/player/player/findPlayer.html?q=${encodeURIComponent(decoded)}&start=0&count=5`,
      { headers: getHeaders(), redirect: 'follow' },
    );
    if (!res.ok) return null;
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { return null; }
    if (data.status === '0' || data.error) {
      console.error(`BGA: findPlayer error: ${data.error}`);
      return null;
    }

    const items = data.data?.items || data.items || [];
    for (const item of items) {
      if ((item.fullname || item.name || '').toLowerCase() === lower) {
        const id = String(item.id);
        bgaIdCache.set(lower, id);
        return id;
      }
    }
    if (items.length > 0) {
      const id = String(items[0].id);
      bgaIdCache.set(lower, id);
      return id;
    }
    return null;
  } catch {
    return null;
  }
}

// Fetch finished games for a player
export async function fetchRecentGames(
  bgaPlayerId: string,
  opponentId?: string,
): Promise<BGATableResult[]> {
  if (!hasCookie()) return [];

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
    if (!res.ok) return [];

    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { return []; }

    if (data.status === '0' || data.error) {
      console.error(`BGA: getGames error: ${data.error} (code ${data.code})`);
      return [];
    }

    let tables = data.data?.tables;
    if (tables && !Array.isArray(tables)) tables = Object.values(tables);
    console.log(`BGA: Got ${tables?.length || 0} tables`);
    return tables || [];
  } catch {
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
