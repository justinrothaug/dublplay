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
      { id: 'any', name: 'Any Game', icon: '🎯' },
      { id: 'checkers', name: 'Checkers', icon: '⛀', bgaSlug: 'checkers' },
      { id: 'chess', name: 'Chess', icon: '♟', bgaSlug: 'chess' },
      { id: 'reversi', name: 'Othello', icon: '⬡', bgaSlug: 'reversi' },
      { id: 'backgammon', name: 'Backgammon', icon: '🎲', bgaSlug: 'backgammon' },
      { id: 'connect4', name: 'Connect 4', icon: '🔴', bgaSlug: 'connectfour' },
      { id: 'battleship', name: 'Battleship', icon: '🚢', bgaSlug: 'battleship' },
      { id: 'gomoku', name: 'Gomoku', icon: '⊕', bgaSlug: 'gomoku' },
      { id: 'patchwork', name: 'Patchwork', icon: '🧵', bgaSlug: 'patchwork' },
      { id: 'sevenwonders', name: '7 Wonders Duel', icon: '🏛', bgaSlug: 'sevenwondersduel' },
      { id: 'carcassonne', name: 'Carcassonne', icon: '🏰', bgaSlug: 'carcassonne' },
      { id: 'splendor', name: 'Splendor', icon: '💎', bgaSlug: 'splendor' },
      { id: 'azul', name: 'Azul', icon: '🔷', bgaSlug: 'azul' },
      { id: 'quoridor', name: 'Quoridor', icon: '🧱', bgaSlug: 'quoridor' },
      { id: 'santorini', name: 'Santorini', icon: '🏠', bgaSlug: 'santorini' },
      { id: 'jaipur', name: 'Jaipur', icon: '🐪', bgaSlug: 'jaipur' },
      { id: 'kingdomino', name: 'Kingdomino', icon: '👑', bgaSlug: 'kingdomino' },
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

// Get the BGA slug for a game (used in BGA URLs)
export function getBgaSlug(gameType) {
  const game = PLATFORMS.bga?.games.find((g) => g.id === gameType);
  return game?.bgaSlug || null;
}

// Check if user has linked a platform
export function userHasPlatform(user, platformId) {
  const field = PLATFORMS[platformId]?.usernameField;
  return field && user?.[field];
}
