import { auth } from './firebase.js';

const API_URL = import.meta.env.VITE_GAMES_API_URL || '/api';

async function getFirebaseToken() {
  const user = auth.currentUser;
  if (!user) return null;
  return user.getIdToken();
}

export async function gamesApi(path, options = {}) {
  const token = await getFirebaseToken();

  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

// Friends
export const friendsApi = {
  list: () => gamesApi('/friends'),
  requests: () => gamesApi('/friends/requests'),
  sendRequest: (displayName) =>
    gamesApi('/friends/request', {
      method: 'POST',
      body: JSON.stringify({ displayName }),
    }),
  accept: (id) => gamesApi(`/friends/${id}/accept`, { method: 'POST' }),
  decline: (id) => gamesApi(`/friends/${id}/decline`, { method: 'POST' }),
  markBgaAdded: (id) => gamesApi(`/friends/${id}/bga-added`, { method: 'POST' }),
  search: (q) => gamesApi(`/friends/search?q=${encodeURIComponent(q)}`),
};

// Wagers
export const wagersApi = {
  list: (status) => gamesApi(`/wagers${status ? `?status=${status}` : ''}`),
  get: (id) => gamesApi(`/wagers/${id}`),
  create: (opponentId, amountCents, platform = 'chesscom', gameType = null) =>
    gamesApi('/wagers', {
      method: 'POST',
      body: JSON.stringify({ opponentId, amountCents, platform, gameType }),
    }),
  accept: (id) => gamesApi(`/wagers/${id}/accept`, { method: 'POST' }),
  decline: (id) => gamesApi(`/wagers/${id}/decline`, { method: 'POST' }),
  cancel: (id) => gamesApi(`/wagers/${id}/cancel`, { method: 'POST' }),
  markPlaying: (id) => gamesApi(`/wagers/${id}/playing`, { method: 'POST' }),
  checkResult: (id) => gamesApi(`/wagers/${id}/check-result`, { method: 'POST' }),
  pay: (id) => gamesApi(`/stripe/wagers/${id}/pay`, { method: 'POST' }),
};

// Stripe
export const stripeApi = {
  config: () => gamesApi('/stripe/config'),
  onboarding: () => gamesApi('/stripe/onboarding', { method: 'POST' }),
  accountStatus: () => gamesApi('/stripe/account-status'),
};

// Wallet
export const walletApi = {
  balance: () => gamesApi('/wallet/balance'),
  deposit: (amountCents) =>
    gamesApi('/wallet/deposit', {
      method: 'POST',
      body: JSON.stringify({ amountCents }),
    }),
  withdraw: (amountCents) =>
    gamesApi('/wallet/withdraw', {
      method: 'POST',
      body: JSON.stringify({ amountCents }),
    }),
  requestPayout: (amountCents) =>
    gamesApi('/wallet/request-payout', {
      method: 'POST',
      body: JSON.stringify({ amountCents }),
    }),
  history: () => gamesApi('/wallet/history'),
};

// Auth helpers
export const authApi = {
  me: () => gamesApi('/auth/me'),
  updateVenmo: (venmoUsername) =>
    gamesApi('/auth/venmo', {
      method: 'PUT',
      body: JSON.stringify({ venmoUsername }),
    }),
  updatePlatformUsernames: (playStrategyUsername, bgaUsername) =>
    gamesApi('/auth/platform-usernames', {
      method: 'PUT',
      body: JSON.stringify({ playStrategyUsername, bgaUsername }),
    }),
};

// Stats
export const statsApi = {
  leaderboard: () => gamesApi('/stats/leaderboard'),
  balance: (friendId) => gamesApi(`/stats/balance/${friendId}`),
};

// Admin
export const adminApi = {
  users: (search) => gamesApi(`/admin/users${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  updateBalance: (userId, balanceCents) =>
    gamesApi(`/admin/users/${userId}/balance`, {
      method: 'PUT',
      body: JSON.stringify({ balanceCents }),
    }),
  payouts: (status) => gamesApi(`/admin/payouts${status ? `?status=${status}` : ''}`),
  markPaid: (payoutId) => gamesApi(`/admin/payouts/${payoutId}/paid`, { method: 'PUT' }),
};
