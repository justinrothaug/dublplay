import { createContext, useContext, useEffect, useState } from 'react';
import {
  onAuthStateChanged,
  signOut,
  signInWithPopup,
  GoogleAuthProvider,
} from 'firebase/auth';
import { auth } from './firebase.js';

const API_BASE = import.meta.env.VITE_GAMES_API_URL || '/api';

const AuthContext = createContext(null);
const googleProvider = new GoogleAuthProvider();

export function AuthProvider({ children }) {
  const [firebaseUser, setFirebaseUser] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [needsRegistration, setNeedsRegistration] = useState(false);

  const syncDbUser = async (fbUser) => {
    try {
      const token = await fbUser.getIdToken();
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firebaseToken: token }),
      });

      if (res.ok) {
        const dbUser = await res.json();
        setUser(dbUser);
        setNeedsRegistration(false);
      } else {
        setUser(null);
        setNeedsRegistration(true);
      }
    } catch {
      setUser(null);
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      setFirebaseUser(fbUser);
      if (fbUser) {
        await syncDbUser(fbUser);
      } else {
        setUser(null);
        setNeedsRegistration(false);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const signInWithGoogle = async () => {
    await signInWithPopup(auth, googleProvider);
  };

  const completeRegistration = async (chessComUsername) => {
    if (!firebaseUser) throw new Error('Not signed in');
    const token = await firebaseUser.getIdToken();

    // Try registering first; if user already exists, update the username
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firebaseToken: token, chessComUsername }),
    });

    if (res.status === 409) {
      // User already exists — update chess username instead
      const updateRes = await fetch(`${API_BASE}/auth/chess-username`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ chessComUsername }),
      });
      if (!updateRes.ok) {
        const body = await updateRes.json().catch(() => ({ error: 'Update failed' }));
        throw new Error(body.error || 'Failed to update username');
      }
      const dbUser = await updateRes.json();
      setUser(dbUser);
      setNeedsRegistration(false);
      return;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: 'Registration failed' }));
      throw new Error(body.error || 'Registration failed');
    }

    const dbUser = await res.json();
    setUser(dbUser);
    setNeedsRegistration(false);
  };

  const logout = async () => {
    await signOut(auth);
    setUser(null);
  };

  const disconnectChess = () => {
    setUser(null);
    setNeedsRegistration(true);
  };

  const refreshUser = async () => {
    if (firebaseUser) await syncDbUser(firebaseUser);
  };

  return (
    <AuthContext.Provider
      value={{ user, firebaseUser, loading, signInWithGoogle, completeRegistration, logout, disconnectChess, refreshUser, needsRegistration }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
