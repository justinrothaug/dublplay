import { db } from '../config/firebase';
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
    const totalPot = wager.amountCents * 2;
    const platformFee = Math.round(totalPot * 0.05); // 5% platform fee
    const payoutAmount = totalPot - platformFee;

    // Credit winner's wallet balance
    const winnerRef = db.collection('dublplay_users').doc(winnerId);
    const winnerDoc = await winnerRef.get();
    const currentBalance = winnerDoc.data()?.walletBalanceCents || 0;

    await winnerRef.update({
      walletBalanceCents: currentBalance + payoutAmount,
      updatedAt: new Date().toISOString(),
    });

    await db.collection('dublplay_transactions').doc().set({
      wagerId,
      userId: winnerId,
      type: 'payout',
      amountCents: payoutAmount,
      status: 'completed',
      createdAt: new Date().toISOString(),
    });

    console.log(`Credited $${(payoutAmount / 100).toFixed(2)} to wallet of user ${winnerId} for wager ${wagerId}`);
  } catch (err) {
    console.error(`Payout failed for wager ${wagerId}:`, err);
  }
}

async function processDrawRefund(wagerId: string, wager: any) {
  try {
    // Refund both players' wallets
    for (const userId of [wager.challengerId, wager.opponentId]) {
      const userRef = db.collection('dublplay_users').doc(userId);
      const userDoc = await userRef.get();
      const currentBalance = userDoc.data()?.walletBalanceCents || 0;

      await userRef.update({
        walletBalanceCents: currentBalance + wager.amountCents,
        updatedAt: new Date().toISOString(),
      });

      await db.collection('dublplay_transactions').doc().set({
        wagerId,
        userId,
        type: 'draw_refund',
        amountCents: wager.amountCents,
        status: 'completed',
        createdAt: new Date().toISOString(),
      });
    }

    console.log(`Draw refund: credited $${(wager.amountCents / 100).toFixed(2)} each to both players for wager ${wagerId}`);
  } catch (err) {
    console.error(`Draw refund failed for wager ${wagerId}:`, err);
  }
}
