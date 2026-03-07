import { db } from '../config/firebase';
import * as chesscom from '../services/chesscom.service';
import * as playstrategy from '../services/playstrategy.service';
import * as bga from '../services/bga.service';

// Poll a single wager document. Returns true if settled.
export async function pollSingleWager(doc: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot): Promise<boolean> {
  const wager = doc.data()!;
  const platform = wager.platform || 'chesscom';

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
    if (!challengerChess || !opponentChess) return false;

    const games = await chesscom.fetchRecentGames(challengerChess);
    const match = chesscom.findMatchingGame(games, challengerChess, opponentChess, afterTs);
    if (match) {
      result = chesscom.getResultForChallenger(match, challengerChess);
      gameUrl = match.url;
    }
  } else if (platform === 'playstrategy') {
    const challengerPS = challengerData.playStrategyUsername;
    const opponentPS = opponentData.playStrategyUsername;
    if (!challengerPS || !opponentPS) return false;

    const games = await playstrategy.fetchRecentGames(challengerPS, opponentPS);
    const match = playstrategy.findMatchingGame(games, challengerPS, opponentPS, afterTs);
    if (match) {
      result = playstrategy.getResultForChallenger(match, challengerPS);
      gameUrl = `https://playstrategy.org/${match.id}`;
    }
  } else if (platform === 'bga') {
    // Use stored numeric IDs if available, otherwise resolve from usernames
    let challengerBgaId = challengerData.bgaPlayerId || null;
    let opponentBgaId = opponentData.bgaPlayerId || null;

    if (!challengerBgaId || !opponentBgaId) {
      const challengerBGA = challengerData.bgaUsername ? decodeURIComponent(challengerData.bgaUsername).trim() : null;
      const opponentBGA = opponentData.bgaUsername ? decodeURIComponent(opponentData.bgaUsername).trim() : null;
      if (!challengerBGA || !opponentBGA) return false;

      // Fix URL-encoded usernames in DB
      if (challengerData.bgaUsername !== challengerBGA) {
        await db.collection('dublplay_users').doc(wager.challengerId).update({ bgaUsername: challengerBGA, bgaUsernameLower: challengerBGA.toLowerCase() });
      }
      if (opponentData.bgaUsername !== opponentBGA) {
        await db.collection('dublplay_users').doc(wager.opponentId).update({ bgaUsername: opponentBGA, bgaUsernameLower: opponentBGA.toLowerCase() });
      }

      const [resolvedChallenger, resolvedOpponent] = await Promise.all([
        challengerBgaId ? Promise.resolve(challengerBgaId) : bga.resolvePlayerId(challengerBGA),
        opponentBgaId ? Promise.resolve(opponentBgaId) : bga.resolvePlayerId(opponentBGA),
      ]);
      challengerBgaId = resolvedChallenger;
      opponentBgaId = resolvedOpponent;

      // Store resolved IDs for next time
      if (challengerBgaId && !challengerData.bgaPlayerId) {
        await db.collection('dublplay_users').doc(wager.challengerId).update({ bgaPlayerId: challengerBgaId });
      }
      if (opponentBgaId && !opponentData.bgaPlayerId) {
        await db.collection('dublplay_users').doc(wager.opponentId).update({ bgaPlayerId: opponentBgaId });
      }
    }

    if (!challengerBgaId || !opponentBgaId) {
      console.warn(`BGA: Could not resolve IDs — challenger: ${challengerBgaId || 'MISSING'}, opponent: ${opponentBgaId || 'MISSING'}`);
      return false;
    }

    const tables = await bga.fetchRecentGames(challengerBgaId, opponentBgaId);
    const match = bga.findMatchingGame(tables, challengerBgaId, opponentBgaId, afterTs);
    if (match) {
      result = bga.getResultForChallenger(match, challengerBgaId);
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

    return true;
  }

  return false;
}

export async function pollActiveWagers() {
  const snapshot = await db.collection('dublplay_wagers').where('status', '==', 'active').get();

  let settledCount = 0;

  for (const doc of snapshot.docs) {
    try {
      const settled = await pollSingleWager(doc);
      if (settled) settledCount++;
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
