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
const edgeColor = s => s >= 80 ? T.green : s >= 65 ? T.gold : T.red;
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
function GameCard({ game, onRefresh, loadingRefresh, aiOverride }) {
  const isLive   = game.status === "live";
  const isFinal  = game.status === "final";
  const isUp     = game.status === "upcoming";
  const awayLeads = (isLive || isFinal) && game.awayScore > game.homeScore;
  const homeLeads = (isLive || isFinal) && game.homeScore > game.awayScore;

  const staticAnalysis = game.analysis;
  const displayAnalysis = aiOverride ? parseGeminiText(aiOverride) : staticAnalysis;

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
        {isUp    && <span style={{ color:T.green, fontSize:11, fontWeight:700 }}>⏰ {game.time}</span>}
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
        <div style={{ flex:1 }}>
          <TeamBadge abbr={game.away} size={44} />
          <div style={{ color:T.text2, fontSize:12, marginTop:6, fontWeight:500 }}>{game.awayName}</div>
          {isUp && (
            <div style={{ color:T.text, fontSize:13, fontWeight:700, marginTop:2 }}>{game.awayOdds}</div>
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
        <div style={{ flex:1, textAlign:"right" }}>
          <div style={{ display:"flex", justifyContent:"flex-end" }}>
            <TeamBadge abbr={game.home} size={44} />
          </div>
          <div style={{ color:T.text2, fontSize:12, marginTop:6, fontWeight:500 }}>{game.homeName}</div>
          {isUp && (
            <div style={{ color:T.text, fontSize:13, fontWeight:700, marginTop:2 }}>{game.homeOdds}</div>
          )}
        </div>
      </div>

      {/* ── Odds strip ── */}
      {(game.spread || game.ou || game.homeOdds) && (
        <div style={{ display:"flex", borderTop:`1px solid ${T.border}`, borderBottom:`1px solid ${T.border}` }}>
          {game.spread && (
            <OddsCol label="SPREAD" value={game.spread} highlight={!isFinal} />
          )}
          {game.ou && (
            <OddsCol label="TOTAL" value={`${game.ou}${isLive ? ` ${game.ouDir}` : ""}`} highlight={!isFinal} />
          )}
          {game.homeOdds && game.awayOdds && (
            <OddsCol label="MONEYLINE" value={`${game.awayOdds} / ${game.homeOdds}`} highlight={!isFinal} />
          )}
        </div>
      )}

      {/* ── Results (final) or Analysis (live/upcoming) ── */}
      {isFinal
        ? <FinalResultsPanel game={game} />
        : <AnalysisPanel
            analysis={displayAnalysis}
            isLive={isLive}
            isFinal={false}
            onRefresh={onRefresh ? () => onRefresh(game.id) : null}
            loading={loadingRefresh}
            hasOverride={!!aiOverride}
          />
      }
    </div>
  );
}

function OddsCol({ label, value, highlight }) {
  return (
    <div style={{ flex:1, padding:"10px 0", textAlign:"center", borderRight:`1px solid ${T.border}` }}>
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

function AnalysisPanel({ analysis, isLive, isFinal, onRefresh, loading, hasOverride }) {
  if (!analysis) return null;
  const items = [
    { icon:"✦", label:"BEST BET",   text: analysis.best_bet, color:T.green },
    { icon:"◉", label: isLive ? "TOTAL (LIVE)" : "O/U LEAN", text: analysis.ou, color:T.gold },
    { icon:"▸", label:"PLAYER PROP", text: analysis.props,   color:"#a78bfa" },
  ].filter(i => i.text);

  return (
    <div style={{ background:"rgba(0,0,0,0.25)", padding:"12px 16px 14px", flex:1 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
        <span style={{ fontSize:9, color:T.text3, letterSpacing:"0.1em", fontWeight:700 }}>
          {hasOverride ? "⚡ GEMINI ANALYSIS" : "AI ANALYSIS"}
        </span>
        {/* No refresh button for final games */}
        {onRefresh && !isFinal && (
          <button onClick={onRefresh} disabled={loading} style={{
            background:"rgba(83,211,55,0.1)", border:`1px solid ${T.greenBdr}`,
            borderRadius:5, padding:"3px 8px", fontSize:9, color:T.green, fontWeight:700,
            letterSpacing:"0.06em", opacity: loading ? 0.5 : 1, cursor: loading ? "default" : "pointer",
          }}>
            {loading ? <><Spinner />...</> : "REFRESH ↺"}
          </button>
        )}
        {isFinal && (
          <span style={{ fontSize:9, color:T.text3, letterSpacing:"0.06em" }}>GAME OVER</span>
        )}
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        {items.length === 0 && (
          <span style={{ fontSize:11, color:T.text3, lineHeight:1.6 }}>
            {loading ? <><Spinner /> Analyzing...</> : "Tap REFRESH ↺ for AI analysis"}
          </span>
        )}
        {items.map((item, i) => (
          <div key={i} style={{ display:"flex", gap:8, alignItems:"flex-start" }}>
            <span style={{ color:item.color, fontSize:10, marginTop:1, flexShrink:0 }}>{item.icon}</span>
            <div style={{ flex:1 }}>
              <span style={{ fontSize:9, fontWeight:700, color:item.color, letterSpacing:"0.06em", marginRight:6 }}>{item.label}</span>
              <span style={{ fontSize:11, color:T.text2, lineHeight:1.6 }}>{item.text}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── FINAL RESULTS PANEL ───────────────────────────────────────────────────────
function FinalResultsPanel({ game }) {
  const r = calcFinalResults(game);
  if (!r) return null;

  const HitBadge = ({ hit, trueVal, falseVal }) => {
    const won = hit === trueVal;
    const push = hit === "push" || hit === "PUSH";
    return (
      <span style={{
        fontSize:9, fontWeight:800, letterSpacing:"0.06em",
        color: push ? T.gold : won ? T.green : T.red,
        background: push ? "rgba(245,166,35,0.12)" : won ? T.greenDim : T.redDim,
        border: `1px solid ${push ? "rgba(245,166,35,0.3)" : won ? T.greenBdr : "rgba(248,70,70,0.3)"}`,
        borderRadius:4, padding:"2px 6px",
      }}>
        {push ? "PUSH" : won ? "✓ HIT" : "✗ MISS"}
      </span>
    );
  };

  return (
    <div style={{ background:"rgba(0,0,0,0.25)", padding:"12px 16px 14px", flex:1 }}>
      <div style={{ fontSize:9, color:T.text3, letterSpacing:"0.1em", fontWeight:700, marginBottom:10 }}>
        FINAL RESULTS
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:7 }}>

        {/* Moneyline winner */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div style={{ display:"flex", gap:7, alignItems:"center" }}>
            <span style={{ color:T.green, fontSize:10 }}>🏆</span>
            <span style={{ fontSize:9, fontWeight:700, color:T.text3, letterSpacing:"0.06em" }}>MONEYLINE</span>
            <span style={{ fontSize:11, color:T.text }}>{r.mlWinnerName} won by {r.margin}</span>
          </div>
        </div>

        {/* Spread */}
        {r.spreadResult && (() => {
          const s = r.spreadResult;
          const label = `${s.favName} ${s.line > 0 ? "+" : ""}${s.line}`;
          const dogLabel = `${s.dogName} +${Math.abs(s.line)}`;
          return (
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div style={{ display:"flex", gap:7, alignItems:"center", flex:1, minWidth:0 }}>
                <span style={{ color:"#a78bfa", fontSize:10 }}>⊖</span>
                <span style={{ fontSize:9, fontWeight:700, color:T.text3, letterSpacing:"0.06em" }}>SPREAD</span>
                <span style={{ fontSize:11, color:T.text2, whiteSpace:"nowrap" }}>
                  {s.hit === "fav"
                    ? `${s.favName} covered (won by ${Math.abs(Math.round(s.actualMargin))})`
                    : s.hit === "push"
                    ? `Push — won by exactly ${Math.abs(s.line)}`
                    : `${s.dogName} +${Math.abs(s.line)} covered`}
                </span>
              </div>
              <div style={{ display:"flex", gap:5, flexShrink:0, marginLeft:8 }}>
                <span style={{ fontSize:9, color:T.text3 }}>{label}</span>
                <HitBadge hit={s.hit} trueVal="fav" />
              </div>
            </div>
          );
        })()}

        {/* Total */}
        {r.totalResult && (
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div style={{ display:"flex", gap:7, alignItems:"center", flex:1 }}>
              <span style={{ color:T.gold, fontSize:10 }}>◉</span>
              <span style={{ fontSize:9, fontWeight:700, color:T.text3, letterSpacing:"0.06em" }}>TOTAL</span>
              <span style={{ fontSize:11, color:T.text2 }}>
                {r.totalResult.combined} combined — {r.totalResult.hit} {r.totalResult.label}
              </span>
            </div>
            <HitBadge hit={r.totalResult.hit} trueVal={game.analysis?.ou?.includes("OVER") ? "OVER" : "UNDER"} />
          </div>
        )}

        {/* AI notes */}
        {game.analysis?.best_bet && (
          <div style={{ marginTop:4, paddingTop:8, borderTop:`1px solid ${T.border}` }}>
            <div style={{ fontSize:9, color:T.text3, letterSpacing:"0.08em", marginBottom:5 }}>PRE-GAME NOTES</div>
            {[
              { icon:"✦", label:"BEST BET",   text:game.analysis.best_bet, color:T.green },
              { icon:"◉", label:"O/U LEAN",   text:game.analysis.ou,       color:T.gold  },
              { icon:"▸", label:"PLAYER PROP", text:game.analysis.props,   color:"#a78bfa" },
            ].filter(i => i.text).map((item, i) => (
              <div key={i} style={{ display:"flex", gap:7, alignItems:"flex-start", marginBottom:4 }}>
                <span style={{ color:item.color, fontSize:9, marginTop:1, flexShrink:0 }}>{item.icon}</span>
                <div style={{ flex:1 }}>
                  <span style={{ fontSize:8, fontWeight:700, color:item.color, letterSpacing:"0.06em", marginRight:5 }}>{item.label}</span>
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
function GamesScroll({ games, onRefresh, loadingIds, lastUpdated, aiOverrides }) {
  const liveGames      = games.filter(g => g.status === "live"     && !g.day);
  const todayUpcoming  = games.filter(g => g.status === "upcoming" && !g.day);
  const finalGames     = games.filter(g => g.status === "final"    && !g.day);
  const tomorrowGames  = games.filter(g => g.day === "tomorrow");
  const ordered = [...liveGames, ...todayUpcoming, ...finalGames];

  const fmtTime = d => d
    ? d.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })
    : null;

  // Divider card between today and tomorrow
  const TomorrowDivider = () => (
    <div style={{
      display:"flex", alignItems:"center", alignSelf:"stretch",
      padding:"0 4px", flexShrink:0,
    }}>
      <div style={{
        writingMode:"vertical-rl", transform:"rotate(180deg)",
        fontSize:9, fontWeight:700, letterSpacing:"0.12em",
        color:T.text3, padding:"12px 6px",
        borderLeft:`1px solid ${T.border}`,
      }}>TOMORROW</div>
    </div>
  );

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
        {todayUpcoming.length > 0 && (
          <span style={{ fontSize:11, fontWeight:700, color:T.green, letterSpacing:"0.06em" }}>
            {todayUpcoming.length} TONIGHT
          </span>
        )}
        {finalGames.length > 0 && (
          <span style={{ fontSize:11, color:T.text3, letterSpacing:"0.06em" }}>{finalGames.length} FINAL</span>
        )}
        {tomorrowGames.length > 0 && (
          <span style={{ fontSize:11, color:T.accent, letterSpacing:"0.06em" }}>{tomorrowGames.length} TOMORROW</span>
        )}
        <span style={{ marginLeft:"auto", fontSize:9, color:T.text3 }}>
          {liveGames.length > 0
            ? `↻ auto-refreshing${lastUpdated ? ` · ${fmtTime(lastUpdated)}` : ""}`
            : lastUpdated ? `updated ${fmtTime(lastUpdated)}` : ""}
        </span>
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
          />
        ))}
        {tomorrowGames.length > 0 && ordered.length > 0 && <TomorrowDivider />}
        {tomorrowGames.map(g => (
          <GameCard
            key={g.id}
            game={g}
            onRefresh={onRefresh}
            loadingRefresh={loadingIds.has(g.id)}
            aiOverride={aiOverrides[g.id]}
          />
        ))}
      </div>
    </div>
  );
}

// ── BEST BETS (top 3 cards) ───────────────────────────────────────────────────
function BestBetsSection({ props }) {
  const top = [...props].sort((a,b) => b.edge_score - a.edge_score).slice(0,3);
  return (
    <div style={{ marginBottom:28 }}>
      <SectionLabel>TOP AI PICKS — RANKED BY EDGE SCORE</SectionLabel>
      <div style={{ display:"grid", gap:12, gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", marginBottom:16 }}>
        {top.map((p,i) => <BestBetCard key={i} prop={p} rank={i+1} />)}
      </div>
      <BetCalcCard />
    </div>
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
          {[["L5",prop.l5],["L10",prop.l10],["L15",prop.l15],["AVG",prop.avg]].map(([lbl,val]) => (
            <div key={lbl} style={{ flex:1, background:T.cardAlt, borderRadius:7, padding:"6px 0", textAlign:"center" }}>
              <div style={{ fontSize:8, color:T.text3, letterSpacing:"0.06em", marginBottom:2 }}>{lbl}</div>
              <div style={{ fontSize:12, fontWeight:700, color: lbl!=="AVG" ? hitColor(Number(val)) : T.text }}>
                {lbl !== "AVG" ? `${val}%` : val}
              </div>
            </div>
          ))}
        </div>
        {prop.streak >= 3 && (
          <div style={{ fontSize:11, color:T.gold, marginBottom:6 }}>🔥 {prop.streak}-game hit streak</div>
        )}
        <p style={{ color:T.text2, fontSize:11, margin:0, lineHeight:1.65 }}>{prop.reason}</p>
      </div>
    </div>
  );
}

function EdgeCircle({ score }) {
  const c = edgeColor(score);
  return (
    <div style={{
      width:40, height:40, borderRadius:"50%",
      border:`2.5px solid ${c}`, background:`${c}18`,
      display:"flex", alignItems:"center", justifyContent:"center",
      fontSize:12, fontWeight:800, color:c,
    }}>{score}</div>
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
  const filters = [
    {id:"all",label:"ALL"},
    {id:"over",label:"OVER"},
    {id:"under",label:"UNDER"},
    {id:"hot",label:"🔥 HOT"},
  ];
  const sorted = props
    .filter(p => filter==="over"?p.rec==="OVER":filter==="under"?p.rec==="UNDER":filter==="hot"?p.streak>=3:true)
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

      {/* Full props table */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14, flexWrap:"wrap", gap:8 }}>
        <SectionLabel noMargin>ALL PLAYER PROPS · AI RANKED</SectionLabel>
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
                <Th col="edge_score">EDGE</Th>
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
                        <span style={{ fontSize:12, fontWeight:700, color:hitColor(v) }}>{v}%</span>
                      </td>
                    ))}
                    <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                      <span style={{ fontSize:11, color:p.streak>=3?T.gold:T.text3 }}>
                        {p.streak>=3?"🔥 ":""}{p.streak}G
                      </span>
                    </td>
                    <td style={{ padding:"12px" }}>
                      <span style={{ fontSize:12, fontWeight:700, color:T.text }}>{p.avg}</span>
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
  const [msgs, setMsgs] = useState([{role:"assistant",content:"Welcome to dublplay 🏀 I'm your Gemini-powered betting analyst. Ask me anything about tonight's slate — props, spreads, live value, injuries. (Entertainment only.)"}]);
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
      <SectionLabel>AI BETTING CHAT · GEMINI</SectionLabel>
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
              {m.role==="assistant" && <span style={{ color:"#a78bfa",fontSize:9,fontWeight:700,letterSpacing:"0.08em",display:"block",marginBottom:5 }}>GEMINI ANALYST</span>}
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

  // 1) Check server key
  useEffect(() => {
    api.health()
      .then(d => {
        setServerHasKey(d.has_server_key);
        if (d.has_server_key) setApiKey("");
      })
      .catch(() => setApiKey("__no_server__"));
  }, []);

  // 2) Initial data load
  useEffect(() => {
    if (apiKey === null) return;
    Promise.all([api.getGames(), api.getProps()])
      .then(([g, p]) => {
        setGames(g.games);
        setProps(p.props);
        setDataLoaded(true);
        setLastUpdated(new Date());
      })
      .catch(console.error);
  }, [apiKey]);

  // 3) Auto-poll scores when live games are active (every 30s)
  useEffect(() => {
    const hasLive = games.some(g => g.status === "live");
    if (!hasLive || apiKey === null) return;
    const interval = setInterval(() => {
      api.getGames()
        .then(g => { setGames(g.games); setLastUpdated(new Date()); })
        .catch(console.error);
    }, 30000);
    return () => clearInterval(interval);
  }, [games, apiKey]);

  // 4) Auto-analyze all non-final games once data first loads
  useEffect(() => {
    if (!dataLoaded || apiKey === null || apiKey === "__no_server__") return;
    games
      .filter(g => g.status !== "final")
      .forEach(g => {
        setLoadingIds(prev => new Set([...prev, g.id]));
        api.analyze(g.id, apiKey)
          .then(d => setAiOverrides(prev => ({ ...prev, [g.id]: d.analysis })))
          .catch(console.error)
          .finally(() => setLoadingIds(prev => {
            const next = new Set(prev);
            next.delete(g.id);
            return next;
          }));
      });
  }, [dataLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const d = await api.analyze(gameId, apiKey);
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
          <div style={{ color:T.text3, fontSize:10 }}>Feb 20, 2026</div>
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
        />
      )}

      {tab !== "games" && (
        <div style={{ maxWidth:960, margin:"0 auto", padding:"22px 16px" }}>
          {tab === "props" && <PropsTab props={props} parlay={parlay} toggleParlay={toggleParlay} />}
          {tab === "chat"  && <ChatTab apiKey={apiKey} />}
        </div>
      )}

      <ParlayTray parlay={parlay} onRemove={toggleParlay} onClear={()=>setParlay([])} />
    </div>
  );
}

const Loader = () => (
  <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:T.bg }}>
    <Spinner /><span style={{ color:T.text3, fontSize:12, marginLeft:10 }}>Loading...</span>
  </div>
);
