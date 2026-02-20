import { useState, useEffect, useRef } from "react";
import { api } from "./api.js";

// ── CONSTANTS ────────────────────────────────────────────────────────────────
const TEAM_COLORS = {
  NYK:"#006BB6", DET:"#C8102E", CHI:"#CE1141", TOR:"#CE1141",
  SAS:"#8A8D8F", PHX:"#E56020", CLE:"#860038", BKN:"#444",
  CHA:"#00788C", HOU:"#CE1141", LAL:"#552583", DAL:"#00538C",
  GSW:"#1D428A", BOS:"#007A33", SAC:"#5A2D81", ORL:"#0077C0",
  LAC:"#C8102E", DEN:"#0E2240", OKC:"#007AC1", MIN:"#0C2340",
  PHI:"#006BB6", MIA:"#98002E",
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
function americanToPayout(oddsStr, stake) {
  const o = parseInt(oddsStr.replace("+", ""), 10);
  if (isNaN(o)) return null;
  const decimal = o > 0 ? (o / 100) + 1 : (100 / Math.abs(o)) + 1;
  return (decimal * stake).toFixed(2);
}

function edgeColor(score) {
  if (score >= 80) return "#63ca8a";
  if (score >= 70) return "#f5a623";
  return "#ff6040";
}

function hitColor(pct) {
  if (pct >= 80) return "#63ca8a";
  if (pct >= 60) return "#f5a623";
  return "#ff6040";
}

// ── API KEY GATE ─────────────────────────────────────────────────────────────
function ApiKeyGate({ onSubmit, serverHasKey }) {
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");

  if (serverHasKey) {
    return (
      <div style={gateWrap}>
        <div style={gateCard}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🏀</div>
          <h1 style={gateTitle}>NBA EDGE</h1>
          <p style={gateSub}>AI BETTING ANALYST · GEMINI</p>
          <p style={{ color: "rgba(255,255,255,0.35)", fontSize: 12, margin: "0 0 28px", lineHeight: 1.6 }}>
            Server API key detected — no key required.
          </p>
          <button onClick={() => onSubmit("")} style={gateBtn}>LAUNCH APP →</button>
        </div>
      </div>
    );
  }

  return (
    <div style={gateWrap}>
      <div style={gateCard}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🏀</div>
        <h1 style={gateTitle}>NBA EDGE</h1>
        <p style={gateSub}>AI BETTING ANALYST · GEMINI</p>
        <input type="password" placeholder="Enter Gemini API Key..."
          value={key} onChange={e => { setKey(e.target.value); setErr(""); }}
          onKeyDown={e => e.key === "Enter" && key && onSubmit(key)}
          style={{ ...gateInput, borderColor: err ? "#ff5050" : "rgba(99,202,138,0.25)" }} />
        {err && <p style={{ color: "#ff5050", fontSize: 11, margin: "0 0 10px" }}>{err}</p>}
        <button onClick={() => key ? onSubmit(key) : setErr("Please enter your API key")} style={gateBtn}>
          CONNECT →
        </button>
        <p style={{ color: "rgba(255,255,255,0.2)", fontSize: 10, marginTop: 16 }}>
          Key used in-session only · Never stored
        </p>
        <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer"
          style={{ color: "rgba(99,202,138,0.6)", fontSize: 10, display: "block", marginTop: 8 }}>
          Get a free Gemini API key →
        </a>
      </div>
    </div>
  );
}

// ── STATS STRIP ───────────────────────────────────────────────────────────────
function StatsStrip({ liveCount, tonightCount, propsCount, topProp }) {
  return (
    <div style={{ background: "rgba(0,0,0,0.3)", borderBottom: "1px solid rgba(255,255,255,0.05)", padding: "0 20px" }}>
      <div style={{ maxWidth: 960, margin: "0 auto", display: "flex", gap: 0, overflowX: "auto" }}>
        <StatChip icon="🔴" label="LIVE" value={liveCount} color="#ff5050" />
        <StatChip icon="📅" label="TONIGHT" value={tonightCount} color="#63ca8a" />
        <StatChip icon="🎯" label="PROPS" value={propsCount} color="#f5a623" />
        {topProp && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 20px", borderLeft: "1px solid rgba(255,255,255,0.05)", marginLeft: "auto" }}>
            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", letterSpacing: "0.08em" }}>TOP PICK</span>
            <span style={{ fontSize: 11, color: "#63ca8a", fontWeight: 700 }}>{topProp.player}</span>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{topProp.rec} {topProp.line}</span>
            <span style={{ background: edgeColor(topProp.edge_score), color: "#080d1a", fontSize: 9, fontWeight: 800, borderRadius: 4, padding: "2px 6px" }}>
              {topProp.edge_score}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function StatChip({ icon, label, value, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 20px", borderRight: "1px solid rgba(255,255,255,0.05)" }}>
      <span style={{ fontSize: 11 }}>{icon}</span>
      <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", letterSpacing: "0.08em" }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color }}>{value}</span>
    </div>
  );
}

// ── GAME CARD ─────────────────────────────────────────────────────────────────
function GameCard({ game, onAnalyze, analysis, loading }) {
  const isLive = game.status === "live";
  const isFinal = game.status === "final";
  const isUp = game.status === "upcoming";
  const awayWins = (isLive || isFinal) && game.awayScore > game.homeScore;
  const homeWins = (isLive || isFinal) && game.homeScore > game.awayScore;

  return (
    <div style={{
      ...card,
      borderColor: isLive ? "rgba(255,70,70,0.35)" : "rgba(255,255,255,0.07)",
      animation: "fadeUp 0.3s ease",
      transition: "border-color 0.2s",
    }}>
      {/* Status */}
      <div style={{ marginBottom: 14 }}>
        {isLive && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "#ff5050", fontSize: 10, fontWeight: 700, letterSpacing: "0.1em" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#ff5050", animation: "pulse 1.2s infinite", display: "inline-block" }} />
            LIVE · Q{game.quarter} {game.clock}
          </span>
        )}
        {isFinal && <span style={{ color: "rgba(255,255,255,0.2)", fontSize: 10, letterSpacing: "0.1em", fontWeight: 600 }}>FINAL</span>}
        {isUp && <span style={{ color: "#63ca8a", fontSize: 10, letterSpacing: "0.08em", fontWeight: 600 }}>⏰ {game.time}</span>}
      </div>

      {/* Matchup */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <TeamSide abbr={game.away} name={game.awayName} odds={game.awayOdds} isUp={isUp} align="left" winning={awayWins} />
        <div style={{ textAlign: "center", minWidth: 100 }}>
          {(isLive || isFinal) ? (
            <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center" }}>
              <span style={{ fontSize: 32, fontWeight: 700, color: awayWins ? "#fff" : "rgba(255,255,255,0.22)", lineHeight: 1 }}>{game.awayScore}</span>
              <span style={{ color: "rgba(255,255,255,0.12)", fontSize: 18 }}>–</span>
              <span style={{ fontSize: 32, fontWeight: 700, color: homeWins ? "#fff" : "rgba(255,255,255,0.22)", lineHeight: 1 }}>{game.homeScore}</span>
            </div>
          ) : (
            <WinBar home={game.homeWinProb} away={game.awayWinProb} />
          )}
        </div>
        <TeamSide abbr={game.home} name={game.homeName} odds={game.homeOdds} isUp={isUp} align="right" winning={homeWins} />
      </div>

      {/* Lines */}
      {isUp && (
        <div style={{ display: "flex", gap: 6, marginTop: 14, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          <Pill>{game.spread}</Pill>
          <Pill>O/U {game.ou}</Pill>
          <Pill style={{ marginLeft: "auto" }}>{game.awayOdds} / {game.homeOdds}</Pill>
        </div>
      )}

      {/* Analysis */}
      {analysis ? (
        <div style={{ marginTop: 14, background: "rgba(99,202,138,0.06)", border: "1px solid rgba(99,202,138,0.18)", borderRadius: 10, padding: "12px 14px" }}>
          <span style={{ color: "#63ca8a", fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", display: "block", marginBottom: 6 }}>GEMINI ANALYSIS</span>
          <p style={{ color: "rgba(255,255,255,0.7)", fontSize: 11, lineHeight: 1.75, margin: 0 }}>{analysis}</p>
        </div>
      ) : (
        <button onClick={() => onAnalyze(game.id)} disabled={loading} style={{
          ...analyzeBtn, opacity: loading ? 0.4 : 1, marginTop: 14,
        }}>
          {loading ? <><Spinner /> ANALYZING...</> : "⚡ GET AI PICK"}
        </button>
      )}
    </div>
  );
}

function TeamSide({ abbr, name, odds, isUp, align, winning }) {
  return (
    <div style={{ flex: 1, textAlign: align }}>
      <div style={{
        width: 36, height: 36, borderRadius: 9, background: TEAM_COLORS[abbr] || "#333",
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#fff",
        marginBottom: 6, ...(align === "right" ? { marginLeft: "auto" } : {}),
        boxShadow: winning ? `0 0 12px ${TEAM_COLORS[abbr]}88` : "none",
        transition: "box-shadow 0.2s",
      }}>
        {abbr}
      </div>
      <div style={{ color: winning ? "#fff" : "rgba(255,255,255,0.5)", fontSize: 11, fontWeight: winning ? 600 : 400 }}>{name}</div>
      {isUp && odds && <div style={{ color: "rgba(255,255,255,0.28)", fontSize: 11, marginTop: 2 }}>{odds}</div>}
    </div>
  );
}

function WinBar({ away, home }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: "rgba(255,255,255,0.22)", marginBottom: 6, letterSpacing: "0.05em" }}>WIN PROB</div>
      <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,0.07)", overflow: "hidden", marginBottom: 5 }}>
        <div style={{ height: "100%", width: `${away}%`, background: "linear-gradient(90deg,#63ca8a,#48b876)", borderRadius: 3 }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "rgba(255,255,255,0.3)" }}>
        <span>{away}%</span><span>{home}%</span>
      </div>
    </div>
  );
}

// ── BEST BETS TAB ─────────────────────────────────────────────────────────────
function BestBetsTab({ props, apiKey }) {
  const top3 = [...props].sort((a, b) => b.edge_score - a.edge_score).slice(0, 3);
  const [stake, setStake] = useState("100");

  return (
    <div style={{ animation: "fadeUp 0.3s ease" }}>
      <SectionHeader color="#a78bfa" title="BEST BETS" sub="Top AI-curated picks ranked by Edge Score" />

      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", marginBottom: 24 }}>
        {top3.map((prop, i) => (
          <BestBetCard key={i} prop={prop} rank={i + 1} />
        ))}
      </div>

      {/* Bet Calculator */}
      <div style={{ ...card, marginTop: 8 }}>
        <div style={{ marginBottom: 14 }}>
          <h3 style={{ color: "#f5a623", fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", margin: "0 0 4px" }}>PAYOUT CALCULATOR</h3>
          <p style={{ color: "rgba(255,255,255,0.28)", fontSize: 10, margin: 0 }}>Enter odds + stake to calculate winnings</p>
        </div>
        <BetCalculator />
      </div>

      <Disclaimer />
    </div>
  );
}

function BestBetCard({ prop, rank }) {
  const ec = edgeColor(prop.edge_score);
  const rankColors = ["#f5a623", "rgba(255,255,255,0.45)", "#cd7f32"];
  return (
    <div style={{
      ...card,
      borderColor: rank === 1 ? "rgba(245,166,35,0.3)" : "rgba(255,255,255,0.07)",
      position: "relative", overflow: "hidden",
      animation: `fadeUp ${0.2 + rank * 0.08}s ease`,
    }}>
      {rank === 1 && (
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg,#f5a623,#ff8c00)" }} />
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={{ fontSize: 10, color: rankColors[rank - 1] || "rgba(255,255,255,0.2)", fontWeight: 700, letterSpacing: "0.06em" }}>
          #{rank} PICK
        </span>
        <div style={{
          width: 38, height: 38, borderRadius: "50%", background: `${ec}22`,
          border: `2px solid ${ec}`, display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 12, fontWeight: 800, color: ec,
        }}>
          {prop.edge_score}
        </div>
      </div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ color: "#fff", fontWeight: 700, fontSize: 15, marginBottom: 2 }}>{prop.player}</div>
        <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>{prop.team} · {prop.game}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div style={{ background: "rgba(255,255,255,0.07)", borderRadius: 6, padding: "5px 10px", fontSize: 13, fontWeight: 600, color: "#fff" }}>
          {prop.prop}
        </div>
        <div style={{
          background: prop.rec === "OVER" ? "rgba(99,202,138,0.15)" : "rgba(255,96,64,0.15)",
          border: `1px solid ${prop.rec === "OVER" ? "rgba(99,202,138,0.4)" : "rgba(255,96,64,0.4)"}`,
          borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700,
          color: prop.rec === "OVER" ? "#63ca8a" : "#ff6040",
        }}>
          {prop.rec}
        </div>
        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", marginLeft: "auto" }}>{prop.odds}</span>
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {[["L5", prop.l5], ["L10", prop.l10], ["L15", prop.l15]].map(([label, val]) => (
          <div key={label} style={{ flex: 1, background: "rgba(255,255,255,0.04)", borderRadius: 6, padding: "5px 0", textAlign: "center" }}>
            <div style={{ fontSize: 8, color: "rgba(255,255,255,0.25)", letterSpacing: "0.06em", marginBottom: 2 }}>{label}</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: hitColor(val) }}>{val}%</div>
          </div>
        ))}
        <div style={{ flex: 1, background: "rgba(255,255,255,0.04)", borderRadius: 6, padding: "5px 0", textAlign: "center" }}>
          <div style={{ fontSize: 8, color: "rgba(255,255,255,0.25)", letterSpacing: "0.06em", marginBottom: 2 }}>AVG</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#fff" }}>{prop.avg}</div>
        </div>
      </div>
      {prop.streak >= 3 && (
        <div style={{ fontSize: 10, color: "#f5a623", marginBottom: 8 }}>
          🔥 {prop.streak}-game hit streak
        </div>
      )}
      <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, margin: 0, lineHeight: 1.65 }}>{prop.reason}</p>
    </div>
  );
}

// ── BET CALCULATOR ────────────────────────────────────────────────────────────
function BetCalculator() {
  const [odds, setOdds] = useState("-110");
  const [stake, setStake] = useState("100");

  const payout = americanToPayout(odds, parseFloat(stake) || 0);
  const profit = payout ? (parseFloat(payout) - parseFloat(stake)).toFixed(2) : null;

  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
      <div style={{ flex: 1, minWidth: 100 }}>
        <label style={{ display: "block", fontSize: 9, color: "rgba(255,255,255,0.3)", letterSpacing: "0.08em", marginBottom: 5 }}>ODDS</label>
        <input value={odds} onChange={e => setOdds(e.target.value)} placeholder="-110"
          style={{ ...calcInput }} />
      </div>
      <div style={{ flex: 1, minWidth: 100 }}>
        <label style={{ display: "block", fontSize: 9, color: "rgba(255,255,255,0.3)", letterSpacing: "0.08em", marginBottom: 5 }}>STAKE ($)</label>
        <input value={stake} onChange={e => setStake(e.target.value)} placeholder="100" type="number"
          style={{ ...calcInput }} />
      </div>
      <div style={{ flex: 1, minWidth: 100 }}>
        <label style={{ display: "block", fontSize: 9, color: "rgba(255,255,255,0.3)", letterSpacing: "0.08em", marginBottom: 5 }}>PAYOUT</label>
        <div style={{ ...calcInput, color: "#63ca8a", fontWeight: 700, display: "flex", alignItems: "center" }}>
          {payout ? `$${payout}` : "—"}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 100 }}>
        <label style={{ display: "block", fontSize: 9, color: "rgba(255,255,255,0.3)", letterSpacing: "0.08em", marginBottom: 5 }}>PROFIT</label>
        <div style={{ ...calcInput, color: profit && parseFloat(profit) > 0 ? "#63ca8a" : "#ff6040", fontWeight: 700, display: "flex", alignItems: "center" }}>
          {profit ? `+$${profit}` : "—"}
        </div>
      </div>
    </div>
  );
}

// ── PROPS TABLE (Layzer-style) ─────────────────────────────────────────────────
function PropsTab({ props, parlay, toggleParlay }) {
  const [filter, setFilter] = useState("all");
  const [sortCol, setSortCol] = useState("edge_score");
  const [sortDir, setSortDir] = useState("desc");

  const FILTERS = [
    { id: "all", label: "ALL" },
    { id: "over", label: "OVER" },
    { id: "under", label: "UNDER" },
    { id: "hot", label: "🔥 HOT" },
  ];

  const filtered = props
    .filter(p => {
      if (filter === "over") return p.rec === "OVER";
      if (filter === "under") return p.rec === "UNDER";
      if (filter === "hot") return p.streak >= 3;
      return true;
    })
    .sort((a, b) => {
      const mult = sortDir === "desc" ? -1 : 1;
      return mult * (a[sortCol] - b[sortCol]);
    });

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortCol(col); setSortDir("desc"); }
  };

  const SortBtn = ({ col, children }) => (
    <span
      onClick={() => handleSort(col)}
      style={{ cursor: "pointer", color: sortCol === col ? "#63ca8a" : "rgba(255,255,255,0.25)", userSelect: "none",
        display: "inline-flex", alignItems: "center", gap: 3 }}
    >
      {children}
      <span style={{ fontSize: 8 }}>{sortCol === col ? (sortDir === "desc" ? "↓" : "↑") : "↕"}</span>
    </span>
  );

  return (
    <div style={{ animation: "fadeUp 0.3s ease" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <SectionHeader color="#f5a623" title="PLAYER PROPS" sub="Sorted by Edge Score · Click columns to sort" noMargin />
        <div style={{ display: "flex", gap: 6 }}>
          {FILTERS.map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)} style={{
              background: filter === f.id ? "rgba(245,166,35,0.15)" : "transparent",
              border: `1px solid ${filter === f.id ? "rgba(245,166,35,0.5)" : "rgba(255,255,255,0.1)"}`,
              borderRadius: 6, padding: "5px 12px", fontSize: 10, fontWeight: 700,
              color: filter === f.id ? "#f5a623" : "rgba(255,255,255,0.35)", letterSpacing: "0.06em",
            }}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                {[
                  { label: "PARLAY", col: null },
                  { label: "PLAYER", col: null },
                  { label: "PROP", col: null },
                  { label: "REC", col: null },
                  { label: "L5", col: "l5" },
                  { label: "L10", col: "l10" },
                  { label: "L15", col: "l15" },
                  { label: "STREAK", col: "streak" },
                  { label: "AVG", col: "avg" },
                  { label: "EDGE", col: "edge_score" },
                  { label: "ODDS", col: null },
                ].map(({ label, col }) => (
                  <th key={label} style={{
                    padding: "11px 12px", textAlign: "left", fontSize: 9,
                    color: "rgba(255,255,255,0.25)", letterSpacing: "0.08em", fontWeight: 600,
                    background: "rgba(255,255,255,0.02)",
                  }}>
                    {col ? <SortBtn col={col}>{label}</SortBtn> : label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((prop, i) => {
                const inParlay = parlay.some(p => p.player === prop.player && p.prop === prop.prop);
                const over = prop.rec === "OVER";
                return (
                  <tr key={i} style={{
                    borderBottom: "1px solid rgba(255,255,255,0.04)",
                    background: inParlay ? "rgba(99,202,138,0.05)" : "transparent",
                    transition: "background 0.15s",
                  }}>
                    {/* Parlay toggle */}
                    <td style={{ padding: "12px 12px" }}>
                      <button onClick={() => toggleParlay(prop)} style={{
                        width: 20, height: 20, borderRadius: 5,
                        border: `2px solid ${inParlay ? "#63ca8a" : "rgba(255,255,255,0.15)"}`,
                        background: inParlay ? "#63ca8a" : "transparent",
                        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10,
                      }}>
                        {inParlay ? "✓" : ""}
                      </button>
                    </td>
                    {/* Player */}
                    <td style={{ padding: "12px 12px" }}>
                      <div style={{ fontWeight: 700, color: "#fff", fontSize: 13, whiteSpace: "nowrap" }}>{prop.player}</div>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 1 }}>
                        {prop.team} {prop.pos} · <span style={{ color: "rgba(255,255,255,0.2)" }}>{prop.game}</span>
                      </div>
                    </td>
                    {/* Prop */}
                    <td style={{ padding: "12px 12px" }}>
                      <span style={{ color: "rgba(255,255,255,0.75)", fontSize: 12, whiteSpace: "nowrap" }}>{prop.prop}</span>
                    </td>
                    {/* Rec */}
                    <td style={{ padding: "12px 12px" }}>
                      <span style={{
                        background: over ? "rgba(99,202,138,0.15)" : "rgba(255,96,64,0.15)",
                        border: `1px solid ${over ? "rgba(99,202,138,0.35)" : "rgba(255,96,64,0.35)"}`,
                        borderRadius: 5, padding: "3px 8px", fontSize: 10, fontWeight: 700,
                        color: over ? "#63ca8a" : "#ff6040",
                      }}>
                        {prop.rec}
                      </span>
                    </td>
                    {/* Hit rates */}
                    {[prop.l5, prop.l10, prop.l15].map((val, j) => (
                      <td key={j} style={{ padding: "12px 12px" }}>
                        <span style={{
                          background: `${hitColor(val)}22`, border: `1px solid ${hitColor(val)}55`,
                          borderRadius: 5, padding: "3px 8px", fontSize: 11, fontWeight: 700,
                          color: hitColor(val),
                        }}>
                          {val}%
                        </span>
                      </td>
                    ))}
                    {/* Streak */}
                    <td style={{ padding: "12px 12px", whiteSpace: "nowrap" }}>
                      <span style={{ fontSize: 11, color: prop.streak >= 3 ? "#f5a623" : "rgba(255,255,255,0.35)" }}>
                        {prop.streak >= 3 ? "🔥" : ""} {prop.streak} games
                      </span>
                    </td>
                    {/* Avg */}
                    <td style={{ padding: "12px 12px" }}>
                      <span style={{ fontSize: 12, color: "#fff", fontWeight: 600 }}>{prop.avg}</span>
                    </td>
                    {/* Edge Score */}
                    <td style={{ padding: "12px 12px" }}>
                      <div style={{
                        width: 34, height: 34, borderRadius: "50%",
                        border: `2px solid ${edgeColor(prop.edge_score)}`,
                        background: `${edgeColor(prop.edge_score)}18`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 11, fontWeight: 800, color: edgeColor(prop.edge_score),
                      }}>
                        {prop.edge_score}
                      </div>
                    </td>
                    {/* Odds */}
                    <td style={{ padding: "12px 12px" }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: prop.odds.startsWith("+") ? "#63ca8a" : "rgba(255,255,255,0.6)" }}>
                        {prop.odds}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ marginTop: 14, padding: "10px 14px", background: "rgba(245,166,35,0.05)", border: "1px solid rgba(245,166,35,0.15)", borderRadius: 8, fontSize: 10, color: "rgba(255,255,255,0.28)", textAlign: "center" }}>
        ⚠️ Props are for entertainment only. Always verify lines with your sportsbook before betting.
      </div>
    </div>
  );
}

// ── PARLAY BUILDER ────────────────────────────────────────────────────────────
function ParlayTray({ parlay, onRemove, onClear }) {
  const [stake, setStake] = useState("100");
  const [combined, setCombined] = useState(null);
  const [loading, setLoading] = useState(false);

  const calculate = async () => {
    if (parlay.length < 2) return;
    setLoading(true);
    try {
      const odds = parlay.map(p => p.odds);
      const data = await fetch("/api/parlay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ odds }),
      }).then(r => r.json());
      setCombined(data);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  const payout = combined && stake
    ? (combined.combined_decimal * parseFloat(stake)).toFixed(2)
    : null;
  const profit = payout
    ? (parseFloat(payout) - parseFloat(stake)).toFixed(2)
    : null;

  if (parlay.length === 0) return null;

  return (
    <div style={{
      position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 100,
      background: "linear-gradient(0deg,#0a1428 0%,#0d1a30 100%)",
      borderTop: "1px solid rgba(99,202,138,0.25)",
      boxShadow: "0 -8px 40px rgba(0,0,0,0.6)",
      animation: "slideUp 0.25s ease",
    }}>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "14px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ color: "#63ca8a", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", whiteSpace: "nowrap" }}>
            🎰 PARLAY ({parlay.length} LEGS)
          </span>
          <div style={{ display: "flex", gap: 6, flex: 1, flexWrap: "wrap" }}>
            {parlay.map((p, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: 5,
                background: "rgba(99,202,138,0.1)", border: "1px solid rgba(99,202,138,0.25)",
                borderRadius: 6, padding: "4px 8px",
              }}>
                <span style={{ fontSize: 10, color: "rgba(255,255,255,0.7)" }}>{p.player}</span>
                <span style={{ fontSize: 9, color: "rgba(255,255,255,0.4)" }}>{p.rec}</span>
                <button onClick={() => onRemove(p)} style={{
                  background: "none", border: "none", color: "rgba(255,255,255,0.3)", fontSize: 12, padding: 0, lineHeight: 1,
                }}>×</button>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input value={stake} onChange={e => setStake(e.target.value)} placeholder="$100" type="number"
              style={{ width: 70, ...calcInput, padding: "6px 10px" }} />
            <button onClick={calculate} disabled={loading || parlay.length < 2} style={{
              background: "#63ca8a", color: "#080d1a", border: "none", borderRadius: 7,
              padding: "8px 14px", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
              opacity: loading || parlay.length < 2 ? 0.5 : 1,
            }}>
              {loading ? "..." : "CALCULATE"}
            </button>
            <button onClick={onClear} style={{
              background: "transparent", border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 7, padding: "8px 12px", fontSize: 10, color: "rgba(255,255,255,0.35)",
            }}>CLEAR</button>
          </div>
          {combined && (
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 8, color: "rgba(255,255,255,0.25)", letterSpacing: "0.06em" }}>ODDS</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#63ca8a" }}>{combined.combined_odds}</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 8, color: "rgba(255,255,255,0.25)", letterSpacing: "0.06em" }}>PAYOUT</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>${payout}</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 8, color: "rgba(255,255,255,0.25)", letterSpacing: "0.06em" }}>PROFIT</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#63ca8a" }}>+${profit}</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 8, color: "rgba(255,255,255,0.25)", letterSpacing: "0.06em" }}>IMPL PROB</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "rgba(255,255,255,0.6)" }}>{combined.implied_prob}%</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── STANDINGS TABLE ───────────────────────────────────────────────────────────
function StandingsTable({ conf, teams }) {
  return (
    <div style={{ ...card, padding: 0, overflow: "hidden", animation: "fadeUp 0.3s ease" }}>
      <div style={{ padding: "12px 16px", background: "rgba(255,255,255,0.03)", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
        <span style={{ color: "rgba(255,255,255,0.45)", fontSize: 10, letterSpacing: "0.1em", fontWeight: 700 }}>
          {conf.toUpperCase()} CONFERENCE
        </span>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["#", "TEAM", "W", "L", "PCT", "GB", "STK"].map(h => (
              <th key={h} style={{
                padding: "8px 10px", textAlign: h === "TEAM" ? "left" : "center",
                color: "rgba(255,255,255,0.2)", fontSize: 9, letterSpacing: "0.08em", fontWeight: 600,
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {teams.map((t, i) => (
            <tr key={t.abbr} style={{
              borderTop: "1px solid rgba(255,255,255,0.035)",
              background: i < 6 ? "transparent" : "rgba(255,255,255,0.01)",
            }}>
              <td style={{ padding: "10px 10px", textAlign: "center", color: i < 6 ? "rgba(255,255,255,0.25)" : "rgba(255,80,80,0.4)", fontSize: 11, fontWeight: i < 6 ? 400 : 700 }}>{i + 1}</td>
              <td style={{ padding: "10px 10px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{
                    width: 22, height: 22, borderRadius: 5, background: TEAM_COLORS[t.abbr] || "#333",
                    fontSize: 8, fontWeight: 700, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {t.abbr.slice(0, 2)}
                  </div>
                  <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 12 }}>{t.team}</span>
                  {i === 5 && <span style={{ fontSize: 8, color: "#ff5050", background: "rgba(255,80,80,0.1)", borderRadius: 3, padding: "1px 4px" }}>BUBBLE</span>}
                </div>
              </td>
              <td style={{ padding: "10px 10px", textAlign: "center", color: "#fff", fontSize: 12, fontWeight: 700 }}>{t.w}</td>
              <td style={{ padding: "10px 10px", textAlign: "center", color: "rgba(255,255,255,0.4)", fontSize: 12 }}>{t.l}</td>
              <td style={{ padding: "10px 10px", textAlign: "center", color: "rgba(255,255,255,0.5)", fontSize: 12 }}>{t.pct}</td>
              <td style={{ padding: "10px 10px", textAlign: "center", color: "rgba(255,255,255,0.3)", fontSize: 11 }}>{t.gb}</td>
              <td style={{ padding: "10px 10px", textAlign: "center", fontSize: 11, fontWeight: 700, color: t.streak.startsWith("W") ? "#63ca8a" : "#ff6040" }}>{t.streak}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── CHAT ──────────────────────────────────────────────────────────────────────
const QUICK_PROMPTS = [
  "Best bet tonight?",
  "Top prop plays?",
  "Any live value right now?",
  "Injury impacts today?",
  "Best parlay for tonight?",
];

function ChatTab({ apiKey }) {
  const [messages, setMessages] = useState([
    { role: "assistant", content: "Welcome to NBA Edge 🏀 I'm your Gemini-powered betting analyst. Ask me about tonight's slate, player props, line value, injuries — whatever you need. (For entertainment only.)" }
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef(null);

  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [messages]);

  const send = async (text) => {
    const msg = text || input;
    if (!msg.trim() || loading) return;
    const userMsg = { role: "user", content: msg };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError("");
    try {
      const data = await api.chat(next, apiKey);
      setMessages([...next, { role: "assistant", content: data.reply }]);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  return (
    <div style={{ animation: "fadeUp 0.3s ease" }}>
      <SectionHeader color="#a78bfa" title="AI BETTING CHAT" sub="Ask Gemini anything about tonight's NBA slate" />

      {/* Quick prompts */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
        {QUICK_PROMPTS.map(p => (
          <button key={p} onClick={() => send(p)} disabled={loading} style={{
            background: "rgba(167,139,250,0.08)", border: "1px solid rgba(167,139,250,0.22)",
            borderRadius: 20, padding: "6px 12px", fontSize: 10, color: "rgba(167,139,250,0.8)",
            whiteSpace: "nowrap", opacity: loading ? 0.5 : 1,
          }}>
            {p}
          </button>
        ))}
      </div>

      <div style={{ ...card, padding: 0, overflow: "hidden", display: "flex", flexDirection: "column", height: 460 }}>
        <div ref={ref} style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
          {messages.map((m, i) => (
            <div key={i} style={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "82%",
              background: m.role === "user" ? "rgba(99,202,138,0.1)" : "rgba(255,255,255,0.04)",
              border: `1px solid ${m.role === "user" ? "rgba(99,202,138,0.22)" : "rgba(255,255,255,0.07)"}`,
              borderRadius: m.role === "user" ? "14px 14px 3px 14px" : "14px 14px 14px 3px",
              padding: "11px 15px", animation: "fadeUp 0.25s ease",
            }}>
              {m.role === "assistant" && (
                <span style={{ color: "#a78bfa", fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", display: "block", marginBottom: 5 }}>
                  GEMINI ANALYST
                </span>
              )}
              <p style={{ color: "rgba(255,255,255,0.78)", fontSize: 12, lineHeight: 1.75, margin: 0 }}>{m.content}</p>
            </div>
          ))}
          {loading && (
            <div style={{ alignSelf: "flex-start", color: "rgba(255,255,255,0.3)", fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
              <Spinner />Analyzing...
            </div>
          )}
          {error && <div style={{ color: "#ff5050", fontSize: 11 }}>⚠️ {error}</div>}
        </div>
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "14px 16px", display: "flex", gap: 10 }}>
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && send()}
            placeholder="Ask about games, props, value plays, injuries..."
            style={{ flex: 1, background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 9, color: "#fff", padding: "11px 14px", fontSize: 11 }} />
          <button onClick={() => send()} disabled={loading || !input.trim()} style={{
            background: "#a78bfa", color: "#080d1a", border: "none", borderRadius: 9,
            padding: "11px 22px", fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
            opacity: loading || !input.trim() ? 0.4 : 1,
          }}>SEND</button>
        </div>
      </div>
      <Disclaimer />
    </div>
  );
}

// ── SHARED HELPERS ────────────────────────────────────────────────────────────
const Spinner = () => (
  <span style={{ width: 10, height: 10, border: "2px solid rgba(255,255,255,0.15)", borderTopColor: "#63ca8a", borderRadius: "50%", display: "inline-block", animation: "spin 0.7s linear infinite", marginRight: 4 }} />
);
const Pill = ({ children, style }) => (
  <span style={{ background: "rgba(255,255,255,0.06)", borderRadius: 5, padding: "3px 9px", fontSize: 10, color: "rgba(255,255,255,0.4)", ...style }}>
    {children}
  </span>
);
const SectionHeader = ({ color, title, sub, noMargin }) => (
  <div style={{ marginBottom: noMargin ? 0 : 18 }}>
    <h2 style={{ color, fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", margin: "0 0 4px" }}>{title}</h2>
    <p style={{ color: "rgba(255,255,255,0.28)", fontSize: 11, margin: 0 }}>{sub}</p>
  </div>
);
const Disclaimer = () => (
  <p style={{ color: "rgba(255,255,255,0.15)", fontSize: 10, textAlign: "center", marginTop: 14, letterSpacing: "0.04em" }}>
    ⚠️ For entertainment purposes only · Not financial advice · Please gamble responsibly
  </p>
);

// ── SHARED STYLES ─────────────────────────────────────────────────────────────
const card = {
  background: "rgba(255,255,255,0.032)",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: 14, padding: 18,
};
const gateWrap = {
  minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
  background: "linear-gradient(135deg,#080c18 0%,#0b1830 100%)",
};
const gateCard = {
  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(99,202,138,0.22)",
  borderRadius: 20, padding: "52px 44px", maxWidth: 400, width: "90%", textAlign: "center",
  boxShadow: "0 0 80px rgba(99,202,138,0.06)",
};
const gateTitle = { color: "#63ca8a", fontSize: 26, fontWeight: 700, letterSpacing: "0.06em", margin: "0 0 5px" };
const gateSub = { color: "rgba(255,255,255,0.28)", fontSize: 11, letterSpacing: "0.1em", margin: "0 0 32px" };
const gateInput = {
  width: "100%", boxSizing: "border-box", background: "rgba(0,0,0,0.4)",
  border: "1px solid", borderRadius: 10, color: "#fff", padding: "13px 16px", fontSize: 12, marginBottom: 10,
};
const gateBtn = {
  width: "100%", background: "#63ca8a", color: "#080d1a", border: "none",
  borderRadius: 10, padding: "14px", fontSize: 12, fontWeight: 700, letterSpacing: "0.08em",
};
const analyzeBtn = {
  width: "100%", background: "transparent",
  border: "1px solid rgba(99,202,138,0.28)", borderRadius: 8, color: "#63ca8a",
  fontSize: 10, fontWeight: 700, letterSpacing: "0.07em", padding: "9px",
  display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
};
const calcInput = {
  width: "100%", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.09)",
  borderRadius: 8, color: "#fff", padding: "9px 12px", fontSize: 12,
};

// ── MAIN APP ──────────────────────────────────────────────────────────────────
export default function App() {
  const [apiKey, setApiKey] = useState("");
  const [serverHasKey, setServerHasKey] = useState(false);
  const [tab, setTab] = useState("live");
  const [games, setGames] = useState([]);
  const [standings, setStandings] = useState({});
  const [props, setProps] = useState([]);
  const [analyses, setAnalyses] = useState({});
  const [loadingId, setLoadingId] = useState(null);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [parlay, setParlay] = useState([]);

  useEffect(() => {
    api.health().then(d => setServerHasKey(d.has_server_key)).catch(() => {});
  }, []);

  useEffect(() => {
    if (apiKey === null) return;
    Promise.all([api.getGames(), api.getStandings(), api.getProps()])
      .then(([g, s, p]) => { setGames(g.games); setStandings(s.standings); setProps(p.props); setDataLoaded(true); })
      .catch(console.error);
  }, [apiKey]);

  if (apiKey === "" && !serverHasKey) {
    return dataLoaded ? null : <ApiKeyGate serverHasKey={serverHasKey} onSubmit={k => setApiKey(k)} />;
  }
  if (!dataLoaded) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#080c18" }}>
      <Spinner /><span style={{ color: "rgba(255,255,255,0.35)", fontSize: 12, marginLeft: 10 }}>Loading...</span>
    </div>
  );

  const liveGames = games.filter(g => g.status === "live");
  const upcomingGames = games.filter(g => g.status === "upcoming");
  const finalGames = games.filter(g => g.status === "final");
  const topProp = props.length ? [...props].sort((a, b) => b.edge_score - a.edge_score)[0] : null;

  const handleAnalyze = async (gameId) => {
    setLoadingId(gameId);
    try {
      const data = await api.analyze(gameId, apiKey);
      setAnalyses(p => ({ ...p, [gameId]: data.analysis }));
    } catch (e) {
      setAnalyses(p => ({ ...p, [gameId]: `⚠️ ${e.message}` }));
    }
    setLoadingId(null);
  };

  const toggleParlay = (prop) => {
    setParlay(prev => {
      const exists = prev.some(p => p.player === prop.player && p.prop === prop.prop);
      return exists ? prev.filter(p => !(p.player === prop.player && p.prop === prop.prop)) : [...prev, prop];
    });
  };

  const TABS = [
    { id: "live",      label: "🔴 LIVE",      badge: liveGames.length },
    { id: "upcoming",  label: "📅 TONIGHT",   badge: upcomingGames.length },
    { id: "bestbets",  label: "⭐ BEST BETS"  },
    { id: "props",     label: "🎯 PROPS",     badge: props.length },
    { id: "standings", label: "📊 STANDINGS"  },
    { id: "chat",      label: "💬 AI CHAT"    },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,#080c18 0%,#0b1525 60%,#08101e 100%)", paddingBottom: parlay.length ? 90 : 0 }}>
      {/* Header */}
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "0 20px" }}>
        <div style={{ maxWidth: 960, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", height: 58 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 22 }}>🏀</span>
            <span style={{ color: "#63ca8a", fontWeight: 700, fontSize: 18, letterSpacing: "0.06em" }}>NBA EDGE</span>
            <span style={{ color: "rgba(255,255,255,0.15)", fontSize: 9, letterSpacing: "0.12em", marginLeft: 2 }}>POWERED BY GEMINI</span>
          </div>
          <div style={{ color: "rgba(255,255,255,0.2)", fontSize: 10 }}>Feb 19, 2026</div>
        </div>
      </div>

      {/* Stats Strip */}
      <StatsStrip liveCount={liveGames.length} tonightCount={upcomingGames.length} propsCount={props.length} topProp={topProp} />

      {/* Tabs */}
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "0 20px", overflowX: "auto" }}>
        <div style={{ maxWidth: 960, margin: "0 auto", display: "flex" }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              background: "transparent", border: "none",
              borderBottom: tab === t.id ? "2px solid #63ca8a" : "2px solid transparent",
              color: tab === t.id ? "#63ca8a" : "rgba(255,255,255,0.28)",
              padding: "14px 16px", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
              whiteSpace: "nowrap", transition: "color 0.2s",
            }}>
              {t.label}{t.badge != null ? ` (${t.badge})` : ""}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "26px 20px" }}>
        {tab === "live" && (
          <div style={{ animation: "fadeUp 0.3s ease" }}>
            <SectionHeader color="#ff5050" title="LIVE GAMES" sub="Real-time scores · Click for Gemini live betting analysis" />
            <Grid>
              {liveGames.map(g => <GameCard key={g.id} game={g} onAnalyze={handleAnalyze} analysis={analyses[g.id]} loading={loadingId === g.id} />)}
            </Grid>
            {finalGames.length > 0 && <>
              <h3 style={{ color: "rgba(255,255,255,0.18)", fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", margin: "28px 0 14px" }}>FINAL SCORES</h3>
              <Grid>{finalGames.map(g => <GameCard key={g.id} game={g} onAnalyze={handleAnalyze} analysis={analyses[g.id]} loading={loadingId === g.id} />)}</Grid>
            </>}
          </div>
        )}

        {tab === "upcoming" && (
          <div style={{ animation: "fadeUp 0.3s ease" }}>
            <SectionHeader color="#63ca8a" title="TONIGHT'S GAMES" sub="Win probabilities, spreads & moneylines — click for Gemini picks" />
            <Grid>{upcomingGames.map(g => <GameCard key={g.id} game={g} onAnalyze={handleAnalyze} analysis={analyses[g.id]} loading={loadingId === g.id} />)}</Grid>
          </div>
        )}

        {tab === "bestbets" && <BestBetsTab props={props} apiKey={apiKey} />}

        {tab === "props" && <PropsTab props={props} parlay={parlay} toggleParlay={toggleParlay} />}

        {tab === "standings" && (
          <div style={{ animation: "fadeUp 0.3s ease" }}>
            <SectionHeader color="#8b9ff0" title="2025–26 STANDINGS" sub="Top 8 per conference · 6th seed = playoff bubble" />
            <Grid minWidth="380px">
              {Object.entries(standings).map(([conf, teams]) => <StandingsTable key={conf} conf={conf} teams={teams} />)}
            </Grid>
          </div>
        )}

        {tab === "chat" && <ChatTab apiKey={apiKey} />}
      </div>

      {/* Parlay Tray */}
      <ParlayTray
        parlay={parlay}
        onRemove={prop => toggleParlay(prop)}
        onClear={() => setParlay([])}
      />
    </div>
  );
}

const Grid = ({ children, minWidth = "290px" }) => (
  <div style={{ display: "grid", gap: 14, gridTemplateColumns: `repeat(auto-fill,minmax(${minWidth},1fr))` }}>
    {children}
  </div>
);
