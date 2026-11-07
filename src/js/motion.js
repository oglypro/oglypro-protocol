// Motion layer. Every entry point checks reduced motion and falls back to the final state at once.

const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
export const reduced = () => !!(mq && mq.matches);

// Damped spring, semi-implicit Euler at a fixed 1/120 s step.
export function spring(from, to, onUpdate, opts = {}) {
  const k = opts.stiffness ?? 170;
  const c = opts.damping ?? 22;
  const m = opts.mass ?? 1;
  const delay = opts.delay ?? 0;
  const done = opts.onDone || (() => {});
  if (reduced()) { onUpdate(to); done(); return () => {}; }
  let x = from, v = 0, last = 0, raf = 0, timer = 0, dead = false;
  const dt = 1 / 120;
  let acc = 0;
  const frame = (t) => {
    if (dead) return;
    if (!last) last = t;
    acc += Math.min(0.05, (t - last) / 1000);
    last = t;
    while (acc >= dt) {
      const a = (-k * (x - to) - c * v) / m;
      v += a * dt;
      x += v * dt;
      acc -= dt;
    }
    if (Math.abs(x - to) < 0.0008 && Math.abs(v) < 0.002) { onUpdate(to); done(); return; }
    onUpdate(x);
    raf = requestAnimationFrame(frame);
  };
  timer = setTimeout(() => { raf = requestAnimationFrame(frame); }, delay);
  return () => { dead = true; clearTimeout(timer); cancelAnimationFrame(raf); };
}

export function initReveal(root = document) {
  const items = [...root.querySelectorAll('[data-reveal]')];
  const show = (el, delay) => {
    el.style.willChange = 'transform, opacity';
    spring(0, 1, (p) => {
      el.style.opacity = String(Math.max(0, Math.min(1, p)));
      el.style.transform = `translate3d(0, ${((1 - p) * 28).toFixed(2)}px, 0)`;
    }, {
      delay,
      onDone: () => {
        el.style.opacity = '';
        el.style.transform = '';
        el.style.willChange = '';
        el.classList.add('is-in');
      }
    });
  };
  if (reduced() || typeof IntersectionObserver !== 'function') {
    items.forEach((el) => el.classList.add('is-in'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    const batch = entries.filter((e) => e.isIntersecting);
    batch.forEach((e, i) => {
      io.unobserve(e.target);
      const own = Number(e.target.dataset.revealDelay || 0);
      show(e.target, own + i * 70);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  items.forEach((el) => io.observe(el));
}

export function initProgress(bar) {
  if (!bar) return;
  const update = () => {
    const h = document.documentElement.scrollHeight - innerHeight;
    bar.style.transform = `scaleX(${h > 0 ? Math.min(1, scrollY / h) : 0})`;
  };
  addEventListener('scroll', update, { passive: true });
  addEventListener('resize', update);
  update();
}

export function initParallax(scope) {
  if (!scope || reduced()) return;
  const layers = [...scope.querySelectorAll('[data-depth]')];
  if (!layers.length) return;
  let px = 0, py = 0, tx = 0, ty = 0, sy = 0, raf = 0;
  const tick = () => {
    px += (tx - px) * 0.08;
    py += (ty - py) * 0.08;
    for (const l of layers) {
      const d = Number(l.dataset.depth);
      l.style.transform = `translate3d(${(px * d * 26).toFixed(2)}px, ${(py * d * 26 + sy * d * -0.12).toFixed(2)}px, 0)`;
    }
    raf = Math.abs(tx - px) + Math.abs(ty - py) > 0.002 ? requestAnimationFrame(tick) : 0;
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
  scope.addEventListener('pointermove', (e) => {
    const r = scope.getBoundingClientRect();
    tx = (e.clientX - r.left) / r.width - 0.5;
    ty = (e.clientY - r.top) / r.height - 0.5;
    kick();
  });
  scope.addEventListener('pointerleave', () => { tx = 0; ty = 0; kick(); });
  addEventListener('scroll', () => { sy = Math.min(scrollY, innerHeight * 1.2); kick(); }, { passive: true });
}

// Spotlight: writes pointer position into CSS variables for any [data-spot] element.
export function initSpotlight(root = document) {
  if (reduced()) return;
  root.addEventListener('pointermove', (e) => {
    const el = e.target.closest && e.target.closest('[data-spot]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', (e.clientX - r.left).toFixed(1) + 'px');
    el.style.setProperty('--my', (e.clientY - r.top).toFixed(1) + 'px');
  }, { passive: true });
}

// Count-up with a flash on every value change.
export function setNumber(el, to, fmt) {
  const prev = el._val;
  el._val = to;
  if (to === null || to === undefined || Number.isNaN(to)) { el.textContent = '—'; return; }
  if (prev === undefined || prev === null || reduced()) {
    el.textContent = fmt(to);
    if (prev !== undefined && prev !== to) flash(el, to > prev ? 'up' : 'down');
    if (prev === undefined || prev === null) {
      if (!reduced()) spring(0, 1, (p) => { el.textContent = fmt(to * Math.max(0, Math.min(1, p))); },
        { stiffness: 120, damping: 20, onDone: () => { el.textContent = fmt(to); } });
    }
    return;
  }
  spring(prev, to, (v) => { el.textContent = fmt(v); }, {
    stiffness: 140, damping: 22, onDone: () => { el.textContent = fmt(to); }
  });
  if (to !== prev) flash(el, to > prev ? 'up' : 'down');
}

function flash(el, dir) {
  if (reduced()) return;
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth;
  el.classList.add(dir === 'up' ? 'flash-up' : 'flash-down');
}
