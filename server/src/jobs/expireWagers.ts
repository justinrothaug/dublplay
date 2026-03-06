import { db } from '../config/firebase';
import { stripe } from '../config/stripe';

export async function expireStaleWagers() {
  const now = new Date().toISOString();

  // Get pending wagers that have expired
  const pending = await db.collection('dublchess_wagers')
    .where('status', 'in', ['pending_acceptance', 'pending_payment'])
    .get();

  const expired = pending.docs.filter(d => {
    const w = d.data();
    return w.expiresAt && w.expiresAt < now;
  });

  for (const doc of expired) {
    const wager = doc.data();
    await doc.ref.update({ status: 'expired', updatedAt: now });

    // Refund any payments already made
    for (const piId of [wager.challengerPaymentIntentId, wager.opponentPaymentIntentId]) {
      if (piId) {
        try {
          await stripe.refunds.create({ payment_intent: piId });
        } catch (err) {
          console.error(`Refund failed for expired wager ${doc.id}:`, err);
        }
      }
    }
  }

  if (expired.length > 0) {
    console.log(`Expired ${expired.length} stale wager(s)`);
  }
}
