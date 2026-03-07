import { Router, Request, Response } from 'express';
import { db } from '../config/firebase';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { z } from 'zod';

const router = Router();
router.use(authenticate);

const createWagerSchema = z.object({
  opponentId: z.string().min(1),
  amountCents: z.number().int().positive(),
  platform: z.enum(['chesscom', 'playstrategy', 'bga']).default('chesscom'),
  gameType: z.string().optional(),
});

// Helper to enrich wager with user names
async function enrichWager(doc: FirebaseFirestore.DocumentSnapshot) {
  const w = doc.data()!;
  const [challengerDoc, opponentDoc] = await Promise.all([
    db.collection('dublplay_users').doc(w.challengerId).get(),
    db.collection('dublplay_users').doc(w.opponentId).get(),
  ]);
  const challenger = challengerDoc.data() || {};
  const opponent = opponentDoc.data() || {};

  // Get the platform-specific username for display
  const platform = w.platform || 'chesscom';
  const getPlatformUsername = (u: any) => {
    if (platform === 'playstrategy') return u.playStrategyUsername;
    if (platform === 'bga') return u.bgaUsername;
    return u.chessComUsername;
  };

  return {
    id: doc.id,
    ...w,
    challenger_name: challenger.displayName,
    challenger_chess_username: challenger.chessComUsername,
    challenger_platform_username: getPlatformUsername(challenger),
    opponent_name: opponent.displayName,
    opponent_chess_username: opponent.chessComUsername,
    opponent_platform_username: getPlatformUsername(opponent),
  };
}

// List my wagers
router.get('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const status = req.query.status as string | undefined;

  const asChallenger = await db.collection('dublplay_wagers').where('challengerId', '==', userId).get();
  const asOpponent = await db.collection('dublplay_wagers').where('opponentId', '==', userId).get();

  const allDocs = [...asChallenger.docs, ...asOpponent.docs];
  // Deduplicate (shouldn't happen but just in case)
  const seen = new Set<string>();
  const uniqueDocs = allDocs.filter(d => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });

  let filtered = uniqueDocs;
  if (status) {
    const statuses = status.split(',');
    filtered = uniqueDocs.filter(d => statuses.includes(d.data().status));
  }

  const wagers = await Promise.all(filtered.map(enrichWager));
  wagers.sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json(wagers);
});

// Get single wager
router.get('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const doc = await db.collection('dublplay_wagers').doc(String(req.params.id)).get();

  if (!doc.exists) throw new AppError(404, 'Wager not found');
  const w = doc.data()!;
  if (w.challengerId !== userId && w.opponentId !== userId) {
    throw new AppError(404, 'Wager not found');
  }

  res.json(await enrichWager(doc));
});

// Create wager challenge
router.post('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const body = createWagerSchema.parse(req.body);

  if (body.opponentId === userId) {
    throw new AppError(400, 'Cannot wager against yourself');
  }

  // Verify opponent is a friend
  const f1 = await db.collection('dublplay_friendships')
    .where('requesterId', '==', userId)
    .where('addresseeId', '==', body.opponentId)
    .where('status', '==', 'accepted')
    .limit(1).get();
  const f2 = await db.collection('dublplay_friendships')
    .where('requesterId', '==', body.opponentId)
    .where('addresseeId', '==', userId)
    .where('status', '==', 'accepted')
    .limit(1).get();

  if (f1.empty && f2.empty) {
    throw new AppError(400, 'You can only wager against friends');
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  const ref = db.collection('dublplay_wagers').doc();
  const data = {
    challengerId: userId,
    opponentId: body.opponentId,
    amountCents: body.amountCents,
    platform: body.platform || 'chesscom',
    gameType: body.gameType || null,
    status: 'pending_acceptance',
    challengerPaid: false,
    opponentPaid: false,
    challengerPaymentIntentId: null,
    opponentPaymentIntentId: null,
    result: null,
    winnerId: null,
    gameUrl: null,
    chessComGameId: null,
    settledAt: null,
    payoutTransferId: null,
    createdAt: now,
    updatedAt: now,
    expiresAt,
  };

  await ref.set(data);
  res.status(201).json({ id: ref.id, ...data });
});

// Accept wager
router.post('/:id/accept', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const ref = db.collection('dublplay_wagers').doc(String(req.params.id));
  const doc = await ref.get();

  if (!doc.exists) throw new AppError(404, 'Wager not found or cannot be accepted');
  const w = doc.data()!;
  if (w.opponentId !== userId || w.status !== 'pending_acceptance') {
    throw new AppError(404, 'Wager not found or cannot be accepted');
  }

  await ref.update({ status: 'pending_payment', updatedAt: new Date().toISOString() });
  res.json({ id: doc.id, ...w, status: 'pending_payment' });
});

// Decline wager
router.post('/:id/decline', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const ref = db.collection('dublplay_wagers').doc(String(req.params.id));
  const doc = await ref.get();

  if (!doc.exists) throw new AppError(404, 'Wager not found or cannot be declined');
  const w = doc.data()!;
  if (w.opponentId !== userId || w.status !== 'pending_acceptance') {
    throw new AppError(404, 'Wager not found or cannot be declined');
  }

  await ref.update({ status: 'cancelled', updatedAt: new Date().toISOString() });
  res.json({ id: doc.id, ...w, status: 'cancelled' });
});

// Cancel wager (challenger only, before acceptance)
router.post('/:id/cancel', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const ref = db.collection('dublplay_wagers').doc(String(req.params.id));
  const doc = await ref.get();

  if (!doc.exists) throw new AppError(404, 'Wager not found or cannot be cancelled');
  const w = doc.data()!;
  if (w.challengerId !== userId || w.status !== 'pending_acceptance') {
    throw new AppError(404, 'Wager not found or cannot be cancelled');
  }

  await ref.update({ status: 'cancelled', updatedAt: new Date().toISOString() });
  res.json({ id: doc.id, ...w, status: 'cancelled' });
});

export default router;
