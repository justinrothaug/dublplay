import { Router, Request, Response } from 'express';
import { db } from '../config/firebase';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// Leaderboard among friends
router.get('/leaderboard', async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  // Get all friend IDs
  const f1 = await db.collection('dublplay_friendships')
    .where('requesterId', '==', userId)
    .where('status', '==', 'accepted').get();
  const f2 = await db.collection('dublplay_friendships')
    .where('addresseeId', '==', userId)
    .where('status', '==', 'accepted').get();

  const friendIds = [
    ...f1.docs.map(d => d.data().addresseeId),
    ...f2.docs.map(d => d.data().requesterId),
  ];
  const allIds = [userId, ...friendIds];

  // Get all settled wagers involving these users
  const settledWagers: any[] = [];
  for (const id of allIds) {
    const asC = await db.collection('dublplay_wagers')
      .where('challengerId', '==', id)
      .where('status', '==', 'settled').get();
    const asO = await db.collection('dublplay_wagers')
      .where('opponentId', '==', id)
      .where('status', '==', 'settled').get();
    for (const d of [...asC.docs, ...asO.docs]) {
      if (!settledWagers.find(w => w.id === d.id)) {
        settledWagers.push({ id: d.id, ...d.data() });
      }
    }
  }

  // Get user info
  const userDocs = await Promise.all(allIds.map(id => db.collection('dublplay_users').doc(id).get()));

  const leaderboard = userDocs.map(userDoc => {
    const u = userDoc.data()!;
    const uid = userDoc.id;

    const userWagers = settledWagers.filter(
      w => w.challengerId === uid || w.opponentId === uid
    );

    let wins = 0, losses = 0, draws = 0, netCents = 0;
    for (const w of userWagers) {
      if (w.result === 'draw') {
        draws++;
      } else if (w.winnerId === uid) {
        wins++;
        netCents += w.amountCents;
      } else if (w.winnerId) {
        losses++;
        netCents -= w.amountCents;
      }
    }

    return {
      id: uid,
      display_name: u.displayName,
      chess_com_username: u.chessComUsername,
      net_cents: netCents,
      wins,
      losses,
      draws,
      total_games: userWagers.length,
    };
  });

  leaderboard.sort((a, b) => b.net_cents - a.net_cents);
  res.json(leaderboard);
});

// Balance vs specific friend
router.get('/balance/:friendId', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const friendId = req.params.friendId;

  // Get settled wagers between the two users
  const w1 = await db.collection('dublplay_wagers')
    .where('challengerId', '==', userId)
    .where('opponentId', '==', friendId)
    .where('status', '==', 'settled').get();
  const w2 = await db.collection('dublplay_wagers')
    .where('challengerId', '==', friendId)
    .where('opponentId', '==', userId)
    .where('status', '==', 'settled').get();

  const wagers = [...w1.docs, ...w2.docs].map(d => ({ id: d.id, ...d.data() }));

  let wins = 0, losses = 0, draws = 0, netCents = 0;
  for (const w of wagers as any[]) {
    if (w.result === 'draw') {
      draws++;
    } else if (w.winnerId === userId) {
      wins++;
      netCents += w.amountCents;
    } else if (w.winnerId === friendId) {
      losses++;
      netCents -= w.amountCents;
    }
  }

  res.json({ wins, losses, draws, net_cents: netCents });
});

export default router;
