import express from 'express';
import cors from 'cors';
import path from 'path';
import cron from 'node-cron';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { env } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import authRoutes from './routes/auth.routes';
import friendsRoutes from './routes/friends.routes';
import wagersRoutes from './routes/wagers.routes';
import stripeRoutes from './routes/stripe.routes';
import statsRoutes from './routes/stats.routes';
import { pollActiveWagers } from './jobs/pollGames';
import { expireStaleWagers } from './jobs/expireWagers';

const app = express();
app.set('trust proxy', 1);

// CORS
app.use(cors({ origin: true, credentials: true }));

// Stripe webhook needs raw body — mount before json middleware
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());

// ── Games API routes (Express) ──────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/wagers', wagersRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/stats', statsRoutes);

// Games health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'dublplay', timestamp: new Date().toISOString() });
});

// Apple Pay domain verification
app.get('/.well-known/apple-developer-merchantid-domain-association', (_req, res) => {
  const content = process.env.APPLE_PAY_DOMAIN_VERIFICATION || '';
  if (content) {
    res.type('text/plain').send(content);
  } else {
    res.status(404).send('Not configured');
  }
});

// ── Sports API proxy (Python/FastAPI on internal port 8000) ─────────────────
const PYTHON_BACKEND = process.env.PYTHON_BACKEND_URL || 'http://127.0.0.1:8000';

const sportsProxy = createProxyMiddleware({
  target: PYTHON_BACKEND,
  changeOrigin: true,
});

// Proxy sports-specific routes to Python backend
app.use('/api/games', sportsProxy);
app.use('/api/picks', sportsProxy);
app.use('/api/props', sportsProxy);
app.use('/api/injuries', sportsProxy);
app.use('/api/standings', sportsProxy);
app.use('/api/analyze', sportsProxy);
app.use('/api/chat', sportsProxy);
app.use('/api/bet', sportsProxy);
app.use('/api/bets', sportsProxy);
app.use('/api/parlay', sportsProxy);
app.use('/api/debug', sportsProxy);
app.use('/health', sportsProxy);

// ── Serve frontend static files ─────────────────────────────────────────────
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// Serve static assets (loading.png etc.)
const userStaticDir = path.join(__dirname, 'user_static');
app.use('/static', express.static(userStaticDir));

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Error handler
app.use(errorHandler);

// ── Cron jobs ───────────────────────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  try { await pollActiveWagers(); } catch (err) { console.error('Poll cron error:', err); }
});

cron.schedule('*/15 * * * *', async () => {
  try { await expireStaleWagers(); } catch (err) { console.error('Expire cron error:', err); }
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(env.PORT, () => {
  console.log(`DublPlay server running on port ${env.PORT}`);
  console.log(`Sports API proxy → ${PYTHON_BACKEND}`);
});
