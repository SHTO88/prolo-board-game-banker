'use strict';

/*
 * Prolo Board Game Banker: who owes how much to whom.
 *
 * Every entry in the log is either a debt ("A owes B ₹N") or money actually
 * handed over ("A pays B ₹N", stored with k: 'paid'), which cancels what A
 * owed B. The Bank is a party like any player. Net positions are
 * recomputed from the log, and the "Who pays whom" list shows what each pair
 * of people still owe each other. All state lives in localStorage.
 */

const STORE_KEY = 'bgb:v2';
// The first 8 are handed out automatically; all 12 can be picked in setup.
const PALETTE = [
  ['#ef4444', 'Red'], ['#3b82f6', 'Blue'], ['#22c55e', 'Green'], ['#f59e0b', 'Amber'],
  ['#a855f7', 'Purple'], ['#ec4899', 'Pink'], ['#14b8a6', 'Teal'], ['#f97316', 'Orange'],
  ['#6366f1', 'Indigo'], ['#06b6d4', 'Cyan'], ['#84cc16', 'Lime'], ['#d946ef', 'Fuchsia'],
];
const COLORS = PALETTE.map(([c]) => c);
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const QUICK_AMOUNTS = [50, 100, 500, 1000, 5000];
const BANK = 'bank';
const BANK_COLOR = '#94a3b8';
const MAX_DIGITS = 10;

const $ = (sel) => document.querySelector(sel);

// ---------- State ----------

function defaultState() {
  return { players: [], cur: '₹', log: [] };
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.players) && Array.isArray(s.log)) return { ...defaultState(), ...s };
  } catch { /* corrupted or unavailable storage: start fresh */ }
  return defaultState();
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* private mode / quota */ }
}

let state = load();
let undoSnapshot = null;
// open entry: { pid, dir: 'owe' (records a debt) | 'pay' (money handed over), cp: 'bank'|'all'|playerId, amt: string }
let tx = null;
const lastCp = {}; // remembers each player's last counterparty for this session
let setupMode = 'new';

const uid = () => Math.random().toString(36).slice(2, 10);
const playerById = (id) => state.players.find((p) => p.id === id);
const others = (id) => state.players.filter((p) => p.id !== id);
const colorOf = (id) => (id === BANK ? BANK_COLOR : playerById(id)?.color ?? BANK_COLOR);

function nameOf(id) {
  if (id === BANK) return 'Bank';
  if (id === 'all') return 'Everyone';
  return playerById(id)?.name ?? 'Removed player';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Indian digit grouping (1,00,000) for rupees, the device's locale otherwise. */
function fmt(n) {
  const locale = state.cur === '₹' ? 'en-IN' : undefined;
  return (n < 0 ? '−' : '') + state.cur + Math.abs(n).toLocaleString(locale);
}

/**
 * Net position per player and the Bank: positive = gets money back,
 * negative = owes. Players removed mid-game are skipped (removal is only
 * allowed at net zero, so the remaining nets still add up to zero).
 */
function nets(log = state.log) {
  const n = { [BANK]: 0 };
  for (const p of state.players) n[p.id] = 0;
  for (const e of log) {
    const d = entryDeltas(e);
    for (const id in d) if (id in n) n[id] += d[id];
  }
  return n;
}

/**
 * The debts one log entry creates, as [debtor, creditor, amount]. An in-game
 * payment means the payer owes the payee; a settlement reverses that.
 */
function entryDebts(e) {
  let debts;
  if (e.to === 'all') debts = e.ids.map((o) => [e.from, o, e.amt]);
  else if (e.from === 'all') debts = e.ids.map((o) => [o, e.to, e.amt]);
  else debts = [[e.from, e.to, e.amt]];
  // Money handed over runs the other way: it cancels what the payer owed.
  return e.k === 'paid' ? debts.map(([a, b, amt]) => [b, a, amt]) : debts;
}

/** How one log entry changes each party's net position. */
function entryDeltas(e) {
  const d = {};
  for (const [debtor, creditor, amt] of entryDebts(e)) {
    d[debtor] = (d[debtor] ?? 0) - amt;
    d[creditor] = (d[creditor] ?? 0) + amt;
  }
  return d;
}

/**
 * Who pays whom, kept between the two people who actually dealt with each
 * other. Debts are never passed along a chain (A owes B and B owes C stays
 * two payments); only payments back and forth within one pair cancel out.
 * Sorted by player order, with the Bank last.
 */
function settlements() {
  const parties = [...state.players.map((p) => p.id), BANK];
  const rank = new Map(parties.map((id, i) => [id, i]));
  // Key "a|b" with a ranked before b; positive = a owes b, negative = b owes a.
  const pairs = new Map();
  for (const e of state.log) {
    for (const [debtor, creditor, amt] of entryDebts(e)) {
      if (!rank.has(debtor) || !rank.has(creditor) || debtor === creditor) continue;
      const fwd = rank.get(debtor) < rank.get(creditor);
      const key = fwd ? `${debtor}|${creditor}` : `${creditor}|${debtor}`;
      pairs.set(key, (pairs.get(key) ?? 0) + (fwd ? amt : -amt));
    }
  }
  const out = [];
  for (const [key, v] of pairs) {
    if (!v) continue;
    const [a, b] = key.split('|');
    out.push(v > 0 ? { from: a, to: b, amt: v } : { from: b, to: a, amt: -v });
  }
  return out.sort((x, y) => rank.get(x.from) - rank.get(y.from) || rank.get(x.to) - rank.get(y.to));
}

function netStatus(v) {
  if (v > 0) return { cls: 'pos', label: 'gets back', amount: fmt(v) };
  if (v < 0) return { cls: 'neg', label: 'owes', amount: fmt(-v) };
  return { cls: 'zero', label: 'settled', amount: fmt(0) };
}

// ---------- Undo + toast ----------

function snapshot() {
  undoSnapshot = JSON.parse(JSON.stringify(state));
}

let toastTimer;
function toast(msg, canUndo = true) {
  const el = $('#toast');
  // Dialogs render in the top layer; keep the toast visible above an open one.
  const openDialog = document.querySelector('dialog[open]');
  (openDialog || document.body).appendChild(el);
  $('#toast-msg').textContent = msg;
  $('#toast-undo').hidden = !canUndo;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

$('#toast-undo').addEventListener('click', () => {
  if (!undoSnapshot) return;
  state = undoSnapshot;
  undoSnapshot = null;
  save();
  $('#toast').hidden = true;
  if (state.players.length) {
    showGame();
    if ($('#history').open) renderHistory();
  } else {
    openSetup('new');
  }
});

function buzz() {
  if (navigator.vibrate) navigator.vibrate(12);
}

// ---------- Entries ----------

/** "Owes" entries record a debt; "paid" entries record money actually handed over. */
function describe(e) {
  const verb = e.k === 'paid' ? 'paid' : 'owes';
  if (e.to === 'all') return `${nameOf(e.from)} ${verb} everyone ${fmt(e.amt)} each`;
  if (e.from === 'all') return `Everyone ${e.k === 'paid' ? 'paid' : 'owes'} ${nameOf(e.to)} ${fmt(e.amt)} each`;
  return `${nameOf(e.from)} ${verb} ${nameOf(e.to)} ${fmt(e.amt)}`;
}

function commit(entry) {
  const before = nets();
  snapshot();
  state.log.push(entry);
  save();
  const after = nets();
  const deltas = {};
  for (const id in after) if (after[id] !== before[id]) deltas[id] = after[id] - before[id];
  renderGame(deltas);
  toast(describe(entry));
  buzz();
}

// ---------- Game screen ----------

function showGame() {
  $('#setup').hidden = true;
  $('#game').hidden = false;
  renderGame();
  keepAwake();
}

const CHEVRON = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
const BANK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/></svg>';

function initials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  // "Sourabh Jain" -> "SJ"; single names keep two letters so "Vani"/"Vidhi" differ ("Va"/"Vi").
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  return words[0][0].toUpperCase() + (words[0][1] ?? '').toLowerCase();
}

function avatar(id, size = '') {
  const inner = id === BANK ? BANK_ICON : esc(initials(nameOf(id)));
  return `<span class="avatar ${size}" style="--c:${colorOf(id)}" aria-hidden="true">${inner}</span>`;
}

function renderGame(deltas = {}) {
  const n = nets();
  $('#players').innerHTML = state.players.map((p) => {
    const s = netStatus(n[p.id]);
    const d = deltas[p.id];
    const net = s.cls === 'zero'
      ? '<span class="prow-status">Settled</span>'
      : `<span class="prow-amt">${s.amount}</span><span class="prow-status">${s.label}</span>`;
    return `
      <li>
        <button class="prow" type="button" data-pid="${p.id}"
          aria-label="${esc(p.name)} ${s.label}${n[p.id] ? ' ' + s.amount : ''}. Tap to record what they pay or receive.">
          ${avatar(p.id)}
          <span class="prow-name">${esc(p.name)}</span>
          ${d ? `<span class="delta ${d < 0 ? 'neg' : 'pos'}">${d > 0 ? '+' : ''}${fmt(d)}</span>` : ''}
          <span class="prow-net ${s.cls}">${net}</span>
          ${CHEVRON}
        </button>
      </li>`;
  }).join('');
  renderSettlements();
}

function renderSettlements() {
  const list = settlements();
  const dot = (id) => avatar(id, 'sm');
  $('#settle-sub').textContent = list.length
    ? `${list.length} payment${list.length > 1 ? 's' : ''} to settle up`
    : '';
  $('#settle-list').innerHTML = list.length
    ? list.map((s) => `
      <li>
        ${avatar(s.from)}
        <span class="settle-who" aria-label="${esc(nameOf(s.from))} pays ${esc(nameOf(s.to))}">
          <span class="name">${esc(nameOf(s.from))}</span>
          <span class="settle-to">pays ${dot(s.to)}<strong>${esc(nameOf(s.to))}</strong></span>
        </span>
        <span class="settle-amt">${fmt(s.amt)}</span>
        <button class="paid-btn" type="button" data-from="${s.from}" data-to="${s.to}" data-amt="${s.amt}"
          aria-label="Mark ${esc(nameOf(s.from))} paid ${esc(nameOf(s.to))} ${fmt(s.amt)}">Paid</button>
      </li>`).join('')
    : `<li class="empty">${state.log.length ? 'All square. Nobody owes anything.' : 'Tap a player to record what they pay or receive.'}</li>`;
  $('#btn-explain').hidden = !list.length;
}

/** One history entry as seen by party `id`, e.g. "Owes Player 2" or "Paid by Bank". */
function trailLabel(e, id) {
  const name = (x) => esc(nameOf(x));
  const paid = e.k === 'paid';
  const sent = (to) => (paid ? `Paid ${to}` : `Owes ${to}`);
  const got = (from) => (paid ? `Paid by ${from}` : `${from} owes them`);
  if (e.to === 'all') return e.from === id ? sent(`everyone ${fmt(e.amt)} each`) : got(name(e.from));
  if (e.from === 'all') return e.to === id ? got('everyone') : sent(name(e.to));
  return e.from === id ? sent(name(e.to)) : got(name(e.from));
}

const runLabel = (v) => (v < 0 ? `owes ${fmt(-v)}` : v > 0 ? `gets back ${fmt(v)}` : 'square');

/**
 * Explainer sheet: a tree of who pays whom (each person who owes, branching
 * to the people they pay), then a tap-to-open trail per person showing how
 * each history entry moved their total.
 */
function renderExplain() {
  const n = nets();
  const steps = settlements();
  const name = (id) => esc(nameOf(id));

  const debtors = [...new Set(steps.map((s) => s.from))];
  const tree = debtors.map((d) => {
    const mine = steps.filter((s) => s.from === d);
    const total = mine.reduce((sum, s) => sum + s.amt, 0);
    const leaves = mine.map((s) => `
      <li>
        ${avatar(s.to, 'sm')}
        <span class="x-main"><span class="name">${name(s.to)}</span></span>
        <span class="x-amt">${fmt(s.amt)}</span>
      </li>`).join('');
    return `
      <div class="tree">
        <div class="t-root">
          ${avatar(d)}
          <span class="name">${name(d)}</span>
          <span class="x-owes">pays ${fmt(total)}</span>
        </div>
        <ul class="t-branches" aria-label="${name(d)} pays">${leaves}</ul>
      </div>`;
  }).join('');

  const trails = [...state.players.map((p) => p.id), BANK].map((id) => {
    let run = 0;
    const rows = [];
    for (const e of state.log) {
      const d = entryDeltas(e)[id];
      if (!d) continue;
      run += d;
      rows.push(`
        <li>
          <span class="t-what">${trailLabel(e, id)}</span>
          <span class="t-delta ${d < 0 ? 'neg' : 'pos'}">${d > 0 ? '+' : ''}${fmt(d)}</span>
          <span class="t-run">Now ${runLabel(run)}</span>
        </li>`);
    }
    if (!rows.length) return '';
    const s = netStatus(n[id]);
    return `
      <details class="trail">
        <summary>
          ${avatar(id)}
          <span class="name">${name(id)}</span>
          <span class="prow-net ${s.cls}">
            ${s.cls === 'zero' ? '<span class="prow-status">Square</span>'
              : `<span class="x-amt">${s.amount}</span><span class="prow-status">${s.label}</span>`}
          </span>
          ${CHEVRON}
        </summary>
        <ol class="t-steps">${rows.join('')}</ol>
      </details>`;
  }).join('');

  $('#explain-body').innerHTML = `
    <p class="x-note">Each person pays back the people they dealt with in the game. If two people paid each other, only the difference is paid.</p>
    <h3>Who pays whom</h3>
    ${tree}
    <h3>How each total adds up</h3>
    <p class="muted">Tap a name to see every payment, in order.</p>
    <div class="list">${trails}</div>`;
}

$('#btn-explain').addEventListener('click', () => { renderExplain(); $('#explain').showModal(); });

$('#players').addEventListener('click', (ev) => {
  const card = ev.target.closest('[data-pid]');
  if (card) openTx(card.dataset.pid);
});

$('#settle-list').addEventListener('click', (ev) => {
  const b = ev.target.closest('.paid-btn');
  if (!b) return;
  commit({ id: uid(), t: Date.now(), from: b.dataset.from, to: b.dataset.to, amt: Number(b.dataset.amt), k: 'paid' });
});

$('#btn-history').addEventListener('click', () => { renderHistory(); $('#history').showModal(); });
$('#btn-menu').addEventListener('click', () => $('#menu').showModal());
$('#menu-edit').addEventListener('click', () => { $('#menu').close(); openSetup('edit'); });
$('#menu-new').addEventListener('click', () => { $('#menu').close(); openSetup('new'); });

// ---------- Entry sheet ----------

function openTx(pid) {
  const opp = others(pid);
  const remembered = lastCp[pid];
  // Default to the Bank unless this player last dealt with someone still in the game.
  const cp = remembered === 'all' || opp.some((p) => p.id === remembered) ? remembered : BANK;
  tx = { pid, dir: 'owe', cp, amt: '' };

  const opts = [{ id: BANK, label: 'Bank', color: BANK_COLOR }]
    .concat(opp.map((p) => ({ id: p.id, label: p.name, color: p.color })));
  if (opp.length > 1) opts.push({ id: 'all', label: 'Everyone' });
  $('#tx-cp').innerHTML = opts.map((o) => `
    <button class="chip" type="button" data-cp="${o.id}">
      ${o.color ? `<span class="dot" style="background:${o.color}"></span>` : ''}${esc(o.label)}
    </button>`).join('');

  $('#tx-quick').innerHTML = QUICK_AMOUNTS
    .map((q) => `<button class="chip" type="button" data-q="${q}">+${fmt(q)}</button>`).join('');

  renderTx();
  $('#tx').showModal();
  // Wrap the chips if that fits in two rows; otherwise two rows that scroll sideways.
  const cpEl = $('#tx-cp');
  cpEl.classList.add('wrap');
  const rows = new Set([...cpEl.children].map((c) => c.offsetTop)).size;
  if (rows > 2) {
    cpEl.classList.remove('wrap');
    cpEl.style.setProperty('--cols', Math.ceil(opts.length / 2));
  }
  $('#tx-cp [aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $('#tx-go').focus({ preventScroll: true });
}

function renderTx() {
  const p = playerById(tx.pid);
  const net = nets()[tx.pid];
  const amt = Number(tx.amt) || 0;
  const s = netStatus(net);

  $('#tx-dot').style.background = p.color;
  $('#tx-name').textContent = p.name;
  $('#tx-bal').textContent = net ? `${s.label} ${s.amount}` : s.label;

  for (const b of document.querySelectorAll('#tx .seg button')) {
    b.setAttribute('aria-pressed', String(b.dataset.dir === tx.dir));
  }
  // Colours the whole sheet (top strip, amount, confirm button): red for a debt, green for money handed over.
  $('#tx').classList.toggle('mode-owe', tx.dir === 'owe');
  $('#tx').classList.toggle('mode-pay', tx.dir === 'pay');
  for (const b of document.querySelectorAll('#tx-cp .chip')) {
    b.setAttribute('aria-pressed', String(b.dataset.cp === tx.cp));
  }


  const out = $('#tx-amount');
  out.textContent = fmt(amt);
  out.classList.toggle('empty', !amt);
  $('#tx-clear').style.visibility = amt ? 'visible' : 'hidden';

  const count = tx.cp === 'all' ? others(tx.pid).length : 1;
  const total = amt * count;
  // Owing more lowers their total; paying money over raises it back.
  const after = netStatus(net + (tx.dir === 'owe' ? -total : total));
  const afterEl = $('#tx-after');
  afterEl.textContent = amt
    ? `${count > 1 ? `Total ${fmt(total)} · ` : ''}${p.name} then ${after.cls === 'zero' ? 'is settled' : `${after.label} ${after.amount}`}`
    : '';
  afterEl.classList.toggle('neg', amt > 0 && after.cls === 'neg');

  const go = $('#tx-go');
  go.disabled = !amt;
  const each = tx.cp === 'all' ? ' each' : '';
  go.textContent = !amt
    ? 'Enter amount'
    : `${p.name} ${tx.dir === 'owe' ? 'owes' : 'pays'} ${tx.cp === 'all' ? 'everyone' : nameOf(tx.cp)} ${fmt(amt)}${each}`;
}

function pressKey(k) {
  if (k === 'back') tx.amt = tx.amt.slice(0, -1);
  else tx.amt = (tx.amt + k).replace(/^0+/, '').slice(0, MAX_DIGITS);
  renderTx();
}

function confirmTx() {
  const amt = Number(tx.amt) || 0;
  if (!amt) return;
  const e = { id: uid(), t: Date.now(), amt };
  e.from = tx.pid;
  e.to = tx.cp;
  if (tx.dir === 'pay') e.k = 'paid';
  if (tx.cp === 'all') e.ids = others(tx.pid).map((p) => p.id);
  lastCp[tx.pid] = tx.cp;
  $('#tx').close();
  commit(e);
}

$('#tx').addEventListener('click', (ev) => {
  const t = ev.target;
  const dir = t.closest('[data-dir]');
  if (dir) { tx.dir = dir.dataset.dir; return renderTx(); }
  const cp = t.closest('[data-cp]');
  if (cp) {
    tx.cp = cp.dataset.cp;
    cp.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    return renderTx();
  }
  const q = t.closest('[data-q]');
  if (q) {
    tx.amt = String(Math.min((Number(tx.amt) || 0) + Number(q.dataset.q), 10 ** MAX_DIGITS - 1));
    return renderTx();
  }
  const k = t.closest('[data-k]');
  if (k) return pressKey(k.dataset.k);
});
$('#tx-clear').addEventListener('click', () => { tx.amt = ''; renderTx(); });
$('#tx-go').addEventListener('click', confirmTx);

// Physical keyboard support (desktop / tablets with keyboards).
$('#tx').addEventListener('keydown', (ev) => {
  if (/^[0-9]$/.test(ev.key)) { ev.preventDefault(); pressKey(ev.key); }
  else if (ev.key === 'Backspace') { ev.preventDefault(); pressKey('back'); }
  else if (ev.key === 'Enter') { ev.preventDefault(); confirmTx(); }
});

// ---------- History ----------

function timeLabel(t) {
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function renderHistory() {
  const list = $('#history-list');
  if (!state.log.length) {
    list.innerHTML = '<li class="empty">Nothing recorded yet</li>';
    return;
  }
  list.innerHTML = state.log.slice().reverse().map((e) => {
    const verb = e.k === 'paid' ? 'paid' : 'owes';
    const who = `${esc(nameOf(e.from))} ${verb} ${esc(nameOf(e.to))}`;
    const meta = (e.k === 'paid' ? 'Money handed over · ' : '') + timeLabel(e.t);
    const amt = e.ids
      ? `${fmt(e.amt)}<small>each · ${fmt(e.amt * e.ids.length)}</small>`
      : fmt(e.amt);
    return `
      <li>
        <div class="h-main"><div class="h-who">${who}</div><div class="h-meta">${meta}</div></div>
        <div class="h-amt">${amt}</div>
        <button class="icon-btn" type="button" data-del="${e.id}" aria-label="Delete entry">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </li>`;
  }).join('');
}

$('#history-list').addEventListener('click', (ev) => {
  const del = ev.target.closest('[data-del]');
  if (!del) return;
  snapshot();
  state.log = state.log.filter((e) => e.id !== del.dataset.del);
  save();
  renderHistory();
  renderGame();
  toast('Entry deleted');
});

// ---------- Sheets: shared close behaviour ----------

for (const dlg of document.querySelectorAll('dialog')) {
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) {
      // Click on the backdrop (outside the sheet's content box) closes it.
      const r = dlg.getBoundingClientRect();
      const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      if (!inside) dlg.close();
    }
    if (ev.target.closest('[data-close]')) dlg.close();
  });
  dlg.addEventListener('close', () => {
    const t = $('#toast');
    if (dlg.contains(t)) document.body.appendChild(t);
  });
}

// ---------- Setup ----------

function nextColor(used) {
  return COLORS.find((c) => !used.includes(c)) ?? COLORS[used.length % COLORS.length];
}

function playerRow(p, index) {
  const li = document.createElement('li');
  li.dataset.id = p.id;
  li.dataset.color = p.color;
  li.innerHTML = `
    <button class="avatar-btn" type="button" data-color-btn aria-expanded="false" aria-label="Change colour">
      <span class="avatar" style="--c:${p.color}">${esc(initials(p.name || `Player ${index + 1}`))}</span>
      <span class="avatar-caret" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></span>
    </button>
    <input type="text" maxlength="20" autocomplete="off" autocapitalize="words" enterkeyhint="next"
      placeholder="Player ${index + 1}" value="${esc(p.name)}" aria-label="Player ${index + 1} name">
    <button class="icon-btn" type="button" data-remove aria-label="Remove player">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>`;
  return li;
}

// ---------- Setup: colour picker ----------

function rowName(li) {
  const input = li.querySelector('input');
  return input.value.trim() || input.placeholder;
}

function closePalettes(except) {
  for (const li of setupRows()) {
    if (li === except) continue;
    li.querySelector('.palette')?.remove();
    li.querySelector('[data-color-btn]').setAttribute('aria-expanded', 'false');
  }
}

function openPalette(li) {
  closePalettes(li);
  const btn = li.querySelector('[data-color-btn]');
  const existing = li.querySelector('.palette');
  if (existing) {
    existing.remove();
    btn.setAttribute('aria-expanded', 'false');
    return;
  }
  // Show whose colour each swatch is, so it's clear that picking it swaps colours.
  const owners = {};
  for (const r of setupRows()) if (r !== li) owners[r.dataset.color] = r;
  const palette = document.createElement('div');
  palette.className = 'palette';
  palette.setAttribute('role', 'group');
  palette.setAttribute('aria-label', `Colour for ${rowName(li)}`);
  palette.innerHTML = PALETTE.map(([c, label]) => {
    const owner = owners[c];
    const desc = owner ? `${label}, used by ${rowName(owner)}. Picking it swaps colours.` : label;
    return `<button class="swatch" type="button" data-swatch="${c}" style="--c:${c}"
      aria-pressed="${c === li.dataset.color}" aria-label="${esc(desc)}">${owner ? esc(initials(rowName(owner))) : ''}</button>`;
  }).join('');
  li.appendChild(palette);
  btn.setAttribute('aria-expanded', 'true');
}

function setRowColor(li, color) {
  li.dataset.color = color;
  li.querySelector('.avatar').style.setProperty('--c', color);
}

function pickColor(li, color) {
  const current = li.dataset.color;
  if (color !== current) {
    const owner = setupRows().find((r) => r !== li && r.dataset.color === color);
    if (owner) setRowColor(owner, current);
    setRowColor(li, color);
  }
  closePalettes();
}

function refreshRowInitials(li) {
  li.querySelector('.avatar').textContent = initials(rowName(li));
}

$('#setup-players').addEventListener('click', (ev) => {
  const swatch = ev.target.closest('[data-swatch]');
  if (swatch) return pickColor(swatch.closest('li'), swatch.dataset.swatch);
  const colorBtn = ev.target.closest('[data-color-btn]');
  if (colorBtn) return openPalette(colorBtn.closest('li'));
});

$('#setup-players').addEventListener('input', (ev) => {
  if (ev.target.tagName === 'INPUT') refreshRowInitials(ev.target.closest('li'));
});

function setupRows() {
  return [...document.querySelectorAll('#setup-players li')];
}

function refreshSetupRows() {
  const rows = setupRows();
  rows.forEach((li, i) => {
    const input = li.querySelector('input');
    input.placeholder = `Player ${i + 1}`;
    input.setAttribute('aria-label', `Player ${i + 1} name`);
    li.querySelector('[data-color-btn]').setAttribute('aria-label', `Change colour for ${rowName(li)}`);
    refreshRowInitials(li); // unnamed rows show "P2" etc., which shift when a row is removed
  });
  $('#add-player').hidden = rows.length >= MAX_PLAYERS;
}

function addSetupRow(focus = true) {
  const rows = setupRows();
  if (rows.length >= MAX_PLAYERS) return;
  const color = nextColor(rows.map((r) => r.dataset.color));
  const li = playerRow({ id: uid(), name: '', color }, rows.length);
  $('#setup-players').appendChild(li);
  refreshSetupRows();
  if (focus) li.querySelector('input').focus();
}

function openSetup(mode) {
  setupMode = mode;
  $('#toast').hidden = true;
  const hasGame = state.players.length > 0;
  $('#setup-title').textContent = mode === 'edit' ? 'Edit players' : 'New game';
  $('#setup-go').textContent = mode === 'edit' ? 'Save changes' : 'Start game';
  $('#setup-back').hidden = !hasGame;

  // Pre-fill with the current/last players so a rematch is one tap.
  const list = $('#setup-players');
  list.innerHTML = '';
  const seed = hasGame
    ? state.players
    : Array.from({ length: 4 }, (_, i) => ({ id: uid(), name: '', color: COLORS[i] }));
  seed.forEach((p, i) => list.appendChild(playerRow(p, i)));
  refreshSetupRows();

  $('#cur').value = state.cur;

  $('#game').hidden = true;
  $('#setup').hidden = false;
  window.scrollTo(0, 0);
}

$('#add-player').addEventListener('click', () => addSetupRow());

$('#setup-players').addEventListener('click', (ev) => {
  const rm = ev.target.closest('[data-remove]');
  if (!rm) return;
  const li = rm.closest('li');
  const reason = removeBlockedReason(li);
  if (reason) return showRowNote(li, reason);
  li.remove();
  refreshSetupRows();
});

/**
 * Removing a player with money outstanding would make their debts vanish and
 * the remaining totals stop adding up, so explain instead of removing.
 */
function removeBlockedReason(li) {
  if (setupRows().length <= MIN_PLAYERS) return `A game needs at least ${MIN_PLAYERS} players.`;
  if (setupMode !== 'edit') return '';
  const id = li.dataset.id;
  const v = nets()[id];
  // Net zero isn't enough: they may still owe one person and be owed by another.
  const open = settlements().some((s) => s.from === id || s.to === id);
  if (!v && !open) return '';
  const input = li.querySelector('input');
  const name = input.value.trim() || input.placeholder;
  if (!v) return `${name} still has payments to settle. Settle up before removing.`;
  return `${name} ${v < 0 ? 'owes' : 'gets back'} ${fmt(Math.abs(v))}. Settle up before removing.`;
}

function showRowNote(li, msg) {
  let note = li.querySelector('.row-note');
  if (!note) {
    note = document.createElement('p');
    note.className = 'row-note';
    note.setAttribute('role', 'alert');
    li.appendChild(note);
  }
  note.textContent = msg;
  li.classList.remove('shake');
  void li.offsetWidth; // restart the animation on repeated taps
  li.classList.add('shake');
  buzz();
}

// Default names ("Player 3") get selected on focus so typing replaces them.
$('#setup-players').addEventListener('focusin', (ev) => {
  const input = ev.target;
  if (input.tagName === 'INPUT' && /^Player \d+$/.test(input.value)) setTimeout(() => input.select(), 0);
});

$('#setup-players').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' || ev.target.tagName !== 'INPUT') return;
  ev.preventDefault();
  const rows = setupRows();
  const i = rows.indexOf(ev.target.closest('li'));
  if (i < rows.length - 1) rows[i + 1].querySelector('input').focus();
  else if (ev.target.value.trim() && rows.length < MAX_PLAYERS) addSetupRow();
  else ev.target.blur();
});

$('#setup-back').addEventListener('click', showGame);

$('#setup-go').addEventListener('click', () => {
  const players = setupRows().map((li, i) => ({
    id: li.dataset.id,
    color: li.dataset.color,
    name: li.querySelector('input').value.trim() || `Player ${i + 1}`,
  }));
  const cur = $('#cur').value.trim();

  const hadGame = state.players.length > 0;
  snapshot();
  state = {
    ...state,
    players,
    cur,
    log: setupMode === 'edit' ? state.log : [],
  };
  save();
  showGame();
  if (setupMode === 'new' && hadGame) toast('New game started');
  else if (setupMode === 'edit') toast('Players updated');
});

// ---------- Keep the screen on while playing ----------

let wakeLock = null;
async function keepAwake() {
  if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
  if ($('#game').hidden) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* not allowed (battery saver, iframe, etc.) */ }
}
document.addEventListener('visibilitychange', keepAwake);

// ---------- Boot ----------

if (state.players.length) showGame();
else openSetup('new');

if ('serviceWorker' in navigator) {
  // iOS keeps a home-screen app suspended instead of reloading it, so check for
  // a new version every time the app comes back to the foreground.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  });

  // When a new version takes over, reload to show it. Wait if a sheet is open
  // so an entry in progress isn't lost. Skip on first install (no old version).
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloadPending = false;
  const reloadIfIdle = () => {
    if (reloadPending && !document.querySelector('dialog[open]') && $('#setup').hidden) location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloadPending) return;
    reloadPending = true;
    reloadIfIdle();
  });
  // 'close' doesn't bubble, so listen in the capture phase for any sheet closing.
  document.addEventListener('close', reloadIfIdle, true);
  // Also catch leaving the setup screen (Start game / Back), which isn't a sheet.
  new MutationObserver(reloadIfIdle).observe($('#setup'), { attributes: true, attributeFilter: ['hidden'] });
}
