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
      { id: 'connect4', name: 'Connect 4', icon: '🔴', bgaSlug: 'connectfour' },
      { id: 'battleship', name: 'Battleship', icon: '🚢', bgaSlug: 'battleship' },
      { id: 'sevenwonders', name: '7 Wonders Duel', icon: '🏛', bgaSlug: 'sevenwondersduel' },
      { id: 'patchwork', name: 'Patchwork', icon: '🧵', bgaSlug: 'patchwork' },
      { id: 'jaipur', name: 'Jaipur', icon: '🐪', bgaSlug: 'jaipur' },
      { id: 'hex', name: 'Hex', icon: '⬡', bgaSlug: 'hex' },
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
