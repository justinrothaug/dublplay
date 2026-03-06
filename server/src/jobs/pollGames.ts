import { db } from '../config/firebase';
import { stripe } from '../config/stripe';
import { fetchRecentGames, findMatchingGame, getResultForChallenger } from '../services/chesscom.service';

export async function pollActiveWagers() {
  const snapshot = await db.collection('dublplay_wagers').where('status', '==', 'active').get();

  let settledCount = 0;

  for (const doc of snapshot.docs) {
    try {
      const wager = doc.data();

      // Get chess usernames
      const [challengerDoc, opponentDoc] = await Promise.all([
        db.collection('dublplay_users').doc(wager.challengerId).get(),
        db.collection('dublplay_users').doc(wager.opponentId).get(),
      ]);
      const challengerChess = challengerDoc.data()!.chessComUsername;
      const opponentChess = opponentDoc.data()!.chessComUsername;

      const games = await fetchRecentGames(challengerChess);
      const afterTs = Math.floor(new Date(wager.createdAt).getTime() / 1000);

      const match = findMatchingGame(games, challengerChess, opponentChess, afterTs);

      if (match) {
        const result = getResultForChallenger(match, challengerChess);

        let winnerId: string | null = null;
        if (result === 'challenger_win') winnerId = wager.challengerId;
        if (result === 'opponent_win') winnerId = wager.opponentId;

        await doc.ref.update({
          status: 'settled',
          result,
          winnerId,
          gameUrl: match.url,
          chessComGameId: match.url,
          settledAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        if (winnerId) {
          await processWinnerPayout(doc.id, wager, winnerId);
        } else {
          await processDrawRefund(doc.id, wager);
        }

        settledCount++;
      }
    } catch (err) {
      console.error(`Error polling wager ${doc.id}:`, err);
    }
  }

  if (settledCount > 0) {
    console.log(`Settled ${settledCount} wager(s)`);
  }
}

async function processWinnerPayout(wagerId: string, wager: any, winnerId: string) {
  try {
    const winnerDoc = await db.collection('dublplay_users').doc(winnerId).get();
    const connectAccountId = winnerDoc.data()?.stripeConnectAccountId;

    if (!connectAccountId) {
      console.error(`Winner ${winnerId} has no Stripe Connect account`);
      return;
    }

    const totalPot = wager.amountCents * 2;
    const platformFee = Math.round(totalPot * 0.05);
    const payoutAmount = totalPot - platformFee;

    const transfer = await stripe.transfers.create({
      amount: payoutAmount,
      currency: 'usd',
      destination: connectAccountId,
      transfer_group: wagerId,
      metadata: { wagerId, winnerId },
    });

    await db.collection('dublplay_wagers').doc(wagerId).update({ payoutTransferId: transfer.id });

    await db.collection('dublplay_transactions').doc().set({
      wagerId,
      userId: winnerId,
      type: 'payout',
      amountCents: payoutAmount,
      stripeTransferId: transfer.id,
      status: 'completed',
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`Payout failed for wager ${wagerId}:`, err);
  }
}

async function processDrawRefund(wagerId: string, wager: any) {
  try {
    for (const piId of [wager.challengerPaymentIntentId, wager.opponentPaymentIntentId]) {
      if (piId) {
        await stripe.refunds.create({ payment_intent: piId });
        const userId = piId === wager.challengerPaymentIntentId
          ? wager.challengerId
          : wager.opponentId;

        await db.collection('dublplay_transactions').doc().set({
          wagerId,
          userId,
          type: 'draw_refund',
          amountCents: wager.amountCents,
          stripePaymentIntentId: piId,
          status: 'completed',
          createdAt: new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    console.error(`Draw refund failed for wager ${wagerId}:`, err);
  }
}
