import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';

export const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

/** Firebase Hosting が自動配信する設定を読み込んで初期化する（設定値を HTML に書かなくてよい） */
export async function initFirebase() {
  const res = await fetch('/__/firebase/init.json');
  if (!res.ok) throw new Error('Firebase の設定を読み込めませんでした（Firebase Hosting で公開してください）');
  const app = initializeApp(await res.json());
  const auth = getAuth(app);
  const db = getFirestore(app);
  if (isLocal) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }
  return { app, auth, db };
}
