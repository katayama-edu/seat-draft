import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tally, nextRoundState, autoAssign, nextAction, resizeSeatTypes } from '../src/draft.js';

test('tally: 単独は確定、重複は競合', () => {
  const r = tally([
    { uid: 'a', seatId: 's1' },
    { uid: 'b', seatId: 's2' },
    { uid: 'c', seatId: 's2' },
  ]);
  assert.deepEqual(r.settled, [{ uid: 'a', seatId: 's1' }]);
  assert.deepEqual(r.conflicts, [{ seatId: 's2', uids: ['b', 'c'] }]);
});

test('nextRoundState: 競合者だけが資格を持ち、競合席が予約される', () => {
  const s = nextRoundState([{ seatId: 's2', uids: ['b', 'c'] }]);
  assert.deepEqual(s.eligibleUids, ['b', 'c']);
  assert.deepEqual(s.reservedSeats, { s2: ['b', 'c'] });
});

test('nextAction: 競合があり上限未満なら次ラウンド、それ以外は終了', () => {
  assert.equal(nextAction({ round: 1, maxRounds: 3, conflicts: [{}] }), 'nextRound');
  assert.equal(nextAction({ round: 3, maxRounds: 3, conflicts: [{}] }), 'finish');
  assert.equal(nextAction({ round: 1, maxRounds: 3, conflicts: [] }), 'finish');
});

test('autoAssign: 性別を守り、確定済みの席と人は動かさない', () => {
  const seatTypes = { a: 'M', b: 'F', c: 'any', d: 'none', e: 'M' };
  const players = [
    { uid: 'm1', gender: 'M' }, { uid: 'm2', gender: 'M' },
    { uid: 'f1', gender: 'F' }, { uid: 'f2', gender: 'F' }, { uid: 'done', gender: 'M' },
  ];
  for (let i = 0; i < 50; i++) {
    const { assigned, unassigned } = autoAssign({ players, seatTypes, assignments: { e: 'done' } });
    const map = Object.fromEntries(assigned.map((x) => [x.seatId, x.uid]));
    assert.equal(map.d, undefined);
    assert.equal(map.e, undefined);
    assert.ok(!assigned.some((x) => x.uid === 'done'));
    for (const { uid, seatId } of assigned) {
      const g = players.find((p) => p.uid === uid).gender;
      assert.ok(seatTypes[seatId] === 'any' || seatTypes[seatId] === g);
    }
    // 男子2: a + (c) / 女子2: b + (c)。誰でも席は1つなので1人あふれる
    assert.equal(assigned.length, 3);
    assert.equal(unassigned.length, 1);
  }
});

test('autoAssign: 専用席を優先して「誰でも」席を温存する', () => {
  const seatTypes = { a: 'M', c: 'any' };
  const players = [{ uid: 'm', gender: 'M' }, { uid: 'f', gender: 'F' }];
  for (let i = 0; i < 30; i++) {
    const { assigned, unassigned } = autoAssign({ players, seatTypes, assignments: {} });
    assert.equal(unassigned.length, 0);
    assert.deepEqual(Object.fromEntries(assigned.map((x) => [x.uid, x.seatId])), { m: 'a', f: 'c' });
  }
});

test('resizeSeatTypes: 既存設定を引き継いで拡張・縮小', () => {
  const t = resizeSeatTypes({ r1c1: 'M', r2c2: 'F' }, 1, 2);
  assert.deepEqual(t, { r1c1: 'M', r1c2: 'any' });
});
