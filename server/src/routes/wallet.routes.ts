import { Router, Request, Response } from 'express';
import { db } from '../config/firebase';
import { stripe } from '../config/stripe';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

const router = Router();

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

export default router;
