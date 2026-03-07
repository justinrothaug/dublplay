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
  // BGA requires an authenticated session.
  // For now, we use a service account cookie set via environment variable.
  // In production, this would be obtained by logging in via the BGA login endpoint.
  if (bgaSessionCookie) return bgaSessionCookie;
  bgaSessionCookie = process.env.BGA_SESSION_COOKIE || null;
  return bgaSessionCookie;
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

    const params = new URLSearchParams({
      player: bgaPlayerId,
      finished: '1',
      updateStats: '0',
    });
    if (opponentId) {
      params.set('opponent_id', opponentId);
    }

    const url = `https://boardgamearena.com/gamestats/gamestats/getGames.html?${params}`;
    const res = await fetch(url, {
      headers: {
        Cookie: cookie,
        'User-Agent': 'DublPlay/1.0',
      },
    });

    if (!res.ok) return [];
    const data: any = await res.json();
    return data.data?.tables || [];
  } catch {
    return [];
  }
}

export function findMatchingGame(
  tables: BGATableResult[],
  player1BgaId: string,
  player2BgaId: string,
  afterTimestamp: number,
): BGATableResult | null {
  for (const table of tables) {
    if (table.end < afterTimestamp) continue;

    const playerIds = Object.keys(table.players || {});
    const hasP1 = playerIds.includes(player1BgaId);
    const hasP2 = playerIds.includes(player2BgaId);

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
  const challenger = players[challengerBgaId];

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
