import {
  readRecord, isStated, isSolanaAddress, formatPrice, formatPct, formatCompact, letterOf, dedupeOwn
} from './lib.js';
import { loadTrending, loadOwn, createPoller } from './market.js';
import { initReveal, initProgress, initParallax, initSpotlight, setNumber, reduced } from './motion.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const register = JSON.parse($('#register').textContent);
const caRec = readRecord(register, 'ca');
const CA = isStated(caRec) && isSolanaAddress(caRec.value) ? caRec.value : null;

const ICON_COPY = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4 2.75A1.75 1.75 0 0 1 5.75 1h6.5C13.216 1 14 1.784 14 2.75v6.5A1.75 1.75 0 0 1 12.25 11h-6.5A1.75 1.75 0 0 1 4 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v6.5c0 .138.112.25.25.25h6.5a.25.25 0 0 0 .25-.25v-6.5a.25.25 0 0 0-.25-.25ZM2 5.5v7.75C2 14.216 2.784 15 3.75 15h7.75v-1.5H3.75a.25.25 0 0 1-.25-.25V5.5Z"/></svg>';
const ICON_OK = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>';

document.documentElement.classList.add('js');

// ---- copy -----------------------------------------------------------------
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      // a stalled permission prompt must not freeze the feedback: race it against a short timer
      const ok = await Promise.race([
        navigator.clipboard.writeText(text).then(() => true),
        new Promise((res) => setTimeout(() => res(false), 700))
      ]);
      if (ok) return true;
    }
  } catch { /* fall through */ }
  try {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    const ok = document.execCommand('copy'); t.remove(); return ok;
  } catch { return false; }
}

function wireCaSlot() {
  const btn = $('[data-ca-copy]');
  if (!btn || !CA) return;
  const label = $('[data-ca-feedback]');
  btn.addEventListener('click', async () => {
    const ok = await copyText(CA);
    btn.classList.toggle('is-copied', ok);
    if (label) label.textContent = ok ? 'Copied' : 'Copy failed';
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.classList.remove('is-copied'); if (label) label.textContent = 'Copy'; }, 1600);
  });
}

// ---- tiles ----------------------------------------------------------------
function tile(row) {
  const wrap = document.createElement('span');
  wrap.className = 'tile';
  const letter = () => {
    wrap.classList.add('tile--letter');
    wrap.textContent = letterOf(row.symbol || row.name);
  };
  if (!row.logo) { letter(); return wrap; }
  const img = new Image();
  img.alt = '';
  img.width = 40; img.height = 40;
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', () => {
    if (row.own && img.dataset.fell !== '1') { img.dataset.fell = '1'; img.src = 'assets/logo-192.png'; return; }
    img.remove(); letter();
  });
  img.src = row.logo;
  wrap.appendChild(img);
  return wrap;
}

// ---- board ----------------------------------------------------------------
const board = $('[data-board]');
const rowsEl = $('[data-rows]');
const tickerTrack = $('[data-ticker-track]');
const statusEl = $('[data-status]');
const statusText = $('[data-status-text]');
const note = $('[data-board-note]');

let lastTrending = null;   // last good trending data, kept on refresh failure
let lastOwn = null;
let first = true;

function setStatus(state, text) {
  if (!statusEl) return;
  statusEl.dataset.state = state;
  statusText.textContent = text;
}

function skeletonRows() {
  rowsEl.innerHTML = '';
  for (let i = 0; i < 9; i++) {
    const li = document.createElement('li');
    li.className = 'row row--skeleton';
    li.innerHTML = '<span class="sk sk--tile"></span><span class="sk sk--line"></span><span class="sk sk--line sk--s"></span><span class="sk sk--line sk--s"></span><span class="sk sk--line sk--s"></span><span class="sk sk--line sk--s"></span><span></span>';
    rowsEl.appendChild(li);
  }
}

function cell(label, extra = '') {
  const d = document.createElement('span');
  d.className = 'cell ' + extra;
  d.dataset.label = label;
  return d;
}

function copyBtn(row) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'copy-btn';
  b.setAttribute('aria-label', 'Copy mint for ' + (row.symbol || 'token'));
  b.innerHTML = ICON_COPY;
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await copyText(row.address);
    b.innerHTML = ok ? ICON_OK : ICON_COPY;
    b.classList.toggle('is-copied', ok);
    clearTimeout(b._t);
    b._t = setTimeout(() => { b.innerHTML = ICON_COPY; b.classList.remove('is-copied'); }, 1400);
  });
  return b;
}

function changeClass(v) { return v === null || v === undefined ? '' : v >= 0 ? 'is-up' : 'is-down'; }

function fillRow(li, row, index) {
  li.style.setProperty('--i', String(index));
  li.dataset.address = row.address;
  const tokenCell = cell('Token', 'cell--token');
  const meta = document.createElement('span');
  meta.className = 'tok';
  const sym = document.createElement('strong'); sym.textContent = row.symbol;
  const nm = document.createElement('small'); nm.textContent = row.name;
  meta.append(sym, nm);
  tokenCell.append(tile(row), meta);

  const price = cell('Price', 'cell--num');
  const chg = cell('24h', 'cell--num cell--chg ' + changeClass(row.change));
  const vol = cell('Turnover', 'cell--num');
  const liq = cell(row.liquidityLabel || 'Liquidity', 'cell--num');
  if (row.liquidityLabel === 'Mkt Cap') liq.title = 'Mkt Cap';
  const rank = document.createElement('span');
  rank.className = 'rank'; rank.textContent = String(index + 1);

  setNumber(price, row.price, formatPrice);
  setNumber(chg, row.change, formatPct);
  setNumber(vol, row.volume, formatCompact);
  setNumber(liq, row.liquidity, formatCompact);
  li.replaceChildren(rank, tokenCell, price, chg, vol, liq, copyBtn(row));
}

function renderRows(own, trending, err) {
  const list = dedupeOwn(trending || [], CA).slice(0, own ? 9 : 9);
  const frag = document.createDocumentFragment();

  // Row 1, pinned. Branch is chosen from the CA record at runtime.
  const r1 = document.createElement('li');
  r1.className = 'row row--own';
  if (CA) {
    r1.dataset.own = 'live';
    if (own) fillRow(r1, own, 0);
    else {
      r1.classList.add('row--skeleton');
      r1.innerHTML = '<span class="sk sk--tile"></span><span class="sk sk--line"></span><span class="sk sk--line sk--s"></span><span class="sk sk--line sk--s"></span><span class="sk sk--line sk--s"></span><span class="sk sk--line sk--s"></span><span></span>';
    }
  } else {
    r1.dataset.own = 'placeholder';
    r1.setAttribute('aria-disabled', 'true');
    r1.innerHTML = '<span class="rank">1</span>'
      + '<span class="cell cell--token" data-label="Token"><span class="tile tile--brand"><img src="assets/ogly-logo.png" width="40" height="40" alt=""></span><span class="tok"><strong>OGLY</strong><small>pending</small></span></span>'
      + '<span class="cell cell--num" data-label="Price">$0.00</span>'
      + '<span class="cell cell--num" data-label="24h">· · · · ·</span>'
      + '<span class="cell cell--num" data-label="Turnover">· · · · ·</span>'
      + '<span class="cell cell--num" data-label="Liquidity">· · · · ·</span><span></span>';
  }
  frag.appendChild(r1);

  if (!list.length) {
    for (let i = 0; i < 9; i++) {
      const li = document.createElement('li');
      li.className = err ? 'row row--dash' : 'row row--skeleton';
      li.innerHTML = err
        ? `<span class="rank">${i + 2}</span><span class="cell cell--token" data-label="Token"><span class="tile tile--letter">—</span><span class="tok"><strong>—</strong></span></span><span class="cell cell--num" data-label="Price">—</span><span class="cell cell--num" data-label="24h">—</span><span class="cell cell--num" data-label="Turnover">—</span><span class="cell cell--num" data-label="Liquidity">—</span><span></span>`
        : '<span class="sk sk--tile"></span><span class="sk sk--line"></span><span class="sk sk--line sk--s"></span><span class="sk sk--line sk--s"></span><span class="sk sk--line sk--s"></span><span class="sk sk--line sk--s"></span><span></span>';
      frag.appendChild(li);
    }
  } else {
    list.forEach((row, i) => {
      const li = document.createElement('li');
      li.className = 'row row--live';
      fillRow(li, row, i + 1);
      frag.appendChild(li);
    });
  }
  const existing = rowsEl.dataset.mode;
  rowsEl.dataset.mode = list.length ? 'live' : err ? 'error' : 'loading';
  // Update in place when addresses are unchanged so values count and flash instead of re-mounting.
  const same = existing === 'live' && list.length
    && $$('.row--live', rowsEl).map((e) => e.dataset.address).join() === list.map((r) => r.address).join();
  if (same) {
    $$('.row--live', rowsEl).forEach((li, i) => fillRow(li, list[i], i + 1));
    const cur = $('.row--own', rowsEl);
    if (cur && own && CA) fillRow(cur, own, 0);
    return;
  }
  rowsEl.replaceChildren(frag);
  if (list.length) rowsEl.classList.add('is-staggering');
  setTimeout(() => rowsEl.classList.remove('is-staggering'), reduced() ? 0 : 1400);
}

function renderTicker(own, trending) {
  const items = [];
  if (CA && own) items.push(own);
  for (const r of dedupeOwn(trending || [], CA).slice(0, 10)) items.push(r);
  if (!items.length) {
    tickerTrack.innerHTML = '<span class="tick tick--sk"></span>'.repeat(8);
    return;
  }
  const make = (r) => {
    const el = document.createElement('span');
    el.className = 'tick';
    const t = tile({ ...r, own: false });
    const s = document.createElement('b'); s.textContent = r.symbol;
    const p = document.createElement('span'); p.textContent = formatPrice(r.price);
    const c = document.createElement('i'); c.textContent = formatPct(r.change); c.className = changeClass(r.change);
    el.append(t, s, p, c);
    return el;
  };
  const group = document.createElement('div');
  group.className = 'ticker__group';
  items.forEach((r) => group.appendChild(make(r)));
  const dup = group.cloneNode(true);
  dup.setAttribute('aria-hidden', 'true');
  tickerTrack.replaceChildren(group, dup);
}

function renderOwnSummary(own) {
  if (!CA || !own) return;
  const put = (sel, v, fmt) => {
    const el = $(sel);
    if (!el) return;
    el.classList.remove('is-pending');
    setNumber(el, v, fmt);
  };
  put('[data-own-price]', own.price, formatPrice);
  put('[data-own-mc]', own.marketCap, formatCompact);
  put('[data-own-vol]', own.volume, formatCompact);
  put('[data-own-liq]', own.liquidity, formatCompact);
  const ch = $('[data-own-change]');
  if (ch) { ch.textContent = formatPct(own.change); ch.className = changeClass(own.change); }
}

async function tick() {
  const jobs = [loadTrending(register)];
  if (CA) jobs.push(loadOwn(register, CA));
  const settled = await Promise.allSettled(jobs);
  const tr = settled[0];
  const ow = settled[1];
  if (CA && ow && ow.status === 'fulfilled') lastOwn = ow.value;
  if (tr.status === 'fulfilled') lastTrending = tr.value;
  renderRows(lastOwn, lastTrending, tr.status === 'rejected' && !lastTrending);
  renderTicker(lastOwn, lastTrending);
  renderOwnSummary(lastOwn);
  if (tr.status === 'rejected') throw tr.reason;
  first = false;
  setStatus('live', 'Live');
  if (note) note.textContent = '';
}

function onFail(err, n) {
  setStatus('error', lastTrending ? 'Retrying' : 'Source unreachable');
  if (note) note.textContent = lastTrending
    ? 'Refresh failed. Showing the last good data while retrying.'
    : 'No reply came back. Retrying with longer waits.';
  console.warn('[ogly] market fetch failed', n, err && err.message);
}

// ---- boot -----------------------------------------------------------------
wireCaSlot();
skeletonRows();
renderRows(null, null, false);
renderTicker(null, null);
setStatus('loading', 'Syncing');
initProgress($('[data-progress]'));
initParallax($('[data-parallax]'));
initSpotlight();
initReveal();
createPoller(tick, { onFail }).start();

// tabs (stat panels)
$$('[data-tabs]').forEach((root) => {
  const tabs = $$('[role="tab"]', root);
  const panels = tabs.map((t) => document.getElementById(t.getAttribute('aria-controls')));
  const pick = (i, focus) => {
    tabs.forEach((t, j) => { t.setAttribute('aria-selected', String(i === j)); t.tabIndex = i === j ? 0 : -1; });
    panels.forEach((p, j) => { p.hidden = i !== j; });
    if (focus) tabs[i].focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => pick(i));
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); pick((i + 1) % tabs.length, true); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); pick((i + tabs.length - 1) % tabs.length, true); }
    });
  });
});
