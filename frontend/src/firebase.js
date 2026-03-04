import { initializeApp } from "firebase/app";
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut,
} from "firebase/auth";

// Firebase config is injected via env vars at build time.
// Falls back to reading from the backend /api/firebase-config endpoint.
let _app = null;
let _auth = null;
let _provider = null;

const ENV_CONFIG = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

function hasEnvConfig() {
  return ENV_CONFIG.apiKey && ENV_CONFIG.projectId;
}

async function getFirebaseConfig() {
  if (hasEnvConfig()) return ENV_CONFIG;
  const res = await fetch("/api/firebase-config");
  if (!res.ok) throw new Error("Failed to fetch Firebase config");
  return res.json();
}

export async function initFirebase() {
  if (_app) return _auth;
  const config = await getFirebaseConfig();
  _app = initializeApp(config);
  _auth = getAuth(_app);
  _provider = new GoogleAuthProvider();
  return _auth;
}

export function getFirebaseAuth() {
  return _auth;
}

export async function googleSignIn() {
  if (!_auth) await initFirebase();
  return signInWithPopup(_auth, _provider);
}

export async function googleSignOut() {
  if (!_auth) return;
  return signOut(_auth);
}

export function onAuthChange(callback) {
  if (!_auth) return () => {};
  return onAuthStateChanged(_auth, callback);
}

export async function getIdToken() {
  if (!_auth?.currentUser) return null;
  return _auth.currentUser.getIdToken();
}
