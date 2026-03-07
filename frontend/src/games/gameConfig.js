// Platform and game definitions for DublPlay
// Each platform has games that can be wagered on

export const PLATFORMS = {
  chesscom: {
    id: 'chesscom',
    name: 'Chess.com',
    url: 'https://www.chess.com',
    usernameField: 'chess_com_username',
    icon: '♟',
    games: [
      { id: 'chess', name: 'Chess', icon: '♟' },
    ],
  },
  bga: {
    id: 'bga',
    name: 'Board Game Arena',
    url: 'https://boardgamearena.com',
    usernameField: 'bga_username',
    icon: '🎲',
    games: [
      { id: 'checkers', name: 'Checkers', icon: '⛀' },
      { id: 'chess', name: 'Chess', icon: '♟' },
      { id: 'reversi', name: 'Othello', icon: '⬡' },
      { id: 'backgammon', name: 'Backgammon', icon: '🎲' },
      { id: 'connect4', name: 'Connect 4', icon: '🔴' },
      { id: 'battleship', name: 'Battleship', icon: '🚢' },
      { id: 'gomoku', name: 'Gomoku', icon: '⊕' },
      { id: 'patchwork', name: 'Patchwork', icon: '🧵' },
      { id: 'sevenwonders', name: '7 Wonders Duel', icon: '🏛' },
      { id: 'carcassonne', name: 'Carcassonne', icon: '🏰' },
      { id: 'splendor', name: 'Splendor', icon: '💎' },
      { id: 'azul', name: 'Azul', icon: '🔷' },
      { id: 'quoridor', name: 'Quoridor', icon: '🧱' },
      { id: 'santorini', name: 'Santorini', icon: '🏠' },
      { id: 'jaipur', name: 'Jaipur', icon: '🐪' },
      { id: 'kingdomino', name: 'Kingdomino', icon: '👑' },
    ],
  },
};

// Get display name for a platform + game combo
export function getGameDisplayName(platform, gameType) {
  const p = PLATFORMS[platform];
  if (!p) return platform;
  if (!gameType) return p.games[0]?.name || p.name;
  const game = p.games.find((g) => g.id === gameType);
  return game ? game.name : gameType;
}

// Get platform display name
export function getPlatformDisplayName(platform) {
  return PLATFORMS[platform]?.name || platform;
}

// Get the URL to open for a platform
export function getPlatformUrl(platform) {
  return PLATFORMS[platform]?.url || '#';
}

// Check if user has linked a platform
export function userHasPlatform(user, platformId) {
  const field = PLATFORMS[platformId]?.usernameField;
  return field && user?.[field];
}
