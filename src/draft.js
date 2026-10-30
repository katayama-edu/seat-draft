// 席替えドラフトの純粋ロジック（Firestore に依存しない。ブラウザとテストで共用）

export const SEAT_TYPES = ['M', 'F', 'any', 'none'];
export const SEAT_TYPE_LABEL = { M: '男子', F: '女子', any: '誰でも', none: '使用不可' };
export const GENDER_LABEL = { M: '男子', F: '女子' };

export const seatId = (row, col) => `r${row}c${col}`;

/** cols × rows のレイアウトに合わせて seatTypes を作り直す（既存の設定は引き継ぐ） */
export function resizeSeatTypes(seatTypes, rows, cols, defaultType = 'any') {
  const next = {};
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      const id = seatId(r, c);
      next[id] = seatTypes?.[id] ?? defaultType;
    }
  }
  return next;
}

/** 座席に投票・配置できる性別か */
export const seatAccepts = (seatType, gender) => seatType === 'any' || seatType === gender;

/** 確定済みの uid 一覧 */
export const settledUids = (assignments) => Object.values(assignments || {}).filter(Boolean);

/**
 * 1 ラウンド分の投票を集計する。
 * @param {{uid:string, seatId:string}[]} votes
 * @returns {{settled:{uid:string,seatId:string}[], conflicts:{seatId:string,uids:string[]}[]}}
 */
export function tally(votes) {
  const bySeat = new Map();
  for (const v of votes) {
    if (!bySeat.has(v.seatId)) bySeat.set(v.seatId, []);
    bySeat.get(v.seatId).push(v.uid);
  }
  const settled = [];
  const conflicts = [];
  for (const [seat, uids] of bySeat) {
    if (uids.length === 1) settled.push({ uid: uids[0], seatId: seat });
    else conflicts.push({ seatId: seat, uids: [...uids].sort() });
  }
  return { settled, conflicts };
}

/** 競合結果から次ラウンドの投票資格者と予約席を作る */
export function nextRoundState(conflicts) {
  const reservedSeats = {};
  const eligibleUids = [];
  for (const { seatId: s, uids } of conflicts) {
    reservedSeats[s] = uids;
    eligibleUids.push(...uids);
  }
  return { reservedSeats, eligibleUids };
}

function shuffle(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 未確定の生徒を空席へランダムに振り分ける。
 * 選べる席が少ない生徒から順に割り当て、座席属性（男女）を守る。
 * @returns {{assigned:{uid:string,seatId:string}[], unassigned:string[]}}
 */
export function autoAssign({ players, seatTypes, assignments }, rand = Math.random) {
  const taken = new Set(settledUids(assignments));
  const emptySeats = Object.keys(seatTypes).filter(
    (s) => seatTypes[s] !== 'none' && !assignments?.[s],
  );
  const free = new Set(emptySeats);
  const pending = shuffle(players.filter((p) => !taken.has(p.uid)), rand);

  const optionsOf = (p) => [...free].filter((s) => seatAccepts(seatTypes[s], p.gender));
  const assigned = [];
  const unassigned = [];
  // 性別専用席を先に埋めるため、選択肢の少ない人から確定させる
  pending.sort((a, b) => optionsOf(a).length - optionsOf(b).length);
  for (const p of pending) {
    const opts = optionsOf(p);
    // 自分の性別専用の席を優先し、「誰でも」席を温存する
    const exact = opts.filter((s) => seatTypes[s] === p.gender);
    const pool = exact.length ? exact : opts;
    if (!pool.length) {
      unassigned.push(p.uid);
      continue;
    }
    const s = pool[Math.floor(rand() * pool.length)];
    free.delete(s);
    assigned.push({ uid: p.uid, seatId: s });
  }
  return { assigned, unassigned };
}

/** 結果確定後に取るべき次の手 */
export function nextAction({ round, maxRounds, conflicts }) {
  if (conflicts.length > 0 && round < maxRounds) return 'nextRound';
  return 'finish';
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function randomRoomCode(len = 6, rand = Math.random) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)];
  return s;
}

/** 投票ドキュメント ID。1 ラウンド 1 票・変更不可をルール側で担保するため固定形式にする */
export const voteDocId = (drawNo, round, uid) => `${drawNo}-${round}-${uid}`;
export const roundDocId = (drawNo, round) => `${drawNo}-${round}`;
