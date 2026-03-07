import { Router, Request, Response } from 'express';
import { db } from '../config/firebase';
import { authenticate, adminOnly } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

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

export default router;
