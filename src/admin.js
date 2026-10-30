import {
  GoogleAuthProvider, signInWithPopup, signInWithCredential, signOut, onAuthStateChanged,
} from 'firebase/auth';
import {
  doc, collection, query, where, getDoc, getDocs, setDoc, updateDoc, deleteField,
  onSnapshot, writeBatch, serverTimestamp,
} from 'firebase/firestore';
import qrcode from 'qrcode-generator';
import { initFirebase, isLocal } from './firebase.js';
import {
  SEAT_TYPES, SEAT_TYPE_LABEL, GENDER_LABEL, seatAccepts, settledUids, resizeSeatTypes, tally,
  nextRoundState, nextAction, autoAssign, randomRoomCode, roundDocId,
} from './draft.js';
import {
  $, esc, seatLabel, renderGrid, showModal, confirmModal, errorModal, watchConnection,
} from './ui.js';

const S = {
  auth: null, db: null, user: null,
  roomId: null, room: null, players: {}, votes: [],
  brush: 'M', flip: false,
  unsubs: [],
};

const SCREENS = ['#loadingScreen', '#loginScreen', '#notAdminScreen', '#roomsScreen', '#roomScreen'];
const show = (id) => { for (const s of SCREENS) $(s).hidden = s !== id; };
const roomRef = () => doc(S.db, 'rooms', S.roomId);
const studentUrl = (code) => `${location.origin}/?room=${code}`;
const playerList = () => Object.entries(S.players).map(([uid, p]) => ({ uid, ...p }));
const nameOf = (uid) => esc(S.players[uid]?.name ?? '（退出）');

async function main() {
  watchConnection($('#offline'));
  const { auth, db } = await initFirebase();
  Object.assign(S, { auth, db });

  $('#googleLogin').addEventListener('click', () =>
    signInWithPopup(auth, new GoogleAuthProvider()).catch(errorModal));
  // ローカルのエミュレータ実行時だけ、Google を経由しないテスト用ログインを出す
  if (isLocal) {
    $('#emulatorLogin').hidden = false;
    $('#emulatorLogin').addEventListener('click', () => signInWithCredential(auth,
      GoogleAuthProvider.credential(JSON.stringify({ sub: 'local-teacher', email: 'teacher@example.com', email_verified: true }))).catch(errorModal));
  }
  for (const b of document.querySelectorAll('.logout')) b.addEventListener('click', () => signOut(auth));
  $('#createRoom').addEventListener('submit', onCreateRoom);
  $('#backToRooms').addEventListener('click', () => { leaveRoom(); location.search = ''; });
  $('#showQr').addEventListener('click', showQr);
  $('#flip').addEventListener('change', (e) => { S.flip = e.target.checked; render(); });

  onAuthStateChanged(auth, async (user) => {
    leaveRoom();
    S.user = user;
    if (!user) return show('#loginScreen');
    // 匿名ログイン（生徒用）のまま開かれた場合は Google ログインへ
    if (user.isAnonymous) { await signOut(auth); return; }
    const isAdmin = (await getDoc(doc(db, 'admins', user.uid)).catch(() => null))?.exists();
    if (!isAdmin) {
      $('#myUid').textContent = user.uid;
      $('#myEmail').textContent = user.email || '';
      return show('#notAdminScreen');
    }
    const code = new URLSearchParams(location.search).get('room');
    if (code) openRoom(code.toUpperCase());
    else listRooms();
  });
}

// --- 部屋一覧・作成 ------------------------------------------------------------------

async function listRooms() {
  show('#roomsScreen');
  const qs = await getDocs(query(collection(S.db, 'rooms'), where('ownerUid', '==', S.user.uid)));
  const rooms = qs.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));
  $('#roomList').innerHTML = rooms.length
    ? rooms.map((r) => `<li><a href="?room=${r.id}"><b>${esc(r.className)}</b><span class="muted">コード ${r.id}・${phaseLabel(r.phase)}</span></a></li>`).join('')
    : '<li class="muted">まだ部屋がありません</li>';
}

async function onCreateRoom(e) {
  e.preventDefault();
  const className = $('#newClassName').value.trim();
  if (!className) return;
  try {
    let code;
    do { code = randomRoomCode(); } while ((await getDoc(doc(S.db, 'rooms', code))).exists());
    const rows = 6; const cols = 6;
    await setDoc(doc(S.db, 'rooms', code), {
      ownerUid: S.user.uid, className, createdAt: serverTimestamp(),
      phase: 'setup', drawNo: 1, round: 0, maxRounds: 3, rows, cols,
      seatTypes: resizeSeatTypes({}, rows, cols), assignments: {}, fixedSeats: {},
      eligibleUids: [], reservedSeats: {}, votedCount: 0, eligibleCount: 0,
    });
    location.search = `?room=${code}`;
  } catch (err) { errorModal(err); }
}

// --- 部屋の監視 -------------------------------------------------------------------

function leaveRoom() {
  for (const u of S.unsubs) u();
  S.unsubs = [];
  S.room = null;
}

function openRoom(code) {
  S.roomId = code;
  show('#roomScreen');
  S.unsubs.push(onSnapshot(roomRef(), (snap) => {
    if (!snap.exists()) { location.search = ''; return; }
    const prev = S.room;
    S.room = snap.data();
    if (S.room.ownerUid !== S.user.uid) {
      leaveRoom();
      showModal({ title: '権限がありません', body: 'この部屋の担当ではありません。', tone: 'error' }).then(() => { location.search = ''; });
      return;
    }
    if (!prev || prev.drawNo !== S.room.drawNo || prev.round !== S.room.round) watchVotes();
    render();
  }, errorModal));
  S.unsubs.push(onSnapshot(collection(roomRef(), 'players'), (qs) => {
    S.players = Object.fromEntries(qs.docs.map((d) => [d.id, d.data()]));
    render();
  }));
}

let votesUnsub = null;
function watchVotes() {
  votesUnsub?.();
  const { drawNo, round } = S.room;
  const q = query(collection(roomRef(), 'votes'), where('drawNo', '==', drawNo), where('round', '==', round));
  votesUnsub = onSnapshot(q, (qs) => {
    S.votes = qs.docs.map((d) => d.data());
    render();
  });
  S.unsubs.push(() => votesUnsub?.());
}

/** 生徒画面のバナー用に送信数・対象数を部屋へ反映する（変化したときだけ書く） */
function syncCounts() {
  const r = S.room;
  if (r.phase !== 'voting') return;
  const settled = new Set(settledUids(r.assignments));
  const eligibleCount = r.round === 1
    ? playerList().filter((p) => !settled.has(p.uid)).length
    : r.eligibleUids.length;
  const votedCount = S.votes.length;
  if (r.votedCount !== votedCount || r.eligibleCount !== eligibleCount) {
    updateDoc(roomRef(), { votedCount, eligibleCount }).catch(() => {});
  }
}

// --- 描画 -------------------------------------------------------------------------

function phaseLabel(p) {
  return { setup: '準備中', voting: '投票受付中', locked: '集計中', revealed: '結果発表中', finished: '終了' }[p] || p;
}

function render() {
  const r = S.room;
  if (!r) return;
  syncCounts();
  $('#roomTitle').textContent = r.className;
  $('#printTitle').textContent = `${r.className} 座席表`;
  $('#roomCodeLabel').textContent = S.roomId;
  $('#roomUrl').textContent = studentUrl(S.roomId);
  $('#roomUrl').href = studentUrl(S.roomId);
  $('#flip').checked = S.flip;

  const banner = $('#banner');
  const round = r.round ? `第${r.round}回投票（最大${r.maxRounds}回）` : '';
  banner.textContent = {
    setup: '準備中：座席の属性と固定席を設定し、「投票開始」を押してください',
    voting: `${round}：受付中 ― 送信 ${S.votes.length} / ${r.eligibleCount ?? 0} 人`,
    locked: '集計中…',
    revealed: `${round}：結果発表中`,
    finished: '席替え完了',
  }[r.phase];
  banner.className = `banner banner-${r.phase === 'voting' ? 'action' : 'info'}`;

  renderControls();
  renderSeats();
  renderPlayers();
}

function renderControls() {
  const r = S.room;
  const el = $('#controls');
  if (r.phase === 'setup') {
    el.innerHTML = `
      <div class="row">
        <label>縦（列数） <input type="number" id="rows" min="1" max="12" value="${r.rows}"></label>
        <label>横（席数） <input type="number" id="cols" min="1" max="12" value="${r.cols}"></label>
        <button class="btn" id="applySize">サイズ変更</button>
        <label>最大投票回数 <input type="number" id="maxRounds" min="1" max="10" value="${r.maxRounds}"></label>
      </div>
      <div class="row">
        <span class="muted">クリックで設定：</span>
        ${[...SEAT_TYPES, 'fixed'].map((t) => `
          <label class="chip chip-${t} ${S.brush === t ? 'on' : ''}">
            <input type="radio" name="brush" value="${t}" ${S.brush === t ? 'checked' : ''}>
            ${t === 'fixed' ? '固定席に配置' : SEAT_TYPE_LABEL[t]}
          </label>`).join('')}
      </div>
      <div class="row">
        <span class="muted">一括：</span>
        <button class="btn btn-sm" data-preset="cols">縦の列で男女交互</button>
        <button class="btn btn-sm" data-preset="checker">市松模様</button>
        <button class="btn btn-sm" data-preset="any">全部「誰でも」</button>
      </div>
      <div class="row"><button class="btn btn-primary btn-lg" id="startVoting">投票開始</button>
        <span class="muted" id="capacity"></span></div>`;
    $('#applySize').onclick = applySize;
    $('#maxRounds').onchange = (e) => updateDoc(roomRef(), { maxRounds: clampInt(e.target.value, 1, 10) });
    for (const i of el.querySelectorAll('input[name=brush]')) i.onchange = (e) => { S.brush = e.target.value; render(); };
    for (const b of el.querySelectorAll('[data-preset]')) b.onclick = () => applyPreset(b.dataset.preset);
    $('#startVoting').onclick = startVoting;
    $('#capacity').innerHTML = capacityText();
  } else if (r.phase === 'voting') {
    const voted = new Set(S.votes.map((v) => v.uid));
    const settled = new Set(settledUids(r.assignments));
    const targets = r.round === 1
      ? playerList().filter((p) => !settled.has(p.uid)).map((p) => p.uid)
      : r.eligibleUids;
    const notYet = targets.filter((u) => !voted.has(u));
    el.innerHTML = `
      <div class="row"><button class="btn btn-primary btn-lg" id="closeVoting">締め切って結果を確定</button></div>
      <p class="muted">未送信（${notYet.length}人）：${notYet.map(nameOf).join('、') || 'なし'}</p>
      <p class="muted">未送信の人は無視して確定します。</p>`;
    $('#closeVoting').onclick = closeVoting;
  } else if (r.phase === 'locked') {
    el.innerHTML = `<p>集計中です。画面が進まない場合は <button class="btn btn-sm" id="retryClose">集計をやり直す</button></p>`;
    $('#retryClose').onclick = () => tallyAndReveal();
  } else if (r.phase === 'revealed') {
    el.innerHTML = '<p class="muted">結果を読み込み中…</p>';
    loadResult().then((res) => {
      if (S.room?.phase !== 'revealed' || !res) return;
      const action = nextAction({ round: r.round, maxRounds: r.maxRounds, conflicts: res.conflicts });
      el.innerHTML = `
        <p>確定 <b>${res.settled.length}</b> 人 ／ 競合 <b>${res.conflicts.length}</b> 席
          ${res.conflicts.map((c) => `<br>⚔ ${seatLabel(c.seatId)}：${c.uids.map(nameOf).join('・')}`).join('')}</p>
        ${res.conflicts.length ? '<p class="muted">競合した人はじゃんけん等で決めてください。勝った人は同じ席、負けた人は別の席に再投票します。</p>' : ''}
        <div class="row">
          ${action === 'nextRound'
            ? `<button class="btn btn-primary btn-lg" id="nextRound">第${r.round + 1}回投票へ（競合者のみ）</button>
               <button class="btn" id="finish">ここで終了して残りを自動振り分け</button>`
            : `<button class="btn btn-primary btn-lg" id="finish">残りを自動振り分けして終了</button>`}
        </div>`;
      $('#nextRound')?.addEventListener('click', () => startNextRound(res));
      $('#finish').addEventListener('click', finish);
    });
  } else if (r.phase === 'finished') {
    el.innerHTML = `
      <div class="row">
        <button class="btn btn-primary" id="print">印刷</button>
        <button class="btn" id="csv">CSV 出力</button>
        <span class="muted">席をクリックすると手動で修正できます</span>
      </div>
      <div class="row">
        <button class="btn" id="newDraw">新しい席替えを始める（固定席は維持）</button>
        <button class="btn btn-danger" id="deleteRoom">この部屋を削除</button>
      </div>`;
    $('#print').onclick = () => window.print();
    $('#csv').onclick = downloadCsv;
    $('#newDraw').onclick = newDraw;
    $('#deleteRoom').onclick = deleteRoom;
  }
}

function capacityText() {
  const r = S.room;
  const settled = new Set(settledUids(r.assignments));
  const free = Object.keys(r.seatTypes).filter((s) => r.seatTypes[s] !== 'none' && !r.assignments?.[s]);
  const pending = playerList().filter((p) => !settled.has(p.uid));
  const fit = (g) => free.filter((s) => seatAccepts(r.seatTypes[s], g)).length;
  const need = (g) => pending.filter((p) => p.gender === g).length;
  const warn = (g) => (need(g) > fit(g) ? ' ⚠ 席が足りません' : '');
  return `参加 ${playerList().length} 人 ／ 空席 ${free.length}<br>
    男子 ${need('M')} 人（座れる席 ${fit('M')}）${warn('M')}　女子 ${need('F')} 人（座れる席 ${fit('F')}）${warn('F')}`;
}

function renderSeats() {
  const r = S.room;
  const votesBySeat = {};
  if (r.phase === 'voting') for (const v of S.votes) (votesBySeat[v.seatId] ||= []).push(v.uid);
  const clickable = r.phase === 'setup' || r.phase === 'finished';

  renderGrid($('#seatGrid'), r, (id) => {
    const owner = r.assignments?.[id];
    const cls = [];
    let html = `<span class="seat-type">${SEAT_TYPE_LABEL[r.seatTypes[id]]}</span>`;
    if (owner) {
      cls.push('seat-taken');
      if (r.fixedSeats?.[id]) { cls.push('seat-fixed'); html += '<span class="seat-tag">固定</span>'; }
      html += `<span class="seat-name">${nameOf(owner)}</span>`;
    }
    if (r.reservedSeats?.[id] && r.phase === 'voting') {
      cls.push('seat-reserved');
      html += `<span class="seat-tag">⚔ ${r.reservedSeats[id].map(nameOf).join('・')}</span>`;
    }
    const v = votesBySeat[id];
    if (v) {
      cls.push(v.length > 1 ? 'seat-conflict' : 'seat-voted');
      html += `<span class="seat-votes">${v.map(nameOf).join('<br>')}</span>`;
    }
    return { cls: cls.join(' '), html, onClick: clickable ? onSeatClick : null };
  }, { flip: S.flip });
}

function renderPlayers() {
  const r = S.room;
  const seatOf = Object.fromEntries(Object.entries(r.assignments || {}).filter(([, u]) => u).map(([s, u]) => [u, s]));
  const voted = new Set(S.votes.map((v) => v.uid));
  const list = playerList().sort((a, b) => (a.joinedAt?.seconds ?? 0) - (b.joinedAt?.seconds ?? 0));
  $('#playerCount').textContent = `${list.length} 人`;
  $('#playerList').innerHTML = list.map((p) => {
    const status = seatOf[p.uid] ? seatLabel(seatOf[p.uid])
      : r.phase === 'voting' ? (voted.has(p.uid) ? '送信済み' : '未送信') : '未確定';
    return `<li>
      <span class="pname">${esc(p.name)}</span>
      <button class="btn btn-sm gender-${p.gender}" data-gender="${p.uid}" title="クリックで男女を切り替え">${GENDER_LABEL[p.gender]}</button>
      <span class="muted">${status}</span>
      <button class="btn btn-sm btn-ghost" data-remove="${p.uid}" title="削除">✕</button>
    </li>`;
  }).join('') || '<li class="muted">まだ誰も参加していません</li>';
  for (const b of document.querySelectorAll('[data-gender]')) b.onclick = () => toggleGender(b.dataset.gender);
  for (const b of document.querySelectorAll('[data-remove]')) b.onclick = () => removePlayer(b.dataset.remove);
}

// --- 準備 -------------------------------------------------------------------------

const clampInt = (v, min, max) => Math.max(min, Math.min(max, parseInt(v, 10) || min));

async function applySize() {
  const rows = clampInt($('#rows').value, 1, 12);
  const cols = clampInt($('#cols').value, 1, 12);
  const seatTypes = resizeSeatTypes(S.room.seatTypes, rows, cols);
  const keep = (m) => Object.fromEntries(Object.entries(m || {}).filter(([s]) => s in seatTypes));
  await updateDoc(roomRef(), {
    rows, cols, seatTypes, assignments: keep(S.room.assignments), fixedSeats: keep(S.room.fixedSeats),
  }).catch(errorModal);
}

async function applyPreset(kind) {
  const { rows, cols } = S.room;
  const seatTypes = {};
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      const prev = S.room.seatTypes[`r${r}c${c}`];
      seatTypes[`r${r}c${c}`] = prev === 'none' ? 'none'
        : kind === 'any' ? 'any'
          : kind === 'cols' ? (c % 2 ? 'M' : 'F')
            : ((r + c) % 2 ? 'F' : 'M');
    }
  }
  await updateDoc(roomRef(), { seatTypes }).catch(errorModal);
}

async function onSeatClick(id) {
  const r = S.room;
  if (r.phase === 'finished' || S.brush === 'fixed') return assignManually(id);
  const upd = { [`seatTypes.${id}`]: S.brush };
  if (S.brush === 'none' && r.assignments?.[id]) {
    upd[`assignments.${id}`] = deleteField();
    upd[`fixedSeats.${id}`] = deleteField();
  }
  await updateDoc(roomRef(), upd).catch(errorModal);
}

/** 固定席の配置（準備中）・終了後の手動修正 */
async function assignManually(id) {
  const r = S.room;
  if (r.seatTypes[id] === 'none') return;
  const settled = new Set(settledUids(r.assignments));
  const current = r.assignments?.[id];
  const candidates = playerList()
    .filter((p) => (!settled.has(p.uid) || p.uid === current) && seatAccepts(r.seatTypes[id], p.gender));
  const opts = candidates.map((p) => `<option value="${p.uid}" ${p.uid === current ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const isSetup = r.phase === 'setup';
  const res = await showModal({
    title: `${seatLabel(id)} に${isSetup ? '固定配置' : '配置'}`,
    body: candidates.length
      ? `<select id="pickPlayer" class="input"><option value="">（空席にする）</option>${opts}</select>
         <p class="muted">${SEAT_TYPE_LABEL[r.seatTypes[id]]}席に座れる未確定の生徒だけが表示されます。</p>`
      : `<p>この席に座れる未確定の生徒がいません。</p><input type="hidden" id="pickPlayer" value="">`,
    buttons: [{ label: 'キャンセル', value: false }, { label: '決定', value: true, primary: true }],
  });
  if (!res) return;
  const uid = $('#pickPlayer').value;
  const upd = uid
    ? { [`assignments.${id}`]: uid, [`fixedSeats.${id}`]: isSetup ? true : deleteField() }
    : { [`assignments.${id}`]: deleteField(), [`fixedSeats.${id}`]: deleteField() };
  await updateDoc(roomRef(), upd).catch(errorModal);
}

async function toggleGender(uid) {
  const p = S.players[uid];
  await updateDoc(doc(roomRef(), 'players', uid), { gender: p.gender === 'M' ? 'F' : 'M' }).catch(errorModal);
}

async function removePlayer(uid) {
  const p = S.players[uid];
  const ok = await confirmModal('参加者を削除', `<b>${esc(p.name)}</b> さんを削除しますか？<br><small>確定済みの席も空席に戻ります。本人はもう一度参加できます。</small>`, '削除する');
  if (!ok) return;
  const batch = writeBatch(S.db);
  const upd = {};
  for (const [s, u] of Object.entries(S.room.assignments || {})) {
    if (u === uid) { upd[`assignments.${s}`] = deleteField(); upd[`fixedSeats.${s}`] = deleteField(); }
  }
  if (Object.keys(upd).length) batch.update(roomRef(), upd);
  batch.delete(doc(roomRef(), 'players', uid));
  await batch.commit().catch(errorModal);
}

// --- 進行 -------------------------------------------------------------------------

async function startVoting() {
  const ok = await confirmModal('投票を開始しますか？', `${capacityText()}<br><br><small>開始後は座席のレイアウトを変更できません。</small>`, '開始する', 'info');
  if (!ok) return;
  await updateDoc(roomRef(), {
    phase: 'voting', round: 1, eligibleUids: [], reservedSeats: {}, votedCount: 0,
  }).catch(errorModal);
}

async function closeVoting() {
  const ok = await confirmModal('締め切りますか？', `送信 ${S.votes.length} 人分で結果を確定し、全員に発表します。`, '確定して発表', 'info');
  if (!ok) return;
  await tallyAndReveal();
}

async function tallyAndReveal() {
  try {
    // 先に締め切ってから集計する（集計中に票が増えないよう、ルールで投票を拒否させる）
    await updateDoc(roomRef(), { phase: 'locked' });
    const { drawNo, round, assignments } = S.room;
    const qs = await getDocs(query(collection(roomRef(), 'votes'),
      where('drawNo', '==', drawNo), where('round', '==', round)));
    const votes = qs.docs.map((d) => d.data())
      .filter((v) => !assignments?.[v.seatId])
      .map((v) => ({ uid: v.uid, seatId: v.seatId }));
    const { settled, conflicts } = tally(votes);

    const batch = writeBatch(S.db);
    const upd = { phase: 'revealed', votedCount: votes.length };
    for (const s of settled) upd[`assignments.${s.seatId}`] = s.uid;
    batch.update(roomRef(), upd);
    batch.set(doc(roomRef(), 'rounds', roundDocId(drawNo, round)), {
      kind: 'round', drawNo, round, votes, settled, conflicts, at: serverTimestamp(),
    });
    await batch.commit();
  } catch (err) { errorModal(err); }
}

const resultCache = {};
async function loadResult() {
  const key = `${S.roomId}/${roundDocId(S.room.drawNo, S.room.round)}`;
  if (!resultCache[key]) {
    const snap = await getDoc(doc(S.db, 'rooms', S.roomId, 'rounds', key.split('/')[1]));
    if (snap.exists()) resultCache[key] = snap.data();
  }
  return resultCache[key] ?? null;
}

async function startNextRound(res) {
  const { reservedSeats, eligibleUids } = nextRoundState(res.conflicts);
  await updateDoc(roomRef(), {
    phase: 'voting', round: S.room.round + 1, reservedSeats, eligibleUids,
    votedCount: 0, eligibleCount: eligibleUids.length,
  }).catch(errorModal);
}

async function finish() {
  const r = S.room;
  const { assigned, unassigned } = autoAssign({
    players: playerList(), seatTypes: r.seatTypes, assignments: r.assignments,
  });
  const body = `未確定の <b>${assigned.length + unassigned.length}</b> 人を空席にランダムで振り分けます。`
    + (unassigned.length ? `<br>⚠ 座れる席がないため <b>${unassigned.map(nameOf).join('、')}</b> は未配置になります（後で手動修正できます）。` : '');
  if (!(await confirmModal('終了して自動振り分け', body, '振り分けて終了', 'info'))) return;

  const batch = writeBatch(S.db);
  const upd = { phase: 'finished', reservedSeats: {}, eligibleUids: [] };
  for (const a of assigned) upd[`assignments.${a.seatId}`] = a.uid;
  batch.update(roomRef(), upd);
  batch.set(doc(roomRef(), 'rounds', roundDocId(r.drawNo, 'auto')), {
    kind: 'auto', drawNo: r.drawNo, assigned, unassigned, at: serverTimestamp(),
  });
  await batch.commit().catch(errorModal);
}

// --- 終了後 -----------------------------------------------------------------------

function downloadCsv() {
  const r = S.room;
  const lines = [['列', '番', '名前', '性別', '固定']];
  for (let row = 1; row <= r.rows; row++) {
    for (let col = 1; col <= r.cols; col++) {
      const id = `r${row}c${col}`;
      const p = S.players[r.assignments?.[id]];
      if (r.seatTypes[id] === 'none') continue;
      lines.push([row, col, p?.name ?? '', p ? GENDER_LABEL[p.gender] : '', r.fixedSeats?.[id] ? '○' : '']);
    }
  }
  const csv = lines.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = `${r.className}_座席表.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function newDraw() {
  const ok = await confirmModal('新しい席替えを始める',
    '固定席以外の配置をすべて空席に戻し、準備画面に戻ります。参加者はそのまま残ります。', '始める');
  if (!ok) return;
  const r = S.room;
  const assignments = Object.fromEntries(Object.entries(r.assignments || {}).filter(([s]) => r.fixedSeats?.[s]));
  await updateDoc(roomRef(), {
    phase: 'setup', drawNo: r.drawNo + 1, round: 0, assignments,
    reservedSeats: {}, eligibleUids: [], votedCount: 0, eligibleCount: 0,
  }).catch(errorModal);
}

async function deleteRoom() {
  const ok = await confirmModal('部屋を削除', '参加者の名前・投票・結果をすべて削除します。元に戻せません。<br>先に印刷や CSV 出力を済ませてください。', '削除する', 'error');
  if (!ok) return;
  try {
    leaveRoom();
    for (const sub of ['votes', 'rounds', 'players']) {
      const qs = await getDocs(collection(doc(S.db, 'rooms', S.roomId), sub));
      for (let i = 0; i < qs.docs.length; i += 400) {
        const batch = writeBatch(S.db);
        for (const d of qs.docs.slice(i, i + 400)) batch.delete(d.ref);
        await batch.commit();
      }
    }
    const batch = writeBatch(S.db);
    batch.delete(doc(S.db, 'rooms', S.roomId));
    await batch.commit();
    location.search = '';
  } catch (err) { errorModal(err); }
}

function showQr() {
  const url = studentUrl(S.roomId);
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  showModal({
    title: `参加コード ${S.roomId}`,
    body: `<div class="qr">${qr.createSvgTag({ cellSize: 10, margin: 2, scalable: true })}</div>
      <p class="qr-url">${esc(url)}</p>`,
  });
}

main().catch(errorModal);
