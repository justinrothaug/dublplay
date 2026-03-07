import { Request, Response, NextFunction } from 'express';
import { firebaseAuth, db } from '../config/firebase';

declare global {
  namespace Express {
    interface Request {
      user?: { userId: string; email: string; firebaseUid: string; isAdmin: boolean };
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization token' });
    return;
  }

  const token = header.slice(7);
  firebaseAuth
    .verifyIdToken(token)
    .then(async (decoded) => {
      const usersRef = db.collection('dublplay_users');
      const snapshot = await usersRef.where('firebaseUid', '==', decoded.uid).limit(1).get();

      if (snapshot.empty) {
        res.status(401).json({ error: 'User not found. Please complete registration.' });
        return;
      }

      const userDoc = snapshot.docs[0];
      const user = userDoc.data();
      req.user = { userId: userDoc.id, email: user.email, firebaseUid: decoded.uid, isAdmin: !!user.admin };
      next();
    })
    .catch(() => {
      res.status(401).json({ error: 'Invalid or expired token' });
    });
}

export function adminOnly(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
