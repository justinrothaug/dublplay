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
  const userRef = db.collection('dublchess_users').doc(userId);
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
  const userRef = db.collection('dublchess_users').doc(userId);
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

// Pay for a wager (creates PaymentIntent)
router.post('/wagers/:id/pay', authenticate, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const wagerRef = db.collection('dublchess_wagers').doc(String(req.params.id));
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

  // Get or create Stripe customer
  const userRef = db.collection('dublchess_users').doc(userId);
  const userDoc = await userRef.get();
  const user = userDoc.data()!;

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
    amount: wager.amountCents,
    currency: 'usd',
    customer: customerId,
    transfer_group: wagerDoc.id,
    metadata: {
      wagerId: wagerDoc.id,
      userId,
      side: isChallenger ? 'challenger' : 'opponent',
    },
  });

  // Store the PaymentIntent ID
  const field = isChallenger ? 'challengerPaymentIntentId' : 'opponentPaymentIntentId';
  await wagerRef.update({ [field]: paymentIntent.id, updatedAt: new Date().toISOString() });

  res.json({ clientSecret: paymentIntent.client_secret });
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
      const wagerId = pi.metadata?.wagerId;
      const side = pi.metadata?.side;

      if (wagerId && side) {
        const wagerRef = db.collection('dublchess_wagers').doc(wagerId);
        const paidField = side === 'challenger' ? 'challengerPaid' : 'opponentPaid';
        await wagerRef.update({ [paidField]: true, updatedAt: new Date().toISOString() });

        // Check if both sides paid
        const wagerDoc = await wagerRef.get();
        const wager = wagerDoc.data()!;
        if (wager.challengerPaid && wager.opponentPaid) {
          await wagerRef.update({ status: 'active', updatedAt: new Date().toISOString() });
        }

        // Record transaction
        await db.collection('dublchess_transactions').doc().set({
          wagerId,
          userId: pi.metadata.userId,
          type: 'bet_payment',
          amountCents: pi.amount,
          stripePaymentIntentId: pi.id,
          status: 'completed',
          createdAt: new Date().toISOString(),
        });
      }
    }

    res.json({ received: true });
  },
);

export default router;
