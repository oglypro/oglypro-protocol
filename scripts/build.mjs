// Static build: src/ -> dist/. No dependencies.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function build({ root = ROOT, out, registerOverride } = {}) {
  const src = resolve(root, 'src');
  const dist = out || resolve(root, 'dist');
  const register = registerOverride || JSON.parse(readFileSync(resolve(src, 'register.json'), 'utf8'));

  rmSync(dist, { recursive: true, force: true });
  mkdirSync(resolve(dist, 'assets/css'), { recursive: true });
  mkdirSync(resolve(dist, 'assets/js'), { recursive: true });

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rec = (id) => register.records[id] || { state: 'absent', label: id };
  const stated = (r) => r.state === 'stated';
  const handle = (url) => { try { return new URL(url).pathname.split('/').filter(Boolean)[0] || null; } catch { return null; } };

  // The inline copy carries no dates: they stay in dist/register.json as data.
  const inline = JSON.parse(JSON.stringify(register));
  for (const r of Object.values(inline.records)) delete r.checked;

  const X = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
  const GH = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>';

  const social = (id, name, icon) => {
    const r = rec(id);
    if (stated(r) && r.url && handle(r.url)) {
      return `<a class="social__item" data-social="${id}" data-state="stated" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" aria-label="${name} @${esc(handle(r.url))}">${icon}</a>`;
    }
    return `<span class="social__item is-inert" data-social="${id}" data-state="${esc(r.state)}" role="img" aria-disabled="true" aria-label="${name} pending">${icon}</span>`;
  };
  const SOCIAL = `<div class="social" role="group" aria-label="Social">${social('x', 'X', X)}${social('github', 'GitHub', GH)}</div>`;

  const ca = rec('ca');
  const caOk = stated(ca) && typeof ca.value === 'string' && ca.value.length > 0;
  const CA_SLOT = caOk
    ? `<section class="ca" data-ca data-state="stated" aria-label="Mint address"><div class="wrap ca__in"><div class="ca__label">Mint (CA)</div><button type="button" class="ca__value" data-ca-copy aria-label="Copy mint address"><span class="ca__text" data-ca-value>${esc(ca.value)}</span><span class="ca__action"><span data-ca-feedback aria-live="polite">Copy</span></span></button><p class="ca__hint">Match every character before you swap.</p></div></section>`
    : `<section class="ca" data-ca data-state="${esc(ca.state)}" aria-label="Mint address"><div class="wrap ca__in"><div class="ca__label">Mint (CA)</div><div class="ca__value is-inert" data-ca-value>pending</div><p class="ca__hint">Full mint prints here upon publication.</p></div></section>`;

  const venueIds = Object.keys(register.records).filter((k) => k.startsWith('venue-'));
  const VENUES = venueIds.map((id) => {
    const r = rec(id);
    const name = esc(r.label || id);
    const letter = esc((r.label || id).trim()[0].toUpperCase());
    if (stated(r) && r.url) {
      return `<li><a class="venue" data-venue="${id}" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer"><span class="venue__logo" aria-hidden="true">${letter}</span><span><strong>${name}</strong><small>Open</small></span></a></li>`;
    }
    return `<li><div class="venue is-inert" data-venue="${id}" aria-disabled="true"><span class="venue__logo" aria-hidden="true">${letter}</span><span><strong>${name}</strong><small>pending</small></span></div></li>`;
  }).join('');

  const tokens = readFileSync(resolve(src, 'css/tokens.css'), 'utf8');
  const theme = (tokens.match(/--color-bg:\s*(#[0-9a-fA-F]{6})/) || [])[1];
  const chain = rec('chain');

  let html = readFileSync(resolve(src, 'index.html'), 'utf8');
  const map = {
    THEME_COLOR: theme,
    REGISTER_INLINE: JSON.stringify(inline).replace(/</g, '\\u003c'),
    CA_STATE: caOk ? 'stated' : esc(ca.state),
    SOCIAL, CA_SLOT, VENUES,
    CHAIN_NAME: stated(chain) ? esc(chain.value) : 'Chain pending'
  };
  html = html.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => {
    if (!(k in map)) throw new Error('unknown placeholder ' + k);
    return map[k];
  });
  writeFileSync(resolve(dist, 'index.html'), html);
  writeFileSync(resolve(dist, 'register.json'), JSON.stringify(register, null, 2) + '\n');

  cpSync(resolve(src, 'css'), resolve(dist, 'assets/css'), { recursive: true });
  cpSync(resolve(src, 'js'), resolve(dist, 'assets/js'), { recursive: true });
  for (const f of ['ogly-mark.png', 'ogly-logo.png', 'logo-192.png', 'logo-512.png', 'banner.jpg']) {
    cpSync(resolve(src, 'assets', f), resolve(dist, 'assets', f));
  }
  cpSync(resolve(src, 'assets/favicon.svg'), resolve(dist, 'favicon.svg'));
  return dist;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('built ->', build());
}
