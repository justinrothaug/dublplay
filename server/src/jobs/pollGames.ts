import { db } from '../config/firebase';
import * as chesscom from '../services/chesscom.service';
import * as playstrategy from '../services/playstrategy.service';
import * as bga from '../services/bga.service';

export async function pollActiveWagers() {
  const snapshot = await db.collection('dublplay_wagers').where('status', '==', 'active').get();

  let settledCount = 0;

  for (const doc of snapshot.docs) {
    try {
      const wager = doc.data();
      const platform = wager.platform || 'chesscom';

      // Get user docs
      const [challengerDoc, opponentDoc] = await Promise.all([
        db.collection('dublplay_users').doc(wager.challengerId).get(),
        db.collection('dublplay_users').doc(wager.opponentId).get(),
      ]);
      const challengerData = challengerDoc.data()!;
      const opponentData = opponentDoc.data()!;
      const afterTs = Math.floor(new Date(wager.createdAt).getTime() / 1000);

      let result: 'challenger_win' | 'opponent_win' | 'draw' | null = null;
      let gameUrl: string | null = null;

      if (platform === 'chesscom') {
        const challengerChess = challengerData.chessComUsername;
        const opponentChess = opponentData.chessComUsername;
        if (!challengerChess || !opponentChess) continue;

        const games = await chesscom.fetchRecentGames(challengerChess);
        const match = chesscom.findMatchingGame(games, challengerChess, opponentChess, afterTs);
        if (match) {
          result = chesscom.getResultForChallenger(match, challengerChess);
          gameUrl = match.url;
        }
      } else if (platform === 'playstrategy') {
        const challengerPS = challengerData.playStrategyUsername;
        const opponentPS = opponentData.playStrategyUsername;
        if (!challengerPS || !opponentPS) continue;

        const games = await playstrategy.fetchRecentGames(challengerPS, opponentPS);
        const match = playstrategy.findMatchingGame(games, challengerPS, opponentPS, afterTs);
        if (match) {
          result = playstrategy.getResultForChallenger(match, challengerPS);
          gameUrl = `https://playstrategy.org/${match.id}`;
        }
      } else if (platform === 'bga') {
        const challengerBGA = challengerData.bgaUsername;
        const opponentBGA = opponentData.bgaUsername;
        if (!challengerBGA || !opponentBGA) continue;

        const tables = await bga.fetchRecentGames(challengerBGA, opponentBGA);
        const match = bga.findMatchingGame(tables, challengerBGA, opponentBGA, afterTs);
        if (match) {
          result = bga.getResultForChallenger(match, challengerBGA);
          gameUrl = `https://boardgamearena.com/gamereview?table=${match.table_id}`;
        }
      }

      if (result) {
        let winnerId: string | null = null;
        if (result === 'challenger_win') winnerId = wager.challengerId;
        if (result === 'opponent_win') winnerId = wager.opponentId;

        await doc.ref.update({
          status: 'settled',
          result,
          winnerId,
          gameUrl,
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

    // Credit winner's wallet balance (full pot, no fee)
    const winnerRef = db.collection('dublplay_users').doc(winnerId);
    const winnerDoc = await winnerRef.get();
    const currentBalance = winnerDoc.data()?.walletBalanceCents || 0;

    await winnerRef.update({
      walletBalanceCents: currentBalance + totalPot,
      updatedAt: new Date().toISOString(),
    });

    await db.collection('dublplay_transactions').doc().set({
      wagerId,
      userId: winnerId,
      type: 'payout',
      amountCents: totalPot,
      status: 'completed',
      createdAt: new Date().toISOString(),
    });

    console.log(`Credited $${(totalPot / 100).toFixed(2)} to wallet of user ${winnerId} for wager ${wagerId}`);
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
