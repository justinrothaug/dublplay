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
  getGames:     ()             => req("/api/games"),
  getStandings: ()             => req("/api/standings"),
  getProps:     ()             => req("/api/props"),
  analyze:      (game_id, api_key) =>
    req("/api/analyze", { method:"POST", body: JSON.stringify({ game_id, api_key }) }),
  chat: (messages, api_key) =>
    req("/api/chat", { method:"POST", body: JSON.stringify({ messages, api_key }) }),
  health: () => req("/health"),
};
