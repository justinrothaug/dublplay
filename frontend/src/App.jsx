import { useState, useEffect, useRef } from "react";
import { api } from "./api.js";

// ── DESIGN TOKENS ─────────────────────────────────────────────────────────────
const T = {
  bg:       "#13151a",
  card:     "#1c1f28",
  cardAlt:  "#22252f",
  green:    "#53d337",
  greenDim: "rgba(83,211,55,0.12)",
  greenBdr: "rgba(83,211,55,0.28)",
  red:      "#f84646",
  redDim:   "rgba(248,70,70,0.12)",
  gold:     "#f5a623",
  text:     "#ffffff",
  text2:    "#9ea3b0",
  text3:    "#555c6e",
  border:   "rgba(255,255,255,0.07)",
  borderBr: "rgba(255,255,255,0.13)",
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
              style={{ width:"100%", boxSizing:"border-box", background:"rgba(0,0,0,0.4)",
                border:`1px solid ${err ? T.red : T.borderBr}`, borderRadius:10,
                color:T.text, padding:"13px 16px", fontSize:12, fontFamily:"inherit", marginBottom:10 }} />
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

// ── GAME CARD ─────────────────────────────────────────────────────────────────
function GameCard({ game, onRefresh, loadingRefresh, aiOverride, onPickOdds }) {
  const isLive   = game.status === "live";
  const isFinal  = game.status === "final";
  const isUp     = game.status === "upcoming";
  const awayLeads = (isLive || isFinal) && game.awayScore > game.homeScore;
  const homeLeads = (isLive || isFinal) && game.homeScore > game.awayScore;

  const staticAnalysis = game.analysis;
  const displayAnalysis = aiOverride || staticAnalysis;
  // Use lines from Gemini analysis when available — single source of truth
  const L = aiOverride?.lines || {};
  const dispSpread   = L.spread   || game.spread;
  const dispOu       = L.ou       || game.ou;
  const dispAwayOdds = L.awayOdds || game.awayOdds;
  const dispHomeOdds = L.homeOdds || game.homeOdds;

  return (
    <div style={{
      background: T.card,
      border: `1px solid ${isLive ? "rgba(248,70,70,0.3)" : T.border}`,
      borderRadius: 16,
      scrollSnapAlign: "start",
      flexShrink: 0,
      width: "min(340px, 88vw)",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
    }}>
      {/* ── Top gradient bar ── */}
      <div style={{
        height: 3,
        background: isLive
          ? "linear-gradient(90deg,#f84646,#ff8c00)"
          : isFinal
          ? `linear-gradient(90deg,${TEAM_COLORS[game.away]||"#555"},${TEAM_COLORS[game.home]||"#555"})`
          : `linear-gradient(90deg,${TEAM_COLORS[game.away]||T.green},${T.green})`,
      }} />

      {/* ── Status row ── */}
      <div style={{ padding:"12px 16px 0", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        {isLive && (
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <span style={{ width:7, height:7, borderRadius:"50%", background:T.red, display:"inline-block", animation:"pulse 1.2s infinite" }} />
            <span style={{ color:T.red, fontSize:11, fontWeight:700, letterSpacing:"0.08em" }}>
              LIVE · Q{game.quarter} {game.clock}
            </span>
          </div>
        )}
        {isFinal && <span style={{ color:T.text3, fontSize:11, fontWeight:700, letterSpacing:"0.08em" }}>FINAL</span>}
        {isUp && game.time && (
          <span style={{ color:T.green, fontSize:11, fontWeight:700 }}>
            ⏰ {new Date(game.time).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })}
          </span>
        )}
        {isLive && (
          <div style={{ display:"flex", gap:6 }}>
            <WinProbChip pct={game.awayWinProb} abbr={game.away} />
            <WinProbChip pct={game.homeWinProb} abbr={game.home} />
          </div>
        )}
      </div>

      {/* ── Injury alert ── */}
      {game.injuryAlert && isUp && (
        <div style={{ margin:"8px 16px 0", background:"rgba(248,70,70,0.08)", border:"1px solid rgba(248,70,70,0.2)", borderRadius:7, padding:"5px 10px", fontSize:10, color:T.red, fontWeight:600 }}>
          {game.injuryAlert}
        </div>
      )}

      {/* ── Teams + Score / Win% ── */}
      <div style={{ padding:"14px 16px 12px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        {/* Away */}
        <div
          style={{ flex:1, cursor: dispAwayOdds && onPickOdds ? "pointer" : "default" }}
          onClick={dispAwayOdds && onPickOdds ? () => onPickOdds(dispAwayOdds) : undefined}
          title={dispAwayOdds ? `Calc: ${game.awayName} ${dispAwayOdds}` : undefined}
        >
          <TeamBadge abbr={game.away} size={44} />
          <div style={{ color:T.text2, fontSize:12, marginTop:6, fontWeight:500 }}>{game.awayName}</div>
          {isUp && (
            <div style={{ color:T.text, fontSize:13, fontWeight:700, marginTop:2 }}>{dispAwayOdds}</div>
          )}
        </div>

        {/* Center */}
        <div style={{ textAlign:"center", padding:"0 10px" }}>
          {(isLive || isFinal) ? (
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ fontSize:36, fontWeight:800, color: awayLeads ? T.text : T.text3, lineHeight:1 }}>
                {game.awayScore}
              </span>
              <span style={{ color:T.text3, fontSize:16 }}>–</span>
              <span style={{ fontSize:36, fontWeight:800, color: homeLeads ? T.text : T.text3, lineHeight:1 }}>
                {game.homeScore}
              </span>
            </div>
          ) : (
            <div>
              <div style={{ display:"flex", alignItems:"center", gap:4, justifyContent:"center" }}>
                <span style={{ fontSize:20, fontWeight:800, color:T.text }}>{game.awayWinProb}%</span>
                <span style={{ color:T.text3, fontSize:12 }}>vs</span>
                <span style={{ fontSize:20, fontWeight:800, color:T.text }}>{game.homeWinProb}%</span>
              </div>
              <div style={{ width:110, height:5, borderRadius:3, background:"rgba(255,255,255,0.07)", overflow:"hidden", margin:"8px auto 0" }}>
                <div style={{ height:"100%", width:`${game.awayWinProb}%`, background:T.green, borderRadius:3, transition:"width 0.6s" }} />
              </div>
              <div style={{ color:T.text3, fontSize:9, marginTop:4, letterSpacing:"0.04em" }}>WIN PROBABILITY</div>
            </div>
          )}
        </div>

        {/* Home */}
        <div
          style={{ flex:1, textAlign:"right", cursor: dispHomeOdds && onPickOdds ? "pointer" : "default" }}
          onClick={dispHomeOdds && onPickOdds ? () => onPickOdds(dispHomeOdds) : undefined}
          title={dispHomeOdds ? `Calc: ${game.homeName} ${dispHomeOdds}` : undefined}
        >
          <div style={{ display:"flex", justifyContent:"flex-end" }}>
            <TeamBadge abbr={game.home} size={44} />
          </div>
          <div style={{ color:T.text2, fontSize:12, marginTop:6, fontWeight:500 }}>{game.homeName}</div>
          {isUp && (
            <div style={{ color:T.text, fontSize:13, fontWeight:700, marginTop:2 }}>{dispHomeOdds}</div>
          )}
        </div>
      </div>

      {/* ── Odds strip ── */}
      {(dispSpread || dispOu || dispHomeOdds) && (
        <div style={{ display:"flex", borderTop:`1px solid ${T.border}`, borderBottom:`1px solid ${T.border}` }}>
          {dispSpread && (
            <OddsCol label="SPREAD" value={dispSpread} highlight={!isFinal}
              onClick={onPickOdds ? () => onPickOdds("-110") : undefined} />
          )}
          {dispOu && (
            <OddsCol label="TOTAL" value={`${dispOu}${isLive && game.ouDir ? ` ${game.ouDir}` : ""}`} highlight={!isFinal}
              onClick={onPickOdds ? () => onPickOdds("-110") : undefined} />
          )}
          {dispHomeOdds && dispAwayOdds && (
            <OddsCol label="MONEYLINE" value={`${dispAwayOdds} / ${dispHomeOdds}`} highlight={!isFinal} />
          )}
        </div>
      )}

      {/* ── Results (final) or Analysis (live/upcoming) ── */}
      {isFinal
        ? <FinalResultsPanel game={game} aiOverride={aiOverride} />
        : <AnalysisPanel
            analysis={displayAnalysis}
            isLive={isLive}
            loading={loadingRefresh}
            game={game}
          />
      }
    </div>
  );
}

function OddsCol({ label, value, highlight, onClick }) {
  return (
    <div onClick={onClick} style={{ flex:1, padding:"10px 0", textAlign:"center", borderRight:`1px solid ${T.border}`, cursor: onClick ? "pointer" : "default" }}>
      <div style={{ fontSize:8, color:T.text3, letterSpacing:"0.08em", fontWeight:700, marginBottom:4 }}>{label}</div>
      <div style={{ fontSize:12, fontWeight:700, color: highlight ? T.text : T.text2 }}>{value}</div>
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

function ScorePip({ score, reasoning }) {
  const [open, setOpen] = useState(false);
  if (score == null) return null;
  const c = edgeColor(score);
  return (
    <div style={{ position:"relative", flexShrink:0, marginLeft:6 }}>
      <span
        onClick={e => { e.stopPropagation(); if (reasoning) setOpen(o => !o); }}
        style={{
          display:"inline-flex", alignItems:"center", justifyContent:"center",
          width:28, height:28, borderRadius:"50%",
          border:`2px solid ${c}`, background:`${c}18`,
          fontSize:10, fontWeight:800, color:c,
          cursor: reasoning ? "pointer" : "default",
        }}
      >{score}</span>
      {open && reasoning && (
        <div style={{
          position:"absolute", right:0, top:34, zIndex:200,
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

function AnalysisPanel({ analysis, isLive, loading, game }) {
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

  const items = [
    { icon:"✦", label:"BEST BET",   text: analysis.best_bet, color:T.green,  score: analysis.dubl_score_bet, reasoning: analysis.dubl_reasoning_bet, isBet: true },
    { icon:"◉", label: isLive ? "TOTAL (LIVE)" : "O/U LEAN", text: analysis.ou, color:T.gold, score: analysis.dubl_score_ou, reasoning: analysis.dubl_reasoning_ou, isOu: true },
    { icon:"▸", label:"PLAYER PROP", text: analysis.props,   color:"#a78bfa", score: null, isProp: true },
  ].filter(i => i.text);

  // If live game has no analysis yet, show computed O/U status from scores alone
  const showFallbackOu = isLive && game && game.ou && items.length === 0 && !loading;

  return (
    <div style={{ background:"rgba(0,0,0,0.25)", padding:"12px 16px 14px", flex:1 }}>
      <div style={{ marginBottom:10 }}>
        <span style={{ fontSize:9, color:T.text3, letterSpacing:"0.1em", fontWeight:700 }}>
          dublplay analysis
        </span>
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        {items.length === 0 && loading && (
          <span style={{ fontSize:11, color:T.text3, lineHeight:1.6 }}>
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
                <span style={{ fontSize:11, color:T.text2 }}>O/U {game.ou}</span>
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
        {items.map((item, i) => (
          <div key={i} style={{ display:"flex", gap:8, alignItems:"flex-start" }}>
            <span style={{ color:item.color, fontSize:10, marginTop:1, flexShrink:0 }}>{item.icon}</span>
            <div style={{ flex:1 }}>
              <div style={{ display:"flex", alignItems:"center", flexWrap:"wrap", gap:4, marginBottom:2 }}>
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
              <span style={{ fontSize:11, color:T.text2, lineHeight:1.6 }}>{item.text}</span>
            </div>
            <ScorePip score={item.score} reasoning={item.reasoning} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── FINAL RESULTS PANEL ───────────────────────────────────────────────────────
function FinalResultsPanel({ game, aiOverride }) {
  const r = calcFinalResults(game);
  if (!r) return null;

  const analysis = aiOverride || game.analysis;

  // Did pre-game picks hit?
  let bestBetHit = null;
  if (analysis?.bet_team) {
    if (r.spreadResult) {
      const bettingFav = analysis.bet_team === r.spreadResult.favAbbr;
      bestBetHit = bettingFav ? r.spreadResult.hit === "fav" : r.spreadResult.hit === "dog";
    } else {
      bestBetHit = analysis.bet_team === r.mlWinner;
    }
  }
  let ouHit = null;
  if (analysis?.ou && r.totalResult) {
    const leanedOver = /over/i.test(analysis.ou);
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
        <span style={{ fontSize:9, fontWeight:700, color:T.text3, letterSpacing:"0.06em", flexShrink:0 }}>{label}</span>
        {line && <span style={{ fontSize:10, color: line === "N/A" ? T.text3 : T.text, fontWeight: line === "N/A" ? 400 : 700, flexShrink:0 }}>{line}</span>}
        {sub && <span style={{ fontSize:10, color:T.text3, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>→ {sub}</span>}
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
    <div style={{ background:"rgba(0,0,0,0.25)", padding:"12px 16px 14px", flex:1 }}>
      <div style={{ fontSize:9, color:T.text3, letterSpacing:"0.1em", fontWeight:700, marginBottom:10 }}>
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
        {analysis?.best_bet && (
          <div style={{ marginTop:4, paddingTop:8, borderTop:`1px solid ${T.border}` }}>
            <div style={{ fontSize:9, color:T.text3, letterSpacing:"0.08em", fontWeight:700, marginBottom:6 }}>
              PRE-GAME PICKS
            </div>
            {[
              { icon:"✦", label:"BEST BET",    text:analysis.best_bet, color:T.green,   hit:bestBetHit },
              { icon:"◉", label:"O/U LEAN",    text:analysis.ou,       color:T.gold,    hit:ouHit      },
              { icon:"▸", label:"PLAYER PROP", text:analysis.props,    color:"#a78bfa", hit:null       },
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
                        background: item.hit ? T.greenDim : T.redDim,
                        border:`1px solid ${item.hit ? T.greenBdr : "rgba(248,70,70,0.3)"}`,
                        borderRadius:3, padding:"1px 5px",
                      }}>{hitLabel(item.hit)}</span>
                    )}
                  </div>
                  <span style={{ fontSize:10, color:T.text3, lineHeight:1.5 }}>{item.text}</span>
                </div>
              </div>
            ))}
          </div>
        )}

      </div>
    </div>
  );
}

// ── HORIZONTAL GAMES SCROLL ───────────────────────────────────────────────────
function GamesScroll({ games, onRefresh, loadingIds, lastUpdated, aiOverrides, upcomingLabel, onPickOdds }) {
  const liveGames     = games.filter(g => g.status === "live");
  const upcomingGames = games.filter(g => g.status === "upcoming");
  const finalGames    = games.filter(g => g.status === "final");
  const ordered = [...liveGames, ...upcomingGames, ...finalGames];

  const fmtTime = d => d
    ? d.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })
    : null;

  return (
    <div>
      {/* Section labels + last updated */}
      <div style={{ padding:"18px 20px 12px", display:"flex", alignItems:"center", gap:16, flexWrap:"wrap" }}>
        {liveGames.length > 0 && (
          <div style={{ display:"flex", alignItems:"center", gap:5 }}>
            <span style={{ width:6, height:6, borderRadius:"50%", background:T.red, display:"inline-block", animation:"pulse 1.2s infinite" }} />
            <span style={{ fontSize:11, fontWeight:700, color:T.red, letterSpacing:"0.06em" }}>{liveGames.length} LIVE</span>
          </div>
        )}
        {upcomingGames.length > 0 && (
          <span style={{ fontSize:11, fontWeight:700, color:T.green, letterSpacing:"0.06em" }}>
            {upcomingGames.length} {upcomingLabel || "TONIGHT"}
          </span>
        )}
        {finalGames.length > 0 && (
          <span style={{ fontSize:11, color:T.text3, letterSpacing:"0.06em" }}>{finalGames.length} FINAL</span>
        )}
        <span style={{ marginLeft:"auto", fontSize:9, color:T.text3 }}>
          {liveGames.length > 0
            ? `↻ auto-refreshing${lastUpdated ? ` · ${fmtTime(lastUpdated)}` : ""}`
            : lastUpdated ? `updated ${fmtTime(lastUpdated)}` : ""}
        </span>
      </div>

      {/* Top 3 individual picks (Best Bet / O/U) ranked by Dubl Score */}
      <TopPicksSection games={ordered} aiOverrides={aiOverrides} onPickOdds={onPickOdds} />

      {/* League / view bar */}
      <div style={{
        display:"flex", alignItems:"center", gap:0,
        margin:"4px 20px 12px", borderRadius:10,
        background:"rgba(255,255,255,0.04)", border:`1px solid ${T.border}`,
        overflow:"hidden",
      }}>
        <div style={{
          padding:"8px 16px", fontSize:11, fontWeight:800,
          color:T.gold, letterSpacing:"0.1em",
          borderRight:`1px solid ${T.border}`,
        }}>NBA</div>
        <div style={{
          padding:"8px 16px", fontSize:11, fontWeight:700,
          color:T.text1, letterSpacing:"0.06em", flex:1,
        }}>All Games</div>
      </div>

      {/* Horizontal scroll rail */}
      <div style={{
        display:"flex", gap:12, overflowX:"auto", scrollSnapType:"x mandatory",
        WebkitOverflowScrolling:"touch", padding:"0 20px 20px",
        scrollbarWidth:"none",
      }}>
        {ordered.map(g => (
          <GameCard
            key={g.id}
            game={g}
            onRefresh={onRefresh}
            loadingRefresh={loadingIds.has(g.id)}
            aiOverride={aiOverrides[g.id]}
            onPickOdds={onPickOdds}
          />
        ))}
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
function TopPickCard({ pick, rank, onPickOdds }) {
  const rankLabel = ["🥇 TOP PICK","🥈 2ND PICK","🥉 3RD PICK"][rank-1] || `#${rank}`;
  const ec = edgeColor(pick.score);
  const isBet = pick.type === "bet";
  const isLiveGame = pick.game.status === "live";
  const color = isBet ? T.green : T.gold;
  const ouLineNum = pick.game?.ou || "";
  const betLine = isBet ? (pick.text?.match(/([+-]\d+(?:\.\d+)?)/)?.[1] || "") : "";
  const pickLabel = isBet
    ? `${pick.betTeam || "?"}${betLine ? ` ${betLine}` : ""}`
    : /under/i.test(pick.text) ? `UNDER${ouLineNum ? ` ${ouLineNum}` : ""}` : `OVER${ouLineNum ? ` ${ouLineNum}` : ""}`;
  const calcOdds = isBet
    ? (pick.betTeam === pick.game.home ? pick.game.homeOdds : pick.game.awayOdds) || "-110"
    : "-110";

  // Live O/U pace data
  const pace = (!isBet && isLiveGame) ? calcLivePace(pick.game) : null;
  const isOver = !isBet && /over/i.test(pick.text);
  const ouOnTrack = pace ? (isOver ? pace.projected > pace.ouLine : pace.projected < pace.ouLine) : null;

  // Live best-bet margin
  let betMargin = null;
  if (isBet && isLiveGame && pick.betTeam) {
    const isBettingHome = pick.betTeam === pick.game.home;
    const ourScore = isBettingHome ? (pick.game.homeScore || 0) : (pick.game.awayScore || 0);
    const oppScore = isBettingHome ? (pick.game.awayScore || 0) : (pick.game.homeScore || 0);
    betMargin = ourScore - oppScore;
  }

  return (
    <div
      onClick={onPickOdds ? () => onPickOdds(calcOdds) : undefined}
      style={{
        background: T.card,
        border: `1px solid ${isLiveGame ? "rgba(248,70,70,0.35)" : rank===1 ? "rgba(245,166,35,0.3)" : T.border}`,
        borderRadius:14, overflow:"hidden",
        animation:`fadeUp ${0.1+rank*0.07}s ease`,
        cursor: onPickOdds ? "pointer" : "default",
      }}
    >
      <div style={{ height:2, background: isLiveGame ? "linear-gradient(90deg,#f84646,#ff8c00)" : rank===1 ? "linear-gradient(90deg,#f5a623,#ff8c00)" : `linear-gradient(90deg,${ec}55,transparent)` }} />

      {/* ── LIVE BANNER ── */}
      {isLiveGame && (
        <div style={{
          display:"flex", alignItems:"center", gap:6,
          padding:"5px 14px",
          background:"rgba(248,70,70,0.1)",
          borderBottom:"1px solid rgba(248,70,70,0.2)",
        }}>
          <span style={{ width:6, height:6, borderRadius:"50%", background:T.red, display:"inline-block", animation:"pulse 1.2s infinite", flexShrink:0 }} />
          <span style={{ fontSize:9, color:T.red, fontWeight:800, letterSpacing:"0.1em" }}>
            LIVE · Q{pick.game.quarter} {pick.game.clock}
          </span>
          <span style={{ marginLeft:"auto", fontSize:10, color:T.text1, fontWeight:700 }}>
            {pick.game.awayScore} – {pick.game.homeScore}
          </span>
        </div>
      )}

      <div style={{ padding:"12px 14px" }}>
        {/* Top row: rank/type badge + score */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <span style={{ fontSize:9, color:T.text3, fontWeight:700, letterSpacing:"0.08em" }}>{rankLabel}</span>
            <span style={{
              fontSize:9, fontWeight:700, letterSpacing:"0.06em",
              color, background:`${color}18`,
              border:`1px solid ${color}44`, borderRadius:4, padding:"2px 7px",
            }}>{isBet ? `✦ ${pickLabel}` : `◉ ${pickLabel}`}</span>
          </div>
          <EdgeCircle score={pick.score} reasoning={pick.reasoning} />
        </div>
        {/* Team logos row */}
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
          <TeamBadge abbr={pick.game.away} size={32} />
          <div style={{ flex:1 }}>
            <div style={{ fontSize:10, color:T.text2, fontWeight:600 }}>
              {pick.game.awayName} <span style={{ color:T.text3 }}>@</span> {pick.game.homeName}
            </div>
          </div>
          <TeamBadge abbr={pick.game.home} size={32} />
        </div>
        {/* Pick text + inline live badges */}
        <div style={{ fontSize:12, color:T.text2, lineHeight:1.5 }}>
          {pick.text.length > 120 ? pick.text.slice(0,120)+"…" : pick.text}
          {/* O/U ON TRACK / FADING inline */}
          {pace && ouOnTrack !== null && (
            <span style={{
              display:"inline-block", marginLeft:8,
              fontSize:8, fontWeight:800, letterSpacing:"0.08em",
              color: ouOnTrack ? T.green : T.red,
              background: ouOnTrack ? T.greenDim : T.redDim,
              border: `1px solid ${ouOnTrack ? T.greenBdr : "rgba(248,70,70,0.3)"}`,
              borderRadius:4, padding:"1px 5px", verticalAlign:"middle",
            }}>{ouOnTrack ? "ON TRACK" : "FADING"}</span>
          )}
          {/* Best-bet LEADING / TRAILING inline */}
          {isBet && isLiveGame && betMargin !== null && (
            <span style={{
              display:"inline-block", marginLeft:8,
              fontSize:8, fontWeight:800, letterSpacing:"0.07em",
              color: betMargin > 0 ? T.green : betMargin < 0 ? T.red : T.gold,
              background: betMargin > 0 ? T.greenDim : betMargin < 0 ? T.redDim : "rgba(245,166,35,0.12)",
              border: `1px solid ${betMargin > 0 ? T.greenBdr : betMargin < 0 ? "rgba(248,70,70,0.3)" : "rgba(245,166,35,0.3)"}`,
              borderRadius:4, padding:"1px 5px", verticalAlign:"middle",
            }}>{betMargin > 0 ? `+${betMargin} LEADING` : betMargin < 0 ? `${betMargin} TRAILING` : "TIED"}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function TopPicksSection({ games, aiOverrides, onPickOdds }) {
  const picks = [];
  for (const g of games) {
    if (g.status === "final") continue;
    const a = aiOverrides[g.id];
    if (!a) continue;
    if (a.best_bet && a.dubl_score_bet != null)
      picks.push({ type:"bet", score:a.dubl_score_bet, text:a.best_bet, betTeam:a.bet_team, game:g, reasoning:a.dubl_reasoning_bet });
    if (a.ou && a.dubl_score_ou != null)
      picks.push({ type:"ou",  score:a.dubl_score_ou,  text:a.ou,       game:g, reasoning:a.dubl_reasoning_ou });
  }
  const top = picks.sort((a,b) => b.score - a.score).slice(0,3);
  if (top.length === 0) return null;
  return (
    <div style={{ padding:"0 20px", marginBottom:16 }}>
      <SectionLabel>TOP PICKS — BEST BET & O/U RANKED BY DUBL SCORE</SectionLabel>
      <div style={{ display:"grid", gap:10, gridTemplateColumns:"repeat(auto-fill,minmax(min(260px,calc(50vw - 25px)),1fr))" }}>
        {top.map((pick,i) => <TopPickCard key={`${pick.game.id}-${pick.type}`} pick={pick} rank={i+1} onPickOdds={onPickOdds} />)}
      </div>
    </div>
  );
}

// ── TOP PLAYER PROPS (top 3 cards) ───────────────────────────────────────────
function BestBetsSection({ props }) {
  const top = [...props].sort((a,b) => b.edge_score - a.edge_score).slice(0,3);
  return (
    <div style={{ marginBottom:28 }}>
      <SectionLabel>TOP PLAYER PROPS — RANKED BY EDGE SCORE</SectionLabel>
      <div style={{ display:"grid", gap:12, gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))" }}>
        {top.map((p,i) => <BestBetCard key={i} prop={p} rank={i+1} />)}
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
        position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", zIndex:300,
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

function BestBetCard({ prop, rank }) {
  const ec = edgeColor(prop.edge_score);
  const over = prop.rec === "OVER";
  const rankLabel = ["🥇 TOP PICK","🥈 2ND PICK","🥉 3RD PICK"][rank-1] || `#${rank}`;
  return (
    <div style={{
      background: T.card, border:`1px solid ${rank===1 ? "rgba(245,166,35,0.3)" : T.border}`,
      borderRadius:14, overflow:"hidden", animation:`fadeUp ${0.1+rank*0.07}s ease`,
    }}>
      <div style={{ height:2, background: rank===1 ? "linear-gradient(90deg,#f5a623,#ff8c00)" : `linear-gradient(90deg,${ec}55,transparent)` }} />
      <div style={{ padding:"14px 16px" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
          <span style={{ fontSize:9, color:T.text3, fontWeight:700, letterSpacing:"0.08em" }}>{rankLabel}</span>
          <EdgeCircle score={prop.edge_score} />
        </div>
        <div style={{ marginBottom:8 }}>
          <div style={{ color:T.text, fontWeight:800, fontSize:16 }}>{prop.player}</div>
          <div style={{ color:T.text3, fontSize:11, marginTop:2 }}>{prop.team} · {prop.game}</div>
        </div>
        <div style={{ display:"flex", gap:6, alignItems:"center", marginBottom:10 }}>
          <div style={{ background:"rgba(255,255,255,0.07)", borderRadius:7, padding:"5px 11px", fontSize:13, fontWeight:700, color:T.text }}>
            {prop.prop}
          </div>
          <div style={{
            background: over ? T.greenDim : T.redDim,
            border:`1px solid ${over ? T.greenBdr : "rgba(248,70,70,0.3)"}`,
            borderRadius:7, padding:"5px 10px", fontSize:11, fontWeight:700,
            color: over ? T.green : T.red,
          }}>
            {prop.rec}
          </div>
          <span style={{ color:T.text2, fontSize:12, marginLeft:"auto", fontWeight:700 }}>{prop.odds}</span>
        </div>
        <div style={{ display:"flex", gap:6, marginBottom:10 }}>
          {[["L5",prop.l5],["L10",prop.l10],["L15",prop.l15],["AVG",prop.avg]].map(([lbl,val]) => {
            const missing = val === 0 || val === null || val === undefined;
            const display = lbl !== "AVG"
              ? (missing ? "—" : `${val}%`)
              : (missing ? "—" : val);
            return (
            <div key={lbl} style={{ flex:1, background:T.cardAlt, borderRadius:7, padding:"6px 0", textAlign:"center" }}>
              <div style={{ fontSize:8, color:T.text3, letterSpacing:"0.06em", marginBottom:2 }}>{lbl}</div>
              <div style={{ fontSize:12, fontWeight:700, color: (lbl!=="AVG" && !missing) ? hitColor(Number(val)) : T.text3 }}>
                {display}
              </div>
            </div>
            );
          })}
        </div>
        {prop.streak >= 3 && (
          <div style={{ fontSize:11, color:T.gold, marginBottom:6 }}>🔥 {prop.streak}-game hit streak</div>
        )}
        <p style={{ color:T.text2, fontSize:11, margin:0, lineHeight:1.65 }}>{prop.reason}</p>
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
              style={{ width:"100%", boxSizing:"border-box", background:T.cardAlt, border:`1px solid ${T.border}`, borderRadius:8, color:T.text, padding:"9px 12px", fontSize:12, fontFamily:"inherit" }} />
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
function PropsTab({ props, parlay, toggleParlay }) {
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
    {id:"hot",label:"🔥 HOT"},
  ];
  const sorted = props
    .filter(p => {
      if (filter==="over" && p.rec!=="OVER") return false;
      if (filter==="under" && p.rec!=="UNDER") return false;
      if (filter==="hot" && p.streak<3) return false;
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
      <BestBetsSection props={props} />

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
            fontSize:13, fontFamily:"inherit",
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
                <Th col="l5">L5</Th>
                <Th col="l10">L10</Th>
                <Th col="l15">L15</Th>
                <Th col="streak">STRK</Th>
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
                    {[p.l5,p.l10,p.l15].map((v,j)=>(
                      <td key={j} style={{ padding:"12px" }}>
                        {v ? <span style={{ fontSize:12, fontWeight:700, color:hitColor(v) }}>{v}%</span>
                           : <span style={{ fontSize:12, color:T.text3 }}>—</span>}
                      </td>
                    ))}
                    <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                      <span style={{ fontSize:11, color:p.streak>=3?T.gold:T.text3 }}>
                        {p.streak>=3?"🔥 ":""}{p.streak>0?`${p.streak}G`:"—"}
                      </span>
                    </td>
                    <td style={{ padding:"12px" }}>
                      <span style={{ fontSize:12, fontWeight:700, color:p.avg?T.text:T.text3 }}>{p.avg||"—"}</span>
                    </td>
                    <td style={{ padding:"12px" }}>
                      <EdgeCircle score={p.edge_score} />
                    </td>
                    <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                      <span style={{ fontSize:12, fontWeight:700, color:p.odds.startsWith("+")?T.green:T.text2 }}>{p.odds}</span>
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
      background:`linear-gradient(0deg,#0d0f14 0%,${T.card} 100%)`,
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
              style={{ width:70, background:T.cardAlt, border:`1px solid ${T.border}`, borderRadius:7, color:T.text, padding:"7px 10px", fontSize:12, fontFamily:"inherit" }} />
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
            style={{ flex:1, background:T.cardAlt, border:`1px solid ${T.border}`, borderRadius:9, color:T.text, padding:"10px 13px", fontSize:12, fontFamily:"inherit" }} />
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
  width:"100%", background:T.green, color:"#080d1a", border:"none",
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
    rec: recUp, l5:0, l10:0, l15:0, streak:0,
    avg: line, edge_score: 3.5,
    matchup, reason, _source:"game_analysis",
  };
}

// ── APP ROOT ──────────────────────────────────────────────────────────────────
export default function App() {
  const [apiKey, setApiKey] = useState(null);
  const [serverHasKey, setServerHasKey] = useState(false);
  const [tab, setTab] = useState("games");
  const [games, setGames] = useState([]);
  const [props, setProps] = useState([]);
  const [loadingIds, setLoadingIds] = useState(new Set());
  const [aiOverrides, setAiOverrides] = useState({});
  const [parlay, setParlay] = useState([]);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null); // null = today
  const [calcSeed, setCalcSeed] = useState(null); // null = closed, string = pre-filled odds
  const analyzedLiveRef = useRef(new Set()); // game IDs already analyzed with live prompt

  const tomorrowStr = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10).replace(/-/g, "");
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
  useEffect(() => {
    if (apiKey === null) return;
    setDataLoaded(false);
    setGames([]);
    setAiOverrides({});
    Promise.all([api.getGames(selectedDate), api.getProps()])
      .then(([g, p]) => {
        setGames(g.games);
        setProps(p.props);
        setDataLoaded(true);
        setLastUpdated(new Date());
      })
      .catch(console.error);
  }, [apiKey, selectedDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // 3) Auto-poll scores when live games are active (every 30s)
  useEffect(() => {
    const hasLive = games.some(g => g.status === "live");
    if (!hasLive || apiKey === null) return;
    const interval = setInterval(() => {
      api.getGames(selectedDate)
        .then(g => { setGames(g.games); setLastUpdated(new Date()); })
        .catch(console.error);
    }, 30000);
    return () => clearInterval(interval);
  }, [games, apiKey, selectedDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // 4) Auto-analyze non-final games once data loads
  useEffect(() => {
    if (!dataLoaded || apiKey === null || apiKey === "__no_server__") return;
    games
      .filter(g => g.status !== "final")
      .forEach(g => {
        setLoadingIds(prev => new Set([...prev, g.id]));
        api.analyze(g.id, apiKey, selectedDate)
          .then(d => setAiOverrides(prev => ({ ...prev, [g.id]: d.analysis })))
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
      api.analyze(g.id, apiKey, selectedDate)
        .then(d => setAiOverrides(prev => ({ ...prev, [g.id]: d.analysis })))
        .catch(console.error)
        .finally(() => setLoadingIds(prev => {
          const next = new Set(prev);
          next.delete(g.id);
          return next;
        }));
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
      const d = await api.analyze(gameId, apiKey, selectedDate);
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

  const TABS = [
    { id:"games", label:"🏀 GAMES" },
    { id:"props", label:"🎯 PROPS" },
    { id:"chat",  label:"💬 CHAT"  },
  ];

  return (
    <div style={{ minHeight:"100vh", background:T.bg, paddingBottom: parlay.length ? 90 : 0 }}>
      {/* ── Header ── */}
      <div style={{ borderBottom:`1px solid ${T.border}`, background:T.card }}>
        <div style={{ maxWidth:960, margin:"0 auto", padding:"0 20px", display:"flex", alignItems:"center", justifyContent:"space-between", height:56 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:20 }}>🏀</span>
            <div>
              <span style={{ color:T.green, fontWeight:800, fontSize:17, letterSpacing:"0.04em" }}>dublplay</span>
              <span style={{ color:T.text3, fontSize:9, letterSpacing:"0.1em", marginLeft:8 }}>AI SPORTSBOOK ANALYST</span>
            </div>
          </div>
          <div style={{ display:"flex", gap:4, alignItems:"center" }}>
            {[{ label:"TODAY", val:null }, { label:"TMW", val:tomorrowStr }].map(({ label, val }) => (
              <button key={label} onClick={() => setSelectedDate(val)} style={{
                background: selectedDate === val ? T.green : "transparent",
                border: `1px solid ${selectedDate === val ? T.green : T.border}`,
                color: selectedDate === val ? "#000" : T.text3,
                borderRadius: 5, padding: "3px 9px",
                fontSize: 9, fontWeight: 700, letterSpacing: "0.08em",
                cursor: "pointer",
              }}>{label}</button>
            ))}
            <button onClick={() => setCalcSeed("-110")} style={{
              background: "transparent",
              border: `1px solid ${T.border}`,
              color: T.gold,
              borderRadius: 5, padding: "3px 9px",
              fontSize: 13, cursor: "pointer",
              lineHeight: 1,
            }} title="Payout Calculator">$</button>
          </div>
        </div>
      </div>

      {/* ── Tab bar ── */}
      <div style={{ background:T.card, borderBottom:`1px solid ${T.border}` }}>
        <div style={{ maxWidth:960, margin:"0 auto", padding:"0 16px", display:"flex" }}>
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} style={{
              background:"transparent", border:"none",
              borderBottom:`2px solid ${tab===t.id?T.green:"transparent"}`,
              color: tab===t.id ? T.green : T.text2,
              padding:"13px 20px", fontSize:11, fontWeight:700, letterSpacing:"0.07em",
              whiteSpace:"nowrap", transition:"color 0.15s",
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      {/* ── Tab content ── */}
      {tab === "games" && (
        <GamesScroll
          games={games}
          onRefresh={handleRefresh}
          loadingIds={loadingIds}
          lastUpdated={lastUpdated}
          aiOverrides={aiOverrides}
          upcomingLabel={selectedDate ? "UPCOMING" : "TONIGHT"}
          onPickOdds={odds => setCalcSeed(odds)}
        />
      )}

      {tab !== "games" && (
        <div style={{ maxWidth:960, margin:"0 auto", padding:"22px 16px" }}>
          {tab === "props" && (() => {
            // Merge game-analysis player props into the props list so they
            // always appear in the Props tab even if the bulk Gemini call missed them.
            const existing = new Set(props.map(p => `${p.player.toLowerCase()}|${p.stat.toLowerCase()}`));
            const gamePropsList = games.flatMap(g => {
              const a = aiOverrides[g.id];
              if (!a?.props) return [];
              const parsed = parseGameProp(a.props, g);
              if (!parsed) return [];
              const key = `${parsed.player.toLowerCase()}|${parsed.stat.toLowerCase()}`;
              return existing.has(key) ? [] : [parsed];
            });
            const mergedProps = [...props, ...gamePropsList];
            return <PropsTab props={mergedProps} parlay={parlay} toggleParlay={toggleParlay} />;
          })()}
          {tab === "chat"  && <ChatTab apiKey={apiKey} />}
        </div>
      )}

      <ParlayTray parlay={parlay} onRemove={toggleParlay} onClear={()=>setParlay([])} />
      {calcSeed !== null && <CalcPopup key={calcSeed} initialOdds={calcSeed} onClose={() => setCalcSeed(null)} />}
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
        style={{ position:"absolute", inset:0, width:"100%", height:"100%", objectFit:"cover" }}
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
