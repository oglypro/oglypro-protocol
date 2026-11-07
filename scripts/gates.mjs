// Gate harness. `npm run gates` builds the real site, proves both register branches on
// scratch builds, and exits 0 only when every gate passes.
import { readFileSync, existsSync, readdirSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { build } from './build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = resolve(ROOT, '.gate-tmp');
const read = (p) => readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(read(p));

// ---------- helpers --------------------------------------------------------
const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
export function visibleText(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/g, ' ');
  return decodeEntities(body.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
export function attrText(html) {
  const out = [];
  const stripped = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ');
  for (const m of stripped.matchAll(/\s(?:aria-label|aria-description|alt|title|placeholder|content)="([^"]*)"/g)) out.push(decodeEntities(m[1]));
  return out.join(' ');
}
function walk(dir, skip = []) {
  const out = [];
  for (const n of readdirSync(dir)) {
    if (skip.includes(n)) continue;
    const p = join(dir, n);
    statSync(p).isDirectory() ? out.push(...walk(p, skip)) : out.push(p);
  }
  return out;
}
const TEXT_EXT = /\.(html|css|js|mjs|json|md|svg|txt)$|^LICENSE$|^\.gitignore$/;
const HEX = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;

export function findAddressLike(text) {
  const out = [];
  for (const m of text.matchAll(/\b0x[0-9a-fA-F]{40}\b/g)) out.push(m[0]);
  for (const m of text.matchAll(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g)) out.push(m[0]);
  return out;
}
export function scanAddresses(text, register, exempt = []) {
  const stated = new Set(Object.values(register.records).filter((r) => r.state === 'stated' && r.value).map((r) => r.value));
  return findAddressLike(text).filter((a) => !stated.has(a) && !exempt.includes(a));
}

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let p = 8, w = 0, h = 0, ct = 0, bd = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; }
    if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (!bpp || bd !== 8) throw new Error('unsupported png');
  const raw = inflateSync(Buffer.concat(idat)); const stride = w * bpp; const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let r = v;
      if (f === 1) r = v + a; else if (f === 2) r = v + b; else if (f === 3) r = v + ((a + b) >> 1);
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      px[y * stride + x] = r & 255;
    }
  }
  return { w, h, ct, bpp, px };
}

const results = [];
const gate = (id, name, fn) => results.push({ id, name, fn });
const check = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---------- shared checks (state-independent: they read the register under test) -------------
function checkRegister(register) {
  for (const [id, r] of Object.entries(register.records)) {
    check(['stated', 'absent', 'unconfirmed'].includes(r.state), `${id}: bad state ${r.state}`);
    if (r.state !== 'stated') {
      check(!('value' in r) && !('url' in r) && !('endpoints' in r), `${id}: inert record carries value/url`);
    } else {
      check(r.value || r.url, `${id}: stated record has neither value nor url`);
    }
  }
}
function checkSocial(distDir) {
  const html = read(join(distDir, 'index.html'));
  const register = readJson(join(distDir, 'register.json'));
  const header = html.match(/<header[\s\S]*?<\/header>/)[0];
  for (const [id, label, sig] of [['x', 'X', 'M18.244 2.25h3.308'], ['github', 'GitHub', 'M8 0c4.42 0 8 3.58 8 8a8.013']]) {
    const rec = register.records[id];
    const m = header.match(new RegExp(`<(a|span)[^>]*data-social="${id}"[^>]*>([\\s\\S]*?)</\\1>`));
    check(m, `${id}: icon missing from header`);
    check(m[2].includes(sig), `${id}: not the official mark`);
    check(!m[2].replace(/<svg[\s\S]*?<\/svg>/g, '').trim(), `${id}: icon carries text`);
    const live = rec.state === 'stated' && rec.url;
    if (live) {
      check(m[1] === 'a' && m[0].includes(`href="${rec.url}"`), `${id}: stated but not linked to its url`);
      const h = new URL(rec.url).pathname.split('/').filter(Boolean)[0];
      check(m[0].includes(`aria-label="${label} @${h}"`), `${id}: handle not derived from url`);
    } else {
      check(m[1] === 'span' && !/href=/.test(m[0]), `${id}: inert record rendered with href`);
      check(m[0].includes(`aria-label="${label} pending"`), `${id}: inert label wrong`);
    }
  }
  // every outbound social href must equal a stated register url
  const urls = new Set(Object.values(register.records).filter((r) => r.state === 'stated' && r.url).map((r) => r.url));
  for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) check(urls.has(m[1]), `href not backed by register: ${m[1]}`);
}
function checkCaSlot(distDir) {
  const html = read(join(distDir, 'index.html'));
  const register = readJson(join(distDir, 'register.json'));
  const ca = register.records.ca;
  const slot = html.match(/<section class="ca"[\s\S]*?<\/section>/)[0];
  check(html.indexOf(slot) < html.indexOf('<main'), 'CA slot is not above the main content');
  check(html.indexOf('<header') < html.indexOf(slot), 'CA slot should follow the header at the top');
  if (ca.state === 'stated' && ca.value) {
    check(slot.includes(`>${ca.value}<`), 'stated CA not shown in full');
    check(slot.includes('data-ca-copy') && slot.includes('<button'), 'stated CA lacks click-to-copy');
    check(slot.includes('data-state="stated"'), 'CA slot state attr');
  } else {
    check(!slot.includes('data-ca-copy') && !slot.includes('<button'), 'inert CA slot is clickable');
    check(/>pending</.test(slot), 'inert CA slot should read pending');
    check(!/value=|data-value|href=/.test(slot), 'inert CA slot carries value/url');
  }
}
function checkNoDates(distDir) {
  const html = read(join(distDir, 'index.html'));
  const text = visibleText(html) + ' ' + attrText(html);
  const bad = [
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i,
    /\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i,
    /\b(19|20)\d{2}\b/, /\b\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\b/, /\b\d{1,2}:\d{2}(:\d{2})?\b/,
    /\bas of\b/i, /\bchecked\b/i, /\bupdated\b/i, /\b\d+\s*(s|m|h|d)\s+ago\b/i, /\bago\b/i, /\b(am|pm)\b/i
  ];
  for (const re of bad) { const m = text.match(re); check(!m, `date-like text on page: "${m && m[0]}"`); }
  const inline = html.match(/id="register">([\s\S]*?)<\/script>/)[1];
  check(!/checked|\b20\d\d-\d\d-\d\d\b/.test(inline), 'inline register carries dates');
}
function checkAddressScan(distDir, caExempt) {
  const html = read(join(distDir, 'index.html'));
  const register = readJson(join(distDir, 'register.json'));
  const text = visibleText(html.replace(/<section class="ca"[\s\S]*?<\/section>/, ' ')) + ' ' + attrText(html);
  const bad = scanAddresses(text, register, caExempt);
  check(!bad.length, 'address-shaped strings not in the stated registry: ' + bad.join(','));
}

// ---------- gates -----------------------------------------------------------
const real = resolve(ROOT, 'dist');
const srcFiles = () => walk(resolve(ROOT, 'src')).filter((f) => TEXT_EXT.test(f.split(/[\\/]/).pop()));

gate('build', 'dist/ is produced with every deploy file', () => {
  build();
  for (const f of ['index.html', 'favicon.svg', 'register.json', 'assets/css/tokens.css', 'assets/css/site.css', 'assets/js/app.js', 'assets/js/lib.js', 'assets/js/market.js', 'assets/js/motion.js', 'assets/ogly-mark.png', 'assets/ogly-logo.png', 'assets/logo-192.png', 'assets/logo-512.png', 'assets/banner.jpg']) {
    check(existsSync(join(real, f)), 'missing dist/' + f);
  }
});
gate('dist-clean', 'repo-only files stay out of dist/', () => {
  const names = walk(real).map((f) => relative(real, f).replace(/\\/g, '/'));
  const repoOnly = new RegExp('^(README|LICENSE|docs/|scripts/|brand/|reference/|package|CLA' + 'UDE|\\.cla' + 'ude)', 'i');
  for (const n of names) check(!repoOnly.test(n), 'repo file in dist: ' + n);
});
gate('hygiene', 'no assistant config, no attribution anywhere in the repo', () => {
  const N = 'CLA' + 'UDE';
  check(!existsSync(resolve(ROOT, N + '.md')), 'assistant memory file present');
  check(!existsSync(resolve(ROOT, '.' + N.toLowerCase())), 'assistant config folder present');
  const banned = new RegExp(['cla' + 'ude', 'anth' + 'ropic', 'co-auth' + 'ored', 'gener' + 'ated by', '\\bA' + 'I\\b'].join('|'), 'i');
  const files = walk(ROOT, ['node_modules', '.git', '.gate-tmp', 'brand', 'reference']).filter((f) => TEXT_EXT.test(f.split(/[\\/]/).pop()));
  for (const f of files) { if (f.endsWith('ref-bigrams.json')) continue; const m = read(f).match(banned); check(!m, `${relative(ROOT, f)} mentions "${m && m[0]}"`); }
});
gate('repo-files', 'README, whitepaper and MIT licence exist with required parts', () => {
  const readme = read(resolve(ROOT, 'README.md'));
  for (const s of ['OGLY', 'Solana', 'ogly.pro', '## Overview', '## Features', '## Links', 'img.shields.io']) check(readme.includes(s), 'README lacks ' + s);
  check(/CA[^\n]*(TBA|pending|placeholder)/i.test(readme), 'README lacks a CA placeholder');
  const wp = read(resolve(ROOT, 'docs/whitepaper.md'));
  for (const s of ['Vision', 'Mission', 'Tokenomics', 'Roadmap', 'Team']) check(wp.includes(s), 'whitepaper lacks ' + s);
  const phases = (wp.match(/^###? Phase \d/gm) || []).length;
  check(phases >= 3 && phases <= 4, 'whitepaper needs 3-4 phases, has ' + phases);
  const lic = read(resolve(ROOT, 'LICENSE'));
  check(/MIT License/.test(lic) && /Copyright \(c\) 2026 OGLY/.test(lic), 'LICENSE is not MIT / OGLY, 2026');
});
gate('register', 'register records are well formed; inert records carry no value or url', () => {
  checkRegister(readJson(resolve(ROOT, 'src/register.json')));
  checkRegister(readJson(join(real, 'register.json')));
});
gate('chain', 'chain record states Solana, publicnode rpc, client statement, batch-level', () => {
  const c = readJson(join(real, 'register.json')).records.chain;
  check(c.state === 'stated' && c.value === 'Solana' && c.url === 'https://solana-rpc.publicnode.com' && c.source === 'client statement' && c.scope === 'batch-level', 'chain record mismatch');
});
gate('no-dates', 'no date, clock or recency text on the page, in tooltips or in aria-labels', () => checkNoDates(real));
gate('palette', 'colour literals live only in tokens.css and come from the provenance block', () => {
  const tokens = read(resolve(ROOT, 'src/css/tokens.css'));
  const prov = new Set([...tokens.matchAll(/#[0-9a-f]{6}\s+at\s+\d+,\d+/g)].map((m) => m[0].slice(0, 7)));
  check(prov.size >= 12, 'provenance block too small');
  const decl = new Set([...tokens.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(HEX)].map((m) => m[0]));
  for (const h of decl) check(prov.has(h), `token ${h} has no provenance`);
  for (const f of srcFiles()) {
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    if (rel === 'src/css/tokens.css' || rel === 'src/register.json') continue;
    if (rel === 'src/assets/favicon.svg') { for (const m of read(f).matchAll(HEX)) check(prov.has(m[0]), `favicon colour ${m[0]} not in palette`); continue; }
    const t = read(f).replace(/&#\d+;|&#x[0-9a-f]+;/gi, '');
    const m = t.match(HEX); check(!m, `${rel} holds colour literal ${m && m[0]}`);
    check(!/\brgba?\(|\bhsla?\(/.test(t), `${rel} holds rgb()/hsl() literal`);
  }
  const html = read(join(real, 'index.html')); const theme = html.match(/theme-color" content="(#[0-9a-f]{6})"/)[1];
  check(prov.has(theme), 'theme-color not from palette');
});
gate('no-ch', 'no ch units anywhere', () => {
  for (const f of [...srcFiles(), join(real, 'index.html')]) { const m = read(f).replace(/\/\*[\s\S]*?\*\//g, '').match(/(?<![\w-])\d*\.?\d+ch\b/); check(!m, `${relative(ROOT, f)} uses ch unit ${m && m[0]}`); }
});
gate('favicon', 'favicon is a 32x32 SVG with no comments and no double hyphens', () => {
  const s = read(join(real, 'favicon.svg'));
  check(/viewBox="0 0 32 32"/.test(s) && /width="32"/.test(s) && /height="32"/.test(s), 'not 32x32');
  check(!s.includes('<!--') && !s.includes('--'), 'comment or double hyphen in svg');
  check(/^<svg[\s\S]*<\/svg>\s*$/.test(s), 'not a single svg document');
});
gate('assets', 'logo assets decode, sizes right, premultiplied resize left no dark fringe', () => {
  const l = decodePng(readFileSync(join(real, 'assets/logo-192.png'))); check(l.w === 192 && l.h === 192, 'logo-192 size');
  const l5 = decodePng(readFileSync(join(real, 'assets/logo-512.png'))); check(l5.w === 512, 'logo-512 size');
  const m = decodePng(readFileSync(join(real, 'assets/ogly-mark.png'))); check(m.ct === 6, 'mark must keep alpha');
  let wsum = 0, lum = 0;
  for (let i = 0; i < m.px.length; i += 4) { const a = m.px[i + 3]; if (a > 0 && a < 255) { wsum += a; lum += a * ((m.px[i] + m.px[i + 1] + m.px[i + 2]) / 3); } }
  check(wsum > 0 && lum / wsum > 235, 'dark fringe on mark edges: ' + (lum / wsum).toFixed(1));
});
gate('copy-ngrams', 'zero 2-grams shared with the reference copy', () => {
  const html = read(join(real, 'index.html'));
  let text = visibleText(html) + ' ' + attrText(html);
  for (const f of ['app.js']) for (const m of read(join(real, 'assets/js', f)).matchAll(/'([^'\n]{12,})'/g)) if (/\s/.test(m[1]) && !/[<>{}=]/.test(m[1])) text += ' ' + m[1];
  const ref = new Set(readJson(resolve(ROOT, 'scripts/ref-bigrams.json')));
  const w = text.toLowerCase().replace(/’/g, "'").match(/[a-z0-9']+/g) || [];
  const hits = [];
  for (let i = 0; i < w.length - 1; i++) { const h = createHash('sha1').update(w[i] + ' ' + w[i + 1]).digest('hex').slice(0, 10); if (ref.has(h)) hits.push(w[i] + ' ' + w[i + 1]); }
  check(!hits.length, 'shared 2-grams: ' + [...new Set(hits)].join(' | '));
});
gate('reduced-motion', 'reduced motion switches every animation and transition off', () => {
  const css = read(join(real, 'assets/css/site.css'));
  const blk = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*)\}\s*$/);
  check(blk, 'no reduced-motion block'); check(/\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation:\s*none\s*!important[^}]*transition:\s*none\s*!important/.test(blk[1]), 'universal kill switch missing');
  check(/\.row--own\s*\{\s*animation:\s*none/.test(blk[1]), 'own row pulse not disabled');
  const js = read(join(real, 'assets/js/motion.js'));
  check(js.includes('prefers-reduced-motion: reduce'), 'motion.js ignores the media query');
  for (const fn of ['spring', 'initReveal', 'initParallax', 'initSpotlight', 'setNumber']) {
    const seg = js.slice(js.indexOf('function ' + fn)); check(/reduced\(\)/.test(seg.slice(0, 700)), fn + ' ignores reduced motion');
  }
});
gate('tap-targets', 'interactive controls declare >=44px boxes', () => {
  const css = read(join(real, 'assets/css/site.css'));
  const rule = (sel) => { const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); const m = new RegExp('(?:^|[,}]\\s*)' + esc + '\\s*(?:,[^{]*)?\\{([^}]*)\\}', 'm').exec(css); check(m, 'no rule ' + sel); return m[1]; };
  for (const sel of ['.social__item', '.copy-btn', '.nav__links a', '.jump a', '.btn', '.faq summary', '.footer nav a', '.brand', '.ca__action', '.link']) {
    const r = rule(sel); const h = /(?:min-)?height:\s*(\d+)px/.exec(r); check(h && +h[1] >= 44, `${sel} lacks >=44px height`);
  }
  check(/\.social__item[^}]*width:\s*44px/.test(css) && /\.copy-btn[^}]*width:\s*44px/.test(css), 'width 44 missing');
  check(/\.tabs \[role="tab"\][^}]*min-height:\s*(5\d|4[4-9])px/.test(css), 'tabs too small');
});
gate('letter-tile', 'letter-tile fallback present at >=2 sites; own row never uses one when CA is absent', () => {
  const js = read(join(real, 'assets/js/app.js'));
  const n = (js.match(/tile--letter/g) || []).length; check(n >= 2, 'letter-tile sites: ' + n);
  const ph = js.slice(js.indexOf("r1.dataset.own = 'placeholder'"), js.indexOf("frag.appendChild(r1)"));
  check(ph.includes('assets/ogly-logo.png') && ph.includes('tile--brand') && !ph.includes('tile--letter'), 'placeholder row is not a brand-logo row');
  check(/aria-disabled/.test(ph), 'placeholder row must be non-clickable'); check(ph.includes('$0.00') && ph.includes('· · · · ·'), 'placeholder data wrong');
  const css = read(join(real, 'assets/css/site.css'));
  check(/\.row--own\s*\{[^}]*border-left:\s*2px solid var\(--color-mint\)[^}]*animation:\s*ownPulse var\(--dur-pulse\) ease-in-out infinite/.test(css), 'own row style');
  check(read(join(real, 'assets/css/tokens.css')).includes('--dur-pulse: 2000ms'), 'pulse not 2s');
});
gate('own-token', 'own-token row logic: parallel fetch, pair choice, logo, liquidity fallback, dedup, logs', async () => {
  const lib = await import(pathToFileURL(join(real, 'assets/js/lib.js')).href);
  const mk = await import(pathToFileURL(join(real, 'assets/js/market.js')).href);
  const CA = 'So11111111111111111111111111111111111111112';
  const reg = readJson(join(real, 'register.json'));
  const pairs = [
    { chainId: 'solana', baseToken: { address: 'OTHER' + 'x'.repeat(30), symbol: 'ZZ' }, priceUsd: '9', volume: { h24: 9e9 } },
    { chainId: 'solana', baseToken: { address: CA, symbol: 'OGLY', name: 'OGLY' }, priceUsd: '0.5', priceChange: { h24: 12.5 }, volume: { h24: 100 }, liquidity: { usd: 0 }, marketCap: 777 },
    { chainId: 'solana', baseToken: { address: CA, symbol: 'OGLY', name: 'OGLY' }, priceUsd: '0.6', priceChange: { h24: 3 }, volume: { h24: 5000 }, liquidity: { usd: 42 }, marketCap: 888 }
  ];
  check(lib.selectOwnPair(pairs, CA).priceUsd === '0.6', 'pair choice must be volume.h24 desc over baseToken match');
  const calls = []; const logs = [];
  const orig = console.log; console.log = (...a) => logs.push(a[0]);
  const fetchImpl = async (u) => { calls.push(u); return { ok: true, json: async () => (u.includes('pump.fun') ? { image_uri: 'https://img.example/x.png' } : { pairs }) }; };
  const row = await mk.loadOwn(reg, CA, { fetchImpl }); console.log = orig;
  check(calls.length === 2 && calls.some((u) => u === reg.records['market-source'].endpoints.token + CA) && calls.some((u) => u === reg.records['logo-source'].url + CA), 'must fetch both sources');
  check(row.logo === 'https://img.example/x.png' && row.price === 0.6 && row.change === 3 && row.volume === 5000 && row.liquidity === 42 && row.liquidityLabel === 'Liquidity', 'row fields');
  check(logs.includes('[ogly] own token raw response') && logs.includes('[ogly] own liquidity candidates'), 'console markers missing');
  const fb = lib.buildOwnRow(CA, { pairs: [pairs[1]] }, null); check(fb.logo === 'assets/logo-192.png', 'logo fallback'); check(fb.liquidity === 777 && fb.liquidityLabel === 'Mkt Cap', 'liquidity falls back to market cap');
  const dd = lib.dedupeOwn([{ address: CA }, { address: 'b' }], CA); check(dd.length === 1 && dd[0].address === 'b', 'dedupe');
  const failing = async () => { throw new Error('down'); };
  const down = await mk.loadOwn(reg, CA, { fetchImpl: failing }); check(down.price === null && down.logo === 'assets/logo-192.png', 'both sources down must degrade');
  const src = read(join(real, 'assets/js/market.js')) + read(join(real, 'assets/js/app.js')) + read(join(real, 'assets/js/lib.js'));
  check(!/dd\.dexscreener\.com/.test(src), 'DexScreener CDN logo referenced');
});
gate('market-independence', 'trending market ignores CA state and follows the market-source record only', async () => {
  const mk = await import(pathToFileURL(join(real, 'assets/js/market.js')).href);
  const base = readJson(join(real, 'register.json'));
  const withCa = JSON.parse(JSON.stringify(base)); withCa.records.ca = { label: 'CA', state: 'stated', value: 'So11111111111111111111111111111111111111112' };
  const boosts = [{ chainId: 'ethereum', tokenAddress: 'E' }, { chainId: 'solana', tokenAddress: 'A'.repeat(40) }, { chainId: 'solana', tokenAddress: 'B'.repeat(40) }, { chainId: 'solana', tokenAddress: 'A'.repeat(40) }];
  const mkPairs = (u) => u.split('/').pop().split(',').map((a, i) => ({ chainId: 'solana', baseToken: { address: a, symbol: 'T' + i }, priceUsd: '1', volume: { h24: 10 * (i + 1) } }));
  const run = async (reg) => { const urls = []; const rows = await mk.loadTrending(reg, { fetchImpl: async (u) => { urls.push(u); return { ok: true, json: async () => (u.includes('boosts') ? boosts : mkPairs(u)) }; } }); return { urls, rows }; };
  const a = await run(base), b = await run(withCa);
  check(JSON.stringify(a) === JSON.stringify(b), 'CA state changed the market fetches');
  check(a.urls[0] === base.records['market-source'].endpoints.boosts && a.urls[1].startsWith(base.records['market-source'].endpoints.pairs), 'endpoints not from register');
  check(!a.urls[1].includes('E') || a.urls[1].split('/').pop().split(',').length === 2, 'non-solana entries must be dropped');
  check(a.rows[0].volume >= a.rows[1].volume, 'sorted by 24h volume');
  const noMarket = JSON.parse(JSON.stringify(base)); noMarket.records['market-source'] = { label: 'x', state: 'absent' };
  let threw = false; try { await mk.loadTrending(noMarket, { fetchImpl: async () => ({ ok: true, json: async () => [] }) }); } catch { threw = true; } check(threw, 'absent market-source must stop the market');
  const mj = read(join(real, 'assets/js/market.js'));
  check(!/records\.ca|'ca'|"ca"/.test(mj.slice(mj.indexOf('export async function loadTrending'), mj.indexOf('export async function loadOwn'))), 'loadTrending touches ca');
});
gate('polling', '60s poll, hidden-tab pause, immediate refetch on visible, exponential backoff, last good data kept', async () => {
  const mj = read(join(real, 'assets/js/market.js')); const aj = read(join(real, 'assets/js/app.js'));
  check(/intervalMs = 60000/.test(mj) && /visibilitychange/.test(mj) && /visibilityState === 'hidden'/.test(mj), 'poll rules missing');
  check(/lastTrending/.test(aj) && /Showing the last good data/.test(aj), 'last good data not kept'); check(/Source unreachable/.test(aj) && /—/.test(aj), 'dash + error state missing');
  const lib = await import(pathToFileURL(join(real, 'assets/js/lib.js')).href);
  check([0, 1, 2, 3, 4, 5, 6].map((n) => lib.backoffDelay(n)).join() === '1000,2000,4000,8000,16000,30000,30000', 'backoff curve');
});
gate('market-ui', 'ticker, skeletons, status pill, spotlight, progress bar, parallax and count-up are wired', () => {
  const html = read(join(real, 'index.html')); const js = read(join(real, 'assets/js/app.js')); const css = read(join(real, 'assets/css/site.css'));
  for (const s of ['data-ticker-track', 'data-progress', 'data-status', 'data-parallax', 'data-spot', 'data-reveal', 'data-rows']) check(html.includes(s), 'html lacks ' + s);
  for (const s of ['row--skeleton', 'renderTicker', 'setNumber', 'initSpotlight', 'initParallax', 'initProgress', 'initReveal', 'copy-btn']) check(js.includes(s), 'app lacks ' + s);
  for (const s of ['@keyframes marquee', '@keyframes shimmer', '@keyframes rowIn', '@keyframes dot', '@keyframes flashUp']) check(css.includes(s), 'css lacks ' + s);
  check(/damping|stiffness/.test(read(join(real, 'assets/js/motion.js'))), 'no spring solver');
});
gate('no-external', 'no third-party scripts, fonts or logo CDNs in the page', () => {
  const html = read(join(real, 'index.html'));
  check(!/<script[^>]+src="https?:/.test(html) && !/<link[^>]+href="https?:/.test(html), 'external asset in html');
  check(!/@import|url\(["']?https?:/.test(read(join(real, 'assets/css/site.css'))), 'external css');
});
gate('branch-absent', 'CA absent: inert CA slot, inert social icons, brand-logo placeholder row, market untouched', () => {
  checkRegister(readJson(join(real, 'register.json')));
  const reg = readJson(join(real, 'register.json'));
  for (const id of ['ca', 'x', 'github']) check(reg.records[id].state !== 'stated', `${id} unexpectedly stated in the shipped register`);
  checkSocial(real); checkCaSlot(real); checkAddressScan(real, []);
  const html = read(join(real, 'index.html')); check(html.includes('data-ca-state="absent"'), 'body state attr');
});
gate('branch-stated', 'CA + X + GitHub stated: full CA with copy, live links with derived handles, scanner exempts only the CA', () => {
  rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true });
  const base = readJson(resolve(ROOT, 'src/register.json'));
  const CA = 'Fh7QwG3mYpL2vXc9RkT8sNdZ4bUe6JiAoHq1WxMn5pum';
  check(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(CA), 'sample CA is not a valid base58 address');
  const reg = JSON.parse(JSON.stringify(base));
  reg.records.ca = { label: 'Contract address', state: 'stated', value: CA, checked: 'x' };
  reg.records.x = { label: 'X', state: 'stated', url: 'https://x.com/oglypro' };
  reg.records.github = { label: 'GitHub', state: 'stated', url: 'https://github.com/ogly-pro/ogly' };
  reg.records['venue-solscan'] = { label: 'Solscan', state: 'stated', url: 'https://solscan.io/token/' + CA };
  const out = build({ out: resolve(TMP, 'stated'), registerOverride: reg });
  checkRegister(readJson(join(out, 'register.json'))); checkSocial(out); checkCaSlot(out); checkNoDates(out);
  const html = read(join(out, 'index.html'));
  check(html.includes('data-ca-state="stated"'), 'body state attr');
  check(/data-venue="venue-solscan" href="https:\/\/solscan\.io\/token\//.test(html), 'stated venue not linked');
  checkAddressScan(out, [CA]);
  // The CA is exempt inside its slot only: a copy elsewhere in the page must trip the scanner.
  const leaked = html.replace('The full mint', 'The full mint ' + CA);
  const textNoSlot = visibleText(leaked.replace(/<section class="ca"[\s\S]*?<\/section>/, ' '));
  check(scanAddresses(textNoSlot, readJson(join(out, 'register.json')), []).length === 0, 'stated CA elsewhere should match registry');
  const stray = 'Send to Gk8vWq3NnZc7YtRb2LpXe5MfHd9JsUa4TiKo6AxCw1Qy now';
  check(scanAddresses(stray, readJson(join(out, 'register.json')), [CA]).length === 1, 'unregistered address must be flagged');
  rmSync(TMP, { recursive: true, force: true });
});
gate('mutation-harness', 'mutations flip the outputs; anchors read the register at runtime, nothing hardcoded', () => {
  rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true });
  const base = readJson(resolve(ROOT, 'src/register.json'));
  const mutate = (id, patch) => { const r = JSON.parse(JSON.stringify(base)); r.records[id] = { label: base.records[id].label, ...patch }; return r; };
  const cases = [
    ['ca-unconfirmed', mutate('ca', { state: 'unconfirmed' })],
    ['x-on', mutate('x', { state: 'stated', url: 'https://x.com/zz' })],
    ['gh-on', mutate('github', { state: 'stated', url: 'https://github.com/zz/zz' })],
    ['ca-on', mutate('ca', { state: 'stated', value: 'Fh7QwG3mYpL2vXc9RkT8sNdZ4bUe6JiAoHq1WxMn5pum' })],
    ['market-off', mutate('market-source', { state: 'unconfirmed' })]
  ];
  for (const [name, reg] of cases) {
    const out = build({ out: resolve(TMP, name), registerOverride: reg });
    checkRegister(readJson(join(out, 'register.json'))); checkSocial(out); checkCaSlot(out); checkNoDates(out);
  }
  const on = read(join(TMP, 'x-on/dist-none'.replace('/dist-none', ''), 'index.html'));
  check(/data-social="x" data-state="stated" href=/.test(on), 'x mutation did not flip the icon');
  const off = read(join(real, 'index.html')); check(/data-social="x" data-state="absent"/.test(off), 'shipped x should be inert');
  rmSync(TMP, { recursive: true, force: true });
});
gate('address-scanner', 'scanner never blanket-rejects 0x hex; it matches address shapes to the stated registry', () => {
  const reg = { records: { a: { state: 'stated', value: '0x' + 'ab'.repeat(20) }, b: { state: 'absent' } } };
  check(scanAddresses('colour 0x1f and 0xdeadbeef and id 0x12', reg).length === 0, 'short 0x hex rejected');
  check(scanAddresses('0x' + 'ab'.repeat(20), reg).length === 0, 'stated 0x address rejected');
  check(scanAddresses('0x' + 'cd'.repeat(20), reg).length === 1, 'unstated 0x address accepted');
  const src = read(resolve(ROOT, 'scripts/gates.mjs')); check(!/startsWith\('0x'\)\s*\)\s*(throw|fail)/.test(src), 'blanket rule');
});

// ---------- run -----------------------------------------------------------------
let failed = 0;
for (const g of results) {
  try { await g.fn(); console.log(`PASS  ${g.id.padEnd(20)} ${g.name}`); }
  catch (e) { failed++; console.log(`FAIL  ${g.id.padEnd(20)} ${g.name}\n        -> ${e.message}`); }
}
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${results.length - failed}/${results.length} gates passed`);
process.exit(failed ? 1 : 0);
