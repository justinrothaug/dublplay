import { Router, Request, Response } from 'express';
import { db } from '../config/firebase';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { z } from 'zod';
import { pollSingleWager } from '../jobs/pollGames';

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

  // Check for existing active wager between these two users
  const activeStatuses = ['pending_acceptance', 'active', 'both_paid'];
  const existingAsChallenger = await db.collection('dublplay_wagers')
    .where('challengerId', '==', userId)
    .where('opponentId', '==', body.opponentId)
    .get();
  const existingAsOpponent = await db.collection('dublplay_wagers')
    .where('challengerId', '==', body.opponentId)
    .where('opponentId', '==', userId)
    .get();

  const hasActive = [...existingAsChallenger.docs, ...existingAsOpponent.docs]
    .some(d => activeStatuses.includes(d.data().status));
  if (hasActive) {
    throw new AppError(409, 'You already have an active wager with this friend. Finish or cancel it first.');
  }

  // Deduct from challenger's wallet immediately
  const userRef = db.collection('dublplay_users').doc(userId);
  const userDoc = await userRef.get();
  const userData = userDoc.data()!;
  const balance = userData.walletBalanceCents || 0;
  if (balance < body.amountCents) {
    throw new AppError(400, `Insufficient balance. You have $${(balance / 100).toFixed(2)} but need $${(body.amountCents / 100).toFixed(2)}. Deposit funds first.`);
  }
  await userRef.update({ walletBalanceCents: balance - body.amountCents, updatedAt: new Date().toISOString() });

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
    challengerPaid: true,
    opponentPaid: false,
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

  // Record transaction
  await db.collection('dublplay_transactions').doc().set({
    wagerId: ref.id, userId, type: 'bet_payment', amountCents: body.amountCents, status: 'completed', createdAt: now,
  });

  res.status(201).json({ id: ref.id, ...data });
});

// Accept wager — deducts from opponent's wallet and activates immediately
router.post('/:id/accept', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const ref = db.collection('dublplay_wagers').doc(String(req.params.id));
  const doc = await ref.get();

  if (!doc.exists) throw new AppError(404, 'Wager not found or cannot be accepted');
  const w = doc.data()!;
  if (w.opponentId !== userId || w.status !== 'pending_acceptance') {
    throw new AppError(404, 'Wager not found or cannot be accepted');
  }

  // Deduct from opponent's wallet
  const userRef = db.collection('dublplay_users').doc(userId);
  const userDoc = await userRef.get();
  const userData = userDoc.data()!;
  const balance = userData.walletBalanceCents || 0;
  if (balance < w.amountCents) {
    throw new AppError(400, `Insufficient balance. You have $${(balance / 100).toFixed(2)} but need $${(w.amountCents / 100).toFixed(2)}. Deposit funds first.`);
  }
  const now = new Date().toISOString();
  await userRef.update({ walletBalanceCents: balance - w.amountCents, updatedAt: now });

  // Both paid — go straight to active
  await ref.update({ status: 'active', opponentPaid: true, updatedAt: now });

  // Record transaction
  await db.collection('dublplay_transactions').doc().set({
    wagerId: doc.id, userId, type: 'bet_payment', amountCents: w.amountCents, status: 'completed', createdAt: now,
  });

  res.json({ id: doc.id, ...w, status: 'active', opponentPaid: true });
});

// Decline wager — refund challenger
router.post('/:id/decline', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const ref = db.collection('dublplay_wagers').doc(String(req.params.id));
  const doc = await ref.get();

  if (!doc.exists) throw new AppError(404, 'Wager not found or cannot be declined');
  const w = doc.data()!;
  if (w.opponentId !== userId || w.status !== 'pending_acceptance') {
    throw new AppError(404, 'Wager not found or cannot be declined');
  }

  // Refund challenger
  if (w.challengerPaid) {
    const challengerRef = db.collection('dublplay_users').doc(w.challengerId);
    const challengerDoc = await challengerRef.get();
    const challengerBalance = challengerDoc.data()?.walletBalanceCents || 0;
    await challengerRef.update({ walletBalanceCents: challengerBalance + w.amountCents, updatedAt: new Date().toISOString() });
  }

  // Delete bet_payment transactions for this wager (cancelled = never happened)
  const txSnap = await db.collection('dublplay_transactions').where('wagerId', '==', doc.id).get();
  await Promise.all(txSnap.docs.map(d => d.ref.delete()));

  await ref.delete();
  res.json({ deleted: true });
});

// Cancel wager — before acceptance: instant delete. After acceptance: request mutual cancel.
router.post('/:id/cancel', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const ref = db.collection('dublplay_wagers').doc(String(req.params.id));
  const doc = await ref.get();

  if (!doc.exists) throw new AppError(404, 'Wager not found');
  const w = doc.data()!;
  if (w.challengerId !== userId && w.opponentId !== userId) {
    throw new AppError(404, 'Wager not found');
  }

  // Before acceptance: either side can cancel instantly, refund challenger
  if (w.status === 'pending_acceptance') {
    if (w.challengerPaid) {
      const challengerRef = db.collection('dublplay_users').doc(w.challengerId);
      const challengerDoc = await challengerRef.get();
      const challengerBalance = challengerDoc.data()?.walletBalanceCents || 0;
      await challengerRef.update({ walletBalanceCents: challengerBalance + w.amountCents, updatedAt: new Date().toISOString() });
    }
    // Delete bet_payment transactions (cancelled = never happened)
    const txSnap = await db.collection('dublplay_transactions').where('wagerId', '==', doc.id).get();
    await Promise.all(txSnap.docs.map(d => d.ref.delete()));
    await ref.delete();
    return res.json({ deleted: true });
  }

  // After acceptance: either side can request cancellation
  const activeStatuses = ['active', 'both_paid'];
  if (!activeStatuses.includes(w.status)) {
    throw new AppError(400, 'This wager cannot be cancelled');
  }

  // If the OTHER person already requested cancellation, this confirms it — refund both and delete
  if (w.cancelRequestedBy && w.cancelRequestedBy !== userId) {
    const [challengerDoc, opponentDoc] = await Promise.all([
      db.collection('dublplay_users').doc(w.challengerId).get(),
      db.collection('dublplay_users').doc(w.opponentId).get(),
    ]);
    const challengerBalance = challengerDoc.data()?.walletBalanceCents || 0;
    const opponentBalance = opponentDoc.data()?.walletBalanceCents || 0;
    const now = new Date().toISOString();
    await Promise.all([
      db.collection('dublplay_users').doc(w.challengerId).update({ walletBalanceCents: challengerBalance + w.amountCents, updatedAt: now }),
      db.collection('dublplay_users').doc(w.opponentId).update({ walletBalanceCents: opponentBalance + w.amountCents, updatedAt: now }),
    ]);
    // Delete all transactions for this wager (cancelled = never happened)
    const txSnap = await db.collection('dublplay_transactions').where('wagerId', '==', doc.id).get();
    await Promise.all(txSnap.docs.map(d => d.ref.delete()));
    await ref.delete();
    return res.json({ deleted: true });
  }

  // Otherwise, request cancellation
  if (w.cancelRequestedBy === userId) {
    throw new AppError(400, 'You already requested cancellation');
  }

  await ref.update({ cancelRequestedBy: userId, updatedAt: new Date().toISOString() });
  res.json({ id: doc.id, ...w, cancelRequestedBy: userId });
});

// Mark wager as playing (user clicked Play Now)
router.post('/:id/playing', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const ref = db.collection('dublplay_wagers').doc(String(req.params.id));
  const doc = await ref.get();

  if (!doc.exists) throw new AppError(404, 'Wager not found');
  const w = doc.data()!;
  if (w.challengerId !== userId && w.opponentId !== userId) {
    throw new AppError(404, 'Wager not found');
  }
  if (w.status !== 'active') {
    throw new AppError(400, 'Wager is not active');
  }

  const isChallenger = w.challengerId === userId;
  const updateData: Record<string, any> = { gameStarted: true, updatedAt: new Date().toISOString() };
  if (isChallenger) {
    updateData.challengerPlaying = true;
  } else {
    updateData.opponentPlaying = true;
  }

  await ref.update(updateData);
  res.json({ id: doc.id, ...w, ...updateData });
});

// Check for game result now (user-triggered)
router.post('/:id/check-result', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const ref = db.collection('dublplay_wagers').doc(String(req.params.id));
  const doc = await ref.get();

  if (!doc.exists) throw new AppError(404, 'Wager not found');
  const w = doc.data()!;
  if (w.challengerId !== userId && w.opponentId !== userId) {
    throw new AppError(404, 'Wager not found');
  }
  if (w.status !== 'active') {
    throw new AppError(400, 'Wager is not active');
  }

  const settled = await pollSingleWager(doc);
  if (settled) {
    const updated = await ref.get();
    res.json(await enrichWager(updated));
  } else {
    res.json({ checked: true, settled: false, message: 'No completed game found yet' });
  }
});

export default router;
