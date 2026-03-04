import { initializeApp } from "firebase/app";
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut,
} from "firebase/auth";

let _app = null;
let _auth = null;
let _provider = null;
let _bypassAuth = false;

// Fake user for bypass mode
const BYPASS_USER = {
  uid: "admin",
  displayName: "Admin",
  photoURL: "",
  email: "admin@local",
};

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
  try {
    const res = await fetch("/api/firebase-config");
    if (!res.ok) return {};
    return res.json();
  } catch {
    return {};
  }
}

export async function initFirebase() {
  if (_app || _bypassAuth) return { auth: _auth, bypass: _bypassAuth };

  const config = await getFirebaseConfig();
  _bypassAuth = config.bypass_auth === true;

  if (_bypassAuth) return { auth: null, bypass: true };

  if (config.apiKey && config.projectId) {
    _app = initializeApp(config);
    _auth = getAuth(_app);
    _provider = new GoogleAuthProvider();
  }

  return { auth: _auth, bypass: false };
}

export function isBypassAuth() {
  return _bypassAuth;
}

export async function googleSignIn() {
  if (_bypassAuth) return { user: BYPASS_USER };
  if (!_auth) await initFirebase();
  return signInWithPopup(_auth, _provider);
}

export async function googleSignOut() {
  if (_bypassAuth) return;
  if (!_auth) return;
  return signOut(_auth);
}

export function onAuthChange(callback) {
  if (_bypassAuth) {
    setTimeout(() => callback(BYPASS_USER), 0);
    return () => {};
  }
  if (!_auth) return () => {};
  return onAuthStateChanged(_auth, callback);
}

export async function getIdToken() {
  if (_bypassAuth) return "bypass";
  if (!_auth?.currentUser) return null;
  return _auth.currentUser.getIdToken();
}
