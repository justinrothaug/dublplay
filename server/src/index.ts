import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
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

// CORS — allow frontend origins
app.use(cors({
  origin: true,
  credentials: true,
}));

// Stripe webhook needs raw body — mount before json middleware
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/wagers', wagersRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/stats', statsRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Apple Pay domain verification (Stripe serves the file content via env)
app.get('/.well-known/apple-developer-merchantid-domain-association', (_req, res) => {
  const content = process.env.APPLE_PAY_DOMAIN_VERIFICATION || '';
  if (content) {
    res.type('text/plain').send(content);
  } else {
    res.status(404).send('Not configured');
  }
});

// Error handler
app.use(errorHandler);

// Cron: poll Chess.com every 60 seconds for active wagers
cron.schedule('* * * * *', async () => {
  try {
    await pollActiveWagers();
  } catch (err) {
    console.error('Poll cron error:', err);
  }
});

// Cron: expire stale wagers every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  try {
    await expireStaleWagers();
  } catch (err) {
    console.error('Expire cron error:', err);
  }
});

app.listen(env.PORT, () => {
  console.log(`DublPlay server running on port ${env.PORT}`);
});
