// 生徒画面・管理画面の共通 UI

export const $ = (sel, root = document) => root.querySelector(sel);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const seatLabel = (id) => {
  const m = /^r(\d+)c(\d+)$/.exec(id);
  return m ? `${m[1]}列目・${m[2]}番` : id;
};

/**
 * 座席グリッドを描画する。
 * @param {HTMLElement} el
 * @param {object} room  rows / cols / seatTypes
 * @param {(seatId:string)=>{cls?:string, html?:string, onClick?:Function, disabled?:boolean}} cell
 * @param {{flip?:boolean}} opts  flip=true で教卓側から見た向き
 */
export function renderGrid(el, room, cell, { flip = false } = {}) {
  const rows = [...Array(room.rows)].map((_, i) => i + 1);
  const cols = [...Array(room.cols)].map((_, i) => i + 1);
  if (flip) { rows.reverse(); cols.reverse(); }

  const board = '<div class="board">黒板・教卓</div>';
  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.style.gridTemplateColumns = `repeat(${room.cols}, minmax(0, 1fr))`;
  for (const r of rows) {
    for (const c of cols) {
      const id = `r${r}c${c}`;
      const type = room.seatTypes?.[id] ?? 'any';
      const spec = cell(id) || {};
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `seat seat-${type} ${spec.cls || ''}`;
      btn.dataset.seat = id;
      btn.innerHTML = `<span class="seat-no">${r}-${c}</span>${spec.html || ''}`;
      if (spec.onClick && !spec.disabled) btn.addEventListener('click', () => spec.onClick(id));
      else btn.disabled = true;
      grid.appendChild(btn);
    }
  }
  el.innerHTML = '';
  if (!flip) el.insertAdjacentHTML('beforeend', board);
  el.appendChild(grid);
  if (flip) el.insertAdjacentHTML('beforeend', board);
}

// --- モーダル -----------------------------------------------------------------

let modalResolve = null;

/**
 * @param {{title:string, body:string, tone?:'info'|'success'|'warn'|'error', buttons?:{label:string,value:any,primary?:boolean}[]}} o
 * @returns {Promise<any>} 押されたボタンの value
 */
export function showModal({ title, body, tone = 'info', buttons = [{ label: 'OK', value: true, primary: true }] }) {
  const m = $('#modal');
  m.className = `modal-backdrop open tone-${tone}`;
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  const foot = $('#modalButtons');
  foot.innerHTML = '';
  return new Promise((resolve) => {
    modalResolve = resolve;
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.className = b.primary ? 'btn btn-primary' : 'btn';
      btn.textContent = b.label;
      btn.addEventListener('click', () => closeModal(b.value));
      foot.appendChild(btn);
    }
    foot.querySelector('.btn-primary, .btn')?.focus();
  });
}

export function closeModal(value) {
  $('#modal').classList.remove('open');
  modalResolve?.(value);
  modalResolve = null;
}

export const confirmModal = (title, body, okLabel = 'OK', tone = 'warn') =>
  showModal({
    title, body, tone,
    buttons: [{ label: 'キャンセル', value: false }, { label: okLabel, value: true, primary: true }],
  });

export const errorModal = (e) =>
  showModal({ title: 'エラー', body: esc(e?.message || e), tone: 'error' });

/** 画面上部の接続状態表示 */
export function watchConnection(el) {
  const update = () => {
    el.textContent = navigator.onLine ? '' : 'オフラインです。通信が戻るまで送信できません';
    el.hidden = navigator.onLine;
  };
  addEventListener('online', update);
  addEventListener('offline', update);
  update();
}
