import { useState, useEffect, useRef } from "react";
import { api } from "./api.js";

// ── CONSTANTS ────────────────────────────────────────────────────────────────
const TEAM_COLORS = {
  NYK:"#006BB6", DET:"#C8102E", CHI:"#CE1141", TOR:"#CE1141",
  SAS:"#8A8D8F", PHX:"#E56020", CLE:"#860038", BKN:"#444",
  CHA:"#00788C", HOU:"#CE1141", LAL:"#552583", DAL:"#00538C",
  GSW:"#1D428A", BOS:"#007A33", SAC:"#5A2D81", ORL:"#0077C0",
  LAC:"#C8102E", DEN:"#0E2240",
};

// ── API KEY GATE ─────────────────────────────────────────────────────────────
function ApiKeyGate({ onSubmit, serverHasKey }) {
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");

  if (serverHasKey) {
    return (
      <div style={gateWrap}>
        <div style={gateCard}>
          <div style={{ fontSize:44, marginBottom:10 }}>🏀</div>
          <h1 style={gateTitle}>NBA EDGE</h1>
          <p style={gateSub}>AI BETTING ANALYST · GEMINI</p>
          <p style={{ color:"rgba(255,255,255,0.4)", fontSize:12, margin:"0 0 24px" }}>
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
        <div style={{ fontSize:44, marginBottom:10 }}>🏀</div>
        <h1 style={gateTitle}>NBA EDGE</h1>
        <p style={gateSub}>AI BETTING ANALYST · GEMINI</p>
        <input type="password" placeholder="Enter Gemini API Key..."
          value={key} onChange={e => { setKey(e.target.value); setErr(""); }}
          onKeyDown={e => e.key==="Enter" && key && onSubmit(key)}
          style={{ ...gateInput, borderColor: err ? "#ff5050" : "rgba(99,202,138,0.25)" }} />
        {err && <p style={{ color:"#ff5050", fontSize:11, margin:"0 0 10px" }}>{err}</p>}
        <button onClick={() => key ? onSubmit(key) : setErr("Please enter your API key")} style={gateBtn}>
          CONNECT →
        </button>
        <p style={{ color:"rgba(255,255,255,0.2)", fontSize:10, marginTop:16 }}>
          Key used in-session only · Never stored
        </p>
        <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer"
          style={{ color:"rgba(99,202,138,0.6)", fontSize:10, display:"block", marginTop:8 }}>
          Get a free Gemini API key →
        </a>
      </div>
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
    <div style={{ ...card, borderColor: isLive ? "rgba(255,70,70,0.4)" : "rgba(255,255,255,0.07)", animation:"fadeUp 0.3s ease" }}>
      {/* Status */}
      <div style={{ marginBottom:12 }}>
        {isLive && (
          <span style={{ display:"inline-flex", alignItems:"center", gap:5, color:"#ff5050", fontSize:10, fontWeight:700, letterSpacing:"0.1em" }}>
            <span style={{ width:6, height:6, borderRadius:"50%", background:"#ff5050", animation:"pulse 1.2s infinite", display:"inline-block" }} />
            LIVE · Q{game.quarter} {game.clock}
          </span>
        )}
        {isFinal && <span style={{ color:"rgba(255,255,255,0.25)", fontSize:10, letterSpacing:"0.1em", fontWeight:600 }}>FINAL</span>}
        {isUp && <span style={{ color:"#63ca8a", fontSize:10, letterSpacing:"0.08em", fontWeight:600 }}>⏰ {game.time}</span>}
      </div>

      {/* Matchup */}
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <TeamSide abbr={game.away} name={game.awayName} odds={game.awayOdds} isUp={isUp} align="left" />
        <div style={{ textAlign:"center", minWidth:96 }}>
          {(isLive || isFinal) ? (
            <div style={{ display:"flex", gap:10, alignItems:"center", justifyContent:"center" }}>
              <span style={{ fontSize:28, fontWeight:700, color: awayWins ? "#fff" : "rgba(255,255,255,0.28)", lineHeight:1 }}>{game.awayScore}</span>
              <span style={{ color:"rgba(255,255,255,0.15)" }}>:</span>
              <span style={{ fontSize:28, fontWeight:700, color: homeWins ? "#fff" : "rgba(255,255,255,0.28)", lineHeight:1 }}>{game.homeScore}</span>
            </div>
          ) : (
            <WinBar home={game.homeWinProb} away={game.awayWinProb} homeAbbr={game.home} awayAbbr={game.away} />
          )}
        </div>
        <TeamSide abbr={game.home} name={game.homeName} odds={game.homeOdds} isUp={isUp} align="right" />
      </div>

      {/* Lines */}
      {isUp && (
        <div style={{ display:"flex", gap:6, marginTop:12, paddingTop:10, borderTop:"1px solid rgba(255,255,255,0.05)" }}>
          <Pill>Spread: {game.spread}</Pill>
          <Pill>O/U: {game.ou}</Pill>
        </div>
      )}

      {/* Analysis */}
      {analysis ? (
        <div style={{ marginTop:12, background:"rgba(99,202,138,0.06)", border:"1px solid rgba(99,202,138,0.18)", borderRadius:9, padding:"10px 12px" }}>
          <span style={{ color:"#63ca8a", fontSize:9, fontWeight:700, letterSpacing:"0.08em", display:"block", marginBottom:5 }}>GEMINI ANALYSIS</span>
          <p style={{ color:"rgba(255,255,255,0.7)", fontSize:11, lineHeight:1.7, margin:0 }}>{analysis}</p>
        </div>
      ) : (
        <button onClick={() => onAnalyze(game.id)} disabled={loading} style={{
          ...analyzeBtn, opacity: loading ? 0.4 : 1
        }}>
          {loading ? <><Spinner /> ANALYZING...</> : "⚡ GET AI ANALYSIS"}
        </button>
      )}
    </div>
  );
}

function TeamSide({ abbr, name, odds, isUp, align }) {
  return (
    <div style={{ flex:1, textAlign: align }}>
      <div style={{ width:30, height:30, borderRadius:7, background: TEAM_COLORS[abbr] || "#333",
        display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, fontWeight:700, color:"#fff",
        marginBottom:5, ...(align==="right" ? {marginLeft:"auto"} : {}) }}>
        {abbr}
      </div>
      <div style={{ color:"rgba(255,255,255,0.55)", fontSize:11 }}>{name}</div>
      {isUp && odds && <div style={{ color:"rgba(255,255,255,0.3)", fontSize:11, marginTop:2 }}>{odds}</div>}
    </div>
  );
}

function WinBar({ away, home, awayAbbr, homeAbbr }) {
  return (
    <div>
      <div style={{ fontSize:9, color:"rgba(255,255,255,0.25)", marginBottom:5, letterSpacing:"0.05em" }}>WIN PROB</div>
      <div style={{ height:5, borderRadius:3, background:"rgba(255,255,255,0.08)", overflow:"hidden", marginBottom:4 }}>
        <div style={{ height:"100%", width:`${away}%`, background:"linear-gradient(90deg,#63ca8a,#48b876)", borderRadius:3 }} />
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"rgba(255,255,255,0.35)" }}>
        <span>{away}%</span><span>{home}%</span>
      </div>
    </div>
  );
}

// ── PROP CARD ─────────────────────────────────────────────────────────────────
function PropCard({ prop }) {
  const over = prop.rec === "OVER";
  const accent = over ? "#63ca8a" : "#ff6040";
  return (
    <div style={{ ...card, animation:"fadeUp 0.3s ease" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12 }}>
        <div>
          <div style={{ color:"#fff", fontWeight:700, fontSize:14 }}>{prop.player}</div>
          <div style={{ color:"rgba(255,255,255,0.35)", fontSize:10, marginTop:3 }}>{prop.team} · {prop.game}</div>
        </div>
        <div style={{ background:`${accent}1a`, border:`1px solid ${accent}55`, borderRadius:6,
          padding:"4px 10px", fontSize:10, fontWeight:700, color: accent, letterSpacing:"0.08em" }}>
          {prop.rec}
        </div>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
        <div style={{ background:"rgba(255,255,255,0.08)", borderRadius:6, padding:"5px 10px", fontSize:12, fontWeight:600, color:"#fff", whiteSpace:"nowrap" }}>
          {prop.prop} {prop.line}
        </div>
        <div style={{ flex:1, height:4, borderRadius:2, background:"rgba(255,255,255,0.07)", overflow:"hidden" }}>
          <div style={{ height:"100%", width:`${prop.conf}%`, borderRadius:2, background:`linear-gradient(90deg,${accent},${accent}aa)` }} />
        </div>
        <span style={{ fontSize:10, color:"rgba(255,255,255,0.35)", minWidth:30 }}>{prop.conf}%</span>
      </div>
      <p style={{ color:"rgba(255,255,255,0.45)", fontSize:11, margin:0, lineHeight:1.65 }}>{prop.reason}</p>
    </div>
  );
}

// ── STANDINGS TABLE ───────────────────────────────────────────────────────────
function StandingsTable({ conf, teams }) {
  return (
    <div style={{ ...card, padding:0, overflow:"hidden", animation:"fadeUp 0.3s ease" }}>
      <div style={{ padding:"11px 16px", background:"rgba(255,255,255,0.03)", borderBottom:"1px solid rgba(255,255,255,0.05)" }}>
        <span style={{ color:"rgba(255,255,255,0.45)", fontSize:10, letterSpacing:"0.1em", fontWeight:700 }}>
          {conf.toUpperCase()} CONFERENCE
        </span>
      </div>
      <table style={{ width:"100%", borderCollapse:"collapse" }}>
        <thead>
          <tr>{["#","TEAM","W","L","PCT","STK"].map(h => (
            <th key={h} style={{ padding:"7px 10px", textAlign: h==="TEAM"?"left":"center",
              color:"rgba(255,255,255,0.2)", fontSize:9, letterSpacing:"0.08em", fontWeight:600 }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {teams.map((t, i) => (
            <tr key={t.abbr} style={{ borderTop:"1px solid rgba(255,255,255,0.035)" }}>
              <td style={{ padding:"9px 10px", textAlign:"center", color:"rgba(255,255,255,0.25)", fontSize:11 }}>{i+1}</td>
              <td style={{ padding:"9px 10px" }}>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <div style={{ width:20, height:20, borderRadius:4, background: TEAM_COLORS[t.abbr]||"#333",
                    fontSize:8, fontWeight:700, color:"#fff", display:"flex", alignItems:"center", justifyContent:"center" }}>
                    {t.abbr.slice(0,2)}
                  </div>
                  <span style={{ color:"rgba(255,255,255,0.7)", fontSize:12 }}>{t.team}</span>
                </div>
              </td>
              <td style={{ padding:"9px 10px", textAlign:"center", color:"#fff", fontSize:12, fontWeight:700 }}>{t.w}</td>
              <td style={{ padding:"9px 10px", textAlign:"center", color:"rgba(255,255,255,0.4)", fontSize:12 }}>{t.l}</td>
              <td style={{ padding:"9px 10px", textAlign:"center", color:"rgba(255,255,255,0.5)", fontSize:12 }}>{t.pct}</td>
              <td style={{ padding:"9px 10px", textAlign:"center", fontSize:11, fontWeight:700,
                color: t.streak.startsWith("W") ? "#63ca8a" : "#ff6040" }}>{t.streak}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── CHAT ──────────────────────────────────────────────────────────────────────
function ChatTab({ apiKey }) {
  const [messages, setMessages] = useState([
    { role:"assistant", content:"Welcome to NBA Edge 🏀 I'm your Gemini-powered betting analyst. Ask me about tonight's slate, player props, line value, injuries — whatever you need. (For entertainment only.)" }
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef(null);

  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [messages]);

  const send = async () => {
    if (!input.trim() || loading) return;
    const userMsg = { role:"user", content: input };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError("");
    try {
      const data = await api.chat(next, apiKey);
      setMessages([...next, { role:"assistant", content: data.reply }]);
    } catch(e) {
      setError(e.message);
    }
    setLoading(false);
  };

  return (
    <div style={{ animation:"fadeUp 0.3s ease" }}>
      <SectionHeader color="#a78bfa" title="AI BETTING CHAT" sub="Ask Gemini anything about tonight's NBA slate" />
      <div style={{ ...card, padding:0, overflow:"hidden", display:"flex", flexDirection:"column", height:500 }}>
        <div ref={ref} style={{ flex:1, overflowY:"auto", padding:20, display:"flex", flexDirection:"column", gap:12 }}>
          {messages.map((m, i) => (
            <div key={i} style={{
              alignSelf: m.role==="user" ? "flex-end" : "flex-start", maxWidth:"80%",
              background: m.role==="user" ? "rgba(99,202,138,0.12)" : "rgba(255,255,255,0.05)",
              border:`1px solid ${m.role==="user" ? "rgba(99,202,138,0.22)" : "rgba(255,255,255,0.07)"}`,
              borderRadius: m.role==="user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
              padding:"10px 14px", animation:"fadeUp 0.25s ease",
            }}>
              {m.role==="assistant" && (
                <span style={{ color:"#a78bfa", fontSize:9, fontWeight:700, letterSpacing:"0.08em", display:"block", marginBottom:5 }}>
                  GEMINI ANALYST
                </span>
              )}
              <p style={{ color:"rgba(255,255,255,0.78)", fontSize:12, lineHeight:1.7, margin:0 }}>{m.content}</p>
            </div>
          ))}
          {loading && <div style={{ alignSelf:"flex-start", color:"rgba(255,255,255,0.3)", fontSize:11, display:"flex", alignItems:"center", gap:6 }}><Spinner />Analyzing...</div>}
          {error && <div style={{ color:"#ff5050", fontSize:11 }}>⚠️ {error}</div>}
        </div>
        <div style={{ borderTop:"1px solid rgba(255,255,255,0.06)", padding:"14px 16px", display:"flex", gap:10 }}>
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key==="Enter" && send()}
            placeholder="Ask about games, props, value plays, injuries..."
            style={{ flex:1, background:"rgba(0,0,0,0.35)", border:"1px solid rgba(255,255,255,0.09)",
              borderRadius:8, color:"#fff", padding:"10px 14px", fontSize:11 }} />
          <button onClick={send} disabled={loading || !input.trim()} style={{
            background:"#63ca8a", color:"#080d1a", border:"none", borderRadius:8,
            padding:"10px 20px", fontSize:11, fontWeight:700, letterSpacing:"0.06em",
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
  <span style={{ width:10, height:10, border:"2px solid rgba(255,255,255,0.2)", borderTopColor:"#63ca8a",
    borderRadius:"50%", display:"inline-block", animation:"spin 0.7s linear infinite", marginRight:4 }} />
);
const Pill = ({ children }) => (
  <span style={{ background:"rgba(255,255,255,0.06)", borderRadius:5, padding:"3px 8px", fontSize:10, color:"rgba(255,255,255,0.45)" }}>
    {children}
  </span>
);
const SectionHeader = ({ color, title, sub }) => (
  <div style={{ marginBottom:18 }}>
    <h2 style={{ color, fontSize:12, fontWeight:700, letterSpacing:"0.12em", margin:"0 0 4px" }}>{title}</h2>
    <p style={{ color:"rgba(255,255,255,0.28)", fontSize:11, margin:0 }}>{sub}</p>
  </div>
);
const Disclaimer = () => (
  <p style={{ color:"rgba(255,255,255,0.18)", fontSize:10, textAlign:"center", marginTop:14, letterSpacing:"0.04em" }}>
    ⚠️ For entertainment purposes only · Not financial advice · Please gamble responsibly
  </p>
);

// ── SHARED STYLES ─────────────────────────────────────────────────────────────
const card = {
  background:"rgba(255,255,255,0.035)",
  border:"1px solid rgba(255,255,255,0.07)",
  borderRadius:13, padding:18,
};
const gateWrap = { minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center",
  background:"linear-gradient(135deg,#080c18 0%,#0b1830 100%)" };
const gateCard = { background:"rgba(255,255,255,0.04)", border:"1px solid rgba(99,202,138,0.25)",
  borderRadius:18, padding:"48px 44px", maxWidth:400, width:"90%", textAlign:"center",
  boxShadow:"0 0 80px rgba(99,202,138,0.07)" };
const gateTitle = { color:"#63ca8a", fontSize:24, fontWeight:700, letterSpacing:"0.06em", margin:"0 0 4px" };
const gateSub = { color:"rgba(255,255,255,0.3)", fontSize:11, letterSpacing:"0.1em", margin:"0 0 28px" };
const gateInput = { width:"100%", boxSizing:"border-box", background:"rgba(0,0,0,0.4)",
  border:"1px solid", borderRadius:9, color:"#fff", padding:"12px 16px", fontSize:12, marginBottom:10 };
const gateBtn = { width:"100%", background:"#63ca8a", color:"#080d1a", border:"none",
  borderRadius:9, padding:"13px", fontSize:12, fontWeight:700, letterSpacing:"0.08em" };
const analyzeBtn = { marginTop:12, width:"100%", background:"transparent",
  border:"1px solid rgba(99,202,138,0.3)", borderRadius:8, color:"#63ca8a",
  fontSize:10, fontWeight:700, letterSpacing:"0.07em", padding:"8px",
  display:"flex", alignItems:"center", justifyContent:"center", gap:4 };

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

  // Check if server has a key configured
  useEffect(() => {
    api.health().then(d => setServerHasKey(d.has_server_key)).catch(() => {});
  }, []);

  // Load data after key is set
  useEffect(() => {
    if (apiKey === null) return; // not yet past gate
    Promise.all([api.getGames(), api.getStandings(), api.getProps()])
      .then(([g, s, p]) => { setGames(g.games); setStandings(s.standings); setProps(p.props); setDataLoaded(true); })
      .catch(console.error);
  }, [apiKey]);

  if (apiKey === "" && !serverHasKey) {
    // Check if server has key to skip gate
    return dataLoaded ? null : <ApiKeyGate serverHasKey={serverHasKey} onSubmit={k => setApiKey(k)} />;
  }
  if (!dataLoaded) return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"#080c18" }}>
      <Spinner /><span style={{ color:"rgba(255,255,255,0.4)", fontSize:12, marginLeft:10 }}>Loading...</span>
    </div>
  );

  const liveGames     = games.filter(g => g.status==="live");
  const upcomingGames = games.filter(g => g.status==="upcoming");
  const finalGames    = games.filter(g => g.status==="final");

  const handleAnalyze = async (gameId) => {
    setLoadingId(gameId);
    try {
      const data = await api.analyze(gameId, apiKey);
      setAnalyses(p => ({ ...p, [gameId]: data.analysis }));
    } catch(e) {
      setAnalyses(p => ({ ...p, [gameId]: `⚠️ ${e.message}` }));
    }
    setLoadingId(null);
  };

  const TABS = [
    { id:"live",      label:"🔴 LIVE",      badge: liveGames.length },
    { id:"upcoming",  label:"📅 TONIGHT",   badge: upcomingGames.length },
    { id:"props",     label:"🎯 PROPS",     badge: props.length },
    { id:"standings", label:"📊 STANDINGS"  },
    { id:"chat",      label:"💬 AI CHAT"    },
  ];

  return (
    <div style={{ minHeight:"100vh", background:"linear-gradient(160deg,#080c18 0%,#0b1525 60%,#08101e 100%)" }}>
      {/* Header */}
      <div style={{ borderBottom:"1px solid rgba(255,255,255,0.06)", padding:"0 20px" }}>
        <div style={{ maxWidth:960, margin:"0 auto", display:"flex", alignItems:"center", justifyContent:"space-between", height:58 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:24 }}>🏀</span>
            <span style={{ color:"#63ca8a", fontWeight:700, fontSize:17, letterSpacing:"0.07em" }}>NBA EDGE</span>
            <span style={{ color:"rgba(255,255,255,0.18)", fontSize:9, letterSpacing:"0.12em", marginLeft:2 }}>POWERED BY GEMINI</span>
          </div>
          <div style={{ color:"rgba(255,255,255,0.25)", fontSize:10 }}>Feb 19, 2026 · Live Data</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ borderBottom:"1px solid rgba(255,255,255,0.06)", padding:"0 20px", overflowX:"auto" }}>
        <div style={{ maxWidth:960, margin:"0 auto", display:"flex" }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              background:"transparent", border:"none",
              borderBottom: tab===t.id ? "2px solid #63ca8a" : "2px solid transparent",
              color: tab===t.id ? "#63ca8a" : "rgba(255,255,255,0.3)",
              padding:"14px 16px", fontSize:10, fontWeight:700, letterSpacing:"0.08em",
              whiteSpace:"nowrap", transition:"color 0.2s",
            }}>
              {t.label}{t.badge != null ? ` (${t.badge})` : ""}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth:960, margin:"0 auto", padding:"26px 20px" }}>
        {tab==="live" && (
          <div style={{ animation:"fadeUp 0.3s ease" }}>
            <SectionHeader color="#ff5050" title="LIVE GAMES" sub="Real-time scores · Click for Gemini live betting analysis" />
            <Grid>
              {liveGames.map(g => <GameCard key={g.id} game={g} onAnalyze={handleAnalyze} analysis={analyses[g.id]} loading={loadingId===g.id} />)}
            </Grid>
            {finalGames.length > 0 && <>
              <h3 style={{ color:"rgba(255,255,255,0.2)", fontSize:10, fontWeight:700, letterSpacing:"0.1em", margin:"28px 0 14px" }}>FINAL SCORES</h3>
              <Grid>{finalGames.map(g => <GameCard key={g.id} game={g} onAnalyze={handleAnalyze} analysis={analyses[g.id]} loading={loadingId===g.id} />)}</Grid>
            </>}
          </div>
        )}

        {tab==="upcoming" && (
          <div style={{ animation:"fadeUp 0.3s ease" }}>
            <SectionHeader color="#63ca8a" title="TONIGHT'S GAMES" sub="Win probabilities, spreads & moneylines — click for Gemini picks" />
            <Grid>{upcomingGames.map(g => <GameCard key={g.id} game={g} onAnalyze={handleAnalyze} analysis={analyses[g.id]} loading={loadingId===g.id} />)}</Grid>
          </div>
        )}

        {tab==="props" && (
          <div style={{ animation:"fadeUp 0.3s ease" }}>
            <SectionHeader color="#f5a623" title="PLAYER PROP PICKS" sub="AI-curated picks with confidence ratings" />
            <Grid minWidth="310px">{props.map((p,i) => <PropCard key={i} prop={p} />)}</Grid>
            <div style={{ marginTop:20, padding:"12px 16px", background:"rgba(245,166,35,0.05)",
              border:"1px solid rgba(245,166,35,0.18)", borderRadius:10, fontSize:10,
              color:"rgba(255,255,255,0.3)", textAlign:"center" }}>
              ⚠️ Props are for entertainment only. Always verify lines with your sportsbook before betting.
            </div>
          </div>
        )}

        {tab==="standings" && (
          <div style={{ animation:"fadeUp 0.3s ease" }}>
            <SectionHeader color="#8b9ff0" title="2025–26 STANDINGS" sub="Top 8 per conference" />
            <Grid minWidth="380px">
              {Object.entries(standings).map(([conf, teams]) => <StandingsTable key={conf} conf={conf} teams={teams} />)}
            </Grid>
          </div>
        )}

        {tab==="chat" && <ChatTab apiKey={apiKey} />}
      </div>
    </div>
  );
}

const Grid = ({ children, minWidth="290px" }) => (
  <div style={{ display:"grid", gap:14, gridTemplateColumns:`repeat(auto-fill,minmax(${minWidth},1fr))` }}>
    {children}
  </div>
);
