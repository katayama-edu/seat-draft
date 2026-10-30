import { test, before, beforeEach, after } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';

let env;
const ROOM = 'ABC123';
const TEACHER = 'teacher1';

const baseRoom = {
  ownerUid: TEACHER,
  phase: 'voting',
  drawNo: 1,
  round: 1,
  maxRounds: 3,
  rows: 1,
  cols: 4,
  seatTypes: { r1c1: 'M', r1c2: 'F', r1c3: 'any', r1c4: 'none' },
  assignments: { r1c1: null, r1c2: null, r1c3: null, r1c4: null },
  eligibleUids: [],
  reservedSeats: {},
};

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-seat-draft',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(() => env.cleanup());

async function seed(roomPatch = {}, players = { boy: 'M', girl: 'F', boy2: 'M' }) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'admins', TEACHER), { name: 'T' });
    await setDoc(doc(db, 'rooms', ROOM), { ...baseRoom, ...roomPatch });
    for (const [uid, gender] of Object.entries(players)) {
      await setDoc(doc(db, 'rooms', ROOM, 'players', uid), { name: uid, gender });
    }
  });
}
beforeEach(() => seed());

const db = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
const vote = (uid, seatId, { drawNo = 1, round = 1, id } = {}) =>
  setDoc(doc(db(uid), 'rooms', ROOM, 'votes', id ?? `${drawNo}-${round}-${uid}`), {
    uid, drawNo, round, seatId, createdAt: serverTimestamp(),
  });

// --- 管理者権限 ---------------------------------------------------------------

test('生徒は部屋を書き換えられない（席の直接確定を防ぐ）', async () => {
  await assertFails(updateDoc(doc(db('boy'), 'rooms', ROOM), { 'assignments.r1c1': 'boy' }));
});

test('admins 未登録のユーザーは部屋を作れない', async () => {
  await assertFails(setDoc(doc(db('stranger'), 'rooms', 'NEW1'), { ...baseRoom, ownerUid: 'stranger' }));
});

test('登録済み教員は自分の部屋を作成・更新できる', async () => {
  await assertSucceeds(setDoc(doc(db(TEACHER), 'rooms', 'NEW1'), baseRoom));
  await assertSucceeds(updateDoc(doc(db(TEACHER), 'rooms', ROOM), { phase: 'locked' }));
});

test('自分で admins に登録することはできない', async () => {
  await assertFails(setDoc(doc(db('boy'), 'admins', 'boy'), { name: 'x' }));
});

test('別の教員は他人の部屋を更新できない', async () => {
  await env.withSecurityRulesDisabled((ctx) =>
    setDoc(doc(ctx.firestore(), 'admins', 'teacher2'), { name: 'T2' }));
  await assertFails(updateDoc(doc(db('teacher2'), 'rooms', ROOM), { phase: 'locked' }));
});

test('未ログインでは部屋を読めない', async () => {
  await assertFails(getDoc(doc(db(null), 'rooms', ROOM)));
});

// --- 参加登録 -----------------------------------------------------------------

test('生徒は自分の参加登録を作れるが、他人の分は作れない', async () => {
  const d = db('newkid');
  await assertSucceeds(setDoc(doc(d, 'rooms', ROOM, 'players', 'newkid'),
    { name: '太郎', gender: 'M', joinedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(d, 'rooms', ROOM, 'players', 'other'),
    { name: '花子', gender: 'F', joinedAt: serverTimestamp() }));
});

test('生徒は登録後に性別を変えられない', async () => {
  await assertFails(updateDoc(doc(db('boy'), 'rooms', ROOM, 'players', 'boy'), { gender: 'F' }));
});

test('余計なフィールドや不正な性別は拒否', async () => {
  const d = db('newkid');
  await assertFails(setDoc(doc(d, 'rooms', ROOM, 'players', 'newkid'),
    { name: 'x', gender: 'X', joinedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(d, 'rooms', ROOM, 'players', 'newkid'),
    { name: 'x', gender: 'M', joinedAt: serverTimestamp(), isAdmin: true }));
});

test('教員は参加者の性別を修正できる', async () => {
  await assertSucceeds(updateDoc(doc(db(TEACHER), 'rooms', ROOM, 'players', 'boy'), { gender: 'F' }));
});

// --- 投票 ---------------------------------------------------------------------

test('性別の合う空席に投票できる', async () => {
  await assertSucceeds(vote('boy', 'r1c1'));
  await assertSucceeds(vote('girl', 'r1c3'));
});

test('性別の合わない席・使用不可・存在しない席には投票できない', async () => {
  await assertFails(vote('boy', 'r1c2'));
  await assertFails(vote('boy', 'r1c4'));
  await assertFails(vote('boy', 'r9c9'));
});

test('投票は変更できない（同じ ID への再書き込みも削除も不可）', async () => {
  await assertSucceeds(vote('boy', 'r1c1'));
  await assertFails(vote('boy', 'r1c3'));
  await assertFails(deleteDoc(doc(db('boy'), 'rooms', ROOM, 'votes', '1-1-boy')));
});

test('なりすまし投票・ID 形式違反は拒否', async () => {
  await assertFails(setDoc(doc(db('boy'), 'rooms', ROOM, 'votes', '1-1-boy2'),
    { uid: 'boy2', drawNo: 1, round: 1, seatId: 'r1c1', createdAt: serverTimestamp() }));
  await assertFails(vote('boy', 'r1c1', { id: 'whatever' }));
  await assertFails(vote('boy', 'r1c1', { round: 2 }));
});

test('投票受付中以外は投票できない', async () => {
  await seed({ phase: 'locked' });
  await assertFails(vote('boy', 'r1c1'));
});

test('確定済みの席・確定済みの生徒は投票できない', async () => {
  await seed({ assignments: { ...baseRoom.assignments, r1c1: 'boy2' } });
  await assertFails(vote('boy', 'r1c1'));
  await assertFails(vote('boy2', 'r1c3'));
});

test('参加登録していない人は投票できない', async () => {
  await assertFails(vote('ghost', 'r1c3'));
});

test('2 回目以降は競合した人だけが投票でき、競合席はその当事者だけ', async () => {
  await seed({
    round: 2,
    eligibleUids: ['boy', 'boy2'],
    reservedSeats: { r1c1: ['boy', 'boy2'] },
  });
  await assertFails(vote('girl', 'r1c3', { round: 2 }));        // 競合していない
  await assertSucceeds(vote('boy', 'r1c1', { round: 2 }));       // 勝者は同じ席へ
  await assertSucceeds(vote('boy2', 'r1c3', { round: 2 }));      // 敗者は別の席へ
});

test('競合していない人は他人の競合席に投票できない', async () => {
  await seed({
    round: 2,
    eligibleUids: ['boy', 'boy2', 'girl'],
    reservedSeats: { r1c1: ['boy', 'boy2'], r1c3: ['girl', 'x'] },
  });
  await assertFails(vote('girl', 'r1c1', { round: 2 }));
  await assertFails(vote('boy', 'r1c3', { round: 2 }));
});

test('投票内容は発表前、本人と担当教員しか読めない', async () => {
  await assertSucceeds(vote('boy', 'r1c1'));
  await assertSucceeds(getDoc(doc(db('boy'), 'rooms', ROOM, 'votes', '1-1-boy')));
  await assertSucceeds(getDoc(doc(db(TEACHER), 'rooms', ROOM, 'votes', '1-1-boy')));
  await assertFails(getDoc(doc(db('girl'), 'rooms', ROOM, 'votes', '1-1-boy')));
});

test('投票前でも自分の票（未作成）は読めるが、他人の分は読めない', async () => {
  await assertSucceeds(getDoc(doc(db('boy'), 'rooms', ROOM, 'votes', '1-1-boy')));
  await assertFails(getDoc(doc(db('girl'), 'rooms', ROOM, 'votes', '1-1-boy')));
});

test('ラウンド結果は全員が読めるが、書けるのは担当教員だけ', async () => {
  await assertSucceeds(setDoc(doc(db(TEACHER), 'rooms', ROOM, 'rounds', '1-1'), { votes: [] }));
  await assertSucceeds(getDoc(doc(db('girl'), 'rooms', ROOM, 'rounds', '1-1')));
  await assertFails(setDoc(doc(db('girl'), 'rooms', ROOM, 'rounds', '1-1'), { votes: [] }));
});
