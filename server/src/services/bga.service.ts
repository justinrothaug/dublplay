// Board Game Arena integration
// Uses BGA's internal AJAX endpoints which return JSON.

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

// Resolve BGA username to numeric player ID
export async function resolvePlayerId(bgaUsername: string): Promise<string | null> {
  const lower = bgaUsername.toLowerCase();
  const cached = bgaIdCache.get(lower);
  if (cached) return cached;

  try {
    const res = await fetch(
      `https://boardgamearena.com/player/player/findPlayer.html?q=${encodeURIComponent(bgaUsername)}&start=0&count=5`,
      { headers: getHeaders() },
    );
    if (!res.ok) return null;
    const data: any = await res.json();
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

// Fetch finished games for a player (uses numeric player IDs)
export async function fetchRecentGames(
  bgaPlayerId: string,
  opponentId?: string,
): Promise<BGATableResult[]> {
  try {
    const params = new URLSearchParams({
      player: bgaPlayerId,
      finished: '1',
      updateStats: '0',
    });
    if (opponentId) params.set('opponent_id', opponentId);

    const res = await fetch(
      `https://boardgamearena.com/gamestats/gamestats/getGames.html?${params}`,
      { headers: getHeaders() },
    );
    if (!res.ok) return [];

    const data: any = await res.json();
    let tables = data.data?.tables;
    if (tables && !Array.isArray(tables)) tables = Object.values(tables);
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
