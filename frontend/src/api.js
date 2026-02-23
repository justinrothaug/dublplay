const BASE = import.meta.env.VITE_API_URL || "";

async function req(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "Request failed");
  return data;
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
};
