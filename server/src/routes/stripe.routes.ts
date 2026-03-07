import { Router, Request, Response } from 'express';
import { db } from '../config/firebase';
import { stripe } from '../config/stripe';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { env } from '../config/env';
import express from 'express';

const router = Router();

// Return publishable key to client
router.get('/config', (_req: Request, res: Response) => {
  res.json({ publishableKey: env.STRIPE_PUBLISHABLE_KEY });
});

// Stripe Connect onboarding - create account and return link
router.post('/onboarding', authenticate, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const userRef = db.collection('dublplay_users').doc(userId);
  const userDoc = await userRef.get();
  const user = userDoc.data()!;

  let accountId = user.stripeConnectAccountId;

  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      email: user.email,
      metadata: { userId },
    });
    accountId = account.id;
    await userRef.update({ stripeConnectAccountId: accountId });
  }

  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${req.protocol}://${req.get('host')}/stripe/onboarding/refresh`,
    return_url: `${req.protocol}://${req.get('host')}/stripe/onboarding/complete`,
    type: 'account_onboarding',
  });

  res.json({ url: accountLink.url });
});

// Check onboarding status
router.get('/account-status', authenticate, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const userRef = db.collection('dublplay_users').doc(userId);
  const userDoc = await userRef.get();
  const user = userDoc.data()!;

  const accountId = user.stripeConnectAccountId;

  if (!accountId) {
    res.json({ onboarded: false, accountId: null });
    return;
  }

  const account = await stripe.accounts.retrieve(accountId);
  const onboarded = account.charges_enabled && account.payouts_enabled;

  if (onboarded) {
    await userRef.update({ stripeOnboardingComplete: true });
  }

  res.json({
    onboarded,
    accountId,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
  });
});

// Pay for a wager from wallet balance
router.post('/wagers/:id/pay', authenticate, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const wagerRef = db.collection('dublplay_wagers').doc(String(req.params.id));
  const wagerDoc = await wagerRef.get();

  if (!wagerDoc.exists) throw new AppError(404, 'Wager not found');
  const wager = wagerDoc.data()!;

  if (wager.status !== 'pending_payment') {
    throw new AppError(400, 'Wager is not in payment stage');
  }

  const isChallenger = wager.challengerId === userId;
  const isOpponent = wager.opponentId === userId;
  if (!isChallenger && !isOpponent) throw new AppError(403, 'Not your wager');

  if (isChallenger && wager.challengerPaid) throw new AppError(400, 'Already paid');
  if (isOpponent && wager.opponentPaid) throw new AppError(400, 'Already paid');

  // Deduct from wallet balance
  const userRef = db.collection('dublplay_users').doc(userId);
  const userDoc = await userRef.get();
  const user = userDoc.data()!;
  const balance = user.walletBalanceCents || 0;

  if (balance < wager.amountCents) {
    throw new AppError(400, `Insufficient balance. You have $${(balance / 100).toFixed(2)} but need $${(wager.amountCents / 100).toFixed(2)}. Deposit funds first.`);
  }

  await userRef.update({
    walletBalanceCents: balance - wager.amountCents,
    updatedAt: new Date().toISOString(),
  });

  // Mark as paid
  const paidField = isChallenger ? 'challengerPaid' : 'opponentPaid';
  await wagerRef.update({ [paidField]: true, updatedAt: new Date().toISOString() });

  // Check if both sides paid → activate
  const freshWager = (await wagerRef.get()).data()!;
  if (freshWager.challengerPaid && freshWager.opponentPaid) {
    await wagerRef.update({ status: 'active', updatedAt: new Date().toISOString() });
  }

  // Record transaction
  await db.collection('dublplay_transactions').doc().set({
    wagerId: wagerDoc.id,
    userId,
    type: 'bet_payment',
    amountCents: wager.amountCents,
    status: 'completed',
    createdAt: new Date().toISOString(),
  });

  const newBalance = balance - wager.amountCents;
  res.json({ success: true, newBalanceCents: newBalance });
});

// Stripe webhook
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req: Request, res: Response) => {
    const sig = req.headers['stripe-signature'] as string;

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, env.STRIPE_WEBHOOK_SECRET);
    } catch (err: any) {
      res.status(400).json({ error: `Webhook Error: ${err.message}` });
      return;
    }

    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object as any;

      // ── Wallet deposit (only remaining Stripe payment flow) ──
      if (pi.metadata?.type === 'wallet_deposit') {
        const userId = pi.metadata.userId;
        if (userId) {
          const userRef = db.collection('dublplay_users').doc(userId);
          const userDoc = await userRef.get();
          const currentBalance = userDoc.data()?.walletBalanceCents || 0;
          await userRef.update({
            walletBalanceCents: currentBalance + pi.amount,
            updatedAt: new Date().toISOString(),
          });
          await db.collection('dublplay_transactions').doc().set({
            userId,
            type: 'deposit',
            amountCents: pi.amount,
            stripePaymentIntentId: pi.id,
            status: 'completed',
            createdAt: new Date().toISOString(),
          });
        }
      }
      // Note: wager payments now deduct from wallet balance directly (no Stripe charge)
    }

    res.json({ received: true });
  },
);

export default router;
