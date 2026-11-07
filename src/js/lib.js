// Pure helpers shared by the browser bundle and the gate harness.
// No DOM access here so the same code runs under node.

export const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isSolanaAddress(s) {
  return typeof s === 'string' && BASE58.test(s);
}

// Store the URL, derive the handle. Returns null for anything unusable.
export function deriveHandle(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return seg || null;
  } catch {
    return null;
  }
}

export function readRecord(register, id) {
  const r = register && register.records ? register.records[id] : null;
  return r || { state: 'absent' };
}

export function isStated(rec) {
  return !!rec && rec.state === 'stated';
}

export function shortAddress(a) {
  return a && a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a || '';
}

const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};
export { num };

export function formatCompact(v) {
  const n = num(v);
  if (n === null) return '—';
  const abs = Math.abs(n);
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [d, s] of units) {
    if (abs >= d) return '$' + (n / d).toFixed(abs / d >= 100 ? 0 : 2).replace(/\.?0+$/, '') + s;
  }
  return '$' + n.toFixed(2);
}

export function formatPrice(v) {
  const n = num(v);
  if (n === null) return '—';
  if (n === 0) return '$0.00';
  if (n >= 1) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  if (n >= 0.01) return '$' + n.toFixed(4);
  const decimals = Math.min(14, Math.floor(-Math.log10(Math.abs(n))) + 4);
  return '$' + n.toFixed(decimals);
}

export function formatPct(v) {
  const n = num(v);
  if (n === null) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

export function letterOf(name) {
  const s = String(name || '?').trim();
  return (s.match(/[A-Za-z0-9]/) || ['?'])[0].toUpperCase();
}

// --- trending ------------------------------------------------------------

export function solanaBoostAddresses(boosts, limit = 30) {
  if (!Array.isArray(boosts)) return [];
  const seen = new Set();
  const out = [];
  for (const b of boosts) {
    if (!b || b.chainId !== 'solana' || typeof b.tokenAddress !== 'string') continue;
    if (seen.has(b.tokenAddress)) continue;
    seen.add(b.tokenAddress);
    out.push(b.tokenAddress);
    if (out.length >= limit) break;
  }
  return out;
}

const vol24 = (p) => num(p && p.volume && p.volume.h24) || 0;

export function bestPairByToken(pairs) {
  const best = new Map();
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const addr = p && p.baseToken && p.baseToken.address;
    if (!addr || p.chainId !== 'solana') continue;
    const cur = best.get(addr);
    if (!cur || vol24(p) > vol24(cur)) best.set(addr, p);
  }
  return best;
}

export function buildTrending(boosts, pairs, limit = 10) {
  const icons = new Map();
  for (const b of Array.isArray(boosts) ? boosts : []) {
    if (b && b.tokenAddress && b.icon) icons.set(b.tokenAddress, b.icon);
  }
  const rows = [];
  for (const [address, p] of bestPairByToken(pairs)) {
    rows.push({
      address,
      symbol: p.baseToken.symbol || '?',
      name: p.baseToken.name || p.baseToken.symbol || '?',
      price: num(p.priceUsd),
      change: num(p.priceChange && p.priceChange.h24),
      volume: vol24(p),
      liquidity: num(p.liquidity && p.liquidity.usd),
      logo: (p.info && p.info.imageUrl) || icons.get(address) || null,
      url: p.url || null
    });
  }
  rows.sort((a, b) => b.volume - a.volume);
  return rows.slice(0, limit);
}

// --- own token -------------------------------------------------------------

export function selectOwnPair(pairs, ca) {
  const list = (Array.isArray(pairs) ? pairs : []).filter(
    (p) => p && p.baseToken && p.baseToken.address === ca
  );
  list.sort((a, b) => vol24(b) - vol24(a));
  return list[0] || null;
}

export function ownLiquidity(pair) {
  if (!pair) return { value: null, label: 'Liquidity' };
  const liq = num(pair.liquidity && pair.liquidity.usd);
  if (liq && liq > 0) return { value: liq, label: 'Liquidity' };
  const mc = num(pair.marketCap);
  return { value: mc, label: 'Mkt Cap' };
}

export const OWN_FALLBACK_LOGO = 'assets/logo-192.png';

export function buildOwnRow(ca, dexJson, pumpJson) {
  const pair = selectOwnPair(dexJson && dexJson.pairs, ca);
  const liq = ownLiquidity(pair);
  const pumpLogo = pumpJson && typeof pumpJson.image_uri === 'string' && pumpJson.image_uri ? pumpJson.image_uri : null;
  return {
    own: true,
    address: ca,
    symbol: (pair && pair.baseToken.symbol) || (pumpJson && pumpJson.symbol) || 'OGLY',
    name: (pair && pair.baseToken.name) || (pumpJson && pumpJson.name) || 'OGLY',
    price: pair ? num(pair.priceUsd) : null,
    change: pair ? num(pair.priceChange && pair.priceChange.h24) : null,
    volume: pair ? vol24(pair) : null,
    liquidity: liq.value,
    liquidityLabel: liq.label,
    marketCap: pair ? num(pair.marketCap) : null,
    logo: pumpLogo || OWN_FALLBACK_LOGO,
    hasPair: !!pair
  };
}

export function dedupeOwn(trending, ca) {
  return ca ? trending.filter((r) => r.address !== ca) : trending;
}

// --- retry -----------------------------------------------------------------

export function backoffDelay(attempt, base = 1000, cap = 30000) {
  return Math.min(cap, base * Math.pow(2, Math.max(0, attempt)));
}
