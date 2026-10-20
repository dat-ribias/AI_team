// Ping wheel + ping animations + sounds, ported from lolPing's overlay (wheel.ts, pingFx.ts, soundBank.ts).
const { ipcRenderer } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const assets = new URLSearchParams(location.search).get('assets');
const VOLUME = 0.7, PING_SIZE = 110, PING_DUR = 3.2, MAX_PINGS = 60, MAX_VOICES = 8;
const texture = name => pathToFileURL(join(assets, 'textures', `${name}.png`)).href;

// Top (N) then clockwise, as League ships it.
const WHEEL_PINGS = [
  { icon: 'pingwheel_retreatrender', art: ['pingwheel_retreatrender'], sound: 'SRP_12', color: '#ff3b55' },
  { icon: 'push', art: ['pingwheel_pushrender'], sound: 'SRP_9', color: '#35d27a' },
  { icon: 'omw', art: ['omw'], sound: 'OnMyWay', color: '#2e8bff' },
  { icon: 'all_in', art: ['pingwheel_allin_render_01', 'pingwheel_allin_render_02'], sound: 'SRP_4', color: '#f2b320' },
  { icon: 'assist_me', art: ['assist_me'], sound: 'ComeHere', color: '#56d43c' },
  { icon: 'need_vision', art: ['need_vision'], sound: 'SRP_7', color: '#56d43c' },
  { icon: 'enemy_missing', art: ['enemy_missing'], sound: 'MIA', color: '#f2c518' },
  { icon: 'pingwheel_enemyvisionrender', art: ['pingwheel_enemyvisionrender'], sound: 'AreaIsWarded', color: '#ff3b55' },
];
const W = { innerR: 86, outerR: 188, extR: 288, iconR: 137, iconSize: 48 };

// ---------- sounds: pre-decoded Web Audio buffers (HTMLAudioElement per play lags) ----------
const ctx = new AudioContext({ latencyHint: 'interactive' });
const buffers = new Map();
let voices = 0;
for (const name of new Set([...WHEEL_PINGS.map(p => p.sound), 'button'])) {
  try {
    const b = readFileSync(join(assets, 'sounds', `${name}.wav`));
    ctx.decodeAudioData(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)).then(a => buffers.set(name, a), () => {});
  } catch {}
}
function play(name, vol) {
  const buffer = buffers.get(name);
  if (!buffer || voices >= MAX_VOICES) return;
  if (ctx.state !== 'running') ctx.resume();
  const src = ctx.createBufferSource(), gain = ctx.createGain();
  src.buffer = buffer;
  gain.gain.value = vol;
  src.connect(gain).connect(ctx.destination);
  voices++;
  src.onended = () => voices--;
  src.start();
}

// ---------- wheel ----------
const NS = 'http://www.w3.org/2000/svg';
const svg = document.getElementById('wheel');
function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent.append(e);
  return e;
}
const polar = (r, deg) => [r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180)];
function sector(r0, r1, a0, a1) {
  const [x0, y0] = polar(r0, a0), [x1, y1] = polar(r1, a0), [x2, y2] = polar(r1, a1), [x3, y3] = polar(r0, a1);
  return `M${x0},${y0} L${x1},${y1} A${r1},${r1} 0 0 1 ${x2},${y2} L${x3},${y3} A${r0},${r0} 0 0 0 ${x0},${y0}Z`;
}
/** -1 in the dead zone, else 0..7 with 0 = N, clockwise. */
function pickSlice(dx, dy) {
  if (Math.hypot(dx, dy) < W.innerR) return -1;
  return Math.floor((((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 22.5 + 360) % 360) / 45) % 8;
}

const wedges = [], icons = [];
(function build() {
  const { innerR, outerR, extR, iconR, iconSize } = W;
  el('defs', {}, svg).innerHTML = `
    <radialGradient id="g-ext" cx="0" cy="0" r="${extR}" gradientUnits="userSpaceOnUse">
      <stop offset="${outerR / extR}" stop-color="#5c6066" stop-opacity=".55"/><stop offset="1" stop-color="#5c6066" stop-opacity="0"/></radialGradient>
    <radialGradient id="g-ring" cx="0" cy="0" r="${outerR}" gradientUnits="userSpaceOnUse">
      <stop offset="${innerR / outerR}" stop-color="#2a2d31"/><stop offset="1" stop-color="#4a4e54"/></radialGradient>
    <radialGradient id="g-hot" cx="0" cy="0" r="${extR}" gradientUnits="userSpaceOnUse">
      <stop offset="${innerR / extR}" stop-color="#8a8f96"/><stop offset="${outerR / extR}" stop-color="#9aa0a8"/>
      <stop offset="1" stop-color="#9aa0a8" stop-opacity="0"/></radialGradient>
    <radialGradient id="g-core" cx="0" cy="-10" r="${innerR}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2c5d60"/><stop offset="1" stop-color="#11292c"/></radialGradient>`;
  const slots = [0, 1, 2, 3, 4, 5, 6, 7];
  for (const i of slots) if (i % 2 === 0) { const m = -90 + i * 45; el('path', { d: sector(outerR, extR, m - 22.5, m + 22.5), fill: 'url(#g-ext)' }, svg); }
  el('circle', { r: (innerR + outerR) / 2, fill: 'none', stroke: 'url(#g-ring)', 'stroke-width': outerR - innerR, opacity: 0.92 }, svg);
  for (const i of slots) {
    const m = -90 + i * 45;
    wedges.push(el('path', { d: sector(innerR, i % 2 === 0 ? extR : outerR, m - 22.5, m + 22.5), fill: 'url(#g-hot)', 'fill-opacity': 0, class: 'wedge' }, svg));
    const [x0, y0] = polar(innerR, m - 22.5), [x1, y1] = polar(outerR, m - 22.5);
    el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: '#a08a5c', 'stroke-opacity': 0.45, 'stroke-width': 1.2 }, svg);
  }
  for (const i of slots) {
    const [ix, iy] = polar(iconR, -90 + i * 45);
    icons.push(el('image', { href: texture(WHEEL_PINGS[i].icon), x: ix - iconSize / 2, y: iy - iconSize / 2, width: iconSize, height: iconSize, class: 'icon' }, svg));
  }
  el('circle', { r: innerR + 4, fill: 'none', stroke: '#1a1a1a', 'stroke-width': 6, opacity: 0.6 }, svg);
  el('circle', { r: innerR, fill: 'url(#g-core)', stroke: '#c8aa6e', 'stroke-width': 3 }, svg);
  el('circle', { r: innerR - 7, fill: 'none', stroke: '#8a7448', 'stroke-width': 1, opacity: 0.6 }, svg);
  el('image', { href: texture('generic_ping'), x: -20, y: -58, width: 40, height: 40 }, svg);
  el('text', { x: 0, y: 6, 'text-anchor': 'middle', class: 'centerTxt' }, svg).textContent = 'PING';
  el('text', { x: 6, y: 50, 'text-anchor': 'middle', class: 'backTxt' }, svg).textContent = 'BACK';
})();

let hot = -1, ox = 0, oy = 0, opened = false;
function setHot(i) {
  if (i === hot) return;
  if (hot >= 0) { wedges[hot].setAttribute('fill-opacity', '0'); icons[hot].classList.remove('hot'); }
  hot = i;
  if (i >= 0) {
    wedges[i].setAttribute('fill-opacity', '0.55');
    icons[i].classList.add('hot');
    if (opened) play('button', VOLUME * 0.5);
  }
}
function close() { opened = false; svg.classList.remove('open'); setHot(-1); }

// ---------- ping animation ----------
const layer = document.getElementById('pings');
const div = cls => { const d = document.createElement('div'); d.className = cls; return d; };
function img(name, cls = '') {
  const e = document.createElement('img');
  if (cls) e.className = cls;
  e.src = texture(name);
  return e;
}
function spawnPing(def, x, y) {
  const root = div('ping');
  root.style.left = `${x}px`;
  root.style.top = `${y}px`;
  root.style.setProperty('--c', def.color);
  root.style.setProperty('--size', `${PING_SIZE}px`);
  root.style.setProperty('--dur', `${PING_DUR}s`);
  root.append(div('ground'), div('ring'), div('ring r2'), div('ring r3'));
  const art = div('art');
  if (def.art.length === 2) {
    const clash = div('clash');
    clash.append(img(def.art[0], 'a1'), img(def.art[1], 'a2'));
    art.append(clash, div('flash'));
  } else {
    const pop = div('pop');
    pop.append(img(def.art[0]));
    art.append(pop);
  }
  root.append(art);
  while (layer.childElementCount >= MAX_PINGS) layer.firstElementChild.remove();
  layer.append(root);
  setTimeout(() => root.remove(), PING_DUR * 1000 + 150);
  play(def.sound, VOLUME);
}

ipcRenderer.on('wheel:open', (_e, p) => {
  ox = p.x; oy = p.y;
  svg.style.left = `${p.x}px`;
  svg.style.top = `${p.y}px`;
  setHot(-1);
  opened = true;
  svg.classList.add('open');
});
ipcRenderer.on('wheel:move', (_e, p) => { if (opened) setHot(pickSlice(p.x - ox, p.y - oy)); });
ipcRenderer.on('wheel:release', (_e, p) => {
  if (!opened) return;
  const slice = pickSlice(p.x - ox, p.y - oy);
  close();
  if (slice >= 0) spawnPing(WHEEL_PINGS[slice], ox, oy);
});
ipcRenderer.on('wheel:cancel', () => { if (opened) close(); });
ipcRenderer.on('ping:clearAll', () => layer.replaceChildren());
