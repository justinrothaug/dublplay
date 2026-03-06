import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyAEnTxgQ8yOJ2_ZwFSQ19xDe9ARQTg-UHA',
  authDomain: 'myavatarlab.firebaseapp.com',
  projectId: 'myavatarlab',
  storageBucket: 'myavatarlab.firebasestorage.app',
  messagingSenderId: '171636644437',
  appId: '1:171636644437:web:eb894a2d7cc308e65352dc',
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
