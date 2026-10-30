import { signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import {
  doc, collection, getDoc, setDoc, onSnapshot, serverTimestamp,
} from 'firebase/firestore';
import { initFirebase } from './firebase.js';
import { seatAccepts, settledUids, voteDocId, roundDocId, GENDER_LABEL } from './draft.js';
import {
  $, esc, seatLabel, renderGrid, showModal, confirmModal, errorModal, watchConnection,
} from './ui.js';

const S = {
  db: null, uid: null, roomId: null,
  room: null, players: {}, me: null,
  myVote: null,      // 現在ラウンドの自分の票 (seatId)
  result: null,      // 直近に公開されたラウンド結果
  selected: null,
  unsubs: [],
};

const show = (id) => {
  for (const s of ['#loadingScreen', '#roomScreen', '#joinScreen', '#gameScreen']) $(s).hidden = s !== id;
};

async function main() {
  watchConnection($('#offline'));
  const { auth, db } = await initFirebase();
  S.db = db;
  await signInAnonymously(auth);
  onAuthStateChanged(auth, (u) => { if (u) S.uid = u.uid; });
  S.uid = auth.currentUser.uid;

  const code = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (code) await enterRoom(code);
  else show('#roomScreen');

  $('#roomForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const c = $('#roomCode').value.trim().toUpperCase();
    if (c) await enterRoom(c);
  });
  $('#joinForm').addEventListener('submit', onJoin);
  $('#submitVote').addEventListener('click', onSubmitVote);
}

async function enterRoom(code) {
  const snap = await getDoc(doc(S.db, 'rooms', code));
  if (!snap.exists()) {
    show('#roomScreen');
    await showModal({ title: '部屋が見つかりません', body: `コード「${esc(code)}」の部屋はありません。先生に確認してください。`, tone: 'error' });
    return;
  }
  S.roomId = code;
  history.replaceState(null, '', `?room=${code}`);
  const meSnap = await getDoc(doc(S.db, 'rooms', code, 'players', S.uid));
  if (meSnap.exists()) startGame();
  else {
    $('#joinClass').textContent = snap.data().className || '';
    show('#joinScreen');
  }
}

async function onJoin(e) {
  e.preventDefault();
  const name = $('#joinName').value.trim();
  const gender = new FormData(e.target).get('gender');
  if (!name || !gender) return;
  const ok = await confirmModal('この内容で参加しますか？',
    `名前：<b>${esc(name)}</b><br>性別：<b>${GENDER_LABEL[gender]}</b><br><small>参加後は自分で変更できません（間違えたら先生に伝えてください）</small>`,
    '参加する', 'info');
  if (!ok) return;
  try {
    await setDoc(doc(S.db, 'rooms', S.roomId, 'players', S.uid),
      { name, gender, joinedAt: serverTimestamp() });
    startGame();
  } catch (err) { errorModal(err); }
}

function startGame() {
  show('#gameScreen');
  const roomRef = doc(S.db, 'rooms', S.roomId);
  S.unsubs.push(onSnapshot(roomRef, (snap) => {
    const prev = S.room;
    S.room = snap.data();
    if (!S.room) return;
    if (!prev || prev.drawNo !== S.room.drawNo || prev.round !== S.room.round) {
      watchMyVote();
      S.selected = null;
    }
    if (['revealed', 'finished'].includes(S.room.phase)) watchResult();
    render();
  }));
  S.unsubs.push(onSnapshot(collection(roomRef, 'players'), (qs) => {
    S.players = Object.fromEntries(qs.docs.map((d) => [d.id, d.data()]));
    S.me = S.players[S.uid] || null;
    render();
  }));
}

let voteUnsub = null;
function watchMyVote() {
  voteUnsub?.();
  S.myVote = null;
  const { drawNo, round } = S.room;
  if (!round) return;
  voteUnsub = onSnapshot(doc(S.db, 'rooms', S.roomId, 'votes', voteDocId(drawNo, round, S.uid)), (snap) => {
    S.myVote = snap.exists() ? snap.data().seatId : null;
    render();
  });
}

let resultKey = null;
let resultUnsub = null;
function watchResult() {
  const key = S.room.phase === 'finished' ? roundDocId(S.room.drawNo, 'auto') : roundDocId(S.room.drawNo, S.room.round);
  if (key === resultKey) return;
  resultKey = key;
  resultUnsub?.();
  resultUnsub = onSnapshot(doc(S.db, 'rooms', S.roomId, 'rounds', key), (snap) => {
    if (!snap.exists()) return;
    S.result = snap.data();
    render();
    announce(key);
  });
}

// --- 結果発表ポップアップ ---------------------------------------------------------

function announce(key) {
  const storeKey = `seen:${S.roomId}:${key}`;
  try { if (localStorage.getItem(storeKey)) return; localStorage.setItem(storeKey, '1'); } catch { /* 表示は続ける */ }

  const r = S.result;
  const mySeat = Object.entries(S.room.assignments || {}).find(([, u]) => u === S.uid)?.[0];
  if (r.kind === 'auto') {
    const mine = r.assigned?.find((a) => a.uid === S.uid);
    if (mine) showModal({ title: '自動振り分け', body: `あなたの席は <b>${seatLabel(mine.seatId)}</b> になりました。`, tone: 'success' });
    else if (mySeat) showModal({ title: '席替え完了！', body: `あなたの席は <b>${seatLabel(mySeat)}</b> です。`, tone: 'success' });
    return;
  }
  const settled = r.settled?.find((x) => x.uid === S.uid);
  const conflict = r.conflicts?.find((c) => c.uids.includes(S.uid));
  if (settled) {
    showModal({ title: '確定！', body: `<b>${seatLabel(settled.seatId)}</b> に決まりました！`, tone: 'success' });
  } else if (conflict) {
    const rivals = conflict.uids.filter((u) => u !== S.uid).map((u) => esc(S.players[u]?.name ?? '?')).join('、');
    showModal({
      title: '競合しました',
      tone: 'warn',
      body: `<b>${seatLabel(conflict.seatId)}</b> で <b>${rivals}</b> さんと競合しました。<br><br>
        じゃんけん等で決めてください。<br>
        ・<b>勝った人</b>：同じ席にもう一度投票<br>
        ・<b>負けた人</b>：別の空いている席に投票`,
    });
  } else if (!mySeat && S.room.round === 1) {
    showModal({ title: '結果発表', body: '今回は投票していませんでした。最後に自動で振り分けられます。' });
  }
}

// --- 描画 ---------------------------------------------------------------------

function myStatus() {
  const room = S.room;
  const mySeat = Object.entries(room.assignments || {}).find(([, u]) => u === S.uid)?.[0];
  if (mySeat) return { kind: 'settled', seat: mySeat };
  if (room.phase !== 'voting') return { kind: room.phase };
  if (room.round > 1 && !(room.eligibleUids || []).includes(S.uid)) return { kind: 'waiting' };
  if (S.myVote) return { kind: 'voted' };
  return { kind: 'canVote' };
}

function canPick(seatId) {
  const room = S.room;
  if (!S.me || room.assignments?.[seatId]) return false;
  if (!seatAccepts(room.seatTypes[seatId], S.me.gender)) return false;
  const reserved = room.reservedSeats?.[seatId];
  return !reserved || reserved.includes(S.uid);
}

function render() {
  const room = S.room;
  if (!room || !S.me) return;
  const st = myStatus();
  const nameOf = (u) => esc(S.players[u]?.name ?? '');

  $('#className').textContent = room.className || '';
  $('#meLabel').textContent = `${S.me.name}（${GENDER_LABEL[S.me.gender]}）`;

  const banner = $('#banner');
  const roundLabel = room.round ? `第${room.round}回投票` : '';
  const counts = room.phase === 'voting' ? `（送信済み ${room.votedCount ?? 0} / ${room.eligibleCount ?? 0} 人）` : '';
  const msg = {
    settled: [`あなたの席は ${seatLabel(st.seat)} です`, 'success'],
    setup: ['先生が準備中です。開始までお待ちください', 'info'],
    locked: ['締め切りました。集計中…', 'info'],
    revealed: ['結果発表！ 次の投票をお待ちください', 'info'],
    finished: ['席替えは終了しました', 'info'],
    waiting: [`${roundLabel}：競合した人の再投票中です。お待ちください ${counts}`, 'info'],
    voted: [`${roundLabel}：送信済みです（変更できません）。結果発表を待っています ${counts}`, 'info'],
    canVote: [`${roundLabel}：座りたい席を選んで送信してください ${counts}`, 'action'],
  }[st.kind];
  banner.textContent = msg[0];
  banner.className = `banner banner-${msg[1]}`;

  // 結果発表後は今回の投票先を全員に公開する
  const revealedVotes = {};
  if (room.phase === 'revealed' && S.result?.round === room.round && S.result.drawNo === room.drawNo) {
    for (const v of S.result.votes || []) (revealedVotes[v.seatId] ||= []).push(v.uid);
  }

  const voting = st.kind === 'canVote';
  renderGrid($('#seatGrid'), room, (id) => {
    const type = room.seatTypes[id];
    if (type === 'none') return { cls: 'seat-off' };
    const owner = room.assignments?.[id];
    if (owner) {
      return {
        cls: `seat-taken ${owner === S.uid ? 'seat-mine' : ''} ${room.fixedSeats?.[id] ? 'seat-fixed' : ''}`,
        html: `<span class="seat-name">${nameOf(owner)}</span>`,
      };
    }
    const cls = [];
    let html = '';
    const reserved = room.reservedSeats?.[id];
    if (reserved && room.phase === 'voting') {
      cls.push('seat-reserved');
      html += `<span class="seat-tag">⚔ 競合中</span><span class="seat-sub">${reserved.map(nameOf).join('・')}</span>`;
    }
    if (revealedVotes[id]) {
      cls.push(revealedVotes[id].length > 1 ? 'seat-conflict' : '');
      html += `<span class="seat-sub">${revealedVotes[id].map(nameOf).join('・')}</span>`;
    }
    if (S.myVote === id) { cls.push('seat-voted'); html += '<span class="seat-tag">送信済み</span>'; }
    if (S.selected === id) cls.push('seat-selected');
    const pickable = voting && canPick(id);
    if (voting && !pickable) cls.push('seat-dim');
    return { cls: cls.join(' '), html, onClick: pickable ? onPick : null };
  });

  $('#voteBar').hidden = !voting;
  $('#selectedLabel').textContent = S.selected ? seatLabel(S.selected) : '席を選んでください';
  $('#submitVote').disabled = !S.selected;
}

function onPick(id) {
  S.selected = S.selected === id ? null : id;
  render();
}

async function onSubmitVote() {
  const seat = S.selected;
  if (!seat) return;
  const ok = await confirmModal('この席で送信しますか？',
    `<b>${seatLabel(seat)}</b><br><small>送信後は変更できません。</small>`, '送信する', 'info');
  if (!ok) return;
  const { drawNo, round } = S.room;
  $('#submitVote').disabled = true;
  try {
    await setDoc(doc(S.db, 'rooms', S.roomId, 'votes', voteDocId(drawNo, round, S.uid)), {
      uid: S.uid, drawNo, round, seatId: seat, createdAt: serverTimestamp(),
    });
    S.selected = null;
  } catch (err) {
    showModal({
      title: '送信できませんでした',
      tone: 'error',
      body: '締め切られたか、その席には投票できません。画面を確認してもう一度選んでください。',
    });
    render();
  }
}

main().catch((e) => {
  show('#roomScreen');
  errorModal(e);
});
