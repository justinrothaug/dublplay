// Board Game Arena integration
// Authenticates via programmatic login (BGA_EMAIL + BGA_PASSWORD env vars)
// Falls back to BGA_SESSION_COOKIE if login credentials not set.

const BGA_BASE = 'https://en.boardgamearena.com';

export interface BGATableResult {
  table_id: string;
  game_name: string;
  players: Record<string, BGAPlayerResult>;
  end: number; // unix timestamp
  gamestart: string;
  scores: Record<string, string>;
}

interface BGAPlayerResult {
  player_id: string;
  fullname: string;
  rank: number;
  score: string;
}

const bgaIdCache = new Map<string, string>();

// Session management — auto-login when cookies expire
let sessionCookies: string | null = null;
let loginInProgress: Promise<boolean> | null = null;

async function bgaLogin(): Promise<boolean> {
  const email = process.env.BGA_EMAIL;
  const password = process.env.BGA_PASSWORD;
  if (!email || !password) return false;

  try {
    console.log('BGA: Logging in...');
    // Step 1: GET login page to get CSRF token (login is on boardgamearena.com, not en. subdomain)
    const LOGIN_BASE = 'https://boardgamearena.com';
    const loginPage = await fetch(`${LOGIN_BASE}/account`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      redirect: 'follow',
    });
    const html = await loginPage.text();
    const csrfMatch = html.match(/id="csrf_token"[^>]*value="([^"]+)"/i)
      || html.match(/name="csrf_token"[^>]*value="([^"]+)"/i)
      || html.match(/value="([^"]+)"[^>]*id="csrf_token"/i)
      || html.match(/value="([^"]+)"[^>]*name="csrf_token"/i);

    // Collect cookies from login page
    const pageCookies = loginPage.headers.getSetCookie?.() || [];
    const cookieJar: Record<string, string> = {};
    for (const c of pageCookies) {
      const [kv] = c.split(';');
      const [k, v] = kv.split('=');
      if (k && v) cookieJar[k.trim()] = v.trim();
    }

    // Step 2: POST login
    const formData = new URLSearchParams();
    formData.set('email', email);
    formData.set('password', password);
    if (csrfMatch) formData.set('csrf_token', csrfMatch[1]);
    formData.set('form_id', 'loginform');

    const cookieHeader = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');

    const loginRes = await fetch(`${LOGIN_BASE}/account/account/login.html`, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieHeader,
      },
      body: formData.toString(),
      redirect: 'manual',
    });

    // Collect all cookies from response
    const resCookies = loginRes.headers.getSetCookie?.() || [];
    for (const c of resCookies) {
      const [kv] = c.split(';');
      const [k, v] = kv.split('=');
      if (k && v) cookieJar[k.trim()] = v.trim();
    }

    sessionCookies = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
    console.log(`BGA: Login response status ${loginRes.status}, got ${Object.keys(cookieJar).length} cookies`);

    // Verify login worked by checking a simple endpoint
    const checkRes = await fetch(`${BGA_BASE}/player`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': sessionCookies },
      redirect: 'follow',
    });
    const checkText = await checkRes.text();
    const loggedIn = !checkText.includes('"is_visitor":1') && !checkText.includes('"id":"0"');
    if (loggedIn) {
      console.log('BGA: Login successful');
    } else {
      console.error('BGA: Login failed — still visitor');
      sessionCookies = null;
    }
    return loggedIn;
  } catch (err: any) {
    console.error('BGA: Login error:', err.message);
    return false;
  }
}

async function ensureSession(): Promise<boolean> {
  if (sessionCookies) return true;
  if (process.env.BGA_SESSION_COOKIE) {
    sessionCookies = process.env.BGA_SESSION_COOKIE;
    return true;
  }
  if (loginInProgress) return loginInProgress;
  loginInProgress = bgaLogin().finally(() => { loginInProgress = null; });
  return loginInProgress;
}

async function refreshSession(): Promise<boolean> {
  sessionCookies = null;
  if (process.env.BGA_EMAIL && process.env.BGA_PASSWORD) {
    loginInProgress = bgaLogin().finally(() => { loginInProgress = null; });
    return loginInProgress;
  }
  return false;
}

function getHeaders(): Record<string, string> {
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ...(sessionCookies ? { 'Cookie': sessionCookies } : {}),
  };
}

function hasCookie(): boolean {
  return !!sessionCookies || !!process.env.BGA_SESSION_COOKIE || !!(process.env.BGA_EMAIL && process.env.BGA_PASSWORD);
}

// Resolve BGA username to numeric player ID
export async function resolvePlayerId(bgaUsername: string): Promise<string | null> {
  const decoded = decodeURIComponent(bgaUsername).trim();
  const lower = decoded.toLowerCase();
  const cached = bgaIdCache.get(lower);
  if (cached) return cached;

  if (!hasCookie()) {
    console.warn('BGA: No credentials or cookies configured');
    return null;
  }

  await ensureSession();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(
        `${BGA_BASE}/player/player/findPlayer.html?q=${encodeURIComponent(decoded)}&start=0&count=5`,
        { headers: getHeaders(), redirect: 'follow' },
      );
      if (!res.ok) return null;
      const text = await res.text();
      let data: any;
      try { data = JSON.parse(text); } catch { return null; }
      if (data.code === 806 || (data.status === '0' && data.error?.includes('session'))) {
        console.warn('BGA: Session expired during findPlayer, re-logging in...');
        const ok = await refreshSession();
        if (!ok) return null;
        continue;
      }
      if (data.status === '0' || data.error) {
        console.error(`BGA: findPlayer error: ${data.error}`);
        return null;
      }

      const items = data.data?.items || data.items || [];
      for (const item of items) {
        if ((item.fullname || item.name || '').toLowerCase() === lower) {
          const id = String(item.id);
          bgaIdCache.set(lower, id);
          return id;
        }
      }
      if (items.length > 0) {
        const id = String(items[0].id);
        bgaIdCache.set(lower, id);
        return id;
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

// Fetch finished games for a player
export async function fetchRecentGames(
  bgaPlayerId: string,
  opponentId?: string,
): Promise<BGATableResult[]> {
  if (!hasCookie()) return [];

  await ensureSession();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const params = new URLSearchParams({
        player: bgaPlayerId,
        finished: '1',
        updateStats: '0',
      });
      if (opponentId) params.set('opponent_id', opponentId);

      const url = `${BGA_BASE}/gamestats/gamestats/getGames.html?${params}`;
      console.log(`BGA: Fetching ${url}`);
      const res = await fetch(url, { headers: getHeaders(), redirect: 'follow' });
      if (!res.ok) return [];

      const text = await res.text();
      let data: any;
      try { data = JSON.parse(text); } catch { return []; }

      if (data.code === 806 || (data.status === '0' && data.error?.includes('session'))) {
        console.warn('BGA: Session expired during getGames, re-logging in...');
        const ok = await refreshSession();
        if (!ok) return [];
        continue;
      }

      if (data.status === '0' || data.error) {
        console.error(`BGA: getGames error: ${data.error} (code ${data.code})`);
        return [];
      }

      let tables = data.data?.tables;
      if (tables && !Array.isArray(tables)) tables = Object.values(tables);
      console.log(`BGA: Got ${tables?.length || 0} tables`);
      return tables || [];
    } catch {
      return [];
    }
  }
  return [];
}

export function findMatchingGame(
  tables: BGATableResult[],
  player1Id: string,
  player2Id: string,
  afterTimestamp: number,
): BGATableResult | null {
  for (const table of tables) {
    if (table.end < afterTimestamp) continue;
    const playerIds = Object.keys(table.players || {});
    if (playerIds.includes(player1Id) && playerIds.includes(player2Id)) {
      return table;
    }
  }
  return null;
}

export function getResultForChallenger(
  table: BGATableResult,
  challengerId: string,
): 'challenger_win' | 'opponent_win' | 'draw' {
  const challenger = table.players?.[challengerId];
  if (!challenger) return 'draw';

  if (challenger.rank === 1) {
    const rank1Count = Object.values(table.players).filter((p) => p.rank === 1).length;
    if (rank1Count > 1) return 'draw';
    return 'challenger_win';
  }
  return 'opponent_win';
}

// Fast 2-player games on BGA
export const BGA_GAMES: Record<string, string> = {
  checkers: 'Checkers',
  connect4: 'Connect 4',
  battleship: 'Battleship',
  sevenwonders: 'Seven Wonders Duel',
  patchwork: 'Patchwork',
  jaipur: 'Jaipur',
  hex: 'Hex',
};
