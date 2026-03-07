import { Router, Request, Response } from 'express';
import { db } from '../config/firebase';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

const router = Router();
router.use(authenticate);

// List accepted friends
router.get('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  // Get friendships where user is requester or addressee and status is accepted
  const asRequester = await db.collection('dublplay_friendships')
    .where('requesterId', '==', userId)
    .where('status', '==', 'accepted')
    .get();

  const asAddressee = await db.collection('dublplay_friendships')
    .where('addresseeId', '==', userId)
    .where('status', '==', 'accepted')
    .get();

  const friends: any[] = [];

  for (const doc of asRequester.docs) {
    const f = doc.data();
    const userDoc = await db.collection('dublplay_users').doc(f.addresseeId).get();
    if (userDoc.exists) {
      const u = userDoc.data()!;
      friends.push({
        friendship_id: doc.id,
        id: userDoc.id,
        email: u.email,
        chess_com_username: u.chessComUsername,
        bga_username: u.bgaUsername || null,
        display_name: u.displayName,
      });
    }
  }

  for (const doc of asAddressee.docs) {
    const f = doc.data();
    const userDoc = await db.collection('dublplay_users').doc(f.requesterId).get();
    if (userDoc.exists) {
      const u = userDoc.data()!;
      friends.push({
        friendship_id: doc.id,
        id: userDoc.id,
        email: u.email,
        chess_com_username: u.chessComUsername,
        bga_username: u.bgaUsername || null,
        display_name: u.displayName,
      });
    }
  }

  friends.sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''));
  res.json(friends);
});

// List pending incoming requests
router.get('/requests', async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const snapshot = await db.collection('dublplay_friendships')
    .where('addresseeId', '==', userId)
    .where('status', '==', 'pending')
    .get();

  const requests: any[] = [];
  for (const doc of snapshot.docs) {
    const f = doc.data();
    const userDoc = await db.collection('dublplay_users').doc(f.requesterId).get();
    if (userDoc.exists) {
      const u = userDoc.data()!;
      requests.push({
        friendship_id: doc.id,
        id: userDoc.id,
        email: u.email,
        chess_com_username: u.chessComUsername,
        display_name: u.displayName,
        created_at: f.createdAt,
      });
    }
  }

  requests.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  res.json(requests);
});

// Send friend request by display name or chess.com username
router.post('/request', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { chessComUsername, displayName } = req.body;
  const searchTerm = displayName || chessComUsername;

  if (!searchTerm) {
    throw new AppError(400, 'Display name or username required');
  }

  // Try display name first, then fall back to chess.com username
  let userSnapshot = await db.collection('dublplay_users')
    .where('displayNameLower', '==', searchTerm.toLowerCase())
    .limit(1).get();

  if (userSnapshot.empty) {
    userSnapshot = await db.collection('dublplay_users')
      .where('chessComUsernameLower', '==', searchTerm.toLowerCase())
      .limit(1).get();
  }

  if (userSnapshot.empty) {
    throw new AppError(404, 'No user found with that name');
  }

  const friendDoc = userSnapshot.docs[0];
  const friendId = friendDoc.id;

  if (friendId === userId) {
    throw new AppError(400, 'Cannot friend yourself');
  }

  // Check if friendship already exists in either direction
  const existing1 = await db.collection('dublplay_friendships')
    .where('requesterId', '==', userId)
    .where('addresseeId', '==', friendId)
    .limit(1).get();

  const existing2 = await db.collection('dublplay_friendships')
    .where('requesterId', '==', friendId)
    .where('addresseeId', '==', userId)
    .limit(1).get();

  const existingDoc = existing1.docs[0] || existing2.docs[0];
  if (existingDoc) {
    const f = existingDoc.data();
    if (f.status === 'accepted') throw new AppError(409, 'Already friends');
    if (f.status === 'pending') throw new AppError(409, 'Friend request already pending');
  }

  const now = new Date().toISOString();
  const ref = db.collection('dublplay_friendships').doc();
  const data = {
    requesterId: userId,
    addresseeId: friendId,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(data);

  res.status(201).json({ id: ref.id, ...data });
});

// Accept friend request
router.post('/:id/accept', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const ref = db.collection('dublplay_friendships').doc(String(req.params.id));
  const doc = await ref.get();

  if (!doc.exists) throw new AppError(404, 'Friend request not found');
  const f = doc.data()!;
  if (f.addresseeId !== userId || f.status !== 'pending') {
    throw new AppError(404, 'Friend request not found');
  }

  await ref.update({ status: 'accepted', updatedAt: new Date().toISOString() });
  res.json({ id: doc.id, ...f, status: 'accepted' });
});

// Decline friend request
router.post('/:id/decline', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const ref = db.collection('dublplay_friendships').doc(String(req.params.id));
  const doc = await ref.get();

  if (!doc.exists) throw new AppError(404, 'Friend request not found');
  const f = doc.data()!;
  if (f.addresseeId !== userId || f.status !== 'pending') {
    throw new AppError(404, 'Friend request not found');
  }

  await ref.update({ status: 'declined', updatedAt: new Date().toISOString() });
  res.json({ id: doc.id, ...f, status: 'declined' });
});

// Remove friend
router.delete('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const ref = db.collection('dublplay_friendships').doc(String(req.params.id));
  const doc = await ref.get();

  if (!doc.exists) throw new AppError(404, 'Friendship not found');
  const f = doc.data()!;
  if (f.requesterId !== userId && f.addresseeId !== userId) {
    throw new AppError(404, 'Friendship not found');
  }

  await ref.delete();
  res.json({ deleted: true });
});

export default router;
