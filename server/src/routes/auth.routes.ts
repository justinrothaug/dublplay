import { Router, Request, Response } from 'express';
import { firebaseAuth, db } from '../config/firebase';
import { authenticate } from '../middleware/auth';
import { z } from 'zod';

const router = Router();

const registerSchema = z.object({
  firebaseToken: z.string(),
  chessComUsername: z.string().min(1),
  displayName: z.string().optional(),
  playStrategyUsername: z.string().optional(),
  bgaUsername: z.string().optional(),
});

// Register: Firebase token + Chess.com username -> create Firestore user
router.post('/register', async (req: Request, res: Response) => {
  try {
    const body = registerSchema.parse(req.body);
    const decoded = await firebaseAuth.verifyIdToken(body.firebaseToken);
    const email = decoded.email || '';

    // Check if user already exists
    const existing = await db.collection('dublplay_users').where('firebaseUid', '==', decoded.uid).limit(1).get();
    if (!existing.empty) {
      res.status(409).json({ error: 'Account already exists. Please sign in.' });
      return;
    }

    // Check if chess.com username is taken
    const usernameTaken = await db.collection('dublplay_users')
      .where('chessComUsernameLower', '==', body.chessComUsername.toLowerCase())
      .limit(1).get();
    if (!usernameTaken.empty) {
      res.status(409).json({ error: 'Chess.com username already taken' });
      return;
    }

    const now = new Date().toISOString();
    const userRef = db.collection('dublplay_users').doc();
    const userData = {
      email,
      firebaseUid: decoded.uid,
      chessComUsername: body.chessComUsername,
      chessComUsernameLower: body.chessComUsername.toLowerCase(),
      displayName: body.displayName || body.chessComUsername,
      displayNameLower: (body.displayName || body.chessComUsername).toLowerCase(),
      playStrategyUsername: body.playStrategyUsername || null,
      playStrategyUsernameLower: body.playStrategyUsername?.toLowerCase() || null,
      bgaUsername: body.bgaUsername ? decodeURIComponent(body.bgaUsername).trim() : null,
      bgaUsernameLower: body.bgaUsername ? decodeURIComponent(body.bgaUsername).trim().toLowerCase() : null,
      walletBalanceCents: 0,
      stripeCustomerId: null,
      stripeConnectAccountId: null,
      stripeOnboardingComplete: false,
      venmoUsername: null,
      createdAt: now,
      updatedAt: now,
    };

    await userRef.set(userData);

    res.status(201).json({
      id: userRef.id,
      email: userData.email,
      chess_com_username: userData.chessComUsername,
      play_strategy_username: userData.playStrategyUsername,
      bga_username: userData.bgaUsername,
      display_name: userData.displayName,
      stripe_onboarding_complete: false,
      venmo_username: null,
      is_admin: false,
      created_at: now,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: err.errors[0].message });
      return;
    }
    throw err;
  }
});

// Login: verify Firebase token and return user
router.post('/login', async (req: Request, res: Response) => {
  const { firebaseToken } = req.body;
  if (!firebaseToken) {
    res.status(400).json({ error: 'Firebase token required' });
    return;
  }

  try {
    const decoded = await firebaseAuth.verifyIdToken(firebaseToken);
    const snapshot = await db.collection('dublplay_users').where('firebaseUid', '==', decoded.uid).limit(1).get();

    if (snapshot.empty) {
      res.status(404).json({ error: 'User not found. Please register first.' });
      return;
    }

    const doc = snapshot.docs[0];
    const u = doc.data();
    res.json({
      id: doc.id,
      email: u.email,
      chess_com_username: u.chessComUsername,
      play_strategy_username: u.playStrategyUsername || null,
      bga_username: u.bgaUsername ? decodeURIComponent(u.bgaUsername).trim() : null,
      display_name: u.displayName,
      stripe_onboarding_complete: u.stripeOnboardingComplete,
      venmo_username: u.venmoUsername || null,
      is_admin: !!u.admin,
      created_at: u.createdAt,
    });
  } catch {
    res.status(401).json({ error: 'Invalid Firebase token' });
  }
});

// Update Chess.com username
router.put('/chess-username', authenticate, async (req: Request, res: Response) => {
  const { chessComUsername } = req.body;
  if (!chessComUsername || typeof chessComUsername !== 'string' || !chessComUsername.trim()) {
    res.status(400).json({ error: 'Chess.com username required' });
    return;
  }

  const username = chessComUsername.trim();
  const userRef = db.collection('dublplay_users').doc(req.user!.userId);

  // Check if username is taken by another user
  const taken = await db.collection('dublplay_users')
    .where('chessComUsernameLower', '==', username.toLowerCase())
    .limit(1).get();
  if (!taken.empty && taken.docs[0].id !== req.user!.userId) {
    res.status(409).json({ error: 'Chess.com username already taken' });
    return;
  }

  await userRef.update({
    chessComUsername: username,
    chessComUsernameLower: username.toLowerCase(),
    updatedAt: new Date().toISOString(),
  });

  const doc = await userRef.get();
  const u = doc.data()!;
  res.json({
    id: doc.id,
    email: u.email,
    chess_com_username: u.chessComUsername,
    display_name: u.displayName,
    stripe_onboarding_complete: u.stripeOnboardingComplete,
    venmo_username: u.venmoUsername || null,
    is_admin: !!u.admin,
    created_at: u.createdAt,
  });
});

// Update platform usernames (PlayStrategy, BGA)
router.put('/platform-usernames', authenticate, async (req: Request, res: Response) => {
  const { playStrategyUsername, bgaUsername } = req.body;
  const userRef = db.collection('dublplay_users').doc(req.user!.userId);

  const updates: Record<string, any> = { updatedAt: new Date().toISOString() };

  if (playStrategyUsername !== undefined) {
    updates.playStrategyUsername = playStrategyUsername || null;
    updates.playStrategyUsernameLower = playStrategyUsername?.toLowerCase() || null;
  }
  if (bgaUsername !== undefined) {
    // Decode any URL-encoded characters (e.g. %20 -> space)
    const decoded = bgaUsername ? decodeURIComponent(bgaUsername).trim() : null;
    updates.bgaUsername = decoded || null;
    updates.bgaUsernameLower = decoded?.toLowerCase() || null;
  }

  await userRef.update(updates);

  const doc = await userRef.get();
  const u = doc.data()!;
  res.json({
    id: doc.id,
    email: u.email,
    chess_com_username: u.chessComUsername,
    play_strategy_username: u.playStrategyUsername || null,
    bga_username: u.bgaUsername ? decodeURIComponent(u.bgaUsername).trim() : null,
    display_name: u.displayName,
    stripe_onboarding_complete: u.stripeOnboardingComplete,
    venmo_username: u.venmoUsername || null,
    is_admin: !!u.admin,
    created_at: u.createdAt,
  });
});

// Update Venmo username
router.put('/venmo', authenticate, async (req: Request, res: Response) => {
  const { venmoUsername } = req.body;
  if (venmoUsername !== null && (typeof venmoUsername !== 'string' || !venmoUsername.trim())) {
    res.status(400).json({ error: 'Venmo username required' });
    return;
  }

  const userRef = db.collection('dublplay_users').doc(req.user!.userId);
  await userRef.update({
    venmoUsername: venmoUsername ? venmoUsername.trim() : null,
    updatedAt: new Date().toISOString(),
  });

  res.json({ venmoUsername: venmoUsername ? venmoUsername.trim() : null });
});

// Get current user profile
router.get('/me', authenticate, async (req: Request, res: Response) => {
  const doc = await db.collection('dublplay_users').doc(req.user!.userId).get();

  if (!doc.exists) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const u = doc.data()!;
  res.json({
    id: doc.id,
    email: u.email,
    chess_com_username: u.chessComUsername,
    display_name: u.displayName,
    stripe_onboarding_complete: u.stripeOnboardingComplete,
    venmo_username: u.venmoUsername || null,
    is_admin: !!u.admin,
    created_at: u.createdAt,
  });
});

export default router;
