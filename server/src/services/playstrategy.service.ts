const BASE_URL = 'https://playstrategy.org';

interface PlayStrategyPlayer {
  user?: { name: string };
  rating?: number;
}

interface PlayStrategyGame {
  id: string;
  rated: boolean;
  variant: string;
  speed: string;
  status: string;
  createdAt: number;
  lastMoveAt: number;
  players: {
    p1: PlayStrategyPlayer;
    p2: PlayStrategyPlayer;
  };
  winner?: 'p1' | 'p2';
  url?: string;
}

// PlayStrategy uses ndjson (newline-delimited JSON) for game exports
function parseNdjson(text: string): PlayStrategyGame[] {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as PlayStrategyGame[];
}

export async function fetchRecentGames(
  username: string,
  opponent?: string,
): Promise<PlayStrategyGame[]> {
  try {
    const params = new URLSearchParams({
      max: '20',
      finished: 'true',
    });
    if (opponent) {
      params.set('vs', opponent);
    }

    const url = `${BASE_URL}/api/games/user/${encodeURIComponent(username)}?${params}`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/x-ndjson',
      },
    });
    if (!res.ok) return [];
    const text = await res.text();
    return parseNdjson(text);
  } catch {
    return [];
  }
}

export function findMatchingGame(
  games: PlayStrategyGame[],
  player1: string,
  player2: string,
  afterTimestamp: number,
): PlayStrategyGame | null {
  const p1 = player1.toLowerCase();
  const p2 = player2.toLowerCase();

  for (const game of games) {
    // createdAt is in milliseconds
    if (game.createdAt < afterTimestamp * 1000) continue;
    if (game.status !== 'mate' && game.status !== 'resign' && game.status !== 'outoftime' && game.status !== 'timeout' && game.status !== 'draw' && game.status !== 'stalemate' && game.status !== 'variantEnd') continue;

    const gp1 = game.players.p1?.user?.name?.toLowerCase();
    const gp2 = game.players.p2?.user?.name?.toLowerCase();

    if (!gp1 || !gp2) continue;

    if ((gp1 === p1 && gp2 === p2) || (gp1 === p2 && gp2 === p1)) {
      return game;
    }
  }
  return null;
}

export function getResultForChallenger(
  game: PlayStrategyGame,
  challengerUsername: string,
): 'challenger_win' | 'opponent_win' | 'draw' {
  if (!game.winner) return 'draw';

  const me = challengerUsername.toLowerCase();
  const p1Name = game.players.p1?.user?.name?.toLowerCase();

  const isP1 = p1Name === me;
  const myWin = (isP1 && game.winner === 'p1') || (!isP1 && game.winner === 'p2');

  return myWin ? 'challenger_win' : 'opponent_win';
}

// Map of game variant names to display names
export const PLAYSTRATEGY_GAMES: Record<string, string> = {
  chess: 'Chess',
  chess960: 'Chess960',
  crazyhouse: 'Crazyhouse',
  threeCheck: 'Three-check',
  fiveCheck: 'Five-check',
  kingOfTheHill: 'King of the Hill',
  racingKings: 'Racing Kings',
  antichess: 'Antichess',
  atomic: 'Atomic',
  horde: 'Horde',
  noCastling: 'No Castling',
  international: 'Int\'l Draughts',
  english: 'English Draughts',
  frisian: 'Frisian Draughts',
  russian: 'Russian Draughts',
  brazilian: 'Brazilian Draughts',
  antidraughts: 'Antidraughts',
  breakthrough: 'Breakthrough',
  shogi: 'Shogi',
  minishogi: 'Mini Shogi',
  xiangqi: 'Xiangqi',
  minixiangqi: 'Mini Xiangqi',
  go9x9: 'Go 9x9',
  go13x13: 'Go 13x13',
  go19x19: 'Go 19x19',
  othello: 'Othello',
  backgammon: 'Backgammon',
  nackgammon: 'Nackgammon',
  linesOfAction: 'Lines of Action',
  oware: 'Oware',
  amazons: 'Amazons',
  abalone: 'Abalone',
};
