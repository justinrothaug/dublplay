import { useState, useEffect, useRef, useMemo } from "react";
import { api } from "./api.js";

// ── DESIGN TOKENS ─────────────────────────────────────────────────────────────
const T = {
  bg:       "#f5f5f5",
  card:     "#ffffff",
  cardAlt:  "#f8f8f8",
  green:    "#1a8d4f",
  greenDim: "rgba(26,141,79,0.08)",
  greenBdr: "rgba(26,141,79,0.25)",
  red:      "#e53935",
  redDim:   "rgba(229,57,53,0.08)",
  gold:     "#f5a623",
  text:     "#1a1a1a",
  text2:    "#555555",
  text3:    "#999999",
  border:   "rgba(0,0,0,0.08)",
  borderBr: "rgba(0,0,0,0.15)",
  // Kalshi-specific
  accent:   "#1a1a1a",
  accentBg: "#2d2d5c",
  teal:     "#1a5c6b",
};

const TEAM_COLORS = {
  NYK:"#006BB6", DET:"#C8102E", CHI:"#CE1141", TOR:"#CE1141",
  SAS:"#8A8D8F", PHX:"#E56020", CLE:"#860038", BKN:"#555",
  CHA:"#00788C", HOU:"#CE1141", LAL:"#552583", DAL:"#00538C",
  GSW:"#1D428A", BOS:"#007A33", SAC:"#5A2D81", ORL:"#0077C0",
  LAC:"#C8102E", DEN:"#0E2240", OKC:"#007AC1", MIN:"#0C2340",
  PHI:"#006BB6", MIA:"#98002E",
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
const americanToPayout = (oddsStr, stake) => {
  const o = parseInt(oddsStr?.replace("+",""), 10);
  if (isNaN(o) || !stake) return null;
  const dec = o > 0 ? (o/100)+1 : (100/Math.abs(o))+1;
  return (dec * stake).toFixed(2);
};
const edgeColor = s => s >= 4.0 ? T.green : s >= 3.0 ? T.gold : T.red;
const hitColor  = p => p >= 75 ? T.green : p >= 55 ? T.gold : T.red;

// ── FINAL GAME RESULT CALCULATOR ──────────────────────────────────────────────
// Given a final game, returns what actually hit: spread, total, moneyline
function calcFinalResults(game) {
  if (game.status !== "final") return null;
  const home = game.homeScore ?? 0;
  const away = game.awayScore ?? 0;
  const combined = home + away;

  // Moneyline
  const mlWinner = home > away ? game.home : game.away;
  const mlWinnerName = home > away ? game.homeName : game.awayName;
  const margin = Math.abs(home - away);

  // Total (O/U)
  let totalResult = null;
  if (game.ou) {
    const line = parseFloat(game.ou);
    if (!isNaN(line)) {
      totalResult = {
        label: `${game.ou} O/U`,
        combined,
        hit: combined > line ? "OVER" : combined < line ? "UNDER" : "PUSH",
      };
    }
  }

  // Spread — parse "DET -16.5" or "BOS -2.5"
  let spreadResult = null;
  if (game.spread) {
    const m = game.spread.match(/^([A-Z]+)\s*([-+]?\d+\.?\d*)$/);
    if (m) {
      const favAbbr = m[1];
      const line    = parseFloat(m[2]); // negative = favored
      const favScore = favAbbr === game.home ? home : away;
      const dogScore = favAbbr === game.home ? away : home;
      const actualMargin = favScore - dogScore;        // positive = fav won
      const needed = Math.abs(line);                    // how much fav needed to win by
      const favName = favAbbr === game.home ? game.homeName : game.awayName;
      const dogAbbr = favAbbr === game.home ? game.away : game.home;
      const dogName = favAbbr === game.home ? game.awayName : game.homeName;

      let hit;
      if (actualMargin > needed) hit = "fav";       // fav covered
      else if (actualMargin < needed) hit = "dog";  // dog covered
      else hit = "push";

      spreadResult = {
        favAbbr, favName, dogAbbr, dogName,
        line: line, // e.g. -16.5
        hit,
        actualMargin,
      };
    }
  }

  return { mlWinner, mlWinnerName, margin, totalResult, spreadResult };
}

// Parse Gemini free-text into best_bet / ou / props
// Handles numbered formats like: (1) ... (2) ... (3) ... or 1. ... 2. ... 3. ...
function parseGeminiText(text) {
  if (!text) return { best_bet: null, ou: null, props: null };

  // Try (1) / (2) / (3) format
  let m1 = text.match(/\(1\)[:\s]*([\s\S]*?)(?=\(2\)|$)/i);
  let m2 = text.match(/\(2\)[:\s]*([\s\S]*?)(?=\(3\)|$)/i);
  let m3 = text.match(/\(3\)[:\s]*([\s\S]*?)(?=\(4\)|$)/i);

  // Try 1. / 2. / 3. format
  if (!m1) {
    m1 = text.match(/^1[.)]\s*([\s\S]*?)(?=^2[.)]|$)/im);
    m2 = text.match(/^2[.)]\s*([\s\S]*?)(?=^3[.)]|$)/im);
    m3 = text.match(/^3[.)]\s*([\s\S]*?)(?=^4[.)]|$)/im);
  }

  // Try **Best Bet** / **O\/U** / **Player** headers
  if (!m1) {
    m1 = text.match(/best\s*bet[:\s]*([\s\S]*?)(?=o\/u|total|player\s*prop|$)/i);
    m2 = text.match(/(?:o\/u|total)[:\s]*([\s\S]*?)(?=player\s*prop|$)/i);
    m3 = text.match(/player\s*prop[:\s]*([\s\S]*?)$/i);
  }

  if (m1 || m2 || m3) {
    return {
      best_bet: m1 ? m1[1].trim().replace(/\*+/g, "").trim() : null,
      ou:       m2 ? m2[1].trim().replace(/\*+/g, "").trim() : null,
      props:    m3 ? m3[1].trim().replace(/\*+/g, "").trim() : null,
    };
  }

  // Fallback: put full text in best_bet
  return { best_bet: text.trim(), ou: null, props: null };
}

// ── POT ACTION: localStorage betting system ──────────────────────────────────
const AVATAR_COLORS = ["#f84646","#53d337","#4a90d9","#f5a623","#9b59b6",
                       "#1abc9c","#e74c3c","#3498db","#e67e22","#2ecc71"];
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function useProfile() {
  const [uid] = useState(() => {
    try {
      let id = localStorage.getItem("dublplay_uid");
      if (!id) { id = crypto.randomUUID(); localStorage.setItem("dublplay_uid", id); }
      return id;
    } catch { return crypto.randomUUID(); }
  });
  const [username, setUsername] = useState(() => {
    try { return localStorage.getItem("dublplay_username") || ""; } catch { return ""; }
  });
  const [balance, setBalance] = useState(() => {
    try { return parseFloat(localStorage.getItem("dublplay_balance")) || 100; } catch { return 100; }
  });
  const persist = (name, bal) => {
    try {
      localStorage.setItem("dublplay_username", name);
      localStorage.setItem("dublplay_balance", String(bal));
    } catch {}
  };
  return {
    uid, username, balance,
    setName: name => { setUsername(name); persist(name, balance); },
    deduct: amt => { setBalance(prev => { const nb = prev - amt; persist(username, nb); return nb; }); },
    credit: amt => { setBalance(prev => { const nb = prev + amt; persist(username, nb); return nb; }); },
    color: username ? avatarColor(username) : "#555",
  };
}

// ── Profile Dropdown ─────────────────────────────────────────────────────────
function ProfileDropdown({ profile, onClose }) {
  const [draft, setDraft] = useState(profile.username);
  return (
    <div style={{
      position:"fixed", inset:0, zIndex:9999,
      background:"rgba(0,0,0,0.4)", backdropFilter:"blur(4px)",
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        position:"absolute", top:52, left:12,
        background:T.card, border:`1px solid ${T.borderBr}`,
        borderRadius:14, padding:20, width:240,
        boxShadow:"0 12px 40px rgba(0,0,0,0.5)",
      }}>
        <div style={{ fontSize:10, color:T.text2, fontWeight:700, letterSpacing:"0.1em", marginBottom:12 }}>PROFILE</div>

        {/* Avatar */}
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:16 }}>
          <div style={{
            width:40, height:40, borderRadius:"50%",
            background: profile.username ? avatarColor(profile.username) : T.text3,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:18, fontWeight:800, color:"#fff",
          }}>
            {profile.username ? profile.username[0].toUpperCase() : "?"}
          </div>
          <div>
            <div style={{ color:T.text, fontSize:14, fontWeight:700 }}>{profile.username || "Not set"}</div>
            <div style={{ color:T.green, fontSize:12, fontWeight:700 }}>${profile.balance.toFixed(2)}</div>
          </div>
        </div>

        {/* Username input */}
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && draft.trim()) { profile.setName(draft.trim()); onClose(); } }}
          placeholder="Enter username..."
          maxLength={20}
          style={{
            width:"100%", boxSizing:"border-box",
            background:T.cardAlt, border:`1px solid ${T.borderBr}`,
            borderRadius:8, color:T.text, padding:"10px 12px",
            fontSize:16, fontFamily:"inherit",
          }}
        />
        <button
          onClick={() => { if (draft.trim()) { profile.setName(draft.trim()); onClose(); } }}
          style={{
            width:"100%", marginTop:10, padding:"10px 0",
            background:T.green, color:"#000", border:"none",
            borderRadius:8, fontSize:12, fontWeight:800,
            letterSpacing:"0.06em", cursor:"pointer",
          }}
        >SAVE</button>
      </div>
    </div>
  );
}

// ── Bets (Firestore-backed) ──────────────────────────────────────────────────
function useBets(dateStr) {
  const [bets, setBets] = useState({});  // { game_id: { away: [...], home: [...] } }

  // Load bets from Firestore whenever date changes
  useEffect(() => {
    if (!dateStr) return;
    api.getBets(dateStr).then(d => setBets(d.bets || {})).catch(() => {});
  }, [dateStr]);

  return {
    bets,
    reload: () => {
      if (dateStr) api.getBets(dateStr).then(d => setBets(d.bets || {})).catch(() => {});
    },
    forGame: (gid, uid) => {
      const stripped = gid.replace(/-\d{8}$/, "");
      const g = bets[stripped] || { away: [], home: [] };
      const myPick = uid ? (
        (g.away || []).some(e => e.uid === uid) ? "away" :
        (g.home || []).some(e => e.uid === uid) ? "home" : null
      ) : null;
      return { ...g, myPick, total: ((g.away || []).length + (g.home || []).length) * 10 };
    },
    pick: async (gid, side, uid, username, lockedSpread, lockedMl, date) => {
      try {
        const res = await api.placeBet(gid, side, uid, username, lockedSpread, lockedMl, date);
        // Update local state with the response
        const stripped = gid.replace(/-\d{8}$/, "");
        setBets(prev => ({ ...prev, [stripped]: res.bets }));
        return res.action; // "placed" | "switched" | "removed"
      } catch (e) {
        console.error("Bet failed:", e);
        return null;
      }
    },
  };
}

// ── FAVORITE PICKS (localStorage) ────────────────────────────────────────────
function useFavoritePicks() {
  const [picks, setPicks] = useState(() => {
    try { return JSON.parse(localStorage.getItem("dublplay_favorites") || "[]"); }
    catch { return []; }
  });
  const save = updated => {
    setPicks(updated);
    try { localStorage.setItem("dublplay_favorites", JSON.stringify(updated)); } catch {}
  };
  return {
    picks,
    has: id => picks.some(p => p.id === id),
    add: pick => save([...picks.filter(p => p.id !== pick.id), pick]),
    remove: id => save(picks.filter(p => p.id !== id)),
  };
}

function BookmarkBtn({ active, onClick, light }) {
  return (
    <button onClick={e => { e.stopPropagation(); onClick(); }} style={{
      background:"none", border:"none", cursor:"pointer",
      padding:"2px 4px", flexShrink:0,
      color: active ? T.gold : light ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.18)",
      fontSize:15, lineHeight:1,
      WebkitTapHighlightColor:"transparent",
      transition:"color 0.15s",
    }} title={active ? "Remove from My Picks" : "Save to My Picks"}>★</button>
  );
}

// ── API KEY GATE ──────────────────────────────────────────────────────────────
function ApiKeyGate({ onSubmit, serverHasKey }) {
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");
  return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:T.bg }}>
      <div style={{
        background: T.card, border:`1px solid ${T.border}`,
        borderRadius:20, padding:"52px 44px", maxWidth:400, width:"90%", textAlign:"center",
        boxShadow:"0 0 80px rgba(83,211,55,0.06)",
      }}>
        <div style={{ fontSize:48, marginBottom:12 }}>🏀</div>
        <h1 style={{ color:T.green, fontSize:28, fontWeight:800, letterSpacing:"0.04em", margin:"0 0 6px" }}>dublplay</h1>
        <p style={{ color:T.text2, fontSize:12, letterSpacing:"0.1em", margin:"0 0 32px" }}>AI-POWERED SPORTSBOOK ANALYST</p>
        {serverHasKey ? (
          <button onClick={() => onSubmit("")} style={gateBtn}>LAUNCH APP →</button>
        ) : (
          <>
            <input type="password" placeholder="Gemini API Key..."
              value={key} onChange={e => { setKey(e.target.value); setErr(""); }}
              onKeyDown={e => e.key==="Enter" && key && onSubmit(key)}
              style={{ width:"100%", boxSizing:"border-box", background:T.cardAlt,
                border:`1px solid ${err ? T.red : T.borderBr}`, borderRadius:10,
                color:T.text, padding:"13px 16px", fontSize:16, fontFamily:"inherit", marginBottom:10 }} />
            {err && <p style={{ color:T.red, fontSize:11, margin:"0 0 10px" }}>{err}</p>}
            <button onClick={() => key ? onSubmit(key) : setErr("Enter your API key")} style={gateBtn}>
              CONNECT →
            </button>
            <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer"
              style={{ color:"rgba(83,211,55,0.5)", fontSize:10, display:"block", marginTop:14 }}>
              Get a free Gemini API key →
            </a>
          </>
        )}
      </div>
    </div>
  );
}

function lineMovement(current, opening, isSpread) {
  if (!current || !opening) return null;
  const teamOf = (s) => { const m = String(s).match(/^([A-Z]{2,4})\s/); return m ? m[1] : null; };
  const numOf  = (s) => { const m = String(s).match(/-?\d+\.?\d*/g); return m ? parseFloat(m[m.length - 1]) : null; };
  const c = numOf(current), o = numOf(opening);
  if (c === null || o === null) return null;
  // If the opening spread is from the other team's perspective, flip the sign
  // e.g. current "PHI -9.5", opening "IND +6.5" → opening should be -6.5 for PHI
  let adjustedO = o;
  if (isSpread) {
    const curTeam = teamOf(current), openTeam = teamOf(opening);
    if (curTeam && openTeam && curTeam !== openTeam) adjustedO = -o;
  }
  if (c === adjustedO) return null;
  const diff = c - adjustedO;
  // For spreads: more negative = bigger favorite, so arrow up means line grew
  const arrow = isSpread ? (Math.abs(c) > Math.abs(adjustedO) ? "\u2191" : "\u2193")
                         : (diff > 0 ? "\u2191" : "\u2193");
  const color = arrow === "\u2191" ? "#4ade80" : "#f87171";
  // Show the opening value from the SAME team's perspective as the current line
  const sign = adjustedO > 0 ? "+" : "";
  const openLabel = isSpread ? `${sign}${adjustedO}` : String(opening).replace(/^[A-Z]{2,4}\s*/, "");
  return { text: `${arrow} opened ${openLabel}`, color };
}

// ── TEAM FULL NAMES ──────────────────────────────────────────────────────────
const TEAM_FULL = {
  NYK:"New York", DET:"Detroit", CHI:"Chicago", TOR:"Toronto",
  SAS:"San Antonio", PHX:"Phoenix", CLE:"Cleveland", BKN:"Brooklyn",
  CHA:"Charlotte", HOU:"Houston", LAL:"Los Angeles L", DAL:"Dallas",
  GSW:"Golden State", BOS:"Boston", SAC:"Sacramento", ORL:"Orlando",
  LAC:"Los Angeles C", DEN:"Denver", OKC:"Oklahoma City", MIN:"Minnesota",
  PHI:"Philadelphia", MIA:"Miami", MIL:"Milwaukee", IND:"Indiana",
  ATL:"Atlanta", MEM:"Memphis", NOP:"New Orleans", POR:"Portland",
  WAS:"Washington", UTA:"Utah",
};

// ── ODDS TO MULTIPLIER HELPER ────────────────────────────────────────────────
function oddsToMultiplier(oddsStr) {
  const o = parseInt(oddsStr?.replace("+",""), 10);
  if (isNaN(o)) return null;
  return o > 0 ? ((o/100)+1).toFixed(2) : ((100/Math.abs(o))+1).toFixed(2);
}

function oddsToImpliedProb(oddsStr) {
  const o = parseInt(oddsStr?.replace("+",""), 10);
  if (isNaN(o)) return null;
  const prob = o > 0 ? 100/(o+100) : Math.abs(o)/(Math.abs(o)+100);
  return Math.round(prob * 100);
}

// ── KALSHI-STYLE GAME CARD (list view) ───────────────────────────────────────
function KalshiCard({ game, aiOverride, pickRecord, onClick, betStore, profile }) {
  const isLive = game.status === "live";
  const isFinal = game.status === "final";
  const L = aiOverride?.lines || {};
  const dispAwayOdds = L.awayOdds || game.awayOdds;
  const dispHomeOdds = L.homeOdds || game.homeOdds;
  const awayMult = oddsToMultiplier(dispAwayOdds);
  const homeMult = oddsToMultiplier(dispHomeOdds);
  const awayProb = game.awayWinProb || oddsToImpliedProb(dispAwayOdds);
  const homeProb = game.homeWinProb || oddsToImpliedProb(dispHomeOdds);
  const awayC = TEAM_COLORS[game.away] || "#1a3a6e";
  const homeC = TEAM_COLORS[game.home] || "#6e1a1a";
  const dispSpread = game.spread || L.spread;
  const rawOu = L.ou || game.ou;
  const dispOu = rawOu ? rawOu.replace(/^(over\/under|over|under)\s*/i, "") : rawOu;

  // Volume approximation from pot data
  const gameBets = betStore ? betStore.forGame(game.id, profile?.uid) : null;
  const potTotal = gameBets?.total || 0;

  const fmtTime = t => {
    if (!t) return "";
    return new Date(t).toLocaleTimeString([], { hour:"numeric", minute:"2-digit" });
  };

  return (
    <div
      onClick={() => onClick(game)}
      style={{
        background: T.card,
        borderRadius: 16,
        padding: "16px 18px",
        cursor: "pointer",
        border: `1px solid ${T.border}`,
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        transition: "box-shadow 0.15s, transform 0.1s",
      }}
    >
      {/* Time + category */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
        <span style={{ fontSize:12, color:T.text3, fontWeight:500 }}>
          {isLive ? (
            <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}>
              <span style={{ width:6, height:6, borderRadius:"50%", background:T.red, display:"inline-block", animation:"pulse 1.2s infinite" }} />
              <span style={{ color:T.red, fontWeight:700 }}>LIVE · Q{game.quarter} {game.clock}</span>
            </span>
          ) : isFinal ? (
            <span style={{ color:T.text3, fontWeight:600 }}>Final</span>
          ) : (
            fmtTime(game.time)
          )}
        </span>
        <span style={{ fontSize:11, color:T.text3, fontWeight:500 }}>Pro Basketball (M)</span>
      </div>

      {/* Away team row */}
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
        <TeamBadge abbr={game.away} size={36} />
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:15, fontWeight:700, color:T.text }}>{game.awayName || TEAM_FULL[game.away] || game.away}</div>
          {!isFinal && awayProb != null && (
            <div style={{ height:3, borderRadius:2, background:"rgba(0,0,0,0.06)", marginTop:3, overflow:"hidden" }}>
              <div style={{ height:"100%", width:`${awayProb}%`, background:awayC, borderRadius:2, transition:"width 0.6s" }} />
            </div>
          )}
        </div>
        {(isLive || isFinal) && (
          <span style={{ fontSize:18, fontWeight:800, color:T.text, minWidth:24, textAlign:"right" }}>
            {game.awayScore}
          </span>
        )}
        {!isFinal && awayProb != null && (
          <span style={{
            border:`1px solid ${T.greenBdr}`, borderRadius:20, padding:"4px 12px",
            fontSize:13, fontWeight:600, color:T.green, minWidth:50, textAlign:"center",
          }}>{awayProb}%</span>
        )}
      </div>

      {/* Home team row */}
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
        <TeamBadge abbr={game.home} size={36} />
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:15, fontWeight:700, color:T.text }}>{game.homeName || TEAM_FULL[game.home] || game.home}</div>
          {!isFinal && homeProb != null && (
            <div style={{ height:3, borderRadius:2, background:"rgba(0,0,0,0.06)", marginTop:3, overflow:"hidden" }}>
              <div style={{ height:"100%", width:`${homeProb}%`, background:homeC, borderRadius:2, transition:"width 0.6s" }} />
            </div>
          )}
        </div>
        {(isLive || isFinal) && (
          <span style={{ fontSize:18, fontWeight:800, color:T.text, minWidth:24, textAlign:"right" }}>
            {game.homeScore}
          </span>
        )}
        {!isFinal && homeProb != null && (
          <span style={{
            border:`1px solid ${T.greenBdr}`, borderRadius:20, padding:"4px 12px",
            fontSize:13, fontWeight:600, color:T.green, minWidth:50, textAlign:"center",
          }}>{homeProb}%</span>
        )}
      </div>

      {/* Odds strip (upcoming/live) or AI pick results strip (final) */}
      {isFinal ? (() => {
        const r = calcFinalResults(game);
        if (!r) return null;
        // Show AI pick results with HIT/MISS instead of generic COVER/UNDER/WINNER
        const pBet = aiOverride?.best_bet || pickRecord?.best_bet;
        const pBetTeam = aiOverride?.bet_team || pickRecord?.bet_team;
        const pOu = aiOverride?.ou || pickRecord?.ou;
        let betHit = null;
        if (pickRecord?.result_bet != null) {
          betHit = pickRecord.result_bet === "HIT" ? true : pickRecord.result_bet === "MISS" ? false : "push";
        } else if (pBetTeam && r.spreadResult) {
          const bettingFav = pBetTeam === r.spreadResult.favAbbr;
          betHit = r.spreadResult.hit === "push" ? "push" : (bettingFav ? r.spreadResult.hit === "fav" : r.spreadResult.hit === "dog");
        } else if (pBetTeam) {
          betHit = pBetTeam === r.mlWinner;
        }
        let ouHit = null;
        if (pickRecord?.result_ou != null) {
          ouHit = pickRecord.result_ou === "HIT" ? true : pickRecord.result_ou === "MISS" ? false : "push";
        } else if (pOu && r.totalResult) {
          const leanedOver = /over/i.test(pOu);
          ouHit = r.totalResult.hit === "PUSH" ? "push" : (leanedOver ? r.totalResult.hit === "OVER" : r.totalResult.hit === "UNDER");
        }
        const hitClr = (h) => h === "push" ? T.gold : h === true ? T.green : h === false ? T.red : T.text3;
        const hitLabel = (h) => h === "push" ? "PUSH" : h === true ? "HIT ✓" : h === false ? "MISS ✗" : "";
        // If we have AI picks, show them as the strip; otherwise fall back to COVER/UNDER/WINNER
        if (pBet || pOu) {
          const betLine = pBet?.match(/([+-]\d+(?:\.\d+)?)/)?.[1] || "";
          const ouMatch = pOu?.match(/^(over|under)\s+([\d.]+)/i);
          const ouDir = ouMatch?.[1]?.toLowerCase() === "under" ? "U" : "O";
          const ouNum = ouMatch?.[2] || "";
          return (
            <div style={{
              display:"flex", justifyContent:"space-between", alignItems:"center",
              padding:"8px 0", marginBottom:8,
              borderTop:`1px solid ${T.border}`, borderBottom:`1px solid ${T.border}`,
              fontSize:11, fontWeight:600,
            }}>
              {pBet && (
                <div style={{ textAlign:"center", flex:1 }}>
                  <div style={{ fontSize:9, color:hitClr(betHit), fontWeight:700, letterSpacing:"0.05em", marginBottom:2 }}>
                    {hitLabel(betHit) || "BEST BET"}
                  </div>
                  <div style={{ color: hitClr(betHit) }}>✦ {pBetTeam || "?"}{betLine ? ` ${betLine}` : ""}</div>
                </div>
              )}
              {pOu && (
                <div style={{ textAlign:"center", flex:1, borderLeft: pBet ? `1px solid ${T.border}` : "none" }}>
                  <div style={{ fontSize:9, color:hitClr(ouHit), fontWeight:700, letterSpacing:"0.05em", marginBottom:2 }}>
                    {hitLabel(ouHit) || "O/U"}
                  </div>
                  <div style={{ color: hitClr(ouHit) }}>◉ {ouDir} {ouNum}</div>
                </div>
              )}
              <div style={{ textAlign:"center", flex:1, borderLeft: (pBet || pOu) ? `1px solid ${T.border}` : "none" }}>
                <div style={{ fontSize:9, color:T.text3, fontWeight:700, letterSpacing:"0.05em", marginBottom:2 }}>WINNER</div>
                <div style={{ color:T.text }}>{r.mlWinner} by {r.margin}</div>
              </div>
            </div>
          );
        }
        // Fallback: no AI picks available, show raw results
        return (
          <div style={{
            display:"flex", justifyContent:"space-between", alignItems:"center",
            padding:"8px 0", marginBottom:8,
            borderTop:`1px solid ${T.border}`, borderBottom:`1px solid ${T.border}`,
            fontSize:11, fontWeight:600,
          }}>
            {r.spreadResult && (
              <div style={{ textAlign:"center", flex:1 }}>
                <div style={{ fontSize:9, color:T.text3, fontWeight:700, letterSpacing:"0.05em", marginBottom:2 }}>
                  {r.spreadResult.hit === "push" ? "PUSH" : "COVER"}
                </div>
                <div style={{ color: r.spreadResult.hit === "push" ? T.text3 : T.text }}>
                  {r.spreadResult.hit === "fav" ? `${r.spreadResult.favAbbr} ${r.spreadResult.line}` :
                   r.spreadResult.hit === "dog" ? `${r.spreadResult.dogAbbr} +${Math.abs(r.spreadResult.line)}` :
                   dispSpread}
                </div>
              </div>
            )}
            {r.totalResult && (
              <div style={{ textAlign:"center", flex:1, borderLeft: r.spreadResult ? `1px solid ${T.border}` : "none" }}>
                <div style={{ fontSize:9, color:T.text3, fontWeight:700, letterSpacing:"0.05em", marginBottom:2 }}>
                  {r.totalResult.hit}
                </div>
                <div style={{ color:T.text }}>
                  {r.totalResult.combined} ({dispOu})
                </div>
              </div>
            )}
            <div style={{ textAlign:"center", flex:1, borderLeft: (r.spreadResult || r.totalResult) ? `1px solid ${T.border}` : "none" }}>
              <div style={{ fontSize:9, color:T.text3, fontWeight:700, letterSpacing:"0.05em", marginBottom:2 }}>WINNER</div>
              <div style={{ color:T.text }}>{r.mlWinner} by {r.margin}</div>
            </div>
          </div>
        );
      })() : (
        <div style={{
          display:"flex", justifyContent:"space-between", alignItems:"center",
          padding:"8px 0", marginBottom:8,
          borderTop:`1px solid ${T.border}`, borderBottom:`1px solid ${T.border}`,
          fontSize:11, color:T.text2, fontWeight:600,
        }}>
          {dispSpread && (
            <div style={{ textAlign:"center", flex:1 }}>
              <div style={{ fontSize:9, color:T.text3, fontWeight:700, letterSpacing:"0.05em", marginBottom:2 }}>SPREAD</div>
              <div>{dispSpread}</div>
              {(() => { const m = lineMovement(dispSpread, game.opening_spread, true); return m ? <div style={{ fontSize:9, color:m.color, marginTop:2 }}>{m.text}</div> : null; })()}
            </div>
          )}
          {dispOu && (
            <div style={{ textAlign:"center", flex:1, borderLeft: dispSpread ? `1px solid ${T.border}` : "none" }}>
              <div style={{ fontSize:9, color:T.text3, fontWeight:700, letterSpacing:"0.05em", marginBottom:2 }}>O/U</div>
              <div>{dispOu}</div>
              {(() => { const m = lineMovement(dispOu, game.opening_ou); return m ? <div style={{ fontSize:9, color:m.color, marginTop:2 }}>{m.text}</div> : null; })()}
            </div>
          )}
          {(dispAwayOdds || dispHomeOdds) && (
            <div style={{ textAlign:"center", flex:1, borderLeft: (dispSpread || dispOu) ? `1px solid ${T.border}` : "none" }}>
              <div style={{ fontSize:9, color:T.text3, fontWeight:700, letterSpacing:"0.05em", marginBottom:2 }}>ML</div>
              <div>{dispAwayOdds || "—"} / {dispHomeOdds || "—"}</div>
            </div>
          )}
        </div>
      )}

      {/* Bottom row: pick badges + vol */}
      {(() => {
        // Compute AI pick hit/miss for final games
        let bestBetHit = null;
        let ouHitCard = null;
        if (isFinal) {
          const r = calcFinalResults(game);
          if (r) {
            // Use pickRecord for hit/miss when aiOverride isn't loaded
            const betTeam = aiOverride?.bet_team || pickRecord?.bet_team;
            if (pickRecord?.result_bet != null) {
              bestBetHit = pickRecord.result_bet === "HIT" ? true : pickRecord.result_bet === "MISS" ? false : "push";
            } else if (betTeam) {
              if (r.spreadResult) {
                const bettingFav = betTeam === r.spreadResult.favAbbr;
                bestBetHit = r.spreadResult.hit === "push" ? "push" : (bettingFav ? r.spreadResult.hit === "fav" : r.spreadResult.hit === "dog");
              } else {
                bestBetHit = betTeam === r.mlWinner;
              }
            }
            const ouPick = aiOverride?.ou || pickRecord?.ou;
            if (pickRecord?.result_ou != null) {
              ouHitCard = pickRecord.result_ou === "HIT" ? true : pickRecord.result_ou === "MISS" ? false : "push";
            } else if (ouPick && r.totalResult) {
              const leanedOver = /over/i.test(ouPick);
              ouHitCard = r.totalResult.hit === "PUSH" ? "push" : (leanedOver ? r.totalResult.hit === "OVER" : r.totalResult.hit === "UNDER");
            }
          }
        }
        // Resolve pick display: prefer aiOverride, fall back to pickRecord
        const dispBestBet = aiOverride?.best_bet || pickRecord?.best_bet;
        const dispBetTeam = aiOverride?.bet_team || pickRecord?.bet_team;
        const dispBetScore = aiOverride?.dubl_score_bet ?? pickRecord?.dubl_score_bet;
        const dispOuPick = aiOverride?.ou || pickRecord?.ou;
        const dispOuScore = aiOverride?.dubl_score_ou ?? pickRecord?.dubl_score_ou;
        const hitIcon = (h) => h === "push" ? " 🟰" : h === true ? " ✓" : h === false ? " ✗" : "";
        const hitClr = (h) => h === true ? T.green : h === false ? T.red : null;
        return (
      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
        {/* Best bet pick */}
        {dispBestBet && dispBetScore != null && (() => {
          const betLine = dispBestBet.match(/([+-]\d+(?:\.\d+)?)/)?.[1] || "";
          const label = `✦ ${dispBetTeam || "?"}${betLine ? ` ${betLine}` : ""}`;
          const sc = dispBetScore;
          const ec2 = isFinal && bestBetHit != null ? (hitClr(bestBetHit) || T.gold) : edgeColor(sc);
          const badgeColor = isFinal && bestBetHit != null ? (hitClr(bestBetHit) || T.green) : T.green;
          return (
            <div style={{ display:"flex", alignItems:"center", gap:5, flex:1, minWidth:0 }}>
              <span style={{
                fontSize:10, fontWeight:700, letterSpacing:"0.04em",
                color:badgeColor, background:`${badgeColor}12`, border:`1px solid ${badgeColor}33`,
                borderRadius:6, padding:"3px 8px",
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
              }}>{label}{hitIcon(bestBetHit)}</span>
              {!isFinal && <div style={{
                width:22, height:22, borderRadius:"50%", flexShrink:0,
                border:`2px solid ${ec2}`, background:`${ec2}12`,
                display:"flex", alignItems:"center", justifyContent:"center",
                fontSize:9, fontWeight:800, color:ec2,
              }}>{sc}</div>}
            </div>
          );
        })()}
        {/* O/U pick */}
        {dispOuPick && dispOuScore != null && (() => {
          const ouMatch = dispOuPick.match(/^(over|under)\s+([\d.]+)/i);
          const ouDir = ouMatch?.[1]?.toLowerCase() === "under" ? "U" : "O";
          const ouNum = ouMatch?.[2] || "";
          const label = `◉ ${ouDir} ${ouNum}`;
          const sc = dispOuScore;
          const ec2 = isFinal && ouHitCard != null ? (hitClr(ouHitCard) || T.gold) : edgeColor(sc);
          const badgeColor = isFinal && ouHitCard != null ? (hitClr(ouHitCard) || T.gold) : T.gold;
          return (
            <div style={{ display:"flex", alignItems:"center", gap:5, flex:1, minWidth:0 }}>
              <span style={{
                fontSize:10, fontWeight:700, letterSpacing:"0.04em",
                color:badgeColor, background:`${badgeColor}12`, border:`1px solid ${badgeColor}33`,
                borderRadius:6, padding:"3px 8px",
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
              }}>{label}{hitIcon(ouHitCard)}</span>
              {!isFinal && <div style={{
                width:22, height:22, borderRadius:"50%", flexShrink:0,
                border:`2px solid ${ec2}`, background:`${ec2}12`,
                display:"flex", alignItems:"center", justifyContent:"center",
                fontSize:9, fontWeight:800, color:ec2,
              }}>{sc}</div>}
            </div>
          );
        })()}
        {/* Vol on the right */}
        {potTotal > 0 && (
          <span style={{ fontSize:11, color:T.text3, fontWeight:500, flexShrink:0, marginLeft:"auto" }}>${potTotal} vol</span>
        )}
      </div>
        );
      })()}
    </div>
  );
}

// ── KALSHI-STYLE GAME DETAIL VIEW ────────────────────────────────────────────
function KalshiDetail({ game, aiOverride, onBack, onRefresh, loadingRefresh, favorites, onFavorite, pickRecord, gameBets, onBet, username, onPickOdds, profile }) {
  const isLive = game.status === "live";
  const isFinal = game.status === "final";
  const isUp = game.status === "upcoming";
  const L = aiOverride?.lines || {};
  const dispSpread = game.spread || L.spread;
  const rawOu = L.ou || game.ou;
  const dispOu = rawOu ? rawOu.replace(/^(over\/under|over|under)\s*/i, "") : rawOu;
  const dispAwayOdds = L.awayOdds || game.awayOdds;
  const dispHomeOdds = L.homeOdds || game.homeOdds;
  const awayMult = oddsToMultiplier(dispAwayOdds);
  const homeMult = oddsToMultiplier(dispHomeOdds);
  const awayProb = game.awayWinProb || oddsToImpliedProb(dispAwayOdds);
  const homeProb = game.homeWinProb || oddsToImpliedProb(dispHomeOdds);
  const awayC = TEAM_COLORS[game.away] || "#1a3a6e";
  const homeC = TEAM_COLORS[game.home] || "#6e1a1a";

  const analysis = aiOverride || game.analysis;
  const myPick = gameBets?.myPick;

  const handleSidePick = (side) => {
    if (!isUp || !onBet) return;
    const ml = side === "away" ? dispAwayOdds : dispHomeOdds;
    onBet(game.id, side, dispSpread || "", ml || "");
  };

  // Parse spread into per-team lines (e.g. "ORL -9.5" → away gets +9.5, home gets -9.5)
  const spreadParsed = (() => {
    if (!dispSpread) return null;
    const m = dispSpread.match(/([A-Z]{2,4})\s*([+-]?\d+\.?\d*)/);
    if (!m) return null;
    const favTeam = m[1];
    const favLine = parseFloat(m[2]);
    const awayLine = favTeam === game.away ? favLine : -favLine;
    const homeLine = favTeam === game.home ? favLine : -favLine;
    return {
      away: awayLine > 0 ? `+${awayLine}` : String(awayLine),
      home: homeLine > 0 ? `+${homeLine}` : String(homeLine),
    };
  })();

  return (
    <div style={{ minHeight:"100vh", background:T.bg }}>
      {/* Header */}
      <div style={{
        background:T.card, borderBottom:`1px solid ${T.border}`,
        display:"flex", alignItems:"center", padding:"14px 16px", gap:12,
        position:"sticky", top:0, zIndex:50,
      }}>
        <button onClick={onBack} style={{
          background:"none", border:"none", fontSize:20, color:T.text, padding:"4px 8px",
          display:"flex", alignItems:"center",
        }}>
          ←
        </button>
        <div style={{ flex:1, textAlign:"center" }}>
          <span style={{ fontSize:15, fontWeight:700, color:T.text }}>
            {game.awayName || TEAM_FULL[game.away] || game.away} at {game.homeName || TEAM_FULL[game.home] || game.home}
          </span>
        </div>
        <button onClick={() => onRefresh(game.id)} style={{
          background:"none", border:"none", fontSize:16, color:T.text3, padding:"4px 8px",
        }}>
          {loadingRefresh ? <span style={{ display:"inline-block", animation:"spin 0.8s linear infinite" }}>↻</span> : "↻"}
        </button>
      </div>

      <div style={{ maxWidth:480, margin:"0 auto", padding:"0 16px 120px" }}>
        {/* Win probability display */}
        {(awayProb != null || homeProb != null) && (
          <div style={{ padding:"20px 0 10px", textAlign:"center" }}>
            {(isLive || isFinal) && (
              <div style={{ display:"flex", justifyContent:"center", alignItems:"center", gap:10, marginBottom:12 }}>
                <span style={{ fontSize:34, fontWeight:900, color:T.text }}>{game.awayScore}</span>
                <span style={{ fontSize:16, color:T.text3 }}>–</span>
                <span style={{ fontSize:34, fontWeight:900, color:T.text }}>{game.homeScore}</span>
              </div>
            )}
            {isLive && (
              <div style={{ display:"inline-flex", alignItems:"center", gap:5, background:"rgba(229,57,53,0.08)", borderRadius:20, padding:"4px 14px", marginBottom:12 }}>
                <span style={{ width:6, height:6, borderRadius:"50%", background:T.red, display:"inline-block", animation:"pulse 1.2s infinite" }} />
                <span style={{ color:T.red, fontSize:11, fontWeight:700 }}>Q{game.quarter} {game.clock}</span>
              </div>
            )}
            <div style={{ display:"flex", justifyContent:"center", gap:6, fontSize:13, color:T.text3, marginBottom:4 }}>
              <span>{game.away} <strong style={{color:T.text}}>{awayProb}%</strong></span>
              <span>·</span>
              <span>{game.home} <strong style={{color:T.text}}>{homeProb}%</strong></span>
            </div>
            {/* Probability bar */}
            {awayProb != null && homeProb != null && (
              <div style={{ width:"80%", maxWidth:300, height:6, borderRadius:3, background:"#eee", overflow:"hidden", margin:"10px auto" }}>
                <div style={{ height:"100%", width:`${awayProb}%`, background:awayC, borderRadius:3, transition:"width 0.6s" }} />
              </div>
            )}
          </div>
        )}

        {/* Pot + balance bar */}
        <div style={{
          display:"flex", justifyContent:"space-between", alignItems:"center",
          padding:"10px 14px", marginBottom:12,
          background:T.cardAlt, borderRadius:10, border:`1px solid ${T.border}`,
        }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            {gameBets?.total > 0 && (
              <span style={{ fontSize:12, fontWeight:700, color:T.green }}>${gameBets.total} pot</span>
            )}
            {!isLive && !isFinal && game.time && (
              <span style={{ fontSize:11, color:T.text3 }}>
                {new Date(game.time).toLocaleTimeString([], { hour:"numeric", minute:"2-digit" })}
              </span>
            )}
          </div>
          {profile?.username && (() => {
            const awayCount = (gameBets?.away || []).length;
            const homeCount = (gameBets?.home || []).length;
            const awayPot = awayCount * 10;
            const homePot = homeCount * 10;
            const potentialWin = myPick === "away" && awayCount > 0 ? Math.round(homePot / awayCount)
              : myPick === "home" && homeCount > 0 ? Math.round(awayPot / homeCount)
              : null;
            return potentialWin != null ? (
              <span style={{ fontSize:12, fontWeight:700, color:T.green }}>
                To win: ${potentialWin}
              </span>
            ) : (
              <span style={{ fontSize:12, fontWeight:700, color:T.text2 }}>
                Balance: <span style={{ color:T.green }}>${profile.balance?.toFixed(0)}</span>
              </span>
            );
          })()}
        </div>

        {/* Bettor avatars above team buttons */}
        <div style={{ display:"flex", gap:10, marginBottom:6 }}>
          {/* Away bettors */}
          <div style={{ flex:1, display:"flex", justifyContent:"center", gap:4, flexWrap:"wrap", minHeight:28 }}>
            {(gameBets?.away || []).map((e, i) => (
              <div key={i} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:1 }}>
                <div style={{
                  width:24, height:24, borderRadius:"50%",
                  background: avatarColor(e.username),
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontSize:10, fontWeight:800, color:"#fff",
                  border: e.uid === profile?.uid ? `2px solid ${T.green}` : "2px solid #ddd",
                }}>{e.username[0].toUpperCase()}</div>
                {e.lockedSpread && (
                  <div style={{ fontSize:7, fontWeight:800, color:T.text3, lineHeight:1 }}>
                    {e.lockedSpread.replace(/^[A-Z]{2,4}\s*/, "")}
                  </div>
                )}
              </div>
            ))}
          </div>
          {/* Home bettors */}
          <div style={{ flex:1, display:"flex", justifyContent:"center", gap:4, flexWrap:"wrap", minHeight:28 }}>
            {(gameBets?.home || []).map((e, i) => (
              <div key={i} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:1 }}>
                <div style={{
                  width:24, height:24, borderRadius:"50%",
                  background: avatarColor(e.username),
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontSize:10, fontWeight:800, color:"#fff",
                  border: e.uid === profile?.uid ? `2px solid ${T.green}` : "2px solid #ddd",
                }}>{e.username[0].toUpperCase()}</div>
                {e.lockedSpread && (
                  <div style={{ fontSize:7, fontWeight:800, color:T.text3, lineHeight:1 }}>
                    {e.lockedSpread.replace(/^[A-Z]{2,4}\s*/, "")}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Team pick buttons — clicking places a $10 spread bet */}
        {(() => {
          return (
            <div style={{ display:"flex", gap:10, marginBottom:4 }}>
              <button
                onClick={() => handleSidePick("away")}
                style={{
                  flex:1, padding:"14px 16px", borderRadius:12,
                  background: myPick === "away" ? awayC : T.accentBg,
                  border: myPick === "away" ? `3px solid #fff` : "3px solid transparent",
                  boxShadow: myPick === "away" ? `0 0 0 2px ${awayC}, 0 4px 12px rgba(0,0,0,0.3)` : "none",
                  color: "#fff", fontSize:15, fontWeight:700,
                  cursor: isUp ? "pointer" : "default",
                  opacity: isUp ? 1 : 0.7,
                  textAlign:"center",
                  transition: "all 0.15s",
                }}
              >
                <span style={{ display:"inline-flex", alignItems:"center", gap:6, justifyContent:"center" }}>
                  {game.away}
                  {myPick === "away" && (
                    <span style={{
                      width:18, height:18, borderRadius:"50%", background:"rgba(255,255,255,0.25)",
                      display:"inline-flex", alignItems:"center", justifyContent:"center",
                      fontSize:11, lineHeight:1,
                    }}>✓</span>
                  )}
                </span>
              </button>
              <button
                onClick={() => handleSidePick("home")}
                style={{
                  flex:1, padding:"14px 16px", borderRadius:12,
                  background: myPick === "home" ? homeC : T.teal,
                  border: myPick === "home" ? `3px solid #fff` : "3px solid transparent",
                  boxShadow: myPick === "home" ? `0 0 0 2px ${homeC}, 0 4px 12px rgba(0,0,0,0.3)` : "none",
                  color: "#fff", fontSize:15, fontWeight:700,
                  cursor: isUp ? "pointer" : "default",
                  opacity: isUp ? 1 : 0.7,
                  textAlign:"center",
                  transition: "all 0.15s",
                }}
              >
                <span style={{ display:"inline-flex", alignItems:"center", gap:6, justifyContent:"center" }}>
                  {game.home}
                  {myPick === "home" && (
                    <span style={{
                      width:18, height:18, borderRadius:"50%", background:"rgba(255,255,255,0.25)",
                      display:"inline-flex", alignItems:"center", justifyContent:"center",
                      fontSize:11, lineHeight:1,
                    }}>✓</span>
                  )}
                </span>
              </button>
            </div>
          );
        })()}

        {/* Spread line under each button */}
        <div style={{ display:"flex", gap:10, marginBottom:8, textAlign:"center" }}>
          <div style={{ flex:1, fontSize:13, color:T.text3, fontWeight:600 }}>
            {spreadParsed ? spreadParsed.away : ""}
          </div>
          <div style={{ flex:1, fontSize:13, color:T.text3, fontWeight:600 }}>
            {spreadParsed ? spreadParsed.home : ""}
          </div>
        </div>

        {/* Bet hint */}
        {isUp && onBet && (
          <div style={{ textAlign:"center", fontSize:11, color:T.text3, marginBottom:16 }}>
            {myPick
              ? `You picked ${myPick === "away" ? game.away : game.home} · tap again to remove`
              : "Tap a team to place a $10 bet"}
          </div>
        )}

        {/* Odds strip: Spread | O/U | ML — right above analysis */}
        <div style={{
          display:"flex", justifyContent:"space-between", alignItems:"center",
          padding:"8px 0", marginBottom:12,
          borderTop:`1px solid ${T.border}`, borderBottom:`1px solid ${T.border}`,
          fontSize:11, color:T.text2, fontWeight:600,
        }}>
          {dispSpread && (
            <div style={{ textAlign:"center", flex:1 }}>
              <div style={{ fontSize:9, color:T.text3, fontWeight:700, letterSpacing:"0.05em", marginBottom:2 }}>SPREAD</div>
              <div>{dispSpread}</div>
              {(() => { const m = lineMovement(dispSpread, game.opening_spread, true); return m ? <div style={{ fontSize:9, color:m.color, marginTop:2 }}>{m.text}</div> : null; })()}
            </div>
          )}
          {dispOu && (
            <div style={{ textAlign:"center", flex:1, borderLeft: dispSpread ? `1px solid ${T.border}` : "none" }}>
              <div style={{ fontSize:9, color:T.text3, fontWeight:700, letterSpacing:"0.05em", marginBottom:2 }}>O/U</div>
              <div>{dispOu}</div>
              {(() => { const m = lineMovement(dispOu, game.opening_ou); return m ? <div style={{ fontSize:9, color:m.color, marginTop:2 }}>{m.text}</div> : null; })()}
            </div>
          )}
          {(dispAwayOdds || dispHomeOdds) && (
            <div style={{ textAlign:"center", flex:1, borderLeft: (dispSpread || dispOu) ? `1px solid ${T.border}` : "none" }}>
              <div style={{ fontSize:9, color:T.text3, fontWeight:700, letterSpacing:"0.05em", marginBottom:2 }}>ML</div>
              <div>{dispAwayOdds || "—"} / {dispHomeOdds || "—"}</div>
            </div>
          )}
        </div>

        {/* Analysis section — no tabs, always shown */}
        <div style={{ marginTop:8 }}>
          {isFinal
            ? <FinalResultsPanel game={game} aiOverride={aiOverride} pickRecord={pickRecord} />
            : <AnalysisPanel
                analysis={analysis}
                isLive={isLive}
                loading={loadingRefresh}
                game={game}
                favorites={favorites}
                onFavorite={onFavorite}
              />
          }
        </div>
      </div>
    </div>
  );
}

// ── KALSHI-STYLE VERTICAL GAME LIST ──────────────────────────────────────────
function KalshiGameList({ games, aiOverrides, onGameClick, lastUpdated, upcomingLabel, betStore, profile, loading, picksMap }) {
  const liveGames = games.filter(g => g.status === "live");
  const upcomingGames = games.filter(g => g.status === "upcoming");
  const finalGames = games.filter(g => g.status === "final");
  const ordered = [...liveGames, ...upcomingGames, ...finalGames];

  return (
    <div style={{ maxWidth:480, margin:"0 auto", padding:"0 16px 120px" }}>
      {/* Section header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"20px 0 16px" }}>
        <span style={{ fontSize:20, fontWeight:800, color:T.text }}>Pro Basketball (M)</span>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          {liveGames.length > 0 && (
            <span style={{ display:"inline-flex", alignItems:"center", gap:4, fontSize:11, color:T.red, fontWeight:700 }}>
              <span style={{ width:6, height:6, borderRadius:"50%", background:T.red, display:"inline-block", animation:"pulse 1.2s infinite" }} />
              {liveGames.length} Live
            </span>
          )}
          <span style={{ fontSize:20, color:T.text3, cursor:"pointer" }}>›</span>
        </div>
      </div>

      {/* Game cards */}
      <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
        {ordered.map(g => {
          const baseId = g.id.replace(/-\d{8}$/, "");
          return (
          <KalshiCard
            key={g.id}
            game={g}
            aiOverride={aiOverrides[g.id]}
            pickRecord={picksMap ? (picksMap[baseId] || picksMap[g.id]) : null}
            onClick={onGameClick}
            betStore={betStore}
            profile={profile}
          />
          );
        })}
      </div>

      {ordered.length === 0 && loading && (
        <div style={{ textAlign:"center", padding:"60px 20px" }}>
          <span style={{
            display:"inline-block", width:32, height:32,
            border:"3px solid rgba(0,0,0,0.08)",
            borderTopColor:T.green,
            borderRadius:"50%",
            animation:"spin 0.8s linear infinite",
          }} />
          <div style={{ fontSize:13, color:T.text3, marginTop:12 }}>Loading games...</div>
        </div>
      )}

      {ordered.length === 0 && !loading && (
        <div style={{ textAlign:"center", padding:"60px 20px", color:T.text3 }}>
          <div style={{ fontSize:40, marginBottom:12 }}>🏀</div>
          <div style={{ fontSize:14 }}>No games scheduled</div>
        </div>
      )}
    </div>
  );
}

// ── KALSHI-STYLE MY BETS TAB ─────────────────────────────────────────────────
// Pick card: KalshiCard-style game card with pick/status/score bottom strip
function PickGameCard({ pick, game, onGameClick, onRemove, onSave }) {
  const isBet = pick.type === "bet";
  const isOu = pick.type === "ou";
  const isLive = game.status === "live";
  const isFinal = game.status === "final";
  const color = isBet ? T.green : isOu ? T.gold : "#a78bfa";
  const ec = pick.score != null ? edgeColor(pick.score) : T.text3;
  const L = pick.aiOverride?.lines || {};
  const dispAwayOdds = L.awayOdds || game.awayOdds;
  const dispHomeOdds = L.homeOdds || game.homeOdds;
  const awayMult = oddsToMultiplier(dispAwayOdds);
  const homeMult = oddsToMultiplier(dispHomeOdds);
  const awayProb = game.awayWinProb || oddsToImpliedProb(dispAwayOdds);
  const homeProb = game.homeWinProb || oddsToImpliedProb(dispHomeOdds);
  const awayC = TEAM_COLORS[game.away] || "#1a3a6e";
  const homeC = TEAM_COLORS[game.home] || "#6e1a1a";

  // Build short pick label (e.g. "✦ DAL +8.5" or "◉ O 228.5")
  const betLine = isBet ? (pick.text?.match(/([+-]\d+(?:\.\d+)?)/)?.[1] || "") : "";
  const ouMatch = isOu ? pick.text?.match(/^(over|under)\s+([\d.]+)/i) : null;
  const ouDir = ouMatch?.[1]?.toLowerCase() === "under" ? "U" : "O";
  const ouLineNum = ouMatch?.[2] || game.ou || "";
  const pickLabel = isBet
    ? `✦ ${pick.betTeam || "?"}${betLine ? ` ${betLine}` : ""}`
    : isOu
    ? `◉ ${ouDir} ${ouLineNum}`
    : `▸ ${(pick.text?.split(" ").slice(0,3).join(" ") || "PROP")}`;

  // Live tracking status
  let statusText = null;
  let statusColor = T.text3;
  if (isLive) {
    if (isBet && pick.betTeam) {
      const isBettingHome = pick.betTeam === game.home;
      const margin = (isBettingHome ? (game.homeScore||0) : (game.awayScore||0))
                   - (isBettingHome ? (game.awayScore||0) : (game.homeScore||0));
      statusText = margin > 0 ? "LEAD" : margin < 0 ? "TRAIL" : "TIED";
      statusColor = margin > 0 ? T.green : margin < 0 ? T.red : T.gold;
    } else if (isOu) {
      const pace = calcLivePace(game);
      const isOver = ouDir === "O";
      if (pace) {
        const onTrack = isOver ? pace.projected > pace.ouLine : pace.projected < pace.ouLine;
        statusText = onTrack ? "TRACK" : "FADE";
        statusColor = onTrack ? T.green : T.red;
      }
    }
  }

  // Final result hit/miss
  let finalHit = null;
  if (isFinal) {
    const r = calcFinalResults(game);
    if (r) {
      if (isBet) {
        if (pick.betIsSpread && r.spreadResult) {
          const bettingFav = pick.betTeam === r.spreadResult.favAbbr;
          const h = bettingFav ? r.spreadResult.hit === "fav" : r.spreadResult.hit === "dog";
          finalHit = r.spreadResult.hit === "push" ? "push" : h;
        } else if (pick.betTeam) {
          finalHit = pick.betTeam === r.mlWinner;
        }
      } else if (isOu && r.totalResult) {
        finalHit = r.totalResult.hit === "PUSH" ? "push" : (ouDir === "O") ? r.totalResult.hit === "OVER" : r.totalResult.hit === "UNDER";
      }
    }
  }

  const fmtTime = t => t ? new Date(t).toLocaleTimeString([], { hour:"numeric", minute:"2-digit" }) : "";

  return (
    <div
      onClick={() => onGameClick(game)}
      style={{
        background:T.card, borderRadius:16, overflow:"hidden",
        cursor:"pointer", border:`1px solid ${T.border}`,
        boxShadow:"0 1px 3px rgba(0,0,0,0.04)",
      }}
    >
      {/* Main card body — same layout as KalshiCard */}
      <div style={{ padding:"16px 18px 12px" }}>
        {/* Time + category */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
          <span style={{ fontSize:12, color:T.text3, fontWeight:500 }}>
            {isLive ? (
              <span style={{ display:"inline-flex", alignItems:"center", gap:5 }}>
                <span style={{ width:6, height:6, borderRadius:"50%", background:T.red, display:"inline-block", animation:"pulse 1.2s infinite" }} />
                <span style={{ color:T.red, fontWeight:700 }}>LIVE · Q{game.quarter} {game.clock}</span>
              </span>
            ) : isFinal ? (
              <span style={{ color:T.text3, fontWeight:600 }}>Final</span>
            ) : (
              fmtTime(game.time)
            )}
          </span>
          <span style={{ fontSize:11, color:T.text3, fontWeight:500 }}>Pro Basketball (M)</span>
        </div>

        {/* Away team row */}
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
          <TeamBadge abbr={game.away} size={36} />
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:15, fontWeight:700, color:T.text }}>{game.awayName || TEAM_FULL[game.away] || game.away}</div>
            {awayProb != null && (
              <div style={{ height:3, borderRadius:2, background:"rgba(0,0,0,0.06)", marginTop:3, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${awayProb}%`, background:awayC, borderRadius:2, transition:"width 0.6s" }} />
              </div>
            )}
          </div>
          {(isLive || isFinal) && (
            <span style={{ fontSize:18, fontWeight:800, color:T.text, minWidth:24, textAlign:"right" }}>{game.awayScore}</span>
          )}
          {awayProb != null && (
            <span style={{
              border:`1px solid ${T.greenBdr}`, borderRadius:20, padding:"4px 12px",
              fontSize:13, fontWeight:600, color:T.green, minWidth:50, textAlign:"center",
            }}>{awayProb}%</span>
          )}
        </div>

        {/* Home team row */}
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <TeamBadge abbr={game.home} size={36} />
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:15, fontWeight:700, color:T.text }}>{game.homeName || TEAM_FULL[game.home] || game.home}</div>
            {homeProb != null && (
              <div style={{ height:3, borderRadius:2, background:"rgba(0,0,0,0.06)", marginTop:3, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${homeProb}%`, background:homeC, borderRadius:2, transition:"width 0.6s" }} />
              </div>
            )}
          </div>
          {(isLive || isFinal) && (
            <span style={{ fontSize:18, fontWeight:800, color:T.text, minWidth:24, textAlign:"right" }}>{game.homeScore}</span>
          )}
          {homeProb != null && (
            <span style={{
              border:`1px solid ${T.greenBdr}`, borderRadius:20, padding:"4px 12px",
              fontSize:13, fontWeight:600, color:T.green, minWidth:50, textAlign:"center",
            }}>{homeProb}%</span>
          )}
        </div>
      </div>

      {/* ── Odds strip (light theme, matching Explore cards) ── */}
      {(() => {
        const rawOu = L.ou || game.ou;
        const dispSpread = game.spread || L.spread;
        const dispOu = rawOu ? String(rawOu).replace(/^(over\/under|over|under)\s*/i, "") : rawOu;
        const showOdds = dispSpread || dispOu || dispHomeOdds;
        return showOdds ? (
          <div style={{
            display:"flex", justifyContent:"space-between", alignItems:"center",
            padding:"8px 18px", margin:0,
            borderTop:`1px solid ${T.border}`, borderBottom:`1px solid ${T.border}`,
            fontSize:11, color:T.text2, fontWeight:600,
          }}>
            {dispSpread && (
              <div style={{ textAlign:"center", flex:1 }}>
                <div style={{ fontSize:9, color:T.text3, fontWeight:700, letterSpacing:"0.05em", marginBottom:2 }}>SPREAD</div>
                <div>{dispSpread}</div>
                {(() => { const m = lineMovement(dispSpread, game.opening_spread, true); return m ? <div style={{ fontSize:9, color:m.color, marginTop:2 }}>{m.text}</div> : null; })()}
              </div>
            )}
            {dispOu && (
              <div style={{ textAlign:"center", flex:1, borderLeft: dispSpread ? `1px solid ${T.border}` : "none" }}>
                <div style={{ fontSize:9, color:T.text3, fontWeight:700, letterSpacing:"0.05em", marginBottom:2 }}>O/U</div>
                <div>{dispOu}{isLive && game.ouDir ? ` ${game.ouDir}` : ""}</div>
                {(() => { const m = lineMovement(dispOu, game.opening_ou); return m ? <div style={{ fontSize:9, color:m.color, marginTop:2 }}>{m.text}</div> : null; })()}
              </div>
            )}
            {dispHomeOdds && dispAwayOdds && (
              <div style={{ textAlign:"center", flex:1, borderLeft: (dispSpread || dispOu) ? `1px solid ${T.border}` : "none" }}>
                <div style={{ fontSize:9, color:T.text3, fontWeight:700, letterSpacing:"0.05em", marginBottom:2 }}>ML</div>
                <div>{dispAwayOdds} / {dispHomeOdds}</div>
              </div>
            )}
          </div>
        ) : null;
      })()}

      {/* Bottom strip: pick label | status | DUBL score */}
      <div style={{
        display:"flex", alignItems:"center", gap:6, padding:"8px 16px",
        background:T.cardAlt, borderTop:`1px solid ${T.border}`,
      }}>
        {/* Pick badge */}
        <span style={{
          fontSize:10, fontWeight:700, letterSpacing:"0.04em",
          color, background:`${color}12`, border:`1px solid ${color}33`,
          borderRadius:6, padding:"3px 8px",
          flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
        }}>{pickLabel}</span>

        {/* Live status badge */}
        {isLive && statusText && (
          <span style={{
            fontSize:9, fontWeight:800, letterSpacing:"0.04em",
            color:statusColor, background:`${statusColor}12`, border:`1px solid ${statusColor}33`,
            borderRadius:6, padding:"3px 7px", flexShrink:0,
          }}>{statusText}</span>
        )}

        {/* Final hit/miss badge */}
        {isFinal && finalHit !== null && (
          <span style={{
            fontSize:9, fontWeight:800, letterSpacing:"0.04em",
            color: finalHit === "push" ? T.gold : finalHit ? T.green : T.red,
            background: `${finalHit === "push" ? T.gold : finalHit ? T.green : T.red}12`,
            border: `1px solid ${finalHit === "push" ? T.gold : finalHit ? T.green : T.red}33`,
            borderRadius:6, padding:"3px 7px", flexShrink:0,
          }}>{finalHit === "push" ? "PUSH" : finalHit ? "HIT" : "MISS"}</span>
        )}

        {/* DUBL score circle */}
        {pick.score != null && (
          <div style={{
            width:26, height:26, borderRadius:"50%", flexShrink:0,
            border:`2px solid ${ec}`, background:`${ec}12`,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:10, fontWeight:800, color:ec,
          }}>{pick.score}</div>
        )}

        {/* Star: filled if saved (tap to remove), outline if unsaved (tap to save) */}
        {onRemove ? (
          <button onClick={e => { e.stopPropagation(); onRemove(); }} style={{
            background:"none", border:"none", fontSize:15, color:T.gold, cursor:"pointer",
            padding:"0 2px", flexShrink:0,
          }}>★</button>
        ) : onSave ? (
          <button onClick={e => { e.stopPropagation(); onSave(); }} style={{
            background:"none", border:"none", fontSize:15, color:T.text3, cursor:"pointer",
            padding:"0 2px", flexShrink:0,
          }}>☆</button>
        ) : null}
      </div>
    </div>
  );
}

function KalshiMyBets({ games, aiOverrides, onPickOdds, favorites, onFavorite, onGameClick }) {
  // Top picks — auto-generated from AI analysis
  const picks = [];
  for (const g of games) {
    if (g.status === "final") continue;
    const a = aiOverrides[g.id];
    if (!a) continue;
    if (a.best_bet && a.dubl_score_bet != null)
      picks.push({ type:"bet", score:a.dubl_score_bet, text:a.best_bet, betTeam:a.bet_team, betIsSpread:a.bet_is_spread, game:g, reasoning:a.dubl_reasoning_bet, aiOverride:a });
    if (a.ou && a.dubl_score_ou != null)
      picks.push({ type:"ou", score:a.dubl_score_ou, text:a.ou, game:g, reasoning:a.dubl_reasoning_ou, aiOverride:a });
  }
  const topAll = picks.sort((a,b) => b.score - a.score).slice(0, 6);

  // Saved picks — user-bookmarked
  const favPicks = (favorites?.picks || [])
    .map(p => {
      const basePickId = p.gameId.replace(/-\d{8}$/, "");
      const game = games.find(g => g.id === p.gameId || g.id.replace(/-\d{8}$/, "") === basePickId);
      if (!game) return null;
      return { ...p, game, aiOverride: aiOverrides[game.id] };
    })
    .filter(Boolean);

  // Deduplicate: remove top picks whose game is already in saved picks
  const favGameIds = new Set(favPicks.map(p => p.game.id));
  const top = topAll.filter(p => !favGameIds.has(p.game.id));

  return (
    <div style={{ maxWidth:480, margin:"0 auto", padding:"0 16px 120px" }}>
      {/* Saved picks — shown first */}
      {favPicks.length > 0 && (
        <div style={{ padding:"20px 0 0" }}>
          <span style={{ fontSize:20, fontWeight:800, color:T.text }}>My Picks</span>
          <p style={{ fontSize:13, color:T.text3, marginTop:4, marginBottom:16 }}>Your saved picks</p>
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            {favPicks.map(pick => (
              <PickGameCard
                key={pick.id}
                pick={pick}
                game={pick.game}
                onGameClick={onGameClick}
                onRemove={() => onFavorite.remove(pick.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Top AI picks — after My Picks, excluding duplicates */}
      {top.length > 0 && (
        <div style={{ padding:"24px 0 0" }}>
          <span style={{ fontSize:20, fontWeight:800, color:T.text }}>Top Picks</span>
          <p style={{ fontSize:13, color:T.text3, marginTop:4, marginBottom:16 }}>Best bets ranked by DUBL Score</p>
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            {top.map(pick => {
              const pickId = `${pick.game.id}-${pick.type}`;
              return (
              <PickGameCard
                key={pickId}
                pick={pick}
                game={pick.game}
                onGameClick={onGameClick}
                onSave={onFavorite ? () => onFavorite.add({
                  id: pickId, type: pick.type,
                  label: pick.type === "bet" ? "BEST BET" : pick.type === "ou" ? "O/U" : "PROP",
                  icon: pick.type === "bet" ? "✦" : pick.type === "ou" ? "◉" : "▸",
                  color: pick.type === "bet" ? T.green : pick.type === "ou" ? T.gold : "#a78bfa",
                  text: pick.text, score: pick.score, reasoning: pick.reasoning,
                  betTeam: pick.betTeam || null, betIsSpread: !!pick.betIsSpread,
                  matchup: `${pick.game.away} @ ${pick.game.home}`,
                  gameId: pick.game.id, savedAt: Date.now(),
                  gameSnapshot: {
                    away: pick.game.away, home: pick.game.home,
                    awayName: pick.game.awayName, homeName: pick.game.homeName,
                    ou: pick.game.ou, awayOdds: pick.game.awayOdds, homeOdds: pick.game.homeOdds,
                    homeSpreadOdds: pick.game.homeSpreadOdds, awaySpreadOdds: pick.game.awaySpreadOdds,
                  },
                }) : undefined}
              />
              );
            })}
          </div>
        </div>
      )}

      {top.length === 0 && favPicks.length === 0 && (
        <div style={{ textAlign:"center", padding:"80px 20px", color:T.text3 }}>
          <div style={{ fontSize:40, marginBottom:12 }}>📋</div>
          <div style={{ fontSize:14 }}>No picks yet — check back when games are analyzed</div>
        </div>
      )}
    </div>
  );
}

// ── BOTTOM NAVIGATION BAR ────────────────────────────────────────────────────
function BottomNav({ activeTab, onTabChange, balance }) {
  const tabs = [
    { id:"explore", label:"Explore", icon:"🔍" },
    { id:"mybets",  label:"My Bets", icon:"📋" },
    { id:"chat",    label:"Chat",    icon:"💬" },
  ];
  return (
    <div style={{
      position:"fixed", bottom:0, left:0, right:0, zIndex:100,
      background:T.card, borderTop:`1px solid ${T.border}`,
      paddingBottom:"env(safe-area-inset-bottom)",
      boxShadow:"0 -2px 10px rgba(0,0,0,0.05)",
    }}>
      <div style={{ display:"flex", maxWidth:480, margin:"0 auto" }}>
        {tabs.map(t => {
          const isActive = activeTab === t.id;
          return (
            <button key={t.id} onClick={() => onTabChange(t.id)} style={{
              flex:1, background:"transparent", border:"none",
              display:"flex", flexDirection:"column", alignItems:"center",
              padding:"10px 0 8px", gap:3,
              color: isActive ? T.text : T.text3,
              cursor:"pointer",
            }}>
              <span style={{ fontSize:18 }}>{t.icon}</span>
              <span style={{ fontSize:10, fontWeight: isActive ? 700 : 500 }}>
                {t.id === "mybets" && balance ? `$${balance.toFixed(0)}` : t.label}
              </span>
              {isActive && <div style={{ width:4, height:4, borderRadius:2, background:T.text, marginTop:1 }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── GAME CARD (legacy — kept for compatibility) ──────────────────────────────
function GameCard({ game, onRefresh, loadingRefresh, aiOverride, onPickOdds, favorites, onFavorite, pickRecord, gameBets, onBet, username }) {
  const isLive   = game.status === "live";
  const isFinal  = game.status === "final";
  const isUp     = game.status === "upcoming";
  const awayLeads = (isLive || isFinal) && game.awayScore > game.homeScore;
  const homeLeads = (isLive || isFinal) && game.homeScore > game.awayScore;

  const staticAnalysis = game.analysis;
  const displayAnalysis = aiOverride || staticAnalysis;
  const L = aiOverride?.lines || {};
  const dispSpread         = game.spread || L.spread;
  const rawOu              = L.ou       || game.ou;
  const dispOu             = rawOu ? rawOu.replace(/^(over\/under|over|under)\s*/i, "") : rawOu;
  const dispAwayOdds       = L.awayOdds || game.awayOdds;
  const dispHomeOdds       = L.homeOdds || game.homeOdds;
  const dispHomeSpreadOdds = game.homeSpreadOdds;
  const dispAwaySpreadOdds = game.awaySpreadOdds;

  const awayC = TEAM_COLORS[game.away] || "#1a3a6e";
  const homeC = TEAM_COLORS[game.home] || "#6e1a1a";

  // Pot data for this game
  const myPick = gameBets?.myPick;       // "away" | "home" | null
  const awayBets = gameBets?.away || [];
  const homeBets = gameBets?.home || [];
  const potTotal = gameBets?.total || 0;
  const canBet = isUp && onBet;

  const handleSidePick = (side) => {
    if (!canBet) return;
    const ml = side === "away" ? dispAwayOdds : dispHomeOdds;
    onBet(game.id, side, dispSpread || "", ml || "");
  };

  // ── Spread-aware settlement ──────────────────────────────────────────────
  // Parse locked spread like "BOS -5.5" → { team:"BOS", line:-5.5 }
  const parseSpread = (s) => {
    if (!s) return null;
    const m = s.match(/^([A-Z]{2,4})\s*([+-]?\d+\.?\d*)$/);
    return m ? { team: m[1], line: parseFloat(m[2]) } : null;
  };

  // Did a specific bettor cover the spread?
  // betSide: "away"|"home", lockedSpread: "BOS -5.5"
  const didCover = (betSide, lockedSpread) => {
    if (!isFinal || game.awayScore == null || game.homeScore == null) return null;
    const sp = parseSpread(lockedSpread);
    if (!sp) {
      // No locked spread — fall back to straight-up winner
      const diff = game.awayScore - game.homeScore;
      return betSide === "away" ? diff > 0 : diff < 0;
    }
    // Spread is from the favorite's perspective: "BOS -5.5" means BOS must win by >5.5
    // Adjusted score = favTeam's score + line (line is negative for favorites)
    const favSide = sp.team === game.home ? "home" : "away";
    const favScore = favSide === "home" ? game.homeScore : game.awayScore;
    const dogScore = favSide === "home" ? game.awayScore : game.homeScore;
    const adjustedFav = favScore + sp.line; // e.g. 105 + (-5.5) = 99.5
    if (adjustedFav === dogScore) return null; // push
    const favCovers = adjustedFav > dogScore;
    const betOnFav = betSide === favSide;
    return betOnFav ? favCovers : !favCovers;
  };

  // Find my bet entry to get my locked spread
  const myBetEntry = myPick && username
    ? (myPick === "away" ? awayBets : homeBets).find(e => e.username === username)
    : null;
  const iCovered = myBetEntry ? didCover(myPick, myBetEntry.lockedSpread) : null;

  const hasBet = myPick && potTotal > 0;
  const betSettled = isFinal && hasBet && (game.awayScore != null && game.homeScore != null);
  const iWon = betSettled && iCovered === true;
  const iLost = betSettled && iCovered === false;
  const iPushed = betSettled && iCovered === null;

  // Mini avatar row helper
  const AvatarRow = ({ entries, align }) => entries.length === 0 ? null : (
    <div style={{ display:"flex", gap:4, flexWrap:"wrap", justifyContent: align, marginTop:6 }}>
      {entries.map((e, i) => {
        // Show locked spread as short line, e.g. "BOS -5.5" → "-5.5"
        const shortLine = e.lockedSpread ? e.lockedSpread.replace(/^[A-Z]{2,4}\s*/, "") : "";
        return (
          <div key={i} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:1 }}>
            <div style={{
              width:22, height:22, borderRadius:"50%",
              background: avatarColor(e.username),
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:9, fontWeight:800, color:"#fff",
              border:"1.5px solid rgba(255,255,255,0.3)",
            }}>{e.username[0].toUpperCase()}</div>
            {shortLine && <div style={{ fontSize:7, fontWeight:800, color:"#000", lineHeight:1, whiteSpace:"nowrap" }}>{shortLine}</div>}
          </div>
        );
      })}
    </div>
  );

  return (
    <div style={{
      border: `1px solid ${isLive ? "rgba(248,70,70,0.35)" : "rgba(255,255,255,0.09)"}`,
      borderRadius: 16,
      scrollSnapAlign: "start",
      flexShrink: 0,
      width: "min(340px, 88vw)",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
    }}>

      {/* ── HERO ── */}
      <div style={{ position:"relative", overflow:"hidden" }}>
        {/* Card template background */}
        <div style={{
          position:"absolute", inset:0,
          backgroundImage:"url('/static/card.png')",
          backgroundSize:"100% auto",
          backgroundPosition:"top center",
          backgroundRepeat:"no-repeat",
          zIndex:0,
        }} />
        {/* Team color blend overlay */}
        <div style={{
          position:"absolute", inset:0,
          background:`linear-gradient(112deg, ${awayC} 48%, ${homeC} 48%)`,
          mixBlendMode:"color",
          zIndex:1,
        }} />
        {/* Readability overlay */}
        <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.22)", zIndex:2 }} />

        {/* Selection outline — bright animated border on the picked side */}
        {isUp && myPick === "away" && (
          <div style={{ position:"absolute", inset:0, zIndex:2, pointerEvents:"none",
            clipPath:"polygon(0 0, 53% 0, 41% 100%, 0 100%)",
            background:"rgba(83,211,55,0.12)",
            borderLeft:"2px solid rgba(83,211,55,0.8)",
            borderTop:"2px solid rgba(83,211,55,0.8)",
            borderBottom:"2px solid rgba(83,211,55,0.8)",
            boxShadow:"inset 0 0 18px rgba(83,211,55,0.25), 0 0 12px rgba(83,211,55,0.15)",
          }} />
        )}
        {isUp && myPick === "home" && (
          <div style={{ position:"absolute", inset:0, zIndex:2, pointerEvents:"none",
            clipPath:"polygon(53% 0, 100% 0, 100% 100%, 41% 100%)",
            background:"rgba(83,211,55,0.12)",
            borderRight:"2px solid rgba(83,211,55,0.8)",
            borderTop:"2px solid rgba(83,211,55,0.8)",
            borderBottom:"2px solid rgba(83,211,55,0.8)",
            boxShadow:"inset 0 0 18px rgba(83,211,55,0.25), 0 0 12px rgba(83,211,55,0.15)",
          }} />
        )}
        {/* Settled result glow on final games — green for winners, red for losers */}
        {betSettled && !iPushed && (() => {
          const clr = iWon ? "rgba(83,211,55,0.15)" : "rgba(248,70,70,0.12)";
          const clip = myPick === "away"
            ? "polygon(0 0, 53% 0, 41% 100%, 0 100%)"
            : "polygon(53% 0, 100% 0, 100% 100%, 41% 100%)";
          return <div style={{ position:"absolute", inset:0, zIndex:2, pointerEvents:"none", clipPath:clip, background:clr }} />;
        })()}

        {/* Clickable side overlays for betting (upcoming only) */}
        {isUp && onBet && (
          <>
            <div onClick={() => handleSidePick("away")} style={{
              position:"absolute", inset:0, zIndex:4, cursor:"pointer",
              clipPath:"polygon(0 0, 53% 0, 41% 100%, 0 100%)",
            }} />
            <div onClick={() => handleSidePick("home")} style={{
              position:"absolute", inset:0, zIndex:4, cursor:"pointer",
              clipPath:"polygon(53% 0, 100% 0, 100% 100%, 41% 100%)",
            }} />
          </>
        )}

        {/* Content */}
        <div style={{ position:"relative", zIndex:3, padding:`12px 14px ${isLive ? 16 : 4}px`, pointerEvents: isUp && onBet ? "none" : "auto" }}>
          {/* Top row: avatars left / POT center / avatars right */}
          <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:12, minHeight:32 }}>
            {/* Away bettors — top left */}
            <div style={{ flexShrink:0, minWidth:40 }}>
              <AvatarRow entries={awayBets} align="flex-start" />
              {myPick === "away" && betSettled && (
                <div style={{ fontSize:8, fontWeight:800, letterSpacing:"0.08em", marginTop:3,
                  color: iWon ? T.green : iPushed ? T.text2 : T.red,
                }}>{iWon ? "WON" : iPushed ? "PUSH" : "LOST"}</div>
              )}
            </div>

            {/* Center top: POT badge (always top center) or W/L result or injury */}
            <div style={{ flex:1, display:"flex", justifyContent:"center", alignItems:"flex-start" }}>
              {betSettled ? (() => {
                // Count winners/losers per-user using their individual locked spreads
                const allBettors = [
                  ...awayBets.map(e => ({ ...e, side: "away" })),
                  ...homeBets.map(e => ({ ...e, side: "home" })),
                ];
                const winners = allBettors.filter(e => didCover(e.side, e.lockedSpread) === true);
                const losers = allBettors.filter(e => didCover(e.side, e.lockedSpread) === false);
                const payout = iWon && winners.length > 0 && losers.length > 0
                  ? Math.round((losers.length * 10) / winners.length * 100) / 100
                  : iPushed ? 0 : iWon ? 10 : 0;
                const badgeColor = iWon ? T.green : iPushed ? T.text2 : T.red;
                const badgeBg = iWon ? "rgba(83,211,55,0.25)" : iPushed ? "rgba(255,255,255,0.08)" : "rgba(248,70,70,0.25)";
                const badgeBorder = iWon ? T.greenBdr : iPushed ? "rgba(255,255,255,0.15)" : "rgba(248,70,70,0.4)";
                return (
                  <div style={{ display:"inline-flex", alignItems:"center", gap:4,
                    background: badgeBg,
                    border: `1px solid ${badgeBorder}`,
                    borderRadius:8, padding:"3px 9px",
                  }}>
                    <span style={{ fontSize:9, fontWeight:800, letterSpacing:"0.06em", color: badgeColor }}>
                      {iWon ? "W" : iPushed ? "PUSH" : "L"}
                    </span>
                    {iWon && payout ? (
                      <span style={{ fontSize:11, color:T.green, fontWeight:900 }}>+${payout}</span>
                    ) : iLost ? (
                      <span style={{ fontSize:11, color:T.red, fontWeight:900 }}>-$10</span>
                    ) : null}
                  </div>
                );
              })() : potTotal > 0 ? (
                <div style={{ display:"inline-flex", alignItems:"center", gap:4,
                  background:"rgba(0,0,0,0.55)", borderRadius:8, padding:"3px 9px",
                }}>
                  <span style={{ fontSize:9, color:T.green, fontWeight:800, letterSpacing:"0.06em" }}>POT</span>
                  <span style={{ fontSize:12, color:T.green, fontWeight:900 }}>${potTotal}</span>
                </div>
              ) : game.injuryAlert && isUp ? (
                <div style={{ background:"rgba(248,70,70,0.2)", border:"1px solid rgba(248,70,70,0.3)", borderRadius:6, padding:"3px 8px", fontSize:9, color:"#ff9090", fontWeight:600, maxWidth:"80%", textAlign:"center" }}>
                  ⚠ {game.injuryAlert}
                </div>
              ) : null}
            </div>

            {/* Home bettors — top right */}
            <div style={{ flexShrink:0, minWidth:40, textAlign:"right" }}>
              <AvatarRow entries={homeBets} align="flex-end" />
              {myPick === "home" && betSettled && (
                <div style={{ fontSize:8, fontWeight:800, letterSpacing:"0.08em", marginTop:3,
                  color: iWon ? T.green : iPushed ? T.text2 : T.red,
                }}>{iWon ? "WON" : iPushed ? "PUSH" : "LOST"}</div>
              )}
            </div>
          </div>

          {/* Teams + Score */}
          <div style={{ display:"flex", alignItems:"flex-end", justifyContent:"space-between", gap:8 }}>
            {/* Away */}
            <div style={{ flexShrink:0 }}>
              <TeamBadge abbr={game.away} size={44} />
              <div style={{ color:"rgba(255,255,255,0.75)", fontSize:10, fontWeight:500, marginTop:5 }}>{game.awayName}</div>
            </div>

            {/* Center — scores/prob + pot badge */}
            <div style={{ flex:1, textAlign:"center", paddingBottom:2 }}>
              {(isLive || isFinal) ? (
                <>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
                    <span style={{ fontSize:38, fontWeight:900, color: awayLeads ? "#fff" : "rgba(255,255,255,0.4)", lineHeight:1 }}>{game.awayScore}</span>
                    <span style={{ color:"rgba(255,255,255,0.35)", fontSize:16 }}>–</span>
                    <span style={{ fontSize:38, fontWeight:900, color: homeLeads ? "#fff" : "rgba(255,255,255,0.4)", lineHeight:1 }}>{game.homeScore}</span>
                  </div>
                  <div style={{ marginTop:8 }}>
                    {isLive ? (
                      <div style={{ display:"inline-flex", alignItems:"center", gap:5, background:"rgba(0,0,0,0.6)", borderRadius:20, padding:"4px 12px" }}>
                        <span style={{ width:5, height:5, borderRadius:"50%", background:T.red, display:"inline-block", animation:"pulse 1.2s infinite", flexShrink:0 }} />
                        <span style={{ color:"#fff", fontSize:10, fontWeight:700, letterSpacing:"0.05em" }}>Q{game.quarter} {game.clock}</span>
                      </div>
                    ) : (
                      <span style={{ color:"rgba(255,255,255,0.55)", fontSize:10, fontWeight:700, letterSpacing:"0.12em" }}>FINAL</span>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:5 }}>
                    <span style={{ fontSize:20, fontWeight:800, color:"#fff" }}>{game.awayWinProb}%</span>
                    <span style={{ color:"rgba(255,255,255,0.35)", fontSize:11 }}>vs</span>
                    <span style={{ fontSize:20, fontWeight:800, color:"#fff" }}>{game.homeWinProb}%</span>
                  </div>
                  <div style={{ width:110, height:5, borderRadius:3, background:"rgba(255,255,255,0.12)", overflow:"hidden", margin:"6px auto 0" }}>
                    <div style={{ height:"100%", width:`${game.awayWinProb}%`, background:T.green, borderRadius:3, transition:"width 0.6s" }} />
                  </div>
                  <div style={{ marginTop:3, color:"rgba(255,255,255,0.4)", fontSize:8, letterSpacing:"0.1em", fontWeight:700 }}>WIN PROBABILITY</div>
                  {game.time && (
                    <div style={{ marginTop:8, display:"inline-flex", alignItems:"center", background:"rgba(0,0,0,0.55)", borderRadius:20, padding:"4px 11px" }}>
                      <span style={{ color:"#fff", fontSize:10, fontWeight:700 }}>
                        {new Date(game.time).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })}
                      </span>
                    </div>
                  )}
                </>
              )}
              {/* Live win-prob chips below score */}
              {isLive && (game.awayWinProb != null && game.homeWinProb != null) && (
                <div style={{ display:"flex", gap:5, justifyContent:"center", marginTop:6 }}>
                  <HeroWinChip pct={game.awayWinProb} />
                  <HeroWinChip pct={game.homeWinProb} />
                </div>
              )}
            </div>

            {/* Home */}
            <div style={{ flexShrink:0, textAlign:"right" }}>
              <div style={{ display:"flex", justifyContent:"flex-end" }}>
                <TeamBadge abbr={game.home} size={44} />
              </div>
              <div style={{ color:"rgba(255,255,255,0.75)", fontSize:10, fontWeight:500, marginTop:5 }}>{game.homeName}</div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Odds strip ── */}
      {(dispSpread || dispOu || dispHomeOdds) && (
        <div style={{ display:"flex", background:"#0f0d0a" }}>
          {dispSpread && (
            <OddsCol label="SPREAD" value={dispSpread} highlight={!isFinal}
              movement={lineMovement(dispSpread, game.opening_spread, true)}
              onClick={onPickOdds ? () => onPickOdds(dispHomeSpreadOdds || dispAwaySpreadOdds || "-110") : undefined} />
          )}
          {dispOu && (
            <OddsCol label="TOTAL" value={`${dispOu}${isLive && game.ouDir ? ` ${game.ouDir}` : ""}`} highlight={!isFinal}
              movement={lineMovement(dispOu, game.opening_ou)}
              onClick={onPickOdds ? () => onPickOdds("-110") : undefined} />
          )}
          {dispHomeOdds && dispAwayOdds && (
            <OddsCol label="MONEYLINE" value={`${dispAwayOdds} / ${dispHomeOdds}`} highlight={!isFinal} />
          )}
        </div>
      )}

      {/* ── Results (final) or Analysis (live/upcoming) ── */}
      {isFinal
        ? <FinalResultsPanel game={game} aiOverride={aiOverride} pickRecord={pickRecord} />
        : <AnalysisPanel
            analysis={displayAnalysis}
            isLive={isLive}
            loading={loadingRefresh}
            game={game}
            favorites={favorites}
            onFavorite={onFavorite}
          />
      }
    </div>
  );
}

function OddsCol({ label, value, highlight, onClick, movement }) {
  return (
    <div onClick={onClick} style={{ flex:1, padding:"10px 0", textAlign:"center", borderRight:`1px solid ${T.border}`, cursor: onClick ? "pointer" : "default" }}>
      <div style={{ fontSize:8, color:T.text3, letterSpacing:"0.08em", fontWeight:700, marginBottom:4 }}>{label}</div>
      <div style={{ fontSize:12, fontWeight:700, color: highlight ? T.text : T.text2 }}>{value}</div>
      {movement && <div style={{ fontSize:9, color: movement.color, marginTop:2 }}>{movement.text}</div>}
    </div>
  );
}

function WinProbChip({ pct, abbr }) {
  return (
    <div style={{ background:"rgba(255,255,255,0.06)", borderRadius:6, padding:"3px 7px", textAlign:"center" }}>
      <div style={{ fontSize:10, fontWeight:800, color: pct > 50 ? T.green : T.text2 }}>{pct}%</div>
      <div style={{ fontSize:8, color:T.text3 }}>{abbr}</div>
    </div>
  );
}

function HeroWinChip({ pct }) {
  return (
    <div style={{ background:"rgba(0,0,0,0.55)", borderRadius:6, padding:"3px 8px", textAlign:"center" }}>
      <div style={{ fontSize:10, fontWeight:800, color: pct > 50 ? T.green : "rgba(255,255,255,0.65)" }}>{pct}%</div>
    </div>
  );
}

function TeamBadge({ abbr, size = 40 }) {
  return (
    <div style={{
      width:size, height:size, borderRadius: Math.round(size*0.25),
      background: TEAM_COLORS[abbr] || "#333",
      display:"flex", alignItems:"center", justifyContent:"center",
      fontSize: Math.round(size*0.32), fontWeight:800, color:"#fff",
      boxShadow:`0 2px 12px ${(TEAM_COLORS[abbr]||"#333")}55`,
    }}>
      {abbr.slice(0,3)}
    </div>
  );
}

function ScorePip({ score, reasoning, accuribet }) {
  const [open, setOpen] = useState(false);
  if (score == null) return null;
  const c = edgeColor(score);
  const hasAb = accuribet && (accuribet.ml || accuribet.ou != null);
  const hasPopover = reasoning || hasAb;
  return (
    <div style={{ position:"relative", flexShrink:0, marginLeft:6 }}>
      <span
        onClick={e => { e.stopPropagation(); if (hasPopover) setOpen(o => !o); }}
        style={{
          display:"inline-flex", alignItems:"center", justifyContent:"center",
          width:28, height:28, borderRadius:"50%",
          border:`2px solid ${c}`, background:`${c}18`,
          fontSize:10, fontWeight:800, color:c,
          cursor: hasPopover ? "pointer" : "default",
        }}
      >{score}</span>
      {open && hasPopover && (
        <div style={{
          position:"absolute", right:0, top:34, zIndex:200,
          background:T.card, border:`1px solid ${c}44`,
          borderRadius:10, padding:"10px 12px",
          fontSize:10, color:T.text2, lineHeight:1.6,
          width:230, boxShadow:"0 8px 24px rgba(0,0,0,0.55)",
        }}>
          <div style={{ fontSize:8, color:c, letterSpacing:"0.1em", fontWeight:700, marginBottom:5 }}>DUBL SCORE · {score}/5</div>
          {reasoning && <div style={{ marginBottom: hasAb ? 8 : 0 }}>{reasoning}</div>}
          {hasAb && (
            <div style={{ borderTop: reasoning ? `1px solid ${T.border}` : "none", paddingTop: reasoning ? 8 : 0 }}>
              <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:3 }}>
                <span style={{ color:"#5b9bd5", fontSize:9 }}>⚡</span>
                <span style={{ fontSize:8, fontWeight:700, color:"#5b9bd5", letterSpacing:"0.06em" }}>ACCURIBET ML</span>
              </div>
              {accuribet.ml && (
                <div style={{ fontSize:10, color:T.text2, lineHeight:1.5 }}>
                  Picks <b style={{ color:T.text1 }}>{accuribet.ml}</b>
                  {accuribet.confidence != null && (
                    <span style={{
                      fontSize:8, fontWeight:800, letterSpacing:"0.06em",
                      color: accuribet.confidence >= 70 ? "#2e7d32" : "#5b9bd5",
                      background: accuribet.confidence >= 70 ? "rgba(83,211,55,0.12)" : "rgba(91,155,213,0.12)",
                      border: `1px solid ${accuribet.confidence >= 70 ? "rgba(83,211,55,0.28)" : "rgba(91,155,213,0.25)"}`,
                      borderRadius:4, padding:"1px 5px", marginLeft:5,
                    }}>{accuribet.confidence}%</span>
                  )}
                </div>
              )}
              {accuribet.ou != null && (
                <div style={{ fontSize:10, color:T.text3, marginTop: accuribet.ml ? 2 : 0 }}>
                  Projected total: <b style={{ color:T.text2 }}>{accuribet.ou}</b>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LiveTrackBadge({ onTrack }) {
  return (
    <span style={{
      fontSize:8, fontWeight:800, letterSpacing:"0.08em",
      color: onTrack ? T.green : T.red,
      background: onTrack ? T.greenDim : T.redDim,
      border: `1px solid ${onTrack ? T.greenBdr : "rgba(248,70,70,0.3)"}`,
      borderRadius:4, padding:"1px 5px", marginLeft:6, flexShrink:0,
    }}>{onTrack ? "ON TRACK" : "FADING"}</span>
  );
}

function AnalysisPanel({ analysis, isLive, loading, game, favorites, onFavorite }) {
  if (!analysis) return null;

  // Live tracking computed from scores (no AI needed)
  const pace = (isLive && game) ? calcLivePace(game) : null;
  const ouText = analysis.ou || "";
  const leanIsOver = /over/i.test(ouText);
  const ouOnTrack = pace ? (leanIsOver ? pace.projected > pace.ouLine : pace.projected < pace.ouLine) : null;

  // Best-bet live margin
  let betMargin = null;
  if (isLive && game && analysis.bet_team) {
    const isBettingHome = analysis.bet_team === game.home;
    const ourScore = isBettingHome ? (game.homeScore || 0) : (game.awayScore || 0);
    const oppScore = isBettingHome ? (game.awayScore || 0) : (game.homeScore || 0);
    betMargin = ourScore - oppScore;
  }

  const ab = (analysis.accuribet_ml || analysis.accuribet_ou) ? { ml: analysis.accuribet_ml, confidence: analysis.accuribet_confidence, ou: analysis.accuribet_ou } : null;
  const items = [
    { type:"bet",  icon:"✦", label: isLive ? "BEST BET (LIVE)" : "BEST BET",   text: analysis.best_bet, color:T.green,  score: analysis.dubl_score_bet, reasoning: analysis.dubl_reasoning_bet, accuribet: ab && ab.ml ? { ml: ab.ml, confidence: ab.confidence, ou: null } : null, isBet: true, betTeam: analysis.bet_team, betIsSpread: analysis.bet_is_spread },
    { type:"ou",   icon:"◉", label: isLive ? "TOTAL (LIVE)" : "O/U LEAN", text: analysis.ou, color:T.gold, score: analysis.dubl_score_ou, reasoning: analysis.dubl_reasoning_ou, accuribet: ab && ab.ou ? { ml: null, confidence: null, ou: ab.ou } : null, isOu: true },
    { type:"prop", icon:"▸", label:"PLAYER PROP", text: analysis.props,   color:"#a78bfa", score: null, accuribet: null, isProp: true },
  ].filter(i => i.text);

  // If live game has no analysis yet, show computed O/U status from scores alone
  const showFallbackOu = isLive && game && game.ou && items.length === 0 && !loading;

  return (
    <div style={{ background:"#f4ede1", padding:"12px 16px 14px", flex:1 }}>
      <div style={{ marginBottom:10 }}>
        <span style={{ fontSize:9, color:"#a09078", letterSpacing:"0.1em", fontWeight:700 }}>
          dublplay analysis
        </span>
      </div>
      <div style={{ display:"flex", flexDirection:"column" }}>
        {items.length === 0 && loading && (
          <span style={{ fontSize:11, color:"#9a8a7a", lineHeight:1.6 }}>
            <Spinner /> Analyzing...
          </span>
        )}
        {showFallbackOu && pace && (() => {
          const pacingOver = pace.projected > pace.ouLine;
          return (
            <div style={{ display:"flex", gap:8, alignItems:"flex-start" }}>
              <span style={{ color:T.gold, fontSize:10, marginTop:1, flexShrink:0 }}>◉</span>
              <div style={{ flex:1, display:"flex", alignItems:"center", flexWrap:"wrap", gap:4 }}>
                <span style={{ fontSize:9, fontWeight:700, color:T.gold, letterSpacing:"0.06em" }}>TOTAL (LIVE)</span>
                <span style={{ fontSize:11, color:"#4a3a2e" }}>O/U {game.ou}</span>
                <span style={{
                  fontSize:8, fontWeight:800, letterSpacing:"0.08em",
                  color: pacingOver ? T.red : T.green,
                  background: pacingOver ? T.redDim : T.greenDim,
                  border: `1px solid ${pacingOver ? "rgba(248,70,70,0.3)" : T.greenBdr}`,
                  borderRadius:4, padding:"1px 5px",
                }}>PACING {pacingOver ? "OVER" : "UNDER"}</span>
              </div>
            </div>
          );
        })()}
        {items.map((item, i) => {
          const pickId = game ? `${game.id}-${item.type}` : null;
          const isFav = pickId ? (favorites?.has(pickId) ?? false) : false;
          return (
          <div key={i} style={{ display:"flex", gap:8, alignItems:"flex-start", paddingTop: i > 0 ? 10 : 0, marginTop: i > 0 ? 10 : 0, borderTop: i > 0 ? "1px solid rgba(0,0,0,0.07)" : "none" }}>
            <span style={{ color:item.color, fontSize:10, marginTop:1, flexShrink:0 }}>{item.icon}</span>
            <div style={{ flex:1 }}>
              <div style={{ display:"flex", alignItems:"center", flexWrap:"wrap", gap:4, marginBottom:3 }}>
                <span style={{ fontSize:9, fontWeight:700, color:item.color, letterSpacing:"0.06em" }}>{item.label}</span>
                {/* O/U on-track badge */}
                {item.isOu && isLive && ouOnTrack !== null && (
                  <LiveTrackBadge onTrack={ouOnTrack} />
                )}
                {/* Prop on-track badge */}
                {item.isProp && isLive && analysis.prop_on_track !== null && analysis.prop_on_track !== undefined && (
                  <LiveTrackBadge onTrack={analysis.prop_on_track} />
                )}
                {/* Best-bet leading/trailing badge */}
                {item.isBet && isLive && betMargin !== null && (
                  <span style={{
                    fontSize:8, fontWeight:800, letterSpacing:"0.07em",
                    color: betMargin > 0 ? T.green : betMargin < 0 ? T.red : T.gold,
                    background: betMargin > 0 ? T.greenDim : betMargin < 0 ? T.redDim : "rgba(245,166,35,0.12)",
                    border: `1px solid ${betMargin > 0 ? T.greenBdr : betMargin < 0 ? "rgba(248,70,70,0.3)" : "rgba(245,166,35,0.3)"}`,
                    borderRadius:4, padding:"1px 5px",
                  }}>
                    {betMargin > 0 ? `+${betMargin} LEADING` : betMargin < 0 ? `${betMargin} TRAILING` : "TIED"}
                  </span>
                )}
              </div>
              <span style={{ fontSize:11, color:"#4a3a2e", lineHeight:1.6 }}>{item.text}</span>
            </div>
            <ScorePip score={item.score} reasoning={item.reasoning} accuribet={item.accuribet} />
            {pickId && onFavorite && (
              <BookmarkBtn light active={isFav} onClick={() => isFav
                ? onFavorite.remove(pickId)
                : onFavorite.add({
                    id: pickId, type: item.type,
                    label: item.label.replace(/ \(LIVE\)$/, ""),
                    icon: item.icon, color: item.color,
                    text: item.text, score: item.score, reasoning: item.reasoning,
                    betTeam: item.betTeam || null, betIsSpread: !!item.betIsSpread,
                    matchup: `${game.away} @ ${game.home}`,
                    gameId: game.id, savedAt: Date.now(),
                    gameSnapshot: {
                      away: game.away, home: game.home,
                      awayName: game.awayName, homeName: game.homeName,
                      ou: game.ou, awayOdds: game.awayOdds, homeOdds: game.homeOdds,
                      homeSpreadOdds: game.homeSpreadOdds, awaySpreadOdds: game.awaySpreadOdds,
                    },
                  })
              } />
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}

// ── FINAL RESULTS PANEL ───────────────────────────────────────────────────────
function FinalResultsPanel({ game, aiOverride, pickRecord }) {
  const r = calcFinalResults(game);
  if (!r) return null;

  const analysis = aiOverride || game.analysis;

  // Prefer pickRecord fields (reliable pre-game snapshot), fall back to analysis
  const displayBestBet = pickRecord?.best_bet || analysis?.best_bet;
  const displayOu      = pickRecord?.ou       || analysis?.ou;
  const displayBetTeam = pickRecord?.bet_team || analysis?.bet_team;
  const displayProps   = analysis?.props;

  // Did pre-game picks hit? Use stored results if available, else compute from game data.
  let bestBetHit = null;
  if (pickRecord?.result_bet != null) {
    const rb = pickRecord.result_bet;
    bestBetHit = rb === "HIT" ? true : rb === "MISS" ? false : "push";
  } else if (displayBetTeam) {
    if (r.spreadResult) {
      const bettingFav = displayBetTeam === r.spreadResult.favAbbr;
      bestBetHit = bettingFav ? r.spreadResult.hit === "fav" : r.spreadResult.hit === "dog";
    } else {
      bestBetHit = displayBetTeam === r.mlWinner;
    }
  }
  let ouHit = null;
  if (pickRecord?.result_ou != null) {
    const ro = pickRecord.result_ou;
    ouHit = ro === "HIT" ? true : ro === "MISS" ? false : "push";
  } else if (displayOu && r.totalResult) {
    const leanedOver = /over/i.test(displayOu);
    ouHit = leanedOver ? r.totalResult.hit === "OVER" : r.totalResult.hit === "UNDER";
  }

  // Resolve display odds from aiOverride lines or game fallback
  const L2 = aiOverride?.lines || {};
  const dispAwayOdds = L2.awayOdds || game.awayOdds;
  const dispHomeOdds = L2.homeOdds || game.homeOdds;

  const ResultRow = ({ icon, iconColor, label, line, result, resultColor, sub }) => (
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:8 }}>
      <div style={{ display:"flex", gap:6, alignItems:"center", minWidth:0, flex:1 }}>
        <span style={{ color:iconColor, fontSize:10, flexShrink:0 }}>{icon}</span>
        <span style={{ fontSize:9, fontWeight:700, color:"#a09078", letterSpacing:"0.06em", flexShrink:0 }}>{label}</span>
        {line && <span style={{ fontSize:10, color: line === "N/A" ? "#a09078" : "#2a2218", fontWeight: line === "N/A" ? 400 : 700, flexShrink:0 }}>{line}</span>}
        {sub && <span style={{ fontSize:10, color:"#8a7a6a", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>→ {sub}</span>}
      </div>
      {result && <span style={{ fontSize:11, fontWeight:800, flexShrink:0, color: resultColor }}>{result}</span>}
    </div>
  );

  const hitColor  = c => c === "push" ? T.gold : c ? T.green : T.red;
  const hitLabel  = c => c === "push" ? "PUSH" : c ? "✓ HIT" : "✗ MISS";

  const s = r.spreadResult;
  const t = r.totalResult;
  const away = game.awayScore ?? 0;
  const home = game.homeScore ?? 0;

  return (
    <div style={{ background:"#f4ede1", padding:"12px 16px 14px", flex:1 }}>
      <div style={{ fontSize:9, color:"#a09078", letterSpacing:"0.1em", fontWeight:700, marginBottom:10 }}>
        FINAL RESULTS
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>

        {/* Moneyline */}
        <ResultRow
          icon="🏆" iconColor={T.green}
          label="ML"
          line={dispAwayOdds && dispHomeOdds ? `${game.away} ${dispAwayOdds} / ${game.home} ${dispHomeOdds}` : null}
          sub={`${r.mlWinnerName} wins by ${r.margin}`}
          result={null}
          resultColor={T.green}
        />

        {/* Spread — always render, show N/A when no line */}
        {(() => {
          if (s) {
            const lineStr = `${s.favAbbr} ${s.line > 0 ? "+" : ""}${s.line}`;
            const push = s.hit === "push";
            const resultLabel = push ? "PUSH" : s.hit === "fav" ? `${s.favAbbr} CVR` : `${s.dogAbbr} CVR`;
            const sub = push
              ? `Push — won by exactly ${Math.abs(s.line)}`
              : s.hit === "fav"
              ? `${s.favName} covered (won by ${Math.abs(Math.round(s.actualMargin))})`
              : `${s.dogName} +${Math.abs(s.line)} covered`;
            return (
              <ResultRow
                icon="⊖" iconColor="#a78bfa"
                label="SPREAD"
                line={lineStr}
                sub={sub}
                result={resultLabel}
                resultColor={push ? T.gold : T.green}
              />
            );
          }
          // No line data — still show the actual margin
          return (
            <ResultRow
              icon="⊖" iconColor="#a78bfa"
              label="SPREAD"
              line="N/A"
              sub={`${r.mlWinnerName} won by ${r.margin}`}
              result={null}
              resultColor={T.text3}
            />
          );
        })()}

        {/* Total — always render, show N/A when no line */}
        {(() => {
          const combinedScore = away + home;
          if (t) {
            const push = t.hit === "PUSH";
            return (
              <ResultRow
                icon="◉" iconColor={T.gold}
                label="TOTAL"
                line={`O/U ${t.label.replace(" O/U","")}`}
                sub={`${combinedScore} combined`}
                result={push ? "PUSH" : t.hit}
                resultColor={push ? T.gold : t.hit === "OVER" ? T.red : T.green}
              />
            );
          }
          return (
            <ResultRow
              icon="◉" iconColor={T.gold}
              label="TOTAL"
              line="N/A"
              sub={`${combinedScore} combined`}
              result={null}
              resultColor={T.text3}
            />
          );
        })()}

        {/* Pre-game picks + accuracy */}
        {displayBestBet && (
          <div style={{ marginTop:4, paddingTop:8, borderTop:`1px solid ${T.border}` }}>
            <div style={{ fontSize:9, color:T.text3, letterSpacing:"0.08em", fontWeight:700, marginBottom:6 }}>
              PRE-GAME PICKS
            </div>
            {(() => {
              const abMl = pickRecord?.accuribet_ml || analysis?.accuribet_ml;
              const abConf = pickRecord?.accuribet_confidence ?? analysis?.accuribet_confidence;
              const abOu = pickRecord?.accuribet_ou ?? analysis?.accuribet_ou;
              const abBet = abMl ? { ml: abMl, confidence: abConf, ou: abOu } : null;
              const abOuOnly = abOu != null ? { ml: null, confidence: null, ou: abOu } : null;
              return [
                { icon:"✦", label:"BEST BET",    text:displayBestBet, color:T.green,   hit:bestBetHit, score: pickRecord?.dubl_score_bet ?? analysis?.dubl_score_bet, reasoning: analysis?.dubl_reasoning_bet, accuribet: abBet },
                { icon:"◉", label:"O/U LEAN",    text:displayOu,      color:T.gold,    hit:ouHit,      score: pickRecord?.dubl_score_ou  ?? analysis?.dubl_score_ou,  reasoning: analysis?.dubl_reasoning_ou,  accuribet: abOuOnly },
                { icon:"▸", label:"PLAYER PROP", text:displayProps,   color:"#a78bfa", hit:null,       score: null, accuribet: null },
              ].filter(i => i.text).map((item, i) => (
                <div key={i} style={{ display:"flex", gap:6, alignItems:"flex-start", marginBottom:5 }}>
                  <span style={{ color:item.color, fontSize:9, marginTop:2, flexShrink:0 }}>{item.icon}</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:2 }}>
                      <span style={{ fontSize:8, fontWeight:700, color:item.color, letterSpacing:"0.06em" }}>{item.label}</span>
                      {item.hit !== null && (
                        <span style={{
                          fontSize:8, fontWeight:800, letterSpacing:"0.06em",
                          color: hitColor(item.hit),
                          background: item.hit === "push" ? "rgba(245,166,35,0.12)" : item.hit ? T.greenDim : T.redDim,
                          border:`1px solid ${item.hit === "push" ? "rgba(245,166,35,0.3)" : item.hit ? T.greenBdr : "rgba(248,70,70,0.3)"}`,
                          borderRadius:3, padding:"1px 5px",
                        }}>{hitLabel(item.hit)}</span>
                      )}
                    </div>
                    <span style={{ fontSize:10, color:T.text3, lineHeight:1.5 }}>{item.text}</span>
                  </div>
                  <ScorePip score={item.score} reasoning={item.reasoning} accuribet={item.accuribet} />
                </div>
              ));
            })()}
          </div>
        )}

      </div>
    </div>
  );
}

// ── HORIZONTAL GAMES SCROLL ───────────────────────────────────────────────────
function GamesScroll({ games, onRefresh, loadingIds, lastUpdated, aiOverrides, upcomingLabel, onPickOdds, favorites, onFavorite, picksMap, betStore, profile, dateStr }) {
  const liveGames     = games.filter(g => g.status === "live");
  const upcomingGames = games.filter(g => g.status === "upcoming");
  const finalGames    = games.filter(g => g.status === "final");
  const ordered = [...liveGames, ...upcomingGames, ...finalGames];

  const fmtTime = d => d
    ? d.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })
    : null;

  return (
    <div>
      {/* Top picks (auto) + My Picks — very top of tab */}
      <div style={{ paddingTop:14 }}>
        <TopPicksSection games={ordered} aiOverrides={aiOverrides} onPickOdds={onPickOdds}
          favs={favorites?.picks} onRemoveFav={onFavorite?.remove} />
      </div>

      {/* League / view bar with game counts + last updated on the right */}
      <div style={{
        display:"flex", alignItems:"center", gap:0,
        margin:"0 20px 12px", borderRadius:10,
        background:"rgba(255,255,255,0.04)", border:`1px solid ${T.border}`,
        overflow:"hidden",
      }}>
        <div style={{
          padding:"8px 14px", fontSize:11, fontWeight:800,
          color:T.gold, letterSpacing:"0.1em",
          borderRight:`1px solid ${T.border}`, flexShrink:0,
        }}>NBA</div>
        <div style={{
          padding:"8px 14px", fontSize:11, fontWeight:700,
          color:T.text1, letterSpacing:"0.06em", flexShrink:0,
          borderRight:`1px solid ${T.border}`,
        }}>All Games</div>
        {/* Counts */}
        <div style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 14px", flex:1 }}>
          {liveGames.length > 0 && (
            <div style={{ display:"flex", alignItems:"center", gap:4 }}>
              <span style={{ width:5, height:5, borderRadius:"50%", background:T.red, display:"inline-block", animation:"pulse 1.2s infinite" }} />
              <span style={{ fontSize:10, fontWeight:700, color:T.red, letterSpacing:"0.05em" }}>{liveGames.length} LIVE</span>
            </div>
          )}
          {upcomingGames.length > 0 && (
            <span style={{ fontSize:10, fontWeight:700, color:T.green, letterSpacing:"0.05em" }}>
              {upcomingGames.length} {upcomingLabel || "TONIGHT"}
            </span>
          )}
          {finalGames.length > 0 && (
            <span style={{ fontSize:10, color:T.text3, letterSpacing:"0.05em" }}>{finalGames.length} FINAL</span>
          )}
        </div>
        {/* Last updated */}
        <span style={{ fontSize:9, color:T.text3, padding:"8px 12px", flexShrink:0 }}>
          {liveGames.length > 0
            ? `↻${lastUpdated ? ` ${fmtTime(lastUpdated)}` : ""}`
            : lastUpdated ? fmtTime(lastUpdated) : ""}
        </span>
      </div>

      {/* Horizontal scroll rail */}
      <div style={{
        display:"flex", gap:12, overflowX:"auto", scrollSnapType:"x mandatory",
        WebkitOverflowScrolling:"touch", padding:"0 20px 20px",
        scrollbarWidth:"none",
      }}>
        {ordered.map(g => {
          const baseId = g.id.replace(/-\d{8}$/, "");
          const pickRecord = picksMap ? (picksMap[baseId] || picksMap[g.id]) : null;
          return (
            <GameCard
              key={g.id}
              game={g}
              onRefresh={onRefresh}
              loadingRefresh={loadingIds.has(g.id)}
              aiOverride={aiOverrides[g.id]}
              onPickOdds={onPickOdds}
              favorites={favorites}
              onFavorite={onFavorite}
              pickRecord={pickRecord}
              gameBets={betStore ? betStore.forGame(g.id, profile?.uid) : null}
              onBet={betStore && profile?.uid ? async (gid, side, lockedSpread, lockedMl) => {
                const result = await betStore.pick(gid, side, profile.uid, profile.username, lockedSpread || "", lockedMl || "", dateStr);
                if (result === "placed") profile.deduct(10);
                else if (result === "removed") profile.credit(10);
              } : null}
              username={profile?.username}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── LIVE PACE CALCULATOR ──────────────────────────────────────────────────────
function calcLivePace(game) {
  const combined = (game.awayScore || 0) + (game.homeScore || 0);
  const ouLine = parseFloat(game.ou);
  if (!ouLine || isNaN(ouLine)) return null;
  const quarter = game.quarter || 1;
  const clock = game.clock || "12:00";
  let elapsed;
  if (clock === "Halftime") {
    elapsed = 24;
  } else {
    const parts = clock.split(":");
    const minLeft = parseFloat(parts[0] || 0) + (parseFloat(parts[1] || 0) / 60);
    elapsed = (quarter - 1) * 12 + (12 - minLeft);
  }
  if (elapsed < 1) return null;
  const projected = Math.round(((combined / elapsed) * 48) * 10) / 10;
  const needed = Math.round((ouLine - combined) * 10) / 10;
  return { combined, ouLine, projected, needed };
}

// ── TOP PICKS (top 3 individual bets ranked by Dubl Score) ───────────────────

// Popup shown when tapping the team row on a compact TopPickCard
function TopPickDetailPopup({ pick, onClose, onPickOdds }) {
  const isBet = pick.type === "bet";
  const isLiveGame = pick.game.status === "live";
  const color = isBet ? T.green : T.gold;
  const ec = edgeColor(pick.score);
  const calcOdds = isBet
    ? pick.betIsSpread
      ? (pick.betTeam === pick.game.home ? pick.game.homeSpreadOdds : pick.game.awaySpreadOdds) || "-110"
      : (pick.betTeam === pick.game.home ? pick.game.homeOdds : pick.game.awayOdds) || "-110"
    : "-110";

  const pace = (!isBet && isLiveGame) ? calcLivePace(pick.game) : null;
  const isOver = !isBet && /over/i.test(pick.text);
  const ouOnTrack = pace ? (isOver ? pace.projected > pace.ouLine : pace.projected < pace.ouLine) : null;

  let betMargin = null;
  if (isBet && isLiveGame && pick.betTeam) {
    const isBettingHome = pick.betTeam === pick.game.home;
    betMargin = (isBettingHome ? (pick.game.homeScore||0) : (pick.game.awayScore||0))
              - (isBettingHome ? (pick.game.awayScore||0) : (pick.game.homeScore||0));
  }

  return (
    <>
      <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.4)", zIndex:300, WebkitTapHighlightColor:"transparent" }} />
      <div style={{
        position:"fixed", bottom:0, left:0, right:0, zIndex:301,
        background:T.card, borderTop:`1px solid ${T.borderBr}`,
        borderRadius:"20px 20px 0 0",
        padding:"20px 20px calc(20px + env(safe-area-inset-bottom))",
        animation:"slideUp 0.22s ease", maxWidth:480, margin:"0 auto",
      }}>
        <div style={{ width:36, height:4, borderRadius:2, background:"rgba(255,255,255,0.15)", margin:"0 auto 16px" }} />

        {/* Header row: badge + close */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
          <span style={{ fontSize:9, fontWeight:700, letterSpacing:"0.06em", color, background:`${color}18`, border:`1px solid ${color}44`, borderRadius:4, padding:"3px 8px" }}>
            {isBet ? (isLiveGame ? "✦ BEST BET (LIVE)" : "✦ BEST BET") : "◉ O/U PICK"}
          </span>
          <button onClick={onClose} style={{ background:"none", border:"none", color:T.text3, fontSize:20, cursor:"pointer", padding:"0 0 0 12px", lineHeight:1 }}>×</button>
        </div>

        {/* Teams */}
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
          <TeamBadge abbr={pick.game.away} size={36} />
          <div style={{ flex:1 }}>
            <div style={{ fontSize:12, fontWeight:700, color:T.text1 }}>
              {pick.game.awayName} <span style={{ color:T.text3 }}>@</span> {pick.game.homeName}
            </div>
            {isLiveGame && (
              <div style={{ display:"flex", alignItems:"center", gap:5, marginTop:3 }}>
                <span style={{ width:5, height:5, borderRadius:"50%", background:T.red, display:"inline-block", animation:"pulse 1.2s infinite" }} />
                <span style={{ fontSize:9, color:T.red, fontWeight:800 }}>
                  LIVE · Q{pick.game.quarter} {pick.game.clock} · {pick.game.awayScore}–{pick.game.homeScore}
                </span>
              </div>
            )}
          </div>
          <TeamBadge abbr={pick.game.home} size={36} />
        </div>

        {/* Full pick text */}
        <div style={{ fontSize:13, color:T.text2, lineHeight:1.6, marginBottom:12 }}>{pick.text}</div>

        {/* Live status detail */}
        {isLiveGame && ouOnTrack !== null && (
          <div style={{ fontSize:11, fontWeight:700, color: ouOnTrack ? T.green : T.red, marginBottom:8 }}>
            {ouOnTrack ? "✓ ON TRACK" : "✗ FADING"} · Projected {pace.projected} (line: {pace.ouLine})
          </div>
        )}
        {isLiveGame && betMargin !== null && (
          <div style={{ fontSize:11, fontWeight:700, color: betMargin > 0 ? T.green : betMargin < 0 ? T.red : T.gold, marginBottom:8 }}>
            {betMargin > 0 ? `↑ LEADING +${betMargin}` : betMargin < 0 ? `↓ TRAILING ${betMargin}` : "= TIED"}
          </div>
        )}

        {/* Dubl score + reasoning */}
        {pick.reasoning && (
          <div style={{ padding:"10px 12px", background:"rgba(255,255,255,0.04)", borderRadius:10, border:`1px solid ${T.border}`, marginBottom:12 }}>
            <div style={{ fontSize:8, color:ec, letterSpacing:"0.1em", fontWeight:700, marginBottom:4 }}>DUBL SCORE · {pick.score}/5</div>
            <div style={{ fontSize:11, color:T.text2, lineHeight:1.6 }}>{pick.reasoning}</div>
          </div>
        )}

        {/* Payout calc shortcut */}
        {onPickOdds && (
          <button onClick={() => { onPickOdds(calcOdds); onClose(); }} style={{
            width:"100%", padding:"11px 0", borderRadius:10,
            background:`${color}18`, border:`1px solid ${color}44`,
            color, fontSize:12, fontWeight:700, cursor:"pointer", letterSpacing:"0.05em",
          }}>
            💰 Calculate Payout ({calcOdds})
          </button>
        )}
      </div>
    </>
  );
}

function TopPickCard({ pick, rank, onExpand, onRemove }) {
  const ec = pick.score != null ? edgeColor(pick.score) : T.text3;
  const isBet = pick.type === "bet";
  const isOu  = pick.type === "ou";
  const isMyPick = !!onRemove;
  const isLiveGame = pick.game.status === "live";
  const isFinalGame = pick.game.status === "final";
  const color = isBet ? T.green : isOu ? T.gold : "#a78bfa";
  const betLine = isBet ? (pick.text?.match(/([+-]\d+(?:\.\d+)?)/)?.[1] || "") : "";
  const ouTextMatch = isOu ? pick.text?.match(/^(over|under)\s+([\d.]+)/i) : null;
  const ouDir = ouTextMatch?.[1]?.toLowerCase() === "under" ? "U" : "O";
  const ouLineNum = ouTextMatch?.[2] || pick.game?.ou || "";
  const pickLabel = isBet
    ? `${pick.betTeam || "?"}${betLine ? ` ${betLine}` : ""}`
    : isOu
    ? `${ouDir} ${ouLineNum}`
    : (pick.text?.split(" ").slice(0,3).join(" ") || "PROP");

  const pace = (isOu && isLiveGame) ? calcLivePace(pick.game) : null;
  const isOver = isOu && ouDir === "O";
  const ouOnTrack = pace ? (isOver ? pace.projected > pace.ouLine : pace.projected < pace.ouLine) : null;
  let betMargin = null;
  if (isBet && isLiveGame && pick.betTeam) {
    const isBettingHome = pick.betTeam === pick.game.home;
    betMargin = (isBettingHome ? (pick.game.homeScore||0) : (pick.game.awayScore||0))
              - (isBettingHome ? (pick.game.awayScore||0) : (pick.game.homeScore||0));
  }
  const liveBadgeText = isLiveGame
    ? isBet
      ? betMargin > 0 ? "LEAD" : betMargin < 0 ? "TRAIL" : "TIED"
      : ouOnTrack !== null ? (ouOnTrack ? "TRACK" : "FADE") : null
    : null;
  const liveBadgeColor = isBet
    ? betMargin > 0 ? T.green : betMargin < 0 ? T.red : T.gold
    : ouOnTrack ? T.green : T.red;

  // Final result hit/miss
  let finalHit = null;
  if (isFinalGame) {
    const r = calcFinalResults(pick.game);
    if (r) {
      if (isBet) {
        if (pick.betIsSpread && r.spreadResult) {
          const bettingFav = pick.betTeam === r.spreadResult.favAbbr;
          const h = bettingFav ? r.spreadResult.hit === "fav" : r.spreadResult.hit === "dog";
          finalHit = r.spreadResult.hit === "push" ? "push" : h;
        } else if (pick.betTeam) {
          finalHit = pick.betTeam === r.mlWinner;
        }
      } else if (isOu && r.totalResult) {
        const leanedOver = ouDir === "O";
        finalHit = r.totalResult.hit === "PUSH" ? "push" : leanedOver ? r.totalResult.hit === "OVER" : r.totalResult.hit === "UNDER";
      }
    }
  }

  const awayLeads = (isLiveGame || isFinalGame) && (pick.game.awayScore ?? 0) > (pick.game.homeScore ?? 0);
  const homeLeads = (isLiveGame || isFinalGame) && (pick.game.homeScore ?? 0) > (pick.game.awayScore ?? 0);
  const awayC = TEAM_COLORS[pick.game.away] || "#1a3a6e";
  const homeC = TEAM_COLORS[pick.game.home] || "#6e1a1a";

  return (
    <div style={{
      border: `1px solid ${isLiveGame ? "rgba(248,70,70,0.35)" : isMyPick ? "rgba(167,139,250,0.35)" : rank===1 ? "rgba(245,166,35,0.3)" : T.border}`,
      borderRadius:12, overflow:"hidden", position:"relative",
      display:"flex", flexDirection:"column",
      animation: rank ? `fadeUp ${0.1+rank*0.07}s ease` : undefined,
    }}>
      {/* Colored top bar */}
      <div style={{ height:2, background: isLiveGame ? "linear-gradient(90deg,#f84646,#ff8c00)" : isMyPick ? "linear-gradient(90deg,#a78bfa,#7c3aed)" : rank===1 ? "linear-gradient(90deg,#f5a623,#ff8c00)" : `linear-gradient(90deg,${ec}55,transparent)` }} />

      {/* Hero — card.png + team color blend */}
      <div style={{ position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", inset:0, backgroundImage:"url('/static/card.png')", backgroundSize:"100% auto", backgroundPosition:"top center", backgroundRepeat:"no-repeat", zIndex:0 }} />
        <div style={{ position:"absolute", inset:0, background:`linear-gradient(112deg, ${awayC} 47%, ${homeC} 47%)`, mixBlendMode:"color", zIndex:1 }} />
        <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.22)", zIndex:2 }} />

        <div style={{ position:"relative", zIndex:3, padding:"8px 10px 10px" }}>
          {/* Header row: ★/(rank) · live status · × */}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:7 }}>
            <span style={{ fontSize:9, color: isMyPick ? "#a78bfa" : T.text3, fontWeight:700, lineHeight:1, minWidth:18 }}>
              {isMyPick ? "★" : `(${rank})`}
            </span>
            {isLiveGame && (
              <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                <span style={{ width:5, height:5, borderRadius:"50%", background:T.red, flexShrink:0, animation:"pulse 1.2s infinite" }} />
                <span style={{ fontSize:8, color:T.red, fontWeight:700, letterSpacing:"0.05em" }}>
                  Q{pick.game.quarter}{pick.game.clock ? ` ${pick.game.clock}` : ""}
                </span>
              </div>
            )}
            {onRemove ? (
              <button onClick={e => { e.stopPropagation(); onRemove(); }} style={{
                background:"rgba(0,0,0,0.55)", border:"none", borderRadius:"50%",
                width:16, height:16, color:T.text3, fontSize:10, cursor:"pointer",
                display:"flex", alignItems:"center", justifyContent:"center",
                padding:0, lineHeight:1, WebkitTapHighlightColor:"transparent", minWidth:16,
              }}>×</button>
            ) : <span style={{ minWidth:16 }} />}
          </div>

          {/* Team row — tap to open detail */}
          <div onClick={() => onExpand(pick)} style={{ cursor:"pointer", WebkitTapHighlightColor:"transparent" }}>
            {(isLiveGame || isFinalGame) ? (
              <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                <TeamBadge abbr={pick.game.away} size={22} />
                <span style={{ flex:1, textAlign:"center", fontSize:14, fontWeight: awayLeads ? 800 : 400, color: awayLeads ? "#fff" : "rgba(255,255,255,0.4)" }}>{pick.game.awayScore}</span>
                <span style={{ fontSize:10, color:"rgba(255,255,255,0.35)" }}>–</span>
                <span style={{ flex:1, textAlign:"center", fontSize:14, fontWeight: homeLeads ? 800 : 400, color: homeLeads ? "#fff" : "rgba(255,255,255,0.4)" }}>{pick.game.homeScore}</span>
                <TeamBadge abbr={pick.game.home} size={22} />
              </div>
            ) : (
              <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                <TeamBadge abbr={pick.game.away} size={22} />
                <span style={{ flex:1, fontSize:9, color:"rgba(255,255,255,0.6)", textAlign:"center", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {pick.game.away} @ {pick.game.home}
                </span>
                <TeamBadge abbr={pick.game.home} size={22} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Black bottom strip: BET · STATUS · SCORE */}
      <div style={{ display:"flex", alignItems:"center", gap:4, background:"#0f0d0a", padding:"6px 10px" }}>
        <span style={{
          fontSize:9, fontWeight:700, letterSpacing:"0.04em",
          color, background:`${color}18`, border:`1px solid ${color}44`,
          borderRadius:4, padding:"2px 6px",
          flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
        }}>{isBet ? "✦" : isOu ? "◉" : "▸"} {pickLabel}</span>
        {liveBadgeText && (
          <span style={{
            fontSize:7, fontWeight:800, letterSpacing:"0.04em",
            color: liveBadgeColor, background:`${liveBadgeColor}18`, border:`1px solid ${liveBadgeColor}44`,
            borderRadius:4, padding:"2px 5px", flexShrink:0,
          }}>{liveBadgeText}</span>
        )}
        {isFinalGame && finalHit !== null && (
          <span style={{
            fontSize:7, fontWeight:800, letterSpacing:"0.04em",
            color: finalHit === "push" ? T.gold : finalHit ? T.green : T.red,
            background: finalHit === "push" ? `${T.gold}18` : finalHit ? `${T.green}18` : `${T.red}18`,
            border: `1px solid ${finalHit === "push" ? `${T.gold}44` : finalHit ? `${T.green}44` : `${T.red}44`}`,
            borderRadius:4, padding:"2px 5px", flexShrink:0,
          }}>{finalHit === "push" ? "PUSH" : finalHit ? "✓ HIT" : "✗ MISS"}</span>
        )}
        {pick.score != null && (
          <span style={{
            width:24, height:24, borderRadius:"50%", flexShrink:0,
            border:`2px solid ${ec}`, background:`${ec}18`,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:9, fontWeight:800, color:ec,
          }}>{pick.score}</span>
        )}
      </div>
    </div>
  );
}

function TopPicksSection({ games, aiOverrides, onPickOdds, favs, onRemoveFav }) {
  const [expandedPick, setExpandedPick] = useState(null);

  // Auto-generated top picks — skip games already saved in My Picks
  const favGameIds = new Set((favs || []).map(p => p.gameId));
  const picks = [];
  for (const g of games) {
    if (g.status === "final") continue;
    if (favGameIds.has(g.id)) continue;
    const a = aiOverrides[g.id];
    if (!a) continue;
    if (a.best_bet && a.dubl_score_bet != null)
      picks.push({ type:"bet", score:a.dubl_score_bet, text:a.best_bet, betTeam:a.bet_team, betIsSpread:a.bet_is_spread, game:g, reasoning:a.dubl_reasoning_bet });
    if (a.ou && a.dubl_score_ou != null)
      picks.push({ type:"ou",  score:a.dubl_score_ou,  text:a.ou, game:g, reasoning:a.dubl_reasoning_ou });
  }
  const top = picks.sort((a,b) => b.score - a.score).slice(0,3);

  // User-saved picks — only show ones whose game is in the current date's list.
  // Match on exact id or base id (strips date suffix) so format differences don't matter.
  const myPicks = (favs || [])
    .map(p => {
      const basePickId = p.gameId.replace(/-\d{8}$/, "");
      const game = games.find(g =>
        g.id === p.gameId || g.id.replace(/-\d{8}$/, "") === basePickId
      );
      if (!game) return null;
      return { ...p, game };
    })
    .filter(Boolean);

  if (top.length === 0 && myPicks.length === 0) return null;

  return (
    <div style={{ padding:"0 16px", marginBottom:14 }}>
      <SectionLabel>TOP PICKS{myPicks.length > 0 ? " & MY PICKS" : " — BEST BET & O/U RANKED BY DUBL SCORE"}</SectionLabel>
      <div style={{ display:"flex", gap:8, overflowX:"auto", paddingBottom:4,
        scrollbarWidth:"none", MsOverflowStyle:"none", WebkitOverflowScrolling:"touch" }}>
        {myPicks.map(pick => (
          <div key={`my-${pick.id}`} style={{ flexShrink:0, width:180 }}>
            <TopPickCard pick={pick} onExpand={setExpandedPick} onRemove={() => onRemoveFav(pick.id)} />
          </div>
        ))}
        {top.map((pick,i) => (
          <div key={`top-${pick.game.id}-${pick.type}`} style={{ flexShrink:0, width:180 }}>
            <TopPickCard pick={pick} rank={i+1} onExpand={setExpandedPick} />
          </div>
        ))}
      </div>
      {expandedPick && (
        <TopPickDetailPopup pick={expandedPick} onClose={() => setExpandedPick(null)} onPickOdds={onPickOdds} />
      )}
    </div>
  );
}

// ── TOP PLAYER PROPS (top 3 cards) ───────────────────────────────────────────
function BestBetsSection({ props, games = [], onCalc }) {
  const top = [...props].sort((a,b) => (b.edge_score||0) - (a.edge_score||0)).slice(0,3);
  function findGame(prop) {
    if (!games.length || !prop.matchup) return null;
    const teams = prop.matchup.split(/\s*[@–\-]\s*/).flatMap(s => s.trim().split(/\s+/)).filter(Boolean);
    return games.find(g => teams.includes(g.away) || teams.includes(g.home)) || null;
  }
  return (
    <div style={{ marginBottom:28 }}>
      <SectionLabel>TOP PLAYER PROPS</SectionLabel>
      <div style={{ display:"grid", gap:12, gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))" }}>
        {top.map((p,i) => <BestBetCard key={i} prop={p} rank={i+1} game={findGame(p)} onCalc={onCalc} />)}
      </div>
    </div>
  );
}

// ── PAYOUT CALC POPUP (bottom-sheet, iOS-optimized) ───────────────────────────
function CalcPopup({ onClose, initialOdds }) {
  const [odds, setOdds] = useState(initialOdds || "-110");
  const [stake, setStake] = useState(() => localStorage.getItem("calc_stake") || "100");
  const payout = americanToPayout(odds, parseFloat(stake) || 0);
  const handleStake = v => { setStake(v); localStorage.setItem("calc_stake", v); };
  const profit = payout ? (parseFloat(payout) - (parseFloat(stake) || 0)).toFixed(2) : null;

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{
        position:"fixed", inset:0, background:"rgba(0,0,0,0.4)", zIndex:300,
        WebkitTapHighlightColor:"transparent",
      }} />
      {/* Sheet */}
      <div style={{
        position:"fixed", bottom:0, left:0, right:0, zIndex:301,
        background:T.card, borderTop:`1px solid ${T.borderBr}`,
        borderRadius:"20px 20px 0 0",
        padding:"20px 20px calc(20px + env(safe-area-inset-bottom))",
        animation:"slideUp 0.22s ease",
        maxWidth:480, margin:"0 auto",
      }}>
        {/* Handle */}
        <div style={{ width:36, height:4, borderRadius:2, background:"rgba(255,255,255,0.15)", margin:"0 auto 18px" }} />
        {/* Title row */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div style={{ fontSize:13, fontWeight:800, color:T.gold, letterSpacing:"0.08em" }}>💰 PAYOUT CALCULATOR</div>
          <button onClick={onClose} style={{ background:"rgba(255,255,255,0.06)", border:"none", borderRadius:20, width:30, height:30, color:T.text3, fontSize:16, display:"flex", alignItems:"center", justifyContent:"center" }}>×</button>
        </div>
        {/* Inputs */}
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          {[
            { label:"ODDS (e.g. -110, +150)", val:odds, set:setOdds, placeholder:"-110", inputMode:"text" },
            { label:"STAKE ($)", val:stake, set:handleStake, placeholder:"100", inputMode:"decimal" },
          ].map(f => (
            <div key={f.label}>
              <label style={{ display:"block", fontSize:9, color:T.text3, letterSpacing:"0.1em", fontWeight:700, marginBottom:7 }}>{f.label}</label>
              <input
                value={f.val}
                onChange={e => f.set(e.target.value)}
                placeholder={f.placeholder}
                inputMode={f.inputMode}
                style={{
                  width:"100%", boxSizing:"border-box",
                  background:T.cardAlt, border:`1px solid ${T.borderBr}`,
                  borderRadius:10, color:T.text,
                  padding:"14px 15px",
                  fontSize:16, /* prevents iOS zoom */
                  fontFamily:"inherit",
                }}
              />
            </div>
          ))}
        </div>
        {/* Results */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginTop:18 }}>
          {[
            { label:"PAYOUT", value: payout ? `$${payout}` : "—", color: payout ? T.text : T.text3 },
            { label:"PROFIT", value: profit ? `+$${profit}` : "—", color: profit && parseFloat(profit) > 0 ? T.green : T.text3 },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ background:T.cardAlt, border:`1px solid ${T.border}`, borderRadius:12, padding:"16px", textAlign:"center" }}>
              <div style={{ fontSize:9, color:T.text3, letterSpacing:"0.1em", fontWeight:700, marginBottom:8 }}>{label}</div>
              <div style={{ fontSize:24, fontWeight:800, color }}>{value}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function BestBetCard({ prop, rank, game, onCalc }) {
  const over = prop.rec === "OVER";
  const rankColors = ["#f5a623","#9aa0b0","#cd7f32"];
  const rankLabels = ["TOP PICK","2ND PICK","3RD PICK"];
  const rc = rankColors[rank-1] || T.text3;
  const isLive = game?.status === "live";
  const ec = edgeColor(prop.edge_score);
  return (
    <div style={{
      background: T.card, border:`1px solid ${rank===1 ? "rgba(245,166,35,0.3)" : isLive ? "rgba(248,70,70,0.25)" : T.border}`,
      borderRadius:14, overflow:"hidden", animation:`fadeUp ${0.1+rank*0.07}s ease`,
      display:"flex", flexDirection:"column",
    }}>
      {/* top accent */}
      <div style={{ height:2, background: isLive ? "linear-gradient(90deg,#f84646,#ff8c00)" : rank===1 ? "linear-gradient(90deg,#f5a623,#ff8c00)" : T.border }} />

      {/* live score banner */}
      {isLive && (
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"7px 14px", background:"rgba(248,70,70,0.08)", borderBottom:`1px solid rgba(248,70,70,0.15)` }}>
          <div style={{ display:"flex", alignItems:"center", gap:5 }}>
            <span style={{ width:6, height:6, borderRadius:"50%", background:T.red, display:"inline-block", animation:"pulse 1.2s infinite" }} />
            <span style={{ fontSize:9, color:T.red, fontWeight:800, letterSpacing:"0.08em" }}>LIVE · Q{game.quarter} {game.clock}</span>
          </div>
          <div style={{ fontSize:14, fontWeight:800, letterSpacing:"0.03em" }}>
            <span style={{ color: game.awayScore >= game.homeScore ? T.text : T.text3 }}>{game.away} {game.awayScore}</span>
            <span style={{ color:T.text3, margin:"0 6px" }}>–</span>
            <span style={{ color: game.homeScore > game.awayScore ? T.text : T.text3 }}>{game.home} {game.homeScore}</span>
          </div>
        </div>
      )}

      <div style={{ padding:"12px 14px", flex:1, display:"flex", flexDirection:"column", gap:0 }}>
        {/* rank + matchup */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:9 }}>
          <span style={{ fontSize:9, color:rc, fontWeight:800, letterSpacing:"0.1em" }}>{rankLabels[rank-1] || `#${rank}`}</span>
          {!isLive && <span style={{ fontSize:9, color:T.text3, fontWeight:500 }}>{prop.matchup}</span>}
        </div>

        {/* player name + DUBL score */}
        <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:8, marginBottom:4 }}>
          <div style={{ minWidth:0 }}>
            <div style={{ fontSize:17, fontWeight:800, color:T.text, lineHeight:1.2, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{prop.player}</div>
            <div style={{ fontSize:10, color:T.text3, marginTop:3 }}>{prop.team}{prop.pos ? ` · ${prop.pos}` : ""}</div>
          </div>
          <div style={{ flexShrink:0, marginTop:1 }}>
            <EdgeCircle score={prop.edge_score} reasoning={prop.reason} />
          </div>
        </div>

        {/* prop pill + REC badge + odds */}
        <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:10, marginBottom: prop.avg != null ? 8 : 10 }}>
          <div style={{ background:"rgba(255,255,255,0.07)", borderRadius:7, padding:"5px 10px", fontSize:12, fontWeight:700, color:T.text, flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {prop.prop}
          </div>
          <div style={{ background: over ? T.greenDim : T.redDim, border:`1px solid ${over ? T.greenBdr : "rgba(248,70,70,0.3)"}`, borderRadius:7, padding:"5px 9px", fontSize:10, fontWeight:800, color: over ? T.green : T.red, flexShrink:0 }}>
            {prop.rec}
          </div>
          <span
            onClick={() => onCalc && onCalc(prop.odds)}
            style={{ fontSize:13, fontWeight:800, color:T.text2, flexShrink:0, cursor:onCalc?"pointer":"default", textDecoration:onCalc?"underline dotted":"none" }}
          >{prop.odds}</span>
        </div>

        {/* avg */}
        {prop.avg != null && (
          <div style={{ fontSize:10, color:T.text3, marginBottom:8 }}>Season avg: <strong style={{color:T.text2}}>{prop.avg}</strong></div>
        )}

        {/* reason */}
        {prop.reason && (
          <p style={{ color:T.text2, fontSize:10, margin:0, lineHeight:1.65, marginTop:"auto", paddingTop:4 }}>{prop.reason}</p>
        )}
      </div>
    </div>
  );
}

function EdgeCircle({ score, reasoning }) {
  const [open, setOpen] = useState(false);
  const c = edgeColor(score);
  return (
    <div style={{ position:"relative" }}>
      <div
        onClick={e => { e.stopPropagation(); if (reasoning) setOpen(o => !o); }}
        style={{
          width:40, height:40, borderRadius:"50%",
          border:`2.5px solid ${c}`, background:`${c}18`,
          display:"flex", alignItems:"center", justifyContent:"center",
          fontSize:12, fontWeight:800, color:c,
          cursor: reasoning ? "pointer" : "default",
        }}
      >{score}</div>
      {open && reasoning && (
        <div style={{
          position:"absolute", right:0, top:46, zIndex:200,
          background:T.card, border:`1px solid ${c}44`,
          borderRadius:10, padding:"10px 12px",
          fontSize:10, color:T.text2, lineHeight:1.6,
          width:210, boxShadow:"0 8px 24px rgba(0,0,0,0.55)",
        }}>
          <div style={{ fontSize:8, color:c, letterSpacing:"0.1em", fontWeight:700, marginBottom:5 }}>DUBL SCORE · {score}/5</div>
          {reasoning}
        </div>
      )}
    </div>
  );
}

function BetCalcCard() {
  const [odds, setOdds] = useState("-110");
  const [stake, setStake] = useState("100");
  const payout = americanToPayout(odds, parseFloat(stake)||0);
  const profit = payout ? (parseFloat(payout)-(parseFloat(stake)||0)).toFixed(2) : null;
  return (
    <div style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:14, padding:"16px", marginBottom:14 }}>
      <div style={{ fontSize:10, fontWeight:700, color:T.gold, letterSpacing:"0.1em", marginBottom:14 }}>PAYOUT CALCULATOR</div>
      <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
        {[
          { label:"ODDS", val:odds, set:setOdds, placeholder:"-110" },
          { label:"STAKE ($)", val:stake, set:setStake, placeholder:"100", type:"number" },
        ].map(f => (
          <div key={f.label} style={{ flex:1, minWidth:80 }}>
            <label style={{ display:"block", fontSize:8, color:T.text3, letterSpacing:"0.08em", marginBottom:5 }}>{f.label}</label>
            <input value={f.val} onChange={e=>f.set(e.target.value)} placeholder={f.placeholder} type={f.type||"text"}
              style={{ width:"100%", boxSizing:"border-box", background:T.cardAlt, border:`1px solid ${T.border}`, borderRadius:8, color:T.text, padding:"9px 12px", fontSize:16, fontFamily:"inherit" }} />
          </div>
        ))}
        <div style={{ flex:1, minWidth:80 }}>
          <div style={{ fontSize:8, color:T.text3, letterSpacing:"0.08em", marginBottom:5 }}>PAYOUT</div>
          <div style={{ background:T.cardAlt, border:`1px solid ${T.border}`, borderRadius:8, padding:"9px 12px", fontSize:12, fontWeight:700, color:T.green, minHeight:38 }}>
            {payout ? `$${payout}` : "—"}
          </div>
        </div>
        <div style={{ flex:1, minWidth:80 }}>
          <div style={{ fontSize:8, color:T.text3, letterSpacing:"0.08em", marginBottom:5 }}>PROFIT</div>
          <div style={{ background:T.cardAlt, border:`1px solid ${T.border}`, borderRadius:8, padding:"9px 12px", fontSize:12, fontWeight:700, color: profit && parseFloat(profit)>0 ? T.green : T.red, minHeight:38 }}>
            {profit ? `+$${profit}` : "—"}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── PROPS TABLE (with Best Bets section at top) ───────────────────────────────
function PropsTab({ props, parlay, toggleParlay, onCalc, games }) {
  const [filter, setFilter] = useState("all");
  const [sortCol, setSortCol] = useState("edge_score");
  const [sortDir, setSortDir] = useState("desc");
  const [search, setSearch] = useState("");
  const [statCat, setStatCat] = useState("all");

  const statCategories = [
    {id:"all",label:"All Stats"},
    {id:"Points",label:"Points"},
    {id:"Rebounds",label:"Rebounds"},
    {id:"Assists",label:"Assists"},
    {id:"3PM",label:"3-Pointers"},
    {id:"Blocks",label:"Blocks"},
    {id:"Steals",label:"Steals"},
  ];

  const filters = [
    {id:"all",label:"ALL"},
    {id:"over",label:"OVER"},
    {id:"under",label:"UNDER"},
  ];
  const sorted = props
    .filter(p => {
      if (filter==="over" && p.rec!=="OVER") return false;
      if (filter==="under" && p.rec!=="UNDER") return false;
      if (statCat!=="all" && p.stat!==statCat) return false;
      if (search && !p.player.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    })
    .sort((a,b)=>(sortDir==="desc"?-1:1)*(a[sortCol]-b[sortCol]));
  const doSort = col => { if(sortCol===col) setSortDir(d=>d==="desc"?"asc":"desc"); else{setSortCol(col);setSortDir("desc");} };
  const Th = ({col,children}) => (
    <th onClick={col?()=>doSort(col):undefined} style={{
      padding:"10px 12px", textAlign:"left", fontSize:9,
      color: sortCol===col ? T.green : T.text3,
      letterSpacing:"0.08em", fontWeight:700, cursor:col?"pointer":"default",
      background:"rgba(0,0,0,0.2)", whiteSpace:"nowrap",
    }}>
      {children}{col && <span style={{marginLeft:3,fontSize:8}}>{sortCol===col?(sortDir==="desc"?"↓":"↑"):"↕"}</span>}
    </th>
  );
  return (
    <TabPane>
      {/* Best Bets at top */}
      <BestBetsSection props={props} games={games} onCalc={onCalc} />

      {/* Divider */}
      <div style={{ borderTop:`1px solid ${T.border}`, marginBottom:22 }} />

      {/* Search + Stat Category row */}
      <div style={{ display:"flex", gap:8, marginBottom:12, flexWrap:"wrap" }}>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search player..."
          style={{
            flex:"1 1 160px", minWidth:0,
            background:T.cardAlt, border:`1px solid ${search ? T.greenBdr : T.borderBr}`,
            borderRadius:8, color:T.text, padding:"8px 12px",
            fontSize:16, fontFamily:"inherit",
            outline:"none",
          }}
        />
        <select
          value={statCat}
          onChange={e => setStatCat(e.target.value)}
          style={{
            background:T.cardAlt, border:`1px solid ${statCat!=="all" ? T.greenBdr : T.borderBr}`,
            borderRadius:8, color:statCat!=="all" ? T.green : T.text2,
            padding:"8px 12px", fontSize:12, fontFamily:"inherit",
            fontWeight:700, cursor:"pointer", outline:"none",
          }}
        >
          {statCategories.map(c => (
            <option key={c.id} value={c.id} style={{ background:T.card }}>{c.label}</option>
          ))}
        </select>
      </div>

      {/* Full props table */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14, flexWrap:"wrap", gap:8 }}>
        <SectionLabel noMargin>
          {sorted.length} PLAYER PROPS · AI RANKED
        </SectionLabel>
        <div style={{ display:"flex", gap:6 }}>
          {filters.map(f=>(
            <button key={f.id} onClick={()=>setFilter(f.id)} style={{
              background: filter===f.id ? T.greenDim : "transparent",
              border:`1px solid ${filter===f.id ? T.greenBdr : T.border}`,
              borderRadius:6, padding:"5px 12px", fontSize:10, fontWeight:700,
              color: filter===f.id ? T.green : T.text3, letterSpacing:"0.05em",
            }}>{f.label}</button>
          ))}
        </div>
      </div>
      <div style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:14, overflow:"hidden" }}>
        <div style={{ overflowX:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", minWidth:680 }}>
            <thead>
              <tr>
                <Th>+</Th>
                <Th>PLAYER</Th>
                <Th>PROP</Th>
                <Th>REC</Th>
                <Th col="avg">AVG</Th>
                <Th col="edge_score">DUBL</Th>
                <Th>ODDS</Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p,i) => {
                const inParlay = parlay.some(x=>x.player===p.player&&x.prop===p.prop);
                const over = p.rec==="OVER";
                return (
                  <tr key={i} style={{ borderTop:`1px solid ${T.border}`, background: inParlay?"rgba(83,211,55,0.04)":"transparent" }}>
                    <td style={{ padding:"12px" }}>
                      <button onClick={()=>toggleParlay(p)} style={{
                        width:22, height:22, borderRadius:5,
                        border:`2px solid ${inParlay?T.green:T.borderBr}`,
                        background: inParlay?T.green:"transparent",
                        color: inParlay?"#13151a":T.text3, fontSize:11, fontWeight:700,
                        display:"flex",alignItems:"center",justifyContent:"center",
                      }}>{inParlay?"✓":""}</button>
                    </td>
                    <td style={{ padding:"12px" }}>
                      <div style={{ fontWeight:700, color:T.text, fontSize:13, whiteSpace:"nowrap" }}>{p.player}</div>
                      <div style={{ fontSize:10, color:T.text3, marginTop:1 }}>{p.team} {p.pos}</div>
                    </td>
                    <td style={{ padding:"12px", whiteSpace:"nowrap", color:T.text2, fontSize:12 }}>{p.prop}</td>
                    <td style={{ padding:"12px" }}>
                      <span style={{
                        background:over?T.greenDim:T.redDim,
                        border:`1px solid ${over?"rgba(83,211,55,0.3)":"rgba(248,70,70,0.3)"}`,
                        borderRadius:5, padding:"3px 8px", fontSize:10, fontWeight:700,
                        color:over?T.green:T.red,
                      }}>{p.rec}</span>
                    </td>
                    <td style={{ padding:"12px" }}>
                      <span style={{ fontSize:12, fontWeight:700, color:p.avg?T.text:T.text3 }}>{p.avg||"—"}</span>
                    </td>
                    <td style={{ padding:"12px" }}>
                      <EdgeCircle score={p.edge_score} reasoning={p.reason} />
                    </td>
                    <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                      <span
                        onClick={() => onCalc && onCalc(p.odds)}
                        style={{ fontSize:12, fontWeight:700, color:p.odds.startsWith("+")?T.green:T.text2, cursor:onCalc?"pointer":"default", textDecoration:onCalc?"underline dotted":"none" }}
                      >{p.odds}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div style={{ marginTop:10, fontSize:10, color:T.text3, textAlign:"center" }}>
        ⚠️ Check odds with your sportsbook · For entertainment only
      </div>
    </TabPane>
  );
}

// ── PARLAY TRAY ───────────────────────────────────────────────────────────────
function ParlayTray({ parlay, onRemove, onClear }) {
  const [stake, setStake] = useState("100");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const calc = async () => {
    if (parlay.length < 2) return;
    setBusy(true);
    try {
      const r = await fetch("/api/parlay", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ odds: parlay.map(p=>p.odds) }),
      }).then(r=>r.json());
      setResult(r);
    } catch(e) {}
    setBusy(false);
  };

  const payout = result && stake ? (result.combined_decimal * parseFloat(stake)).toFixed(2) : null;
  const profit = payout ? (parseFloat(payout)-(parseFloat(stake)||0)).toFixed(2) : null;

  if (!parlay.length) return null;
  return (
    <div style={{
      position:"fixed", bottom:0, left:0, right:0, zIndex:200,
      background:`linear-gradient(0deg,#f0f0f0 0%,${T.card} 100%)`,
      borderTop:`1px solid ${T.greenBdr}`,
      boxShadow:"0 -8px 40px rgba(0,0,0,0.7)",
      animation:"slideUp 0.25s ease",
      paddingBottom:"env(safe-area-inset-bottom)",
    }}>
      <div style={{ maxWidth:960, margin:"0 auto", padding:"12px 16px" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
          <span style={{ color:T.green, fontSize:10, fontWeight:800, letterSpacing:"0.08em", whiteSpace:"nowrap" }}>
            🎰 PARLAY · {parlay.length} LEGS
          </span>
          <div style={{ display:"flex", gap:5, flex:1, flexWrap:"wrap" }}>
            {parlay.map((p,i)=>(
              <div key={i} style={{
                display:"flex",alignItems:"center",gap:4,
                background:T.greenDim, border:`1px solid ${T.greenBdr}`,
                borderRadius:6, padding:"4px 8px",
              }}>
                <span style={{ fontSize:10, color:T.text2 }}>{p.player}</span>
                <span style={{ fontSize:9, color:T.green, fontWeight:700 }}>{p.rec}</span>
                <button onClick={()=>onRemove(p)} style={{ background:"none",border:"none",color:T.text3,fontSize:13,padding:0,lineHeight:1 }}>×</button>
              </div>
            ))}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <input value={stake} onChange={e=>{setStake(e.target.value);setResult(null);}} type="number" placeholder="$100"
              style={{ width:80, background:T.cardAlt, border:`1px solid ${T.border}`, borderRadius:7, color:T.text, padding:"7px 10px", fontSize:16, fontFamily:"inherit" }} />
            <button onClick={calc} disabled={busy||parlay.length<2} style={{
              background:T.green, color:"#080d1a", border:"none", borderRadius:7,
              padding:"8px 14px", fontSize:10, fontWeight:800, letterSpacing:"0.06em",
              opacity:busy||parlay.length<2?0.5:1,
            }}>{busy?"...":"CALCULATE"}</button>
            <button onClick={()=>{onClear();setResult(null);}} style={{
              background:"transparent", border:`1px solid ${T.border}`,
              borderRadius:7, padding:"8px 12px", fontSize:10, color:T.text3,
            }}>CLEAR</button>
          </div>
          {result && (
            <div style={{ display:"flex", gap:14, flexWrap:"wrap" }}>
              {[["ODDS",result.combined_odds,T.green],["PAYOUT",payout?`$${payout}`:"-",T.text],["PROFIT",profit?`+$${profit}`:"-",T.green],["IMPL%",`${result.implied_prob}%`,T.text2]].map(([l,v,c])=>(
                <div key={l} style={{ textAlign:"center" }}>
                  <div style={{ fontSize:8,color:T.text3,letterSpacing:"0.08em" }}>{l}</div>
                  <div style={{ fontSize:15,fontWeight:800,color:c }}>{v}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── CHAT ──────────────────────────────────────────────────────────────────────
const QUICK = ["Best bet tonight?","Top prop plays?","Any live value right now?","Best parlay tonight?","Injury impact today?"];

function ChatTab({ apiKey }) {
  const [msgs, setMsgs] = useState([{role:"assistant",content:"Welcome to dublplay 🏀 Ask me anything about tonight's slate — props, spreads, live value, injuries. (Entertainment only.)"}]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ref = useRef(null);
  useEffect(()=>{ if(ref.current) ref.current.scrollTop=ref.current.scrollHeight; },[msgs]);

  const send = async (text) => {
    const msg = text||input;
    if(!msg.trim()||busy) return;
    const next = [...msgs,{role:"user",content:msg}];
    setMsgs(next); setInput(""); setBusy(true); setErr("");
    try {
      const d = await api.chat(next, apiKey);
      setMsgs([...next,{role:"assistant",content:d.reply}]);
    } catch(e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <TabPane>
      <SectionLabel>AI BETTING CHAT</SectionLabel>
      <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:14 }}>
        {QUICK.map(q=>(
          <button key={q} onClick={()=>send(q)} disabled={busy} style={{
            background:"rgba(167,139,250,0.08)", border:"1px solid rgba(167,139,250,0.2)",
            borderRadius:20, padding:"6px 12px", fontSize:10, color:"rgba(167,139,250,0.8)",
            whiteSpace:"nowrap", opacity:busy?0.5:1,
          }}>{q}</button>
        ))}
      </div>
      <div style={{ background:T.card, border:`1px solid ${T.border}`, borderRadius:14, overflow:"hidden", display:"flex", flexDirection:"column", height:420 }}>
        <div ref={ref} style={{ flex:1, overflowY:"auto", padding:16, display:"flex", flexDirection:"column", gap:10 }}>
          {msgs.map((m,i)=>(
            <div key={i} style={{
              alignSelf:m.role==="user"?"flex-end":"flex-start", maxWidth:"82%",
              background:m.role==="user"?T.greenDim:"rgba(255,255,255,0.04)",
              border:`1px solid ${m.role==="user"?T.greenBdr:T.border}`,
              borderRadius:m.role==="user"?"14px 14px 3px 14px":"14px 14px 14px 3px",
              padding:"10px 14px", animation:"fadeUp 0.2s ease",
            }}>
              {m.role==="assistant" && <span style={{ color:"#a78bfa",fontSize:9,fontWeight:700,letterSpacing:"0.08em",display:"block",marginBottom:5 }}>dublplay analyst</span>}
              <p style={{ color:T.text2, fontSize:12, lineHeight:1.75, margin:0 }}>{m.content}</p>
            </div>
          ))}
          {busy && <div style={{ alignSelf:"flex-start", color:T.text3, fontSize:11, display:"flex", alignItems:"center", gap:6 }}><Spinner />Analyzing...</div>}
          {err  && <div style={{ color:T.red, fontSize:11 }}>⚠️ {err}</div>}
        </div>
        <div style={{ borderTop:`1px solid ${T.border}`, padding:"12px 14px", display:"flex", gap:10 }}>
          <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&send()}
            placeholder="Ask about games, props, spreads, value plays..."
            style={{ flex:1, background:T.cardAlt, border:`1px solid ${T.border}`, borderRadius:9, color:T.text, padding:"10px 13px", fontSize:16, fontFamily:"inherit" }} />
          <button onClick={()=>send()} disabled={busy||!input.trim()} style={{
            background:"#a78bfa", color:"#0d0f14", border:"none", borderRadius:9,
            padding:"10px 20px", fontSize:11, fontWeight:800, letterSpacing:"0.06em",
            opacity:busy||!input.trim()?0.4:1,
          }}>SEND</button>
        </div>
      </div>
      <Disclaimer />
    </TabPane>
  );
}

// ── SHARED UI PRIMITIVES ──────────────────────────────────────────────────────
const Spinner = () => (
  <span style={{ width:10,height:10,border:"2px solid rgba(255,255,255,0.1)",borderTopColor:T.green,borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite" }} />
);
const SectionLabel = ({children,noMargin}) => (
  <div style={{ fontSize:10,color:T.text3,letterSpacing:"0.12em",fontWeight:700,marginBottom:noMargin?0:14 }}>{children}</div>
);
const TabPane = ({children}) => (
  <div style={{ animation:"fadeUp 0.25s ease" }}>{children}</div>
);
const Disclaimer = () => (
  <p style={{ color:T.text3,fontSize:10,textAlign:"center",marginTop:14,letterSpacing:"0.04em" }}>
    ⚠️ For entertainment purposes only · Not financial advice · Gamble responsibly
  </p>
);

const gateBtn = {
  width:"100%", background:T.green, color:"#fff", border:"none",
  borderRadius:10, padding:"14px", fontSize:12, fontWeight:800, letterSpacing:"0.08em", fontFamily:"inherit",
};

// ── PARSE GAME-ANALYSIS PLAYER PROP TEXT → STRUCTURED PROP ───────────────────
// Format Gemini outputs: "Player OVER/UNDER X.X Stat (±odds) — reason"
const STAT_ALIASES = {
  "points": "Points", "point": "Points",
  "rebounds": "Rebounds", "rebound": "Rebounds",
  "assists": "Assists", "assist": "Assists",
  "3-pointers made": "3PM", "3-pointer": "3PM", "three-pointers made": "3PM",
  "threes made": "3PM", "threes": "3PM", "three pointers": "3PM",
  "3pm": "3PM",
  "blocks": "Blocks", "block": "Blocks",
  "steals": "Steals", "steal": "Steals",
};
function normalizeStatName(raw) {
  const key = raw.trim().toLowerCase();
  return STAT_ALIASES[key] || raw.trim();
}
function parseGameProp(text, game) {
  if (!text) return null;
  // Match: "Name OVER/UNDER X.X StatWords (±odds) — reason"
  const m = text.match(
    /^(.+?)\s+(OVER|UNDER)\s+(\d+\.?\d*)\s+([^(—–\-]+?)(?:\s*\(([-+]\d+)\))?\s*[—–-]/i
  );
  if (!m) return null;
  const [, player, rec, lineStr, statRaw, oddsStr] = m;
  const line = parseFloat(lineStr);
  const stat = normalizeStatName(statRaw);
  const odds = oddsStr || "-110";
  const recUp = rec.toUpperCase();
  const over_odds  = recUp === "OVER"  ? odds : "-110";
  const under_odds = recUp === "UNDER" ? odds : "-110";
  const matchup = game ? `${game.away} @ ${game.home}` : "";
  const reason = text.replace(/^.+?[—–-]\s*/, "").slice(0, 120);
  return {
    player: player.trim(), team:"", pos:"", stat,
    prop: `${stat} O/U ${line}`, line,
    over_odds, under_odds, odds,
    rec: recUp, avg: null,
    matchup, reason, _source:"game_analysis",
  };
}



// ── ACCURIBET CLIENT-SIDE FETCH ───────────────────────────────────────────────
// Fetched from the browser to bypass Cloudflare blocking cloud-provider IPs.
const AB_BASE = "https://api.accuribet.win";
const _NICKNAME_TO_ABBR = {
  Hawks:"ATL",Celtics:"BOS",Nets:"BKN",Hornets:"CHA",Bulls:"CHI",Cavaliers:"CLE",
  Mavericks:"DAL",Nuggets:"DEN",Pistons:"DET",Warriors:"GSW",Rockets:"HOU",Pacers:"IND",
  Clippers:"LAC",Lakers:"LAL",Grizzlies:"MEM",Heat:"MIA",Bucks:"MIL",Timberwolves:"MIN",
  Pelicans:"NOP",Knicks:"NYK",Thunder:"OKC",Magic:"ORL","76ers":"PHI",Sixers:"PHI",
  Suns:"PHX","Trail Blazers":"POR",Blazers:"POR",Kings:"SAC",Spurs:"SAS",Raptors:"TOR",
  Jazz:"UTA",Wizards:"WAS",
};
function _nameToAbbr(name) {
  if (!name) return "";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    const two = parts.slice(-2).join(" ");
    if (_NICKNAME_TO_ABBR[two]) return _NICKNAME_TO_ABBR[two];
  }
  const last = parts[parts.length - 1];
  if (_NICKNAME_TO_ABBR[last]) return _NICKNAME_TO_ABBR[last];
  return name.length <= 3 ? name.toUpperCase() : name.slice(0, 3).toUpperCase();
}

let _abCache = null;
let _abCacheTime = 0;
async function fetchAccuribetPredictions() {
  // Cache for 10 minutes
  if (_abCache && Date.now() - _abCacheTime < 600000) return _abCache;
  try {
    const [gamesRes, v2Res, ouRes] = await Promise.all([
      fetch(`${AB_BASE}/sports/games`),
      fetch(`${AB_BASE}/sports/predict/all?model_name=v2`),
      fetch(`${AB_BASE}/sports/predict/all?model_name=ou`),
    ]);
    if (!gamesRes.ok || !v2Res.ok || !ouRes.ok) {
      console.warn("Accuribet API error:", gamesRes.status, v2Res.status, ouRes.status);
      return {};
    }
    const [abGames, v2Preds, ouPreds] = await Promise.all([
      gamesRes.json(), v2Res.json(), ouRes.json(),
    ]);
    // Map game_id → team abbreviations
    const gameMap = {};
    for (const g of abGames) {
      const gid = g.game_id || g.id || "";
      const home = _nameToAbbr(g.home_team || g.home_team_name || "");
      const away = _nameToAbbr(g.away_team || g.away_team_name || "");
      if (home && away) gameMap[gid] = { home, away };
    }
    // Index predictions by game_id
    const v2Map = {};
    for (const p of v2Preds) {
      v2Map[p.game_id || ""] = { team: _nameToAbbr(p.prediction || ""), confidence: p.confidence };
    }
    const ouMap = {};
    for (const p of ouPreds) {
      try { ouMap[p.game_id || ""] = parseInt(p.prediction, 10); } catch { /* skip */ }
    }
    // Merge → keyed by "AWAY-HOME" for easy lookup
    const result = {};
    for (const [gid, teams] of Object.entries(gameMap)) {
      const key = [teams.away, teams.home].sort().join("-");
      const entry = {};
      if (v2Map[gid]) { entry.ml_team = v2Map[gid].team; entry.ml_confidence = v2Map[gid].confidence; }
      if (ouMap[gid] != null) entry.ou_total = ouMap[gid];
      if (Object.keys(entry).length) result[key] = entry;
    }
    _abCache = result;
    _abCacheTime = Date.now();
    console.log("Accuribet: fetched", Object.keys(result).length, "predictions");
    return result;
  } catch (e) {
    console.warn("Accuribet fetch failed:", e);
    return {};
  }
}

function mergeAccuribet(analysis, game, abData) {
  if (!analysis || !game || !abData) return analysis;
  if (analysis.accuribet_ml) return analysis; // already has it
  const key = [game.away, game.home].sort().join("-");
  const pred = abData[key];
  if (!pred) return analysis;
  return {
    ...analysis,
    accuribet_ml: pred.ml_team || null,
    accuribet_confidence: pred.ml_confidence != null ? Math.round(pred.ml_confidence * 100 * 10) / 10 : null,
    accuribet_ou: pred.ou_total != null ? String(pred.ou_total) : null,
  };
}

// ── APP ROOT ──────────────────────────────────────────────────────────────────
export default function App() {
  const [apiKey, setApiKey] = useState(null);
  const [serverHasKey, setServerHasKey] = useState(false);
  const [tab, setTab] = useState("explore");
  const [games, setGames] = useState([]);
  const [props, setProps] = useState([]);
  const [loadingIds, setLoadingIds] = useState(new Set());
  const [aiOverrides, setAiOverrides] = useState({});
  const aiCacheRef = useRef({}); // per-date cache: { "20260305": { gameId: override } }
  const [parlay, setParlay] = useState([]);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [gamesLoading, setGamesLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState(null); // null = today
  const [calcSeed, setCalcSeed] = useState(null); // null = closed, string = pre-filled odds
  const [picksData, setPicksData] = useState(null); // picks for the selected date
  const [overallStats, setOverallStats] = useState(null); // 7-day aggregate hit stats
  const [showProfile, setShowProfile] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [selectedGame, setSelectedGame] = useState(null); // null = list view, game obj = detail view
  const profile = useProfile();
  const favorites = useFavoritePicks();
  const analyzedLiveRef = useRef(new Set()); // game IDs already analyzed with live prompt
  const analyzedPreGameRef = useRef(new Set()); // game IDs we already attempted pre-game analysis for this session
  const accuribetRef = useRef({}); // client-side ACCURIBET predictions (bypasses Cloudflare)

  // Use local date parts to avoid UTC rollover (toISOString returns UTC, wrong after 4pm PT etc.)
  const fmtLocal = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}${m}${day}`;
  };

  // Stabilized: computed once on mount so midnight rollovers don't silently
  // swap the game list mid-session. Refresh the page to get the next day.
  const todayStr = useMemo(() => fmtLocal(new Date()), []); // eslint-disable-line react-hooks/exhaustive-deps
  const betStore = useBets(selectedDate || todayStr);

  const tomorrowStr = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return fmtLocal(d);
  })();

  // 1) Check server key
  useEffect(() => {
    api.health()
      .then(d => {
        setServerHasKey(d.has_server_key);
        if (d.has_server_key) setApiKey("");
      })
      .catch(() => setApiKey("__no_server__"));
  }, []);

  // 2) Load games whenever apiKey or selectedDate changes
  const initialLoadDone = useRef(false);
  const prevDateKeyRef = useRef(null);
  useEffect(() => {
    if (apiKey === null) return;
    const newDateKey = selectedDate || todayStr;
    // Save current overrides to per-date cache before switching
    const prevKey = prevDateKeyRef.current;
    if (prevKey) {
      setAiOverrides(cur => { aiCacheRef.current[prevKey] = cur; return cur; });
    }
    prevDateKeyRef.current = newDateKey;
    // Only show full-screen loader on first load; date switches just swap in-place
    if (!initialLoadDone.current) setDataLoaded(false);
    setGames([]);
    // Restore cached overrides for this date, or start empty
    setAiOverrides(aiCacheRef.current[newDateKey] || {});
    setGamesLoading(true);
    analyzedPreGameRef.current.clear();
    Promise.all([api.getGames(selectedDate || todayStr), fetchAccuribetPredictions()])
      .then(([g, ab]) => {
        accuribetRef.current = ab || {};
        setGames(g.games);
        setDataLoaded(true);
        initialLoadDone.current = true;
        setGamesLoading(false);
        setLastUpdated(g.odds_updated_at ? new Date(g.odds_updated_at) : new Date());
      })
      .catch(e => { console.error(e); setGamesLoading(false); });
  }, [apiKey, selectedDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // 3) Auto-poll scores + bets when live games are active (every 30s)
  useEffect(() => {
    const hasLive = games.some(g => g.status === "live");
    if (!hasLive || apiKey === null) return;
    const interval = setInterval(() => {
      api.getGames(selectedDate || todayStr)
        .then(g => { setGames(g.games); setLastUpdated(g.odds_updated_at ? new Date(g.odds_updated_at) : new Date()); })
        .catch(console.error);
      betStore.reload();
    }, 30000);
    return () => clearInterval(interval);
  }, [games, apiKey, selectedDate]); // eslint-disable-line react-hooks/exhaustive-deps


  // 4) Auto-analyze non-final games once data loads
  //    Skip games that already have cached analysis from Firestore, or were already
  //    attempted this session (so Gemini doesn't re-run on every page load / date change).
  useEffect(() => {
    if (!dataLoaded || apiKey === null || apiKey === "__no_server__") return;
    // Load cached analysis for final games (no re-analysis needed)
    games.filter(g => g.status === "final" && g.analysis && g.analysis.best_bet)
      .forEach(g => {
        setAiOverrides(prev => prev[g.id] ? prev : { ...prev, [g.id]: mergeAccuribet(g.analysis, g, accuribetRef.current) });
      });
    games
      .filter(g => g.status !== "final")
      .forEach(g => {
        // Already have valid cached analysis — load it unless odds have moved
        if (g.analysis && g.analysis.best_bet) {
          const snap = g.analysis._snap;
          // Re-analyze pre-game games when spread or O/U changed since last analysis.
          // Live re-analysis is handled separately by effect #5.
          const oddsStale = snap && g.status !== "live" && (
            (g.spread && snap.spread !== "N/A" && snap.spread !== g.spread) ||
            (g.ou     && snap.ou     !== "N/A" && snap.ou     !== g.ou)
          );
          if (!oddsStale) {
            setAiOverrides(prev => prev[g.id] ? prev : { ...prev, [g.id]: mergeAccuribet(g.analysis, g, accuribetRef.current) });
            return;
          }
          // Odds moved — fall through and re-run Gemini with fresh lines
        }
        // Already attempted this session — don't call Gemini again
        if (analyzedPreGameRef.current.has(g.id)) return;
        analyzedPreGameRef.current.add(g.id);
        setLoadingIds(prev => new Set([...prev, g.id]));
        api.analyze(g.id, apiKey, selectedDate || todayStr)
          .then(d => setAiOverrides(prev => ({ ...prev, [g.id]: mergeAccuribet(d.analysis, g, accuribetRef.current) })))
          .catch(console.error)
          .finally(() => setLoadingIds(prev => {
            const next = new Set(prev);
            next.delete(g.id);
            return next;
          }));
      });
  }, [dataLoaded, selectedDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // 5) Re-analyze whenever a game transitions to live (runs on every 30s poll)
  useEffect(() => {
    if (!dataLoaded || apiKey === null || apiKey === "__no_server__") return;
    const newlyLive = games.filter(g => g.status === "live" && !analyzedLiveRef.current.has(g.id));
    if (newlyLive.length === 0) return;
    newlyLive.forEach(g => {
      analyzedLiveRef.current.add(g.id);
      setLoadingIds(prev => new Set([...prev, g.id]));
      api.analyze(g.id, apiKey, selectedDate || todayStr)
        .then(d => setAiOverrides(prev => ({ ...prev, [g.id]: mergeAccuribet(d.analysis, g, accuribetRef.current) })))
        .catch(console.error)
        .finally(() => setLoadingIds(prev => {
          const next = new Set(prev);
          next.delete(g.id);
          return next;
        }));
    });
  }, [games]); // eslint-disable-line react-hooks/exhaustive-deps


  // 6) Load picks for the currently selected date (for HIT/MISS display on game cards).
  //    Re-runs when games change so hit stats update as games go final.
  useEffect(() => {
    const dateKey = selectedDate || todayStr;
    api.getPicks(dateKey)
      .then(d => setPicksData(d))
      .catch(() => setPicksData(null));
  }, [selectedDate, games]); // eslint-disable-line react-hooks/exhaustive-deps

  // 7) Load past 7 days + today to compute overall rolling hit stats.
  //    Re-runs when games change (e.g. a game goes final and picks get scored).
  useEffect(() => {
    const pastDays = [];
    for (let i = 0; i <= 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      pastDays.push(fmtLocal(d));
    }
    Promise.all(pastDays.map(d => api.getPicks(d).catch(() => null)))
      .then(results => {
        let hitsBet = 0, totalBet = 0, hitsOu = 0, totalOu = 0;
        let hitsBet4 = 0, totalBet4 = 0, hitsOu4 = 0, totalOu4 = 0;
        results.forEach(r => {
          if (!r) return;
          (r.picks || []).forEach(p => {
            if (p.result_bet === "HIT") { hitsBet++; totalBet++; }
            else if (p.result_bet === "MISS") { totalBet++; }
            if (p.result_ou === "HIT") { hitsOu++; totalOu++; }
            else if (p.result_ou === "MISS") { totalOu++; }
            // Track 4.0+ DUBL_SCORE picks separately
            const sb = p.dubl_score_bet;
            if (sb != null && sb >= 4.0) {
              if (p.result_bet === "HIT") { hitsBet4++; totalBet4++; }
              else if (p.result_bet === "MISS") { totalBet4++; }
            }
            const so = p.dubl_score_ou;
            if (so != null && so >= 4.0) {
              if (p.result_ou === "HIT") { hitsOu4++; totalOu4++; }
              else if (p.result_ou === "MISS") { totalOu4++; }
            }
          });
        });
        if (totalBet > 0 || totalOu > 0) {
          setOverallStats({ hitsBet, totalBet, hitsOu, totalOu, hitsBet4, totalBet4, hitsOu4, totalOu4 });
        }
      });
  }, [games]); // eslint-disable-line react-hooks/exhaustive-deps

  if (apiKey === null || apiKey === "__no_server__") {
    if (!serverHasKey && apiKey === "__no_server__") {
      return <ApiKeyGate serverHasKey={false} onSubmit={k=>setApiKey(k)} />;
    }
    return <Loader />;
  }
  if (!dataLoaded) return <Loader />;

  const handleRefresh = async (gameId) => {
    setLoadingIds(prev => new Set([...prev, gameId]));
    try {
      const d = await api.analyze(gameId, apiKey, selectedDate || todayStr);
      setAiOverrides(prev => ({ ...prev, [gameId]: d.analysis }));
    } catch(e) {
      console.error(e);
    }
    setLoadingIds(prev => {
      const next = new Set(prev);
      next.delete(gameId);
      return next;
    });
  };

  const toggleParlay = prop => {
    setParlay(prev => {
      const has = prev.some(p=>p.player===prop.player&&p.prop===prop.prop);
      return has ? prev.filter(p=>!(p.player===prop.player&&p.prop===prop.prop)) : [...prev,prop];
    });
  };

  // Build 7 past days + TODAY + TMW for the calendar strip
  const dateOptions = (() => {
    const opts = [];
    for (let i = 7; i >= 1; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const val = fmtLocal(d);
      opts.push({ label: `${d.getMonth()+1}/${d.getDate()}`, val });
    }
    opts.push({ label: "TODAY", val: null });
    const tmw = new Date();
    tmw.setDate(tmw.getDate() + 1);
    opts.push({ label: `${tmw.getMonth()+1}/${tmw.getDate()}`, val: tomorrowStr });
    return opts;
  })();

  // Build picks lookup map keyed by base game_id (no date suffix)
  const picksMap = {};
  if (picksData?.picks) {
    picksData.picks.forEach(p => { picksMap[p.game_id] = p; });
  }

  // ── KALSHI DETAIL VIEW ──
  if (selectedGame) {
    const sg = games.find(g => g.id === selectedGame.id) || selectedGame;
    const baseId = sg.id.replace(/-\d{8}$/, "");
    const pickRecord = picksMap ? (picksMap[baseId] || picksMap[sg.id]) : null;
    return (
      <KalshiDetail
        game={sg}
        aiOverride={aiOverrides[sg.id]}
        onBack={() => setSelectedGame(null)}
        onRefresh={handleRefresh}
        loadingRefresh={loadingIds.has(sg.id)}
        favorites={favorites}
        onFavorite={favorites}
        pickRecord={pickRecord}
        gameBets={betStore ? betStore.forGame(sg.id, profile?.uid) : null}
        onBet={betStore && profile?.uid ? async (gid, side, lockedSpread, lockedMl) => {
          const result = await betStore.pick(gid, side, profile.uid, profile.username, lockedSpread || "", lockedMl || "", selectedDate || todayStr);
          if (result === "placed") profile.deduct(10);
          else if (result === "removed") profile.credit(10);
        } : null}
        username={profile?.username}
        profile={profile}
        onPickOdds={odds => setCalcSeed(odds)}
      />
    );
  }

  // ── KALSHI MAIN VIEW ──
  return (
    <div style={{ minHeight:"100vh", background:T.bg }}>
      {/* ── Header (Kalshi-style) ── */}
      <div style={{ background:T.card, borderBottom:`1px solid ${T.border}` }}>
        <div style={{ display:"flex", alignItems:"center", height:56, padding:"0 20px" }}>
          {/* Hamburger menu → profile */}
          <button
            onClick={() => setShowProfile(v => !v)}
            style={{ background:"none", border:"none", fontSize:20, color:T.text, padding:"4px 8px 4px 0", cursor:"pointer" }}
          >
            {profile.username ? (
              <span style={{
                display:"inline-flex", alignItems:"center", justifyContent:"center",
                width:30, height:30, borderRadius:"50%",
                background: profile.color, fontSize:14, fontWeight:800, color:"#fff",
              }}>{profile.username[0].toUpperCase()}</span>
            ) : "☰"}
          </button>
          <span
            onClick={() => setShowStats(v => !v)}
            style={{ color:T.red, fontWeight:900, fontSize:20, letterSpacing:"-0.02em", marginLeft:8, cursor:"pointer" }}
          >
            dublplay
          </span>
          <div style={{ flex:1 }} />
          {/* Hit stats — toggled by clicking dublplay */}
          {showStats && (() => {
            const { hitsBet = 0, totalBet = 0, hitsOu = 0, totalOu = 0, hitsBet4 = 0, totalBet4 = 0, hitsOu4 = 0, totalOu4 = 0 } = overallStats || {};
            if (totalBet === 0 && totalOu === 0) return null;
            const betPct = totalBet > 0 ? Math.round(hitsBet / totalBet * 100) : null;
            const ouPct  = totalOu  > 0 ? Math.round(hitsOu  / totalOu  * 100) : null;
            const betPct4 = totalBet4 > 0 ? Math.round(hitsBet4 / totalBet4 * 100) : null;
            const ouPct4  = totalOu4  > 0 ? Math.round(hitsOu4  / totalOu4  * 100) : null;
            const c = pct => pct >= 60 ? T.green : pct >= 50 ? T.gold : T.red;
            return (
              <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:1, animation:"fadeIn 0.2s ease" }}>
                <span style={{ fontSize:10, fontWeight:700, whiteSpace:"nowrap", display:"flex", gap:6, alignItems:"center" }}>
                  {betPct !== null && (
                    <span style={{ color:c(betPct) }}>{hitsBet}-{totalBet - hitsBet} Bets ({betPct}%)</span>
                  )}
                  {betPct !== null && ouPct !== null && (
                    <span style={{ color:T.text3 }}>|</span>
                  )}
                  {ouPct !== null && (
                    <span style={{ color:c(ouPct) }}>{hitsOu}-{totalOu - hitsOu} O/U ({ouPct}%)</span>
                  )}
                </span>
                {(betPct4 !== null || ouPct4 !== null) && (
                  <span style={{ fontSize:9, fontWeight:800, whiteSpace:"nowrap", display:"flex", alignItems:"center", gap:4 }}>
                    {betPct4 !== null && (
                      <span style={{ color:c(betPct4) }}>★ {hitsBet4}-{totalBet4 - hitsBet4} ({betPct4}%)</span>
                    )}
                    {betPct4 !== null && ouPct4 !== null && (
                      <span style={{ color:T.text3 }}>|</span>
                    )}
                    {ouPct4 !== null && (
                      <span style={{ color:c(ouPct4) }}>★ {hitsOu4}-{totalOu4 - hitsOu4} ({ouPct4}%)</span>
                    )}
                  </span>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {/* ── Category tabs (Kalshi-style horizontal scroll) ── */}
      <div style={{ background:T.card, borderBottom:`1px solid ${T.border}` }}>
        <div className="hide-scrollbar" style={{
          display:"flex", gap:0, overflowX:"auto", WebkitOverflowScrolling:"touch",
          padding:"0 16px",
        }}>
          {/* Date selector as category tabs */}
          {dateOptions.map(({ label, val }) => {
            const isActive = selectedDate === val;
            const liveCount = isActive || (val === null && selectedDate === null) ? games.filter(g => g.status === "live").length : 0;
            return (
              <button key={label} onClick={() => { setSelectedDate(val); setPicksData(null); setSelectedGame(null); }} style={{
                background:"transparent", border:"none",
                padding:"12px 16px", fontSize:13, fontWeight: isActive ? 700 : 500,
                color: isActive ? T.text : T.text3,
                borderBottom: isActive ? "2px solid #e53935" : "2px solid transparent",
                cursor:"pointer", flexShrink:0, whiteSpace:"nowrap",
                display:"flex", alignItems:"center", gap:5,
              }}>
                {label}
                {isActive && games.length > 0 && (
                  <span style={{ fontSize:11, fontWeight:800, color:T.red }}>{games.length}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Tab content ── */}
      {tab === "explore" && (
        <KalshiGameList
          games={games}
          aiOverrides={aiOverrides}
          onGameClick={g => setSelectedGame(g)}
          lastUpdated={lastUpdated}
          upcomingLabel={selectedDate ? "UPCOMING" : "TONIGHT"}
          betStore={betStore}
          profile={profile}
          loading={gamesLoading}
          picksMap={picksMap}
        />
      )}

      {tab === "mybets" && (
        <KalshiMyBets
          games={games}
          aiOverrides={aiOverrides}
          onPickOdds={odds => setCalcSeed(odds)}
          favorites={favorites}
          onFavorite={favorites}
          onGameClick={g => setSelectedGame(g)}
        />
      )}

      {tab === "chat" && (
        <div style={{ maxWidth:480, margin:"0 auto", padding:"22px 16px 120px" }}>
          <ChatTab apiKey={apiKey} />
        </div>
      )}

      {/* ── Bottom Nav ── */}
      <BottomNav activeTab={tab} onTabChange={setTab} balance={profile.username ? profile.balance : null} />

      {/* ── Overlays ── */}
      <ParlayTray parlay={parlay} onRemove={toggleParlay} onClear={()=>setParlay([])} />
      {calcSeed !== null && <CalcPopup key={calcSeed} initialOdds={calcSeed} onClose={() => setCalcSeed(null)} />}
      {showProfile && <ProfileDropdown profile={profile} onClose={() => setShowProfile(false)} />}
    </div>
  );
}

const LOAD_MESSAGES = [
  "Calculating Odds…",
  "Scanning Lineups…",
  "Making Picks…",
  "Analyzing Trends…",
  "Crunching Numbers…",
  "Checking Injuries…",
  "Running Models…",
  "Almost Ready…",
];

const Loader = () => {
  const [msgIdx, setMsgIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setMsgIdx(i => (i + 1) % LOAD_MESSAGES.length), 1400);
    return () => clearInterval(id);
  }, []);
  return (
    <div style={{
      position:"fixed", inset:0,
      display:"flex", flexDirection:"column",
      alignItems:"center", justifyContent:"flex-end",
      paddingBottom:"12vh",
    }}>
      <img
        src="/static/loading.png"
        alt="DublPlay"
        style={{ position:"absolute", inset:0, width:"100%", height:"100%", objectFit:"contain", background:"#0f0d1a" }}
      />
      <div style={{
        position:"relative", display:"flex", flexDirection:"column",
        alignItems:"center", gap:20,
        background:"rgba(0,0,0,0.45)", borderRadius:16,
        padding:"32px 40px", backdropFilter:"blur(6px)",
      }}>
        <span style={{
          width:36, height:36,
          border:"3px solid rgba(255,255,255,0.15)",
          borderTopColor:T.green,
          borderRadius:"50%",
          display:"inline-block",
          animation:"spin 0.8s linear infinite",
        }} />
        <span key={msgIdx} style={{
          color:"#fff", fontSize:13, letterSpacing:"0.06em",
          minWidth:180, textAlign:"center",
          animation:"fadeUp 0.3s ease",
        }}>
          {LOAD_MESSAGES[msgIdx]}
        </span>
      </div>
    </div>
  );
};
