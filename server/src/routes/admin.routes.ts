import { Router, Request, Response } from 'express';
import { db } from '../config/firebase';
import { authenticate, adminOnly } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import * as bga from '../services/bga.service';

const router = Router();

// All admin routes require auth + admin
router.use(authenticate, adminOnly);

// List all users (with optional search)
router.get('/users', async (req: Request, res: Response) => {
  const search = (req.query.search as string || '').toLowerCase().trim();
  const snapshot = await db.collection('dublplay_users').get();

  let users = snapshot.docs.map(doc => {
    const d = doc.data();
    return {
      id: doc.id,
      email: d.email || '',
      displayName: d.displayName || '',
      chessComUsername: d.chessComUsername || '',
      venmoUsername: d.venmoUsername || null,
      walletBalanceCents: d.walletBalanceCents || 0,
      admin: !!d.admin,
      createdAt: d.createdAt || '',
    };
  });

  if (search) {
    users = users.filter(u =>
      u.email.toLowerCase().includes(search) ||
      u.displayName.toLowerCase().includes(search) ||
      u.chessComUsername.toLowerCase().includes(search) ||
      (u.venmoUsername || '').toLowerCase().includes(search)
    );
  }

  // Sort by most recent
  users.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));

  res.json({ users });
});

// Update a user's wallet balance
router.put('/users/:id/balance', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { balanceCents } = req.body;

  if (typeof balanceCents !== 'number' || balanceCents < 0) {
    throw new AppError(400, 'balanceCents must be a non-negative number');
  }

  const userRef = db.collection('dublplay_users').doc(id);
  const userDoc = await userRef.get();
  if (!userDoc.exists) throw new AppError(404, 'User not found');

  await userRef.update({
    walletBalanceCents: balanceCents,
    updatedAt: new Date().toISOString(),
  });

  res.json({ success: true, balanceCents });
});

// List pending payout requests
router.get('/payouts', async (req: Request, res: Response) => {
  const status = (req.query.status as string) || 'pending';
  const snapshot = await db.collection('dublplay_transactions')
    .where('type', '==', 'payout_request')
    .where('status', '==', status)
    .get();

  const payouts = await Promise.all(snapshot.docs.map(async (doc) => {
    const d = doc.data();
    // Get user display name
    let userName = '';
    try {
      const userDoc = await db.collection('dublplay_users').doc(d.userId).get();
      userName = userDoc.data()?.displayName || userDoc.data()?.email || '';
    } catch {}
    return {
      id: doc.id,
      userId: d.userId,
      userName,
      venmoUsername: d.venmoUsername || '',
      amountCents: d.amountCents,
      status: d.status,
      createdAt: d.createdAt,
    };
  }));

  // Sort newest first
  payouts.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));

  res.json({ payouts });
});

// Mark a payout as paid
router.put('/payouts/:id/paid', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const txRef = db.collection('dublplay_transactions').doc(id);
  const txDoc = await txRef.get();
  if (!txDoc.exists) throw new AppError(404, 'Payout request not found');

  const tx = txDoc.data()!;
  if (tx.type !== 'payout_request') throw new AppError(400, 'Not a payout request');
  if (tx.status === 'completed') throw new AppError(400, 'Already marked as paid');

  await txRef.update({
    status: 'completed',
    paidAt: new Date().toISOString(),
    paidBy: req.user!.userId,
  });

  res.json({ success: true });
});

// Debug BGA API chain — tests each step and returns results
router.get('/debug-bga/:wagerId', async (req: Request, res: Response) => {
  const steps: Record<string, any> = {};

  try {
    // Step 1: Check env var
    const hasCookie = !!process.env.BGA_SESSION_COOKIE;
    steps.cookie = { set: hasCookie, length: process.env.BGA_SESSION_COOKIE?.length || 0 };

    // Step 2: Get wager
    const wagerDoc = await db.collection('dublplay_wagers').doc(req.params.id).get();
    if (!wagerDoc.exists) { res.json({ error: 'Wager not found', steps }); return; }
    const wager = wagerDoc.data()!;
    steps.wager = { platform: wager.platform, status: wager.status, game: wager.game, createdAt: wager.createdAt };

    // Step 3: Get users
    const [cDoc, oDoc] = await Promise.all([
      db.collection('dublplay_users').doc(wager.challengerId).get(),
      db.collection('dublplay_users').doc(wager.opponentId).get(),
    ]);
    const cData = cDoc.data()!;
    const oData = oDoc.data()!;
    steps.users = {
      challenger: { bgaUsername: cData.bgaUsername, bgaPlayerId: cData.bgaPlayerId || null },
      opponent: { bgaUsername: oData.bgaUsername, bgaPlayerId: oData.bgaPlayerId || null },
    };

    // Step 4: Resolve player IDs
    const cBga = cData.bgaUsername;
    const oBga = oData.bgaUsername;
    if (!cBga || !oBga) { res.json({ error: 'Missing BGA usernames', steps }); return; }

    let cId = cData.bgaPlayerId || null;
    let oId = oData.bgaPlayerId || null;

    if (!cId) {
      try { cId = await bga.resolvePlayerId(cBga); steps.resolveChallenger = { success: !!cId, id: cId }; }
      catch (e: any) { steps.resolveChallenger = { error: e.message }; }
    } else {
      steps.resolveChallenger = { cached: true, id: cId };
    }

    if (!oId) {
      try { oId = await bga.resolvePlayerId(oBga); steps.resolveOpponent = { success: !!oId, id: oId }; }
      catch (e: any) { steps.resolveOpponent = { error: e.message }; }
    } else {
      steps.resolveOpponent = { cached: true, id: oId };
    }

    if (!cId || !oId) { res.json({ error: 'Could not resolve BGA IDs', steps }); return; }

    // Step 5: Fetch games
    try {
      const tables = await bga.fetchRecentGames(cId, oId);
      steps.fetchGames = { count: tables.length, tables: tables.slice(0, 5).map(t => ({
        table_id: t.table_id, game_name: t.game_name, end: t.end,
        players: Object.entries(t.players || {}).map(([id, p]) => ({ id, name: p.fullname, rank: p.rank, score: p.score })),
      }))};

      // Step 6: Find matching game
      const afterTs = Math.floor(new Date(wager.createdAt).getTime() / 1000);
      steps.afterTimestamp = { value: afterTs, date: new Date(afterTs * 1000).toISOString() };

      const match = bga.findMatchingGame(tables, cId, oId, afterTs);
      if (match) {
        const result = bga.getResultForChallenger(match, cId);
        steps.match = { found: true, table_id: match.table_id, game_name: match.game_name, end: match.end, result };
      } else {
        steps.match = { found: false };
      }
    } catch (e: any) {
      steps.fetchGames = { error: e.message };
    }

    res.json({ steps });
  } catch (e: any) {
    steps.fatal = e.message;
    res.json({ steps });
  }
});

export default router;
