// Data layer. Endpoints come from the market-source register record only.
// Nothing in loadTrending can see the contract address: market state is independent of CA state.
import {
  readRecord, isStated, solanaBoostAddresses, buildTrending, buildOwnRow, backoffDelay
} from './lib.js';

export function marketEndpoints(register) {
  const rec = readRecord(register, 'market-source');
  return isStated(rec) && rec.endpoints ? rec.endpoints : null;
}

export async function fetchJson(url, { fetchImpl, signal, timeoutMs = 10000 } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
  try {
    const res = await f(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function loadTrending(register, opts = {}) {
  const ep = marketEndpoints(register);
  if (!ep) throw new Error('market source not stated');
  const boosts = await fetchJson(ep.boosts, opts);
  const addrs = solanaBoostAddresses(boosts, 30);
  if (!addrs.length) throw new Error('no solana entries');
  const pairs = await fetchJson(ep.pairs + addrs.join(','), opts);
  const rows = buildTrending(boosts, pairs, 12);
  if (!rows.length) throw new Error('no pairs');
  return rows;
}

export async function loadOwn(register, ca, opts = {}) {
  const ep = marketEndpoints(register);
  const logoRec = readRecord(register, 'logo-source');
  const dexUrl = ep && ep.token ? ep.token + ca : null;
  const pumpUrl = isStated(logoRec) ? logoRec.url + ca : null;
  const [dex, pump] = await Promise.all([
    dexUrl ? fetchJson(dexUrl, opts).catch(() => null) : null,
    pumpUrl ? fetchJson(pumpUrl, opts).catch(() => null) : null
  ]);
  console.log('[ogly] own token raw response', { dex, pump });
  const pair = dex && Array.isArray(dex.pairs)
    ? dex.pairs.filter((p) => p && p.baseToken && p.baseToken.address === ca)
    : [];
  console.log('[ogly] own liquidity candidates', pair.map((p) => ({
    liquidityUsd: p.liquidity && p.liquidity.usd, marketCap: p.marketCap, fdv: p.fdv
  })));
  return buildOwnRow(ca, dex, pump);
}

// Poll every intervalMs, pause while hidden, fetch at once when visible again,
// exponential backoff after failures. `tick` must throw on failure.
export function createPoller(tick, { intervalMs = 60000, onFail = () => {}, onOk = () => {} } = {}) {
  let timer = 0, failures = 0, running = false, stopped = false;
  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const schedule = (ms) => { clearTimeout(timer); if (!stopped && !hidden()) timer = setTimeout(run, ms); };
  async function run() {
    if (running || stopped || hidden()) return;
    running = true;
    try {
      await tick();
      failures = 0;
      onOk();
      running = false;
      schedule(intervalMs);
    } catch (err) {
      failures += 1;
      onFail(err, failures);
      running = false;
      schedule(backoffDelay(failures - 1));
    }
  }
  const onVis = () => { if (hidden()) clearTimeout(timer); else run(); };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
  return {
    start: run,
    stop() { stopped = true; clearTimeout(timer); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis); }
  };
}
