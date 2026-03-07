import { Router, Request, Response } from 'express';
import { db } from '../config/firebase';
import { stripe } from '../config/stripe';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { sendPayoutRequestEmail } from '../utils/email';

const router = Router();

// Get transaction history
router.get('/history', authenticate, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  let snapshot;
  try {
    snapshot = await db.collection('dublplay_transactions')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
  } catch (err: any) {
    // Fallback: query without orderBy if composite index doesn't exist yet
    if (err.code === 9) {
      console.warn('Firestore composite index missing for transactions. Falling back to unordered query.');
      snapshot = await db.collection('dublplay_transactions')
        .where('userId', '==', userId)
        .limit(50)
        .get();
    } else {
      throw err;
    }
  }

  const transactions = snapshot.docs.map((doc) => {
    const t = doc.data();
    return {
      id: doc.id,
      type: t.type,
      amountCents: t.amountCents,
      status: t.status,
      createdAt: t.createdAt,
      wagerId: t.wagerId || null,
    };
  });
  // Sort in JS if we used the fallback
  transactions.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  // Enrich wager-related transactions with opponent name and game info
  const wagerIds: string[] = [...new Set(transactions.filter((t: any) => t.wagerId).map((t: any) => t.wagerId as string))];
  const wagerMap: Record<string, any> = {};
  for (const wid of wagerIds) {
    try {
      const wDoc = await db.collection('dublplay_wagers').doc(wid).get();
      if (wDoc.exists) wagerMap[wid] = wDoc.data();
    } catch {}
  }

  // Resolve unique user IDs for opponent names
  const opponentIds = new Set<string>();
  for (const t of transactions) {
    if (t.wagerId && wagerMap[t.wagerId]) {
      const w = wagerMap[t.wagerId];
      const opponentId = w.challengerId === userId ? w.opponentId : w.challengerId;
      opponentIds.add(opponentId);
    }
  }
  const userNames: Record<string, string> = {};
  for (const uid of opponentIds) {
    try {
      const uDoc = await db.collection('dublplay_users').doc(uid).get();
      if (uDoc.exists) userNames[uid] = uDoc.data()?.displayName || uDoc.data()?.email || '';
    } catch {}
  }

  const enriched = transactions.map(t => {
    if (t.wagerId && wagerMap[t.wagerId]) {
      const w = wagerMap[t.wagerId];
      const opponentId = w.challengerId === userId ? w.opponentId : w.challengerId;
      return {
        ...t,
        opponentName: userNames[opponentId] || null,
        game: w.gameType || null,
        platform: w.platform || null,
        wagerStatus: w.status || null,
        winnerId: w.winnerId || null,
      };
    }
    return t;
  });

  res.json(enriched);
});

// Get wallet balance
router.get('/balance', authenticate, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const userDoc = await db.collection('dublplay_users').doc(userId).get();
  if (!userDoc.exists) throw new AppError(404, 'User not found');
  const data = userDoc.data()!;
  res.json({ balanceCents: data.walletBalanceCents || 0 });
});

// Deposit funds — creates a PaymentIntent for the given amount
router.post('/deposit', authenticate, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { amountCents } = req.body;

  if (!amountCents || amountCents < 100) {
    throw new AppError(400, 'Minimum deposit is $1.00');
  }
  if (amountCents > 50000) {
    throw new AppError(400, 'Maximum deposit is $500.00');
  }

  const userRef = db.collection('dublplay_users').doc(userId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) throw new AppError(404, 'User not found');
  const user = userDoc.data()!;

  // Get or create Stripe customer
  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { userId },
    });
    customerId = customer.id;
    await userRef.update({ stripeCustomerId: customerId });
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    customer: customerId,
    payment_method_types: ['card'],
    metadata: {
      type: 'wallet_deposit',
      userId,
    },
  });

  res.json({ clientSecret: paymentIntent.client_secret });
});

// Withdraw funds — transfer to user's bank (requires Connect onboarding)
router.post('/withdraw', authenticate, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { amountCents } = req.body;

  const userRef = db.collection('dublplay_users').doc(userId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) throw new AppError(404, 'User not found');
  const user = userDoc.data()!;

  const balance = user.walletBalanceCents || 0;
  if (!amountCents || amountCents < 100) {
    throw new AppError(400, 'Minimum withdrawal is $1.00');
  }
  if (amountCents > balance) {
    throw new AppError(400, 'Insufficient balance');
  }

  if (!user.stripeConnectAccountId || !user.stripeOnboardingComplete) {
    throw new AppError(400, 'Set up payouts first via Stripe Connect');
  }

  // Transfer to connected account
  const transfer = await stripe.transfers.create({
    amount: amountCents,
    currency: 'usd',
    destination: user.stripeConnectAccountId,
    metadata: { userId, type: 'wallet_withdrawal' },
  });

  // Deduct balance
  await userRef.update({
    walletBalanceCents: balance - amountCents,
    updatedAt: new Date().toISOString(),
  });

  // Record transaction
  await db.collection('dublplay_transactions').doc().set({
    userId,
    type: 'withdrawal',
    amountCents,
    stripeTransferId: transfer.id,
    status: 'completed',
    createdAt: new Date().toISOString(),
  });

  res.json({ success: true, newBalanceCents: balance - amountCents });
});

// Request payout via Venmo
router.post('/request-payout', authenticate, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { amountCents } = req.body;

  const userRef = db.collection('dublplay_users').doc(userId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) throw new AppError(404, 'User not found');
  const user = userDoc.data()!;

  if (!user.venmoUsername) {
    throw new AppError(400, 'Set your Venmo username first');
  }

  const balance = user.walletBalanceCents || 0;
  if (!amountCents || amountCents < 100) {
    throw new AppError(400, 'Minimum payout is $1.00');
  }
  if (amountCents > balance) {
    throw new AppError(400, 'Insufficient balance');
  }

  // Deduct balance
  await userRef.update({
    walletBalanceCents: balance - amountCents,
    updatedAt: new Date().toISOString(),
  });

  // Record payout request
  await db.collection('dublplay_transactions').doc().set({
    userId,
    type: 'payout_request',
    amountCents,
    venmoUsername: user.venmoUsername,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });

  // Email admin
  const displayName = user.displayName || user.email || userId;
  sendPayoutRequestEmail(displayName, user.venmoUsername, amountCents).catch(() => {});

  res.json({ success: true, newBalanceCents: balance - amountCents });
});

export default router;
