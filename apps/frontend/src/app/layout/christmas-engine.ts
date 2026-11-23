import type { Ornament } from './christmas-settings';

/** What is on screen: the active layers, how dense, and whether motion is frozen. */
export interface DecorationState {
  readonly active: readonly Ornament[];
  /** 1 = light, 2 = medium, 3 = full. */
  readonly intensity: number;
  readonly paused: boolean;
}

/** One decoration. Layers own their DOM and release everything in `destroy`. */
export interface Layer {
  resize?(): void;
  /** Called every frame; `dt` is 0 when the engine draws a single still image. */
  frame?(time: number, dt: number): void;
  pause?(): void;
  play?(): void;
  /** Sends the sleigh across the screen now (sleigh layer only). */
  fly?(): void;
  destroy(): void;
}

interface Palette {
  readonly light: boolean;
  readonly snow: string;
  readonly star: string;
  readonly frost: string;
}

interface Pointer {
  x: number;
  y: number;
  active: boolean;
}

/** Geometry of the wire draped under the top bar, across the content column. */
interface Swag {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly n: number;
  readonly seg: number;
  readonly sag: number;
  /** Vertical position of the wire at local `x`. */
  y(x: number): number;
  /** Wire slope at local `x`, in degrees. */
  angle(x: number): number;
}

/** Shared services the engine lends to each layer. */
interface Env {
  readonly pointer: Pointer;
  readonly palette: Palette;
  /** Density multiplier for a layer at the current intensity. */
  factor(name: Ornament): number;
  isPaused(): boolean;
  /** True when a layer is part of the current scene. */
  has(name: Ornament): boolean;
  /** Registers a pointer-move hook and returns its unsubscribe function. */
  onPointerMove(fn: (dx: number, dy: number) => void): () => void;
}

type LayerFactory = (host: HTMLElement, env: Env) => Layer;

type LayerName = Exclude<Ornament, 'advent'>;

/** Back to front. `advent` is a widget in the control panel, not a scene layer. */
const ORDER: readonly LayerName[] = [
  'stars', 'aurora', 'village', 'embers', 'sleigh', 'snow', 'caps', 'garland', 'lights', 'frost', 'theme',
];

const INTENSITY_FACTOR: readonly number[] = [0, 0.45, 1, 1.8];
const NOOP: Layer = { destroy() {} };
const SVG_NS = 'http://www.w3.org/2000/svg';

const viewWidth = () => document.documentElement.clientWidth;
const viewHeight = () => window.innerHeight;
const isLight = () => document.documentElement.classList.contains('light');

function element(tag: string, className: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/** Small deterministic generator so rebuilt layers look identical after a resize. */
function mulberry(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Surface {
  readonly el: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  fit(): void;
}

/** A viewport-wide canvas that tracks the device pixel ratio. */
function surface(parent: HTMLElement, height: () => number): Surface | null {
  const el = document.createElement('canvas');
  el.className = 'fx-canvas';
  const ctx = el.getContext('2d');
  if (!ctx) return null;
  parent.append(el);
  const s: Surface = {
    el,
    ctx,
    fit() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const h = height();
      el.width = Math.round(viewWidth() * ratio);
      el.height = Math.round(h * ratio);
      el.style.height = `${h}px`;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    },
  };
  s.fit();
  return s;
}

function readPalette(): Palette {
  return isLight()
    ? { light: true, snow: '150,170,208', star: '110,120,180', frost: 'rgba(110,150,205,.5)' }
    : { light: false, snow: '236,244,255', star: '255,255,255', frost: 'rgba(222,238,255,.42)' };
}

function contentColumn(): { left: number; width: number } {
  const rect = document.querySelector<HTMLElement>('.workspace-content')?.getBoundingClientRect();
  return { left: rect?.left ?? 0, width: rect?.width ?? viewWidth() };
}

function swag(drop = 0): Swag {
  const bar = document.querySelector<HTMLElement>('.topbar')?.getBoundingClientRect();
  const { left, width } = contentColumn();
  const top = (bar?.bottom ?? 48) - 2 + drop;
  const n = Math.max(2, Math.round(width / (width < 600 ? 150 : 250)));
  const seg = width / n;
  const sag = Math.min(24, seg * 0.11);
  const phase = (x: number) => (((x % seg) + seg) % seg) / seg;
  return {
    left, top, width, n, seg, sag,
    y: (x) => top + 4 * sag * phase(x) * (1 - phase(x)),
    angle: (x) => Math.atan((4 * sag * (1 - 2 * phase(x))) / seg) * (180 / Math.PI),
  };
}

function flakeSprite(rgb: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  if (x) {
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, `rgba(${rgb},1)`);
    g.addColorStop(0.4, `rgba(${rgb},.85)`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
  }
  return c;
}

interface Flake {
  x: number; y: number; z: number; r: number; vy: number; phase: number; sway: number; alpha: number;
}

const snow: LayerFactory = (host, env) => {
  const cv = surface(host, viewHeight);
  if (!cv) return NOOP;
  const sprite = flakeSprite(env.palette.snow);
  const make = (anywhere: boolean): Flake => {
    const z = Math.random() ** 1.5;
    return {
      x: Math.random() * viewWidth(), y: anywhere ? Math.random() * viewHeight() : -20 - Math.random() * 80,
      z, r: 0.7 + z * 2.8, vy: 16 + z * 48 + Math.random() * 8,
      phase: Math.random() * 6.28, sway: 0.5 + Math.random() * 0.9, alpha: 0.3 + z * 0.55,
    };
  };
  let flakes: Flake[] = [];
  const seed = () => {
    const count = Math.min(480, Math.round((viewWidth() * viewHeight() / 8500) * env.factor('snow')));
    flakes = Array.from({ length: count }, () => make(true));
  };
  seed();
  return {
    resize() { cv.fit(); seed(); },
    frame(time, dt) {
      const c = cv.ctx, w = viewWidth(), h = viewHeight();
      c.clearRect(0, 0, w, h);
      const wind = Math.sin(time / 6100) * 18 + Math.sin(time / 1900) * 6;
      for (const f of flakes) {
        f.phase += f.sway * dt;
        f.y += f.vy * dt;
        f.x += (wind * (0.35 + f.z) + Math.cos(f.phase) * 10 * (0.4 + f.z)) * dt;
        if (env.pointer.active && f.z > 0.3) {
          const dx = f.x - env.pointer.x, dy = f.y - env.pointer.y, d2 = dx * dx + dy * dy;
          if (d2 < 8100) {
            const d = Math.sqrt(d2) || 1, push = (1 - d / 90) * 160 * dt * f.z;
            f.x += (dx / d) * push;
            f.y += (dy / d) * push * 0.4;
          }
        }
        if (f.y > h + 12) Object.assign(f, make(false));
        if (f.x < -12) f.x += w + 24; else if (f.x > w + 12) f.x -= w + 24;
        const bokeh = f.z > 0.82;
        const size = f.r * (bokeh ? 3.8 : 2.6);
        c.globalAlpha = f.alpha * (bokeh ? 0.5 : 1);
        c.drawImage(sprite, f.x - size / 2, f.y - size / 2, size, size);
      }
      c.globalAlpha = 1;
    },
    destroy() { cv.el.remove(); },
  };
};

/** Snow caps on cards come from CSS (`.fx-caps`); this layer draws the icicles under the bar. */
const caps: LayerFactory = (host, env) => {
  // The garland already covers the edge of the bar.
  if (env.has('garland')) return NOOP;
  const strip = element('div', 'fx-icicles');
  host.append(strip);
  const place = () => {
    const g = swag();
    strip.style.left = `${g.left}px`;
    strip.style.width = `${g.width}px`;
    strip.style.top = `${g.top + 1}px`;
  };
  place();
  return { resize: place, destroy() { strip.remove(); } };
};

const LIGHT_COLORS: readonly string[] = ['#ffd27a', '#ff5d73', '#5fe0a8', '#8d97ff', '#ffb35c'];

const lights: LayerFactory = (host, env) => {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('class', 'fx-lights');
  el.setAttribute('aria-hidden', 'true');
  host.append(el);
  // Bulbs hang below the needles when the garland shares the same wire.
  const drop = env.has('garland') ? 16 : 0;
  const draw = () => {
    const g = swag(drop);
    el.setAttribute('viewBox', `0 0 ${g.width} ${Math.ceil(g.top + g.sag + 40)}`);
    el.setAttribute('width', String(g.width));
    el.style.left = `${g.left}px`;
    const defs = LIGHT_COLORS.map((c, i) => `<radialGradient id="fx-halo-${i}"><stop offset="0" stop-color="${c}" stop-opacity=".8"/><stop offset=".45" stop-color="${c}" stop-opacity=".25"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`).join('');
    let wire = '';
    for (let i = 0; i < g.n; i++) {
      const x0 = i * g.seg;
      wire += `M${x0} ${g.top}Q${x0 + g.seg / 2} ${g.top + 2 * g.sag} ${x0 + g.seg} ${g.top}`;
    }
    const step = g.width < 600 ? 26 : 31;
    let bulbs = '';
    for (let x = step / 2, i = 0; x < g.width; x += step, i++) {
      const ci = i % LIGHT_COLORS.length;
      const color = LIGHT_COLORS[ci] ?? LIGHT_COLORS[0];
      bulbs += `<g class="fx-bulb" style="--i:${i}" transform="translate(${x.toFixed(1)} ${g.y(x).toFixed(1)}) rotate(${(g.angle(x) * 0.6).toFixed(1)})">`
        + `<circle class="fx-halo" cx="0" cy="12" r="17" fill="url(#fx-halo-${ci})"/>`
        + '<rect x="-2.6" y="-.5" width="5.2" height="5.5" rx="1.2" fill="var(--fx-socket)"/>'
        + `<path class="fx-glass-bulb" d="M-4.2 6Q-5.6 13 0 18.8Q5.6 13 4.2 6Z" fill="${color}"/>`
        + '<ellipse cx="-1.6" cy="10" rx="1" ry="2.6" fill="#fff" opacity=".65"/></g>';
    }
    el.innerHTML = `<defs>${defs}</defs><path d="${wire}" fill="none" stroke="var(--fx-wire)" stroke-width="1.6"/>${bulbs}`;
  };
  draw();
  return { resize: draw, destroy() { el.remove(); } };
};

interface Bauble {
  x: number; y: number; length: number; r: number; color: string; angle: number; omega: number;
}

const garland: LayerFactory = (host, env) => {
  const height = () => swag().top + 80;
  const cv = surface(host, height);
  if (!cv) return NOOP;
  cv.el.classList.add('fx-garland');
  let base: HTMLCanvasElement | null = null;
  let baubles: Bauble[] = [];
  const drawBow = (b: CanvasRenderingContext2D, x: number, y: number) => {
    b.save();
    b.translate(x, y);
    b.fillStyle = '#c62f45';
    b.strokeStyle = '#8e1f30';
    b.lineWidth = 1;
    for (const s of [-1, 1]) {
      b.beginPath(); b.moveTo(s * 1.5, 2); b.lineTo(s * 8, 15); b.lineTo(s * 4, 14); b.lineTo(s * 0.5, 3); b.closePath(); b.fill(); b.stroke();
      b.beginPath(); b.ellipse(s * 7, -2, 7.5, 4.6, s * -0.35, 0, 7); b.fill(); b.stroke();
    }
    b.beginPath(); b.arc(0, 0, 3.2, 0, 7); b.fillStyle = '#e0485d'; b.fill(); b.stroke();
    b.restore();
  };
  const build = () => {
    const g = swag(), w = g.width, h = height();
    cv.fit();
    cv.el.style.left = `${g.left}px`;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    base = document.createElement('canvas');
    base.width = Math.round(w * ratio);
    base.height = Math.round(h * ratio);
    const b = base.getContext('2d');
    if (!b) return;
    b.scale(ratio, ratio);
    b.lineCap = 'round';
    const rnd = mulberry(7);
    const greens: readonly string[] = ['#143a26', '#1c4a31', '#265d3e', '#31744c', '#3f8d5b'];
    for (let pass = 0; pass < 2; pass++) {
      for (let x = -8; x < w + 8; x += 2) {
        const y = g.y(x);
        for (let k = 0; k < 3; k++) {
          const a = rnd() * Math.PI * 2, len = 6 + rnd() * 8;
          const ox = (rnd() - 0.5) * 6, oy = (rnd() - 0.5) * 10;
          b.strokeStyle = greens[Math.floor(rnd() * (pass ? 5 : 3))] ?? greens[0];
          b.lineWidth = pass ? 1.2 : 1.8;
          b.beginPath(); b.moveTo(x + ox, y + oy); b.lineTo(x + ox + Math.cos(a) * len, y + oy + Math.sin(a) * len); b.stroke();
        }
      }
    }
    b.fillStyle = 'rgba(242,247,255,.9)';
    for (let x = 0; x < w; x += 2.5) {
      if (rnd() < 0.4) { b.beginPath(); b.arc(x, g.y(x) - 5 - rnd() * 4, 0.7 + rnd() * 1.5, 0, 7); b.fill(); }
    }
    for (let i = 0; i <= g.n; i++) drawBow(b, i * g.seg, g.top + 1);
    const colors: readonly string[] = ['#c8344d', '#d9a441', '#2f8f68', '#5865f2', '#e4e7f4'];
    const rnd2 = mulberry(19);
    baubles = [];
    let j = 0;
    for (let i = 0; i < g.n; i++) {
      for (const u of [0.28, 0.5, 0.72]) {
        const x = i * g.seg + u * g.seg, big = u === 0.5;
        baubles.push({
          x, y: g.y(x) + 3, length: big ? 34 : 20 + rnd2() * 6, r: big ? 9.5 : 6.5,
          color: colors[j++ % colors.length] ?? colors[0], angle: (rnd2() - 0.5) * 0.2, omega: 0,
        });
      }
    }
  };
  const unsubscribe = env.onPointerMove((dx) => {
    const left = Number.parseFloat(cv.el.style.left) || 0;
    for (const o of baubles) {
      const bx = o.x + Math.sin(o.angle) * o.length, by = o.y + Math.cos(o.angle) * o.length;
      const ddx = env.pointer.x - left - bx, ddy = env.pointer.y - by;
      if (ddx * ddx + ddy * ddy < 32 * 32) o.omega = Math.max(-6, Math.min(6, o.omega + dx * 0.09));
    }
  });
  build();
  return {
    resize: build,
    frame(_time, dt) {
      if (!base) return;
      const c = cv.ctx, w = swag().width, h = height();
      c.clearRect(0, 0, w, h);
      c.drawImage(base, 0, 0, w, h);
      for (const o of baubles) {
        if (dt) {
          o.omega += (-(900 / o.length) * Math.sin(o.angle) - 1.1 * o.omega) * dt;
          o.angle += o.omega * dt;
        }
        const bx = o.x + Math.sin(o.angle) * o.length, by = o.y + Math.cos(o.angle) * o.length;
        c.strokeStyle = env.palette.light ? '#8a8fa8' : '#cbb88a';
        c.lineWidth = 1;
        c.beginPath(); c.moveTo(o.x, o.y); c.lineTo(bx, by - o.r); c.stroke();
        c.fillStyle = '#c9a24a';
        c.fillRect(bx - 2.5, by - o.r - 3, 5, 4);
        let gr = c.createRadialGradient(bx - o.r * 0.35, by - o.r * 0.35, o.r * 0.05, bx, by, o.r);
        gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(0.25, o.color); gr.addColorStop(1, o.color);
        c.fillStyle = gr; c.beginPath(); c.arc(bx, by, o.r, 0, 7); c.fill();
        gr = c.createRadialGradient(bx, by, o.r * 0.55, bx, by, o.r);
        gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.35)');
        c.fillStyle = gr; c.beginPath(); c.arc(bx, by, o.r, 0, 7); c.fill();
      }
    },
    destroy() { unsubscribe(); cv.el.remove(); },
  };
};

const aurora: LayerFactory = (host) => {
  const el = element('div', 'fx-aurora');
  el.innerHTML = '<i></i><i></i><i></i>';
  host.append(el);
  return { destroy() { el.remove(); } };
};

interface Star { x: number; y: number; r: number; phase: number; speed: number; alpha: number }
interface ShootingStar { x: number; y: number; vx: number; vy: number; life: number; max: number }

const stars: LayerFactory = (host, env) => {
  const cv = surface(host, viewHeight);
  if (!cv) return NOOP;
  let list: Star[] = [];
  let shoot: ShootingStar | null = null;
  let next = 2500;
  const seed = () => {
    const n = Math.round((viewWidth() * viewHeight() / 4800) * Math.min(env.factor('stars'), 1.4));
    list = Array.from({ length: n }, () => ({
      x: Math.random() * viewWidth(), y: Math.random() * viewHeight() * 0.85,
      r: Math.random() < 0.08 ? 1.6 : 0.5 + Math.random() * 0.8,
      phase: Math.random() * 6.28, speed: 0.5 + Math.random() * 1.3, alpha: 0.35 + Math.random() * 0.55,
    }));
  };
  seed();
  return {
    resize() { cv.fit(); seed(); },
    frame(time, dt) {
      const c = cv.ctx, w = viewWidth(), h = viewHeight();
      c.clearRect(0, 0, w, h);
      c.fillStyle = `rgb(${env.palette.star})`;
      for (const s of list) {
        c.globalAlpha = s.alpha * (0.6 + 0.4 * Math.sin(s.phase + (time / 1000) * s.speed)) * Math.max(0, 1 - s.y / (h * 0.85));
        if (s.r > 1.2) { c.beginPath(); c.arc(s.x, s.y, s.r, 0, 7); c.fill(); }
        else c.fillRect(s.x, s.y, s.r * 1.6, s.r * 1.6);
      }
      c.globalAlpha = 1;
      if (!dt) return;
      next -= dt * 1000;
      if (!shoot && next <= 0) {
        shoot = {
          x: w * (0.25 + Math.random() * 0.7), y: h * (0.08 + Math.random() * 0.3),
          vx: -(520 + Math.random() * 300), vy: 170 + Math.random() * 130, life: 0, max: 1.1,
        };
        next = ((6 + Math.random() * 9) * 1000) / Math.max(0.5, env.factor('stars'));
      }
      if (shoot) {
        shoot.life += dt; shoot.x += shoot.vx * dt; shoot.y += shoot.vy * dt;
        const k = shoot.life / shoot.max, alpha = Math.sin(Math.PI * Math.min(k, 1));
        const tx = shoot.x - shoot.vx * 0.2, ty = shoot.y - shoot.vy * 0.2;
        const gr = c.createLinearGradient(shoot.x, shoot.y, tx, ty);
        gr.addColorStop(0, `rgba(${env.palette.star},${alpha})`);
        gr.addColorStop(1, `rgba(${env.palette.star},0)`);
        c.strokeStyle = gr; c.lineWidth = 1.7; c.lineCap = 'round';
        c.beginPath(); c.moveTo(shoot.x, shoot.y); c.lineTo(tx, ty); c.stroke();
        if (k >= 1) shoot = null;
      }
    },
    destroy() { cv.el.remove(); },
  };
};

interface Segment { x: number; y: number; x2: number; y2: number; t0: number; t1: number; w: number }
interface Spark { x: number; y: number; life: number; r: number; vy: number }

const frost: LayerFactory = (host, env) => {
  const glass = element('div', 'fx-frost-glass');
  host.append(glass);
  const cv = surface(host, viewHeight);
  const trail = cv ? surface(host, viewHeight) : null;
  if (!cv || !trail) return { destroy() { host.replaceChildren(); } };
  cv.el.classList.add('fx-frost');
  let segs: Segment[] = [], progress = 0, end = 0, done = false, sparks: Spark[] = [];
  const generate = () => {
    segs = []; progress = 0; end = 0; done = false;
    const w = viewWidth(), h = viewHeight(), rnd = mulberry(11);
    const len0 = Math.min(w, h) * 0.08 * (0.65 + 0.35 * Math.min(env.factor('frost'), 1.8));
    const grow = (x: number, y: number, a: number, len: number, depth: number, t0: number) => {
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len, t1 = t0 + len / 380;
      segs.push({ x, y, x2, y2, t0, t1, w: 0.4 + depth * 0.32 });
      end = Math.max(end, t1);
      if (depth <= 0 || len < 4) return;
      for (const s of [0.3, 0.55, 0.8]) {
        if (rnd() < 0.75) {
          const px = x + (x2 - x) * s, py = y + (y2 - y) * s, tb = t0 + (t1 - t0) * s;
          grow(px, py, a + (0.95 + rnd() * 0.25), len * (0.3 + rnd() * 0.15), depth - 2, tb);
          grow(px, py, a - (0.95 + rnd() * 0.25), len * (0.3 + rnd() * 0.15), depth - 2, tb);
        }
      }
      grow(x2, y2, a + (rnd() - 0.5) * 0.4, len * 0.58, depth - 1, t1);
    };
    const corners: readonly (readonly [number, number, number])[] = [
      [0, 0, 0], [w, 0, Math.PI / 2], [w, h, Math.PI], [0, h, -Math.PI / 2],
    ];
    for (const [cx, cy, a0] of corners) {
      for (let i = 0; i < 5; i++) grow(cx, cy, a0 + ((i + 0.5) / 5) * (Math.PI / 2) + (rnd() - 0.5) * 0.2, len0 * (0.7 + rnd() * 0.6), 4, rnd() * 0.3);
    }
    const edges = Math.max(1, Math.round(w / 300));
    for (let i = 0; i < edges; i++) {
      grow(((i + 0.5) * w) / edges, h, -Math.PI / 2 + (rnd() - 0.5) * 0.7, len0 * 0.45 * (0.6 + rnd() * 0.5), 3, 0.4 + rnd() * 0.6);
    }
  };
  const draw = () => {
    const c = cv.ctx;
    c.clearRect(0, 0, viewWidth(), viewHeight());
    c.strokeStyle = env.palette.frost;
    c.lineCap = 'round';
    for (const s of segs) {
      if (s.t0 > progress) continue;
      const k = Math.min(1, (progress - s.t0) / (s.t1 - s.t0));
      c.lineWidth = s.w;
      c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(s.x + (s.x2 - s.x) * k, s.y + (s.y2 - s.y) * k); c.stroke();
    }
  };
  const unsubscribe = env.onPointerMove((dx, dy) => {
    if (Math.hypot(dx, dy) < 2 || sparks.length > 80) return;
    sparks.push({
      x: env.pointer.x + (Math.random() - 0.5) * 8, y: env.pointer.y + (Math.random() - 0.5) * 8,
      life: 0, r: 2 + Math.random() * 3, vy: 10 + Math.random() * 20,
    });
  });
  generate();
  return {
    resize() { cv.fit(); trail.fit(); generate(); },
    frame(_time, dt) {
      if (!dt) { progress = end + 1; draw(); done = true; }
      else if (!done) { progress += dt; draw(); if (progress > end) done = true; }
      const c = trail.ctx;
      c.clearRect(0, 0, viewWidth(), viewHeight());
      sparks = sparks.filter((s) => (s.life += dt) < 0.7);
      for (const s of sparks) {
        s.y += s.vy * dt;
        const k = 1 - s.life / 0.7, r = s.r * k;
        c.globalAlpha = k;
        c.fillStyle = env.palette.light ? '#6f9ad6' : '#eaf5ff';
        c.beginPath();
        c.moveTo(s.x, s.y - r * 2); c.quadraticCurveTo(s.x, s.y, s.x + r * 2, s.y);
        c.quadraticCurveTo(s.x, s.y, s.x, s.y + r * 2); c.quadraticCurveTo(s.x, s.y, s.x - r * 2, s.y);
        c.quadraticCurveTo(s.x, s.y, s.x, s.y - r * 2); c.fill();
      }
      c.globalAlpha = 1;
    },
    destroy() { unsubscribe(); host.replaceChildren(); },
  };
};

interface Ember { x: number; y: number; vy: number; phase: number; freq: number; r: number; life: number; max: number; color: string }

const EMBER_COLORS: readonly string[] = ['255,179,71', '255,138,61', '255,214,128', '255,110,60'];

const embers: LayerFactory = (host, env) => {
  host.append(element('div', 'fx-hearth'));
  const cv = surface(host, viewHeight);
  if (!cv) return { destroy() { host.replaceChildren(); } };
  let list: Ember[] = [];
  const make = (anywhere: boolean): Ember => {
    const max = 3 + Math.random() * 4;
    return {
      x: Math.random() * viewWidth(), y: anywhere ? viewHeight() * (0.35 + Math.random() * 0.65) : viewHeight() + 6,
      vy: -(26 + Math.random() * 64), phase: Math.random() * 6.28, freq: 2 + Math.random() * 3,
      r: 0.8 + Math.random() * 1.9, life: anywhere ? Math.random() * max : 0, max,
      color: EMBER_COLORS[Math.floor(Math.random() * EMBER_COLORS.length)] ?? EMBER_COLORS[0],
    };
  };
  const seed = () => {
    list = Array.from({ length: Math.round((viewWidth() / 12) * env.factor('embers')) }, () => make(true));
  };
  seed();
  return {
    resize() { cv.fit(); seed(); },
    frame(time, dt) {
      const c = cv.ctx, w = viewWidth(), h = viewHeight();
      c.clearRect(0, 0, w, h);
      c.globalCompositeOperation = env.palette.light ? 'source-over' : 'lighter';
      for (const p of list) {
        p.life += dt; p.y += p.vy * dt;
        p.x += (Math.sin(p.phase + time / 700) * 14 + Math.sin(time / 3000) * 8) * dt;
        if (p.life > p.max || p.y < -10) Object.assign(p, make(false));
        const k = p.life / p.max;
        const alpha = (k < 0.12 ? k / 0.12 : 1 - (k - 0.12) / 0.88) * (0.7 + 0.3 * Math.sin(p.phase + (time / 1000) * p.freq));
        c.fillStyle = `rgba(${p.color},${alpha * 0.16})`;
        c.beginPath(); c.arc(p.x, p.y, p.r * 3.4, 0, 7); c.fill();
        c.fillStyle = `rgba(${p.color},${alpha})`;
        c.beginPath(); c.arc(p.x, p.y, p.r, 0, 7); c.fill();
      }
      c.globalCompositeOperation = 'source-over';
    },
    destroy() { host.replaceChildren(); },
  };
};

const village: LayerFactory = (host) => {
  const moon = element('div', 'fx-moon');
  // The moon sits behind the panels; the engine passes the back slot through `host.dataset`.
  const back = document.querySelector<HTMLElement>('.fx-back [data-layer="village"]');
  (back ?? host).append(moon);
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('class', 'fx-village');
  el.setAttribute('aria-hidden', 'true');
  host.append(el);
  const build = () => {
    const { left, width: w } = contentColumn();
    const h = Math.round(Math.min(160, Math.max(100, viewHeight() * 0.18)));
    document.documentElement.style.setProperty('--fx-village-h', `${h}px`);
    el.style.left = `${left}px`;
    el.setAttribute('viewBox', `0 0 ${w} ${h}`);
    el.setAttribute('width', String(w));
    el.setAttribute('height', String(h));
    const rnd = mulberry(3);
    const hills = (base: number, amp: number, period: number, ph: number) => {
      let d = `M0 ${h}`;
      for (let x = 0; x <= w + 20; x += 16) {
        d += `L${x} ${(base + Math.sin(x / period + ph) * amp + Math.sin(x / (period * 0.37) + ph * 2) * amp * 0.35).toFixed(1)}`;
      }
      return `${d}L${w + 20} ${h}Z`;
    };
    const pine = (x: number, y: number, s: number) => {
      const hh = 26 * s, ww = 16 * s;
      return `<path class="v-pine" d="M${x} ${y - hh}L${x + ww * 0.36} ${y - hh * 0.5}H${x + ww * 0.2}L${x + ww * 0.5} ${y}H${x - ww * 0.5}L${x - ww * 0.2} ${y - hh * 0.5}H${x - ww * 0.36}Z"/>`
        + `<path class="v-snow" d="M${x} ${y - hh}L${x + ww * 0.17} ${y - hh * 0.76}Q${x} ${y - hh * 0.7} ${x - ww * 0.17} ${y - hh * 0.76}Z"/>`;
    };
    let out = `<path class="v-far" d="${hills(h * 0.36, h * 0.1, 150, 1)}"/>`;
    for (let x = 10; x < w; x += 22 + rnd() * 40) out += pine(x, h * 0.52 + rnd() * 6, 0.55 + rnd() * 0.25);
    out += `<path class="v-mid" d="${hills(h * 0.6, h * 0.06, 95, 2.3)}"/>`;
    const ground = h * 0.8;
    let x = 24 + rnd() * 40, i = 0;
    while (x < w - 40) {
      const hw = 38 + rnd() * 26, hb = 24 + rnd() * 18, top = ground - hb, peak = top - hw * 0.42;
      const chx = x + hw * (0.62 + rnd() * 0.15);
      out += `<rect class="v-house" x="${chx}" y="${peak + hw * 0.14}" width="7" height="${hw * 0.3}"/>`;
      for (let k = 0; k < 3; k++) out += `<circle class="v-smoke" cx="${chx + 3.5}" cy="${peak + hw * 0.1}" r="3.2" style="--d:${(-k * 2.3 - rnd() * 2).toFixed(2)}s"/>`;
      out += `<rect class="v-house" x="${x}" y="${top}" width="${hw}" height="${hb + 8}"/>`;
      out += `<path class="v-roof" d="M${x - 6} ${top + 2}L${x + hw / 2} ${peak}L${x + hw + 6} ${top + 2}Z"/>`;
      out += `<path class="v-snow" d="M${x - 7} ${top + 2}L${x + hw / 2} ${peak - 2}L${x + hw + 7} ${top + 2}L${x + hw + 4} ${top + 5}Q${x + hw * 0.75} ${top - 2} ${x + hw / 2} ${peak + 5}Q${x + hw * 0.25} ${top - 2} ${x - 4} ${top + 5}Z"/>`;
      const wins = hw > 52 ? 2 : 1;
      for (let k = 0; k < wins; k++) {
        const wx = x + (wins === 1 ? hw * 0.22 : hw * (0.14 + k * 0.48));
        if (rnd() < 0.85) out += `<rect class="v-win" x="${wx}" y="${top + hb * 0.3}" width="9" height="9" rx="1" style="--d:${(-rnd() * 6).toFixed(2)}s"/>`;
      }
      out += `<rect x="${x + hw * 0.62}" y="${top + hb * 0.42}" width="8" height="${hb * 0.6}" fill="var(--v-roof)" rx="1"/>`;
      const gap = 40 + rnd() * 110;
      const px = x + hw + gap * 0.5;
      if (i % 2) {
        out += `<defs><radialGradient id="fx-lamp-${i}"><stop offset="0" stop-color="var(--v-win)" stop-opacity=".55"/><stop offset="1" stop-color="var(--v-win)" stop-opacity="0"/></radialGradient></defs>`;
        out += `<circle class="v-glow" cx="${px}" cy="${ground - 30}" r="18" fill="url(#fx-lamp-${i})" style="--d:${(-rnd() * 5).toFixed(2)}s"/>`;
        out += `<rect class="v-house" x="${px - 1}" y="${ground - 30}" width="2" height="34"/><rect class="v-lamp" x="${px - 3}" y="${ground - 34}" width="6" height="6" rx="1.5"/>`;
      } else {
        out += pine(px, ground + 4, 1 + rnd() * 0.5);
      }
      x += hw + gap; i++;
    }
    out += `<path class="v-near" d="${hills(ground, h * 0.03, 70, 4)}"/>`;
    el.innerHTML = out;
  };
  build();
  return {
    resize: build,
    destroy() {
      moon.remove();
      el.remove();
      document.documentElement.style.removeProperty('--fx-village-h');    },
  };
};

const HAT = '<svg viewBox="0 0 40 30"><path d="M5 23 Q9 6 23 4 Q33 3 36 15 L32 17 Q30 10 24 11 Q17 13 15 23Z" fill="#d6334f"/><path d="M20 6 Q26 5 30 9" stroke="#fff" stroke-opacity=".3" stroke-width="2" fill="none" stroke-linecap="round"/><rect x="2" y="21" width="22" height="7" rx="3.5" fill="#f4f1ea"/><circle cx="34" cy="18" r="4" fill="#f4f1ea"/></svg>';
const HOLLY = '<svg viewBox="0 0 48 30"><path d="M24 16 C18 6 8 4 2 8 C6 10 5 13 8 14 C6 16 8 19 12 19 C16 20 20 18 24 16Z" fill="#2f7d4f"/><path d="M24 16 C30 6 40 4 46 8 C42 10 43 13 40 14 C42 16 40 19 36 19 C32 20 28 18 24 16Z" fill="#256b42"/><path d="M5 9 Q14 11 23 15.5 M43 9 Q34 11 25 15.5" stroke="#174a2e" stroke-width=".8" fill="none"/><circle cx="20.5" cy="18.5" r="3.6" fill="#d6334f"/><circle cx="27.5" cy="18.5" r="3.6" fill="#c12a44"/><circle cx="24" cy="13" r="3.6" fill="#e04a62"/><circle cx="23" cy="12" r="1" fill="#fff" opacity=".6"/><circle cx="19.5" cy="17.5" r="1" fill="#fff" opacity=".5"/></svg>';

/** Hats on the guild badge and the avatar, holly on the first card of the page. */
const theme: LayerFactory = (host) => {
  let added: HTMLElement[] = [];
  let hollyHost: HTMLElement | null = null;
  const mountOn = (parent: HTMLElement, className: string, svg: string) => {
    const el = element('span', className);
    el.innerHTML = svg;
    parent.append(el);
    return el;
  };
  const clear = () => {
    added.splice(0).forEach((el) => el.remove());
    hollyHost?.classList.remove('fx-holly-host');
    hollyHost = null;
  };
  const mount = () => {
    const badge = document.querySelector<HTMLElement>('.server-header__badge');
    const avatar = document.querySelector<HTMLElement>('app-topbar app-avatar');
    hollyHost = document.querySelector<HTMLElement>('.workspace-main__inner .card');
    if (badge) added.push(mountOn(badge, 'fx-hat fx-hat--badge', HAT));
    if (avatar) added.push(mountOn(avatar, 'fx-hat fx-hat--avatar', HAT));
    if (hollyHost) {
      hollyHost.classList.add('fx-holly-host');
      added.push(mountOn(hollyHost, 'fx-holly', HOLLY));
    }
  };
  mount();
  // Routed pages replace their cards, so the holly has to follow the page.
  const observer = new MutationObserver(() => { clear(); mount(); });
  const content = document.querySelector<HTMLElement>('.workspace-main__inner');
  if (content) observer.observe(content, { childList: true });
  return {
    destroy() {
      observer.disconnect();
      clear();
      host.replaceChildren();
    },
  };
};

const reindeer = (x: number, nose: boolean): string => `
  <g transform="translate(${x} 30)">
    <ellipse cx="0" cy="0" rx="13" ry="5.5"/>
    <path d="M9 -3 L16 -13 L21 -14 L24.5 -12 L22.5 -10 L17.5 -9 L13 1Z"/>
    <path d="M18 -14 l-2 -7 M17 -18 l-4 -2 M20.5 -14 l2 -7 M21.6 -18 l3 -2" stroke="var(--fx-sleigh)" stroke-width="1.3" fill="none" stroke-linecap="round"/>
    <path class="fx-leg" d="M8 3 l3 10" stroke="var(--fx-sleigh)" stroke-width="2.2" stroke-linecap="round"/>
    <path class="fx-leg fx-leg--back" d="M5 3 l2 10" stroke="var(--fx-sleigh)" stroke-width="2.2" stroke-linecap="round"/>
    <path class="fx-leg fx-leg--back" d="M-8 3 l-3 10" stroke="var(--fx-sleigh)" stroke-width="2.2" stroke-linecap="round"/>
    <path class="fx-leg" d="M-10 2 l-2 10" stroke="var(--fx-sleigh)" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M-13 -2 l-4 -3" stroke="var(--fx-sleigh)" stroke-width="2" stroke-linecap="round"/>
    ${nose ? '<circle cx="24.6" cy="-11.6" r="5" fill="#ff4d5e" opacity=".3"/><circle cx="24.6" cy="-11.6" r="2" fill="#ff4d5e"/>' : ''}
  </g>`;

const SLEIGH = `<svg viewBox="-70 0 330 70" width="330" height="70">
  ${Array.from({ length: 14 }, (_, i) => {
    const x = -6 - i * 4.5 - (i % 3) * 2, y = 40 + Math.sin(i * 1.3) * 6 + i * 0.6;
    return `<circle class="fx-spark" cx="${x}" cy="${y}" r="${(1.6 - i * 0.07).toFixed(2)}" fill="#ffe6a8" style="--d:${(-i * 0.17).toFixed(2)}s"/>`;
  }).join('')}
  <g fill="var(--fx-sleigh)">
    <path d="M86 30 L232 22" stroke="var(--fx-sleigh)" stroke-width="1" opacity=".7"/>
    <circle cx="28" cy="29" r="10"/>
    <path d="M38 40 Q38 23 47 23 Q56 23 56 40Z"/>
    <circle cx="47" cy="18" r="5"/>
    <path d="M42 16 Q46 5 54 9 L58 14 Q51 11 51.5 15Z" fill="#d6334f"/>
    <circle cx="58.5" cy="14.5" r="2.2" fill="#f4f1ea"/>
    <path d="M10 37 H74 Q82 37 84 27 L90 23 L92 26 L88 31 Q84 48 68 48 H22 Q12 48 10 42 Z"/>
    <path d="M6 56 H72 Q86 56 90 46 M24 48 V56 M64 48 V56" stroke="var(--fx-sleigh)" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    ${reindeer(132, false)}${reindeer(176, false)}${reindeer(220, true)}
  </g>
</svg>`;

const sleigh: LayerFactory = (host, env) => {
  const wrap = element('div', 'fx-sleigh');
  wrap.innerHTML = SLEIGH;
  host.append(wrap);
  let animation: Animation | null = null;
  const fly = () => {
    if (env.isPaused()) return;
    animation?.cancel();
    const w = viewWidth(), scale = w < 600 ? 0.62 : 1;
    const top = swag().top + 50;
    const y0 = top + Math.random() * Math.max(40, viewHeight() * 0.22), distance = w + 520;
    const frames = Array.from({ length: 13 }, (_, i) => {
      const u = i / 12;
      return {
        transform: `translate(${-420 + distance * u}px, ${y0 - Math.sin(u * Math.PI) * 60 + Math.sin(u * Math.PI * 4) * 7}px) rotate(${(-Math.cos(u * Math.PI) * 5).toFixed(2)}deg) scale(${scale})`,
      };
    });
    animation = wrap.animate(frames, { duration: 11000 * Math.max(0.6, w / 1440), easing: 'linear' });
  };
  const first = window.setTimeout(fly, 2500);
  const timer = window.setInterval(fly, 30000);
  return {
    pause() { animation?.pause(); },
    play() { if (animation?.playState === 'paused') animation.play(); },
    fly,
    destroy() {
      window.clearTimeout(first);
      window.clearInterval(timer);
      animation?.cancel();
      wrap.remove();
    },
  };
};

const FACTORIES: Partial<Record<LayerName, LayerFactory>> = {
  stars, aurora, village, embers, sleigh, snow, caps, garland, lights, frost, theme,
};

/** Mounts, animates and tears down the decoration layers on the document body. */
export class ChristmasEngine {
  private readonly back = element('div', 'fx-back');
  private readonly front = element('div', 'fx-front');
  private readonly slots = new Map<LayerName, { back: HTMLElement; front: HTMLElement }>();
  private readonly running = new Map<LayerName, Layer>();
  private readonly pointer: Pointer = { x: -999, y: -999, active: false };
  private readonly pointerSubs = new Set<(dx: number, dy: number) => void>();
  private state: DecorationState = { active: [], intensity: 1, paused: true };
  private light = isLight();
  private mounted = false;
  private raf = 0;
  private last = 0;
  private resizeTimer = 0;

  private readonly onPointerMove = (event: PointerEvent) => {
    const dx = this.pointer.active ? event.clientX - this.pointer.x : 0;
    const dy = this.pointer.active ? event.clientY - this.pointer.y : 0;
    this.pointer.x = event.clientX;
    this.pointer.y = event.clientY;
    this.pointer.active = true;
    if (!this.state.paused) this.pointerSubs.forEach((fn) => fn(dx, dy));
  };

  private readonly onPointerLeave = () => { this.pointer.active = false; };

  private readonly onResize = () => {
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.running.forEach((layer) => layer.resize?.());
      if (this.state.paused) this.renderStill();
    }, 150);
  };

  private readonly onVisibility = () => (document.hidden ? this.stopLoop() : this.startLoop());

  constructor() {
    for (const [i, name] of ORDER.entries()) {
      const back = element('div', 'fx-slot');
      const front = element('div', 'fx-slot');
      back.dataset['layer'] = name;
      front.dataset['layer'] = name;
      back.style.zIndex = String(i);
      front.style.zIndex = String(i);
      this.back.append(back);
      this.front.append(front);
      this.slots.set(name, { back, front });
    }
    document.body.append(this.back, this.front);
    window.addEventListener('pointermove', this.onPointerMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** Brings the scene in line with the settings; safe to call on every change. */
  sync(state: DecorationState): void {
    const light = isLight();
    const first = !this.mounted;
    // Density and palette are baked into layers when they mount.
    const remount = this.mounted && (light !== this.light || state.intensity !== this.state.intensity);
    const wasPaused = this.state.paused;
    this.state = state;
    this.light = light;
    this.mounted = true;

    const want = new Set<Ornament>(state.active);
    for (const [name, layer] of this.running) {
      if (remount || !want.has(name)) {
        layer.destroy();
        this.running.delete(name);
      }
    }

    const has = (...names: readonly Ornament[]) => names.some((n) => want.has(n));
    const body = document.body.classList;
    body.toggle('fx-night', has('aurora', 'stars', 'village'));
    body.toggle('fx-glass', has('aurora', 'stars', 'village'));
    body.toggle('fx-has-swag', has('lights', 'garland'));
    body.toggle('fx-village-on', has('village'));
    body.toggle('fx-caps', has('caps'));
    body.toggle('fx-theme', has('theme'));

    const env: Env = {
      pointer: this.pointer,
      palette: readPalette(),
      factor: (name) => (INTENSITY_FACTOR[state.intensity] ?? 1),
      isPaused: () => this.state.paused,
      has: (name) => want.has(name),
      onPointerMove: (fn) => {
        this.pointerSubs.add(fn);
        return () => { this.pointerSubs.delete(fn); };
      },
    };
    for (const name of ORDER) {
      if (!want.has(name) || this.running.has(name)) continue;
      const factory = FACTORIES[name];
      const slot = this.slots.get(name);
      if (!factory || !slot) continue;
      const layer = factory(name === 'village' ? slot.front : this.isBack(name) ? slot.back : slot.front, env);
      this.running.set(name, layer);
      if (state.paused) layer.pause?.();
    }

    if (state.paused !== wasPaused || first) {
      body.toggle('fx-paused', state.paused);
      this.running.forEach((layer) => (state.paused ? layer.pause?.() : layer.play?.()));
    }
    if (state.paused) {
      this.stopLoop();
      this.renderStill();
    } else {
      this.startLoop();
    }
  }

  /** Sends the sleigh across the screen right now, when the sleigh layer is on. */
  flySleigh(): void {
    this.running.get('sleigh')?.fly?.();
  }

  destroy(): void {
    this.stopLoop();
    window.clearTimeout(this.resizeTimer);
    this.running.forEach((layer) => layer.destroy());
    this.running.clear();
    this.pointerSubs.clear();
    window.removeEventListener('pointermove', this.onPointerMove);
    document.documentElement.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.body.classList.remove(
      'fx-night', 'fx-glass', 'fx-has-swag', 'fx-village-on', 'fx-caps', 'fx-theme', 'fx-paused',
    );
    this.back.remove();
    this.front.remove();
  }

  /** Layers painted behind the interface rather than over it. */
  private isBack(name: LayerName): boolean {
    return name === 'stars' || name === 'aurora';
  }

  private readonly loop = (time: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = this.last ? Math.min((time - this.last) / 1000, 0.05) : 0.016;
    this.last = time;
    this.running.forEach((layer) => layer.frame?.(time, dt));
  };

  private startLoop(): void {
    if (this.raf || this.state.paused || document.hidden) return;
    this.last = 0;
    this.raf = requestAnimationFrame(this.loop);
  }

  private stopLoop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Draws one frame of every layer in its resting state. */
  private renderStill(): void {
    const time = performance.now();
    this.running.forEach((layer) => layer.frame?.(time, 0));
  }
}
