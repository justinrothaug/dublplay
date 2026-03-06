import admin from 'firebase-admin';
import path from 'path';
import fs from 'fs';

const serviceAccountPath = path.join(__dirname, '../../firebase-service-account.json');

function getServiceAccount(): any | null {
  if (fs.existsSync(serviceAccountPath)) {
    console.log('Firebase: loading service account from file');
    return JSON.parse(fs.readFileSync(serviceAccountPath, 'utf-8'));
  }
  const envVal = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (envVal) {
    console.log('Firebase: loading service account from env var');
    try {
      return JSON.parse(envVal);
    } catch (e) {
      console.error('Firebase: failed to parse FIREBASE_SERVICE_ACCOUNT env var:', e);
      return null;
    }
  }
  console.warn('Firebase: no service account file at', serviceAccountPath);
  console.warn('Firebase: FIREBASE_SERVICE_ACCOUNT env var is', envVal ? 'set but empty' : 'not set');
  return null;
}

const serviceAccount = getServiceAccount();

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
  });
} else {
  console.warn('No Firebase service account found. Auth will not work.');
  admin.initializeApp();
}

export const firebaseAuth = admin.auth();
export const db = admin.firestore();
