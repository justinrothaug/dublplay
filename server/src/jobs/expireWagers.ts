import { db } from '../config/firebase';

export async function expireStaleWagers() {
  const now = new Date().toISOString();

  // Get pending wagers that have expired
  const pending = await db.collection('dublplay_wagers')
    .where('status', 'in', ['pending_acceptance', 'pending_payment'])
    .get();

  const expired = pending.docs.filter(d => {
    const w = d.data();
    return w.expiresAt && w.expiresAt < now;
  });

  for (const doc of expired) {
    const wager = doc.data();
    await doc.ref.update({ status: 'expired', updatedAt: now });

    // Refund wallet balance for any side that already paid
    const refundUsers: string[] = [];
    if (wager.challengerPaid) refundUsers.push(wager.challengerId);
    if (wager.opponentPaid) refundUsers.push(wager.opponentId);

    for (const userId of refundUsers) {
      try {
        const userRef = db.collection('dublplay_users').doc(userId);
        const userDoc = await userRef.get();
        const currentBalance = userDoc.data()?.walletBalanceCents || 0;
        await userRef.update({
          walletBalanceCents: currentBalance + wager.amountCents,
          updatedAt: now,
        });
        await db.collection('dublplay_transactions').doc().set({
          wagerId: doc.id,
          userId,
          type: 'refund',
          amountCents: wager.amountCents,
          status: 'completed',
          createdAt: now,
        });
      } catch (err) {
        console.error(`Wallet refund failed for expired wager ${doc.id}, user ${userId}:`, err);
      }
    }
  }

  if (expired.length > 0) {
    console.log(`Expired ${expired.length} stale wager(s)`);
  }
}
