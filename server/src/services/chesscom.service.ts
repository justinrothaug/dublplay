const BASE_URL = 'https://api.chess.com/pub/player';

interface ChessComGame {
  url: string;
  white: { username: string; result: string };
  black: { username: string; result: string };
  end_time: number;
}

export async function fetchRecentGames(username: string): Promise<ChessComGame[]> {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const url = `${BASE_URL}/${username.toLowerCase()}/games/${year}/${month}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Chessnut-App/1.0' },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { games?: ChessComGame[] };
    return data.games || [];
  } catch {
    return [];
  }
}

export function findMatchingGame(
  games: ChessComGame[],
  player1: string,
  player2: string,
  afterTimestamp: number,
): ChessComGame | null {
  const p1 = player1.toLowerCase();
  const p2 = player2.toLowerCase();

  for (const game of games) {
    if (game.end_time < afterTimestamp) continue;
    const white = game.white.username.toLowerCase();
    const black = game.black.username.toLowerCase();
    if ((white === p1 && black === p2) || (white === p2 && black === p1)) {
      return game;
    }
  }
  return null;
}

export function getResultForChallenger(
  game: ChessComGame,
  challengerUsername: string,
): 'challenger_win' | 'opponent_win' | 'draw' {
  const me = challengerUsername.toLowerCase();
  const isWhite = game.white.username.toLowerCase() === me;
  const myResult = isWhite ? game.white.result : game.black.result;

  if (myResult === 'win') return 'challenger_win';
  if (
    myResult === 'checkmated' ||
    myResult === 'timeout' ||
    myResult === 'resigned' ||
    myResult === 'abandoned'
  ) {
    return 'opponent_win';
  }
  return 'draw';
}
