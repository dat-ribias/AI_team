// Ping-only overlay, cut down from lolPing (D:\p\ping): hook-helper.exe + one click-through window per display.
// No rooms, emotes, settings window, updater. Started by src/server.js; env PING_HELPER, PING_ASSETS.
const { app, BrowserWindow, screen, Tray, Menu, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const readline = require('node:readline');

const helperPath = process.env.PING_HELPER;
const assets = process.env.PING_ASSETS;
// lolPing defaults: hold Alt + drag opens the wheel, Esc cancels, "ddd" clears, Ctrl+Alt+P toggles.
const CONFIG = {
  type: 'config', trigger: 'alt', triggerVk: 0, clickPing: false, keyHoldPing: true, gameCheck: true,
  emoteTrigger: 'off', emoteTriggerVk: 0, emoteClick: false, dragThresholdPx: 8, toggleMods: 1 | 2, toggleVk: 0x50, enabled: true,
};

app.on('window-all-closed', () => {}); // windows are rebuilt on display changes; quit only via tray/parent

const wins = new Map();
let maps = [], wheelDisplay = null, helper = null, quitting = false, crashes = [];
let tray;

const inside = (r, x, y) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
const distSq = (r, x, y) => Math.max(r.x - x, 0, x - (r.x + r.width - 1)) ** 2 + Math.max(r.y - y, 0, y - (r.y + r.height - 1)) ** 2;

/** Physical pixels from the helper → CSS px inside the overlay of `displayId` (default: display under the point). */
function toLocal(x, y, displayId) {
  if (!maps.length) return null;
  const d = maps.find(m => inside(m.phys, x, y)) || maps.reduce((a, b) => (distSq(b.phys, x, y) < distSq(a.phys, x, y) ? b : a));
  const gx = d.dip.x + (x - d.phys.x) / d.scale, gy = d.dip.y + (y - d.phys.y) / d.scale;
  const t = displayId === undefined ? d : maps.find(m => m.id === displayId);
  return t ? { id: t.id, x: gx - t.dip.x, y: gy - t.dip.y } : null;
}

function send(id, channel, payload) {
  const w = wins.get(id);
  if (!w || w.isDestroyed()) return;
  if (channel === 'wheel:open') w.setAlwaysOnTop(true, 'screen-saver'); // Windows can drop it behind after a while
  w.webContents.send(channel, payload);
}

function cancelWheel() {
  if (wheelDisplay !== null) send(wheelDisplay, 'wheel:cancel');
  wheelDisplay = null;
}

function handle(ev) {
  if (ev.type === 'wheelOpen' && ev.wheel !== 'emote') {
    const p = toLocal(ev.x, ev.y);
    if (!p) return;
    wheelDisplay = p.id;
    send(p.id, 'wheel:open', p);
  } else if ((ev.type === 'wheelMove' || ev.type === 'wheelRelease') && wheelDisplay !== null) {
    const p = toLocal(ev.x, ev.y, wheelDisplay);
    if (p) send(p.id, ev.type === 'wheelMove' ? 'wheel:move' : 'wheel:release', p);
    if (ev.type === 'wheelRelease') wheelDisplay = null;
  } else if (ev.type === 'cancel') cancelWheel();
  else if (ev.type === 'clearAll') for (const id of wins.keys()) send(id, 'ping:clearAll');
  else if (ev.type === 'error') console.error('[ping] helper:', ev.message);
}

// Windows treats a window covering a whole display as fullscreen (taskbar hides): stay 1 DIP short.
const boundsOf = d => ({ ...d.bounds, height: d.bounds.height - 1 });

function createWindow(d) {
  const win = new BrowserWindow({
    ...boundsOf(d), transparent: true, backgroundColor: '#00000000', frame: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, focusable: false, skipTaskbar: true, hasShadow: false,
    alwaysOnTop: true, enableLargerThanScreen: true, show: false, type: 'toolbar',
    // Local page only, never remote content: plain node access instead of a preload bridge.
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', spellcheck: false },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.once('ready-to-show', () => { win.showInactive(); win.setBounds(boundsOf(d)); });
  win.loadFile(join(__dirname, 'overlay.html'), { query: { assets } });
  return win;
}

function rebuild() {
  cancelWheel();
  const displays = screen.getAllDisplays();
  maps = displays.map(d => ({ id: d.id, dip: d.bounds, phys: screen.dipToScreenRect(null, d.bounds), scale: d.scaleFactor }));
  for (const [id, w] of wins) if (!displays.some(d => d.id === id)) { w.destroy(); wins.delete(id); }
  for (const d of displays) wins.has(d.id) ? wins.get(d.id).setBounds(boundsOf(d)) : wins.set(d.id, createWindow(d));
}

function startHelper() {
  helper = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  helper.on('error', e => console.error('[ping] helper:', e.message));
  readline.createInterface({ input: helper.stdout }).on('line', line => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === 'ready') helper.stdin.write(JSON.stringify(CONFIG) + '\n');
    else handle(ev);
  });
  helper.on('exit', () => {
    cancelWheel();
    if (quitting) return;
    const now = Date.now();
    crashes = crashes.filter(t => now - t < 60_000).concat(now);
    if (crashes.length > 3) return console.error('[ping] helper keeps crashing, giving up');
    setTimeout(startHelper, 1000);
  });
}

app.whenReady().then(() => {
  rebuild();
  for (const e of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(e, rebuild);
  startHelper();
  tray = new Tray(nativeImage.createFromPath(join(assets, 'textures', 'generic_ping.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('AI Team ping — giữ Alt + kéo chuột');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Quit ping', click: () => app.quit() }]));
  // The team server may die without killing us (console window closed): follow it.
  const parent = Number(process.env.PING_PARENT);
  if (parent) setInterval(() => { try { process.kill(parent, 0); } catch { app.quit(); } }, 5000);
});

app.on('before-quit', () => {
  quitting = true;
  try { helper?.stdin.write('{"type":"shutdown"}\n'); } catch {}
});
