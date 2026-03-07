const BASE = import.meta.env.VITE_API_URL || "";

async function req(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    let msg = `Server error (${res.status})`;
    try {
      const data = await res.json();
      const detail = data.detail;
      msg = Array.isArray(detail)
        ? detail.map(e => e.msg || JSON.stringify(e)).join("; ")
        : (typeof detail === "string" ? detail : msg);
    } catch { /* response wasn't JSON (e.g. 502 HTML page) */ }
    throw new Error(msg);
  }
  return await res.json();
}

export const api = {
  getGames:     (date = null)  => req(date ? `/api/games?date=${date}` : "/api/games"),
  getStandings: ()             => req("/api/standings"),
  getProps:     ()             => req("/api/props"),
  getPicks:     (date)         => req(`/api/picks/${date}`),
  analyze:      (game_id, api_key, date = null) =>
    req("/api/analyze", { method:"POST", body: JSON.stringify({ game_id, api_key, date }) }),
  chat: (messages, api_key) =>
    req("/api/chat", { method:"POST", body: JSON.stringify({ messages, api_key }) }),
  health: () => req("/health"),
  placeBet: (game_id, side, uid, username, locked_spread = "", locked_ml = "", date = null, firebase_uid = "") =>
    req("/api/bet", { method:"POST", body: JSON.stringify({ game_id, side, uid, username, locked_spread, locked_ml, date, firebase_uid }) }),
  getBets:  (date) => req(`/api/bets/${date}`),
};
