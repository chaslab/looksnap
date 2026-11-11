// LookSnap 主进程：托盘、全局快捷键、截屏、裁剪、贴到聊天框
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, desktopCapturer, clipboard, ClipboardItem, nativeImage,
        protocol, net, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { uIOhook, UiohookKey } = require('uiohook-napi');

const IS_MAC = process.platform === 'darwin';
const ROOT = path.join(__dirname, '..');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ---------- 配置 ----------
const CFG_FILE = path.join(app.getPath('userData'), 'config.json');
const DEFAULTS = {
  hotkey: ['ctrl', 'alt'],   // 只按修饰键 = 按下再松开触发；带普通键 = 按下就触发
  speed: 1.0,                // 框移动速度
  deadzone: 3.0,             // 不动区（度）
  boxW: 0.28, boxH: 0.30,    // 框大小（占屏幕宽高的比例）
  autoPaste: false,          // 截完自动按一次粘贴（默认只放进剪贴板，用户自己 Ctrl+V）
  lang: null,                // 界面语言 zh / en（空 = 跟系统）
  showStick: true,           // 框中间显示摇杆指示
  keepCamera: false,         // 摄像头常开（更快出框，但摄像头灯一直亮）
  cameraId: null,            // 用哪个摄像头（空 = 自动挑笔记本自带的，避开手机/虚拟摄像头）
  calib: null                // 校准结果
};
let cfg = { ...DEFAULTS };
try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) }; } catch {}
// 日志：写到 userData/log.txt，方便排查（只记本程序的运行信息）
const LOG_FILE = path.join(app.getPath('userData'), 'log.txt');
function log(...a) { try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + a.map(x => x instanceof Error ? x.stack : (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n'); } catch {} }
process.on('uncaughtException', e => log('uncaught', e));
const I18N = JSON.parse(fs.readFileSync(path.join(__dirname, 'i18n.json'), 'utf8'));
// 跟随系统语言：简体/繁体中文 → 中文，其他一律英文（用户在设置里手动选过则以手选为准）
const sysLang = () => { try { return (app.getPreferredSystemLanguages() || [])[0] || app.getLocale(); } catch { return app.getLocale(); } };
const lang = () => cfg.lang || (/^zh/i.test(sysLang()) ? 'zh' : 'en');
const t = (k, v = {}) => (I18N[lang()][k] || I18N.zh[k] || k).replace(/\{(\w+)\}/g, (_, n) => v[n] ?? '');
function saveCfg() { fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true }); fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2)); }

// ---------- 自定义协议：让页面能用 fetch 读本地的模型和 wasm 文件 ----------
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

let tray = null, overlay = null, settingsWin = null;
let mode = 'idle';          // idle | aim | calib
let shot = null;            // { img: nativeImage, display }
let recordingHotkey = false;

function hotkeyLabel(keys = cfg.hotkey) {
  const names = { ctrl: IS_MAC ? 'Control' : 'Ctrl', alt: IS_MAC ? 'Option' : 'Alt', shift: 'Shift', meta: IS_MAC ? 'Command' : 'Win' };
  return keys.map(k => names[k] || k).join(' + ');
}

// ---------- 窗口 ----------
function createOverlay() {
  overlay = new BrowserWindow({
    show: false, frame: false, transparent: false, backgroundColor: '#000000', resizable: false, movable: false,
    skipTaskbar: true, focusable: false, hasShadow: false, fullscreenable: false, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false }
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  if (IS_MAC) overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadURL('app://looksnap/src/overlay.html');
  overlay.webContents.on('console-message', (e) => { const m = e.message || ''; if (e.level === 'error' || e.level === 'warning' || /^\[ls\]/.test(m)) log('overlay', e.level, m.slice(0, 500)); });
  overlay.webContents.on('render-process-gone', (_e, d) => log('overlay gone', d));
  overlay.on('closed', () => { overlay = null; });
}

function openSettings() {
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    show: false, width: 1060, height: 760, minWidth: 900, minHeight: 640, title: t('settingsTitle'), resizable: true, autoHideMenuBar: true, backgroundColor: '#f5f5f7',
    icon: path.join(ROOT, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  settingsWin.loadURL('app://looksnap/src/settings.html');
  settingsWin.once('ready-to-show', () => {   // Windows 默认不让后台程序抢前台，这里短暂置顶一下
    settingsWin.show(); settingsWin.setAlwaysOnTop(true); settingsWin.focus();
    setTimeout(() => settingsWin && settingsWin.setAlwaysOnTop(false), 400);
  });
  if (process.env.LS_SHOT) settingsWin.webContents.once('did-finish-load', () => setTimeout(async () => {
    const img = await settingsWin.webContents.capturePage();
    fs.writeFileSync(path.join(app.getPath('userData'), 'settings.png'), img.toPNG()); log('settings shot saved');
  }, 2500));
  settingsWin.on('closed', () => { settingsWin = null; recordingHotkey = false; });
}

function buildTray() {
  const img = nativeImage.createFromPath(path.join(ROOT, 'assets', IS_MAC ? 'trayTemplate.png' : 'tray.png'));
  if (!tray) { tray = new Tray(img); tray.on('click', () => openSettings()); }
  tray.setToolTip(t('trayTip', { key: hotkeyLabel() }));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('traySnap', { key: hotkeyLabel() }), click: () => startAim() },
    { label: t('trayCalib'), click: () => startCalib() },
    { label: t('traySettings'), click: () => openSettings() },
    { type: 'separator' },
    { label: t('trayLogin'), type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: m => { app.setLoginItemSettings({ openAtLogin: m.checked }); } },
    { label: t('trayHome'), click: () => shell.openExternal('https://github.com/chaslab/looksnap') },
    { type: 'separator' },
    { label: t('trayQuit'), click: () => app.quit() }
  ]));
}

// ---------- 截屏 ----------
// Windows：用常驻的 GDI 小助手截屏（开 HDR 时颜色正常）；失败了再退回 desktopCapturer
const IS_WIN = process.platform === 'win32';
let gdi = null, gdiWaiter = null, gdiReady = false;
function gdiStart() {
  if (!IS_WIN || gdi) return;
  const script = path.join(__dirname, 'gdi-capture.ps1').replace('app.asar', 'app.asar.unpacked');
  gdi = require('child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
  require('readline').createInterface({ input: gdi.stdout }).on('line', l => {
    if (l.trim() === 'ready') { gdiReady = true; log('gdi helper ready'); return; }
    const w = gdiWaiter; gdiWaiter = null; w && w(l.trim());
  });
  gdi.on('exit', () => { gdi = null; gdiReady = false; });
}
function gdiCapture(rect) {
  return new Promise((resolve, reject) => {
    if (!gdi) return reject(new Error('no gdi helper'));
    const f = path.join(app.getPath('temp'), 'looksnap_cap.raw');
    const timer = setTimeout(() => { gdiWaiter = null; reject(new Error('gdi timeout')); }, 3000);
    gdiWaiter = line => {
      clearTimeout(timer);
      if (!line.startsWith('ok')) return reject(new Error(line));
      const img = nativeImage.createFromBitmap(fs.readFileSync(f), { width: rect.width, height: rect.height });
      try { fs.unlinkSync(f); } catch {}
      resolve(img);
    };
    gdi.stdin.write(`${rect.x}|${rect.y}|${rect.width}|${rect.height}|${f}\n`);
  });
}
async function captureDisplay(display) {
  if (IS_WIN && gdi && gdiReady) {
    try { const t0 = Date.now(); const img = await gdiCapture(screen.dipToScreenRect(null, display.bounds)); log('gdi capture ms', Date.now() - t0); return img; }
    catch (e) { log('gdi capture failed, fallback', e.message); }
  }
  const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find(s => String(s.display_id) === String(display.id)) || sources[0];
  return src ? src.thumbnail : null;
}

async function startAim() {
  if (mode !== 'idle' || !overlay) return;
  mode = 'aim';
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    overlay.webContents.send('cam:warm', cfg);                       // 截屏的同时先把摄像头打开
    const img = await captureDisplay(display);
    if (!img || img.isEmpty()) throw new Error('截屏失败');
    if (mode !== 'aim') return;                                 // 截屏期间被取消
    shot = { img, display };
    overlay.setBounds(display.bounds);
    overlay.webContents.send('aim:start', {
      image: img.toJPEG(88).toString('base64'), w: display.size.width, h: display.size.height,
      primary: display.id === screen.getPrimaryDisplay().id, cfg: { ...cfg, lang: lang() }, label: hotkeyLabel()
    });
    overlay.showInactive();
    overlay.setAlwaysOnTop(true, 'screen-saver');
  } catch (e) {
    log('aim error', e); endAim();
    if (IS_MAC) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
}

function endAim() { mode = 'idle'; shot = null; if (overlay) { overlay.hide(); overlay.webContents.send('aim:end'); } }

async function copyImage(img) {   // Electron 44 起剪贴板改成了网页那种异步写法；老版本用 writeImage
  if (typeof clipboard.writeImage === 'function') return clipboard.writeImage(img);
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([img.toPNG()], { type: 'image/png' }) })]);
}
ipcMain.on('aim:rect', async (_e, r) => {   // 页面告诉我框的位置（逻辑像素），裁剪 + 复制 + 粘贴
  if (mode !== 'aim' || !shot) return;
  const s = shot.img.getSize().width / shot.display.size.width;
  const rect = { x: Math.round(r.x * s), y: Math.round(r.y * s), width: Math.round(r.w * s), height: Math.round(r.h * s) };
  const out = shot.img.crop(rect);
  log('captured', rect, 'display', shot.display.size, 'scale', shot.display.scaleFactor);
  endAim();
  try { await copyImage(out); } catch (e) { log('clipboard error', e); return; }
  if (cfg.autoPaste && !process.env.LS_SELFTEST) setTimeout(() => {   // 模拟按 Ctrl+V（Mac 是 Command+V）
    try { uIOhook.keyTap(UiohookKey.V, [IS_MAC ? UiohookKey.Meta : UiohookKey.Ctrl]); } catch (e) { console.error(e); }
  }, 150);
});
ipcMain.on('aim:cancel', () => endAim());

// ---------- 校准 ----------
function startCalib() {
  if (!overlay) return;
  if (mode === 'aim') endAim();
  mode = 'calib';
  const d = screen.getPrimaryDisplay();
  overlay.setBounds(d.bounds);
  overlay.webContents.send('calib:start', { w: d.size.width, h: d.size.height, cfg: { ...cfg, lang: lang() } });
  overlay.showInactive();
  overlay.setAlwaysOnTop(true, 'screen-saver');
}
ipcMain.on('calib:done', (_e, fit) => {
  cfg.calib = fit; saveCfg(); mode = 'idle'; overlay.hide();
  if (settingsWin) settingsWin.webContents.send('cfg', cfg);
});
ipcMain.on('calib:cancel', () => { mode = 'idle'; overlay && overlay.hide(); });

// ---------- 设置 ----------
ipcMain.handle('cfg:get', () => ({ cfg: { ...cfg, lang: lang() }, label: hotkeyLabel(), mac: IS_MAC, screen: screen.getPrimaryDisplay().size, loginItem: app.getLoginItemSettings().openAtLogin, version: app.getVersion() }));
ipcMain.on('cfg:set', (_e, patch) => {
  cfg = { ...cfg, ...patch }; saveCfg(); buildTray();
  if (overlay) overlay.webContents.send('cfg', { ...cfg, lang: lang() });
  if (settingsWin && patch.lang) settingsWin.setTitle(t('settingsTitle'));
});
ipcMain.on('login:set', (_e, on) => app.setLoginItemSettings({ openAtLogin: !!on }));
ipcMain.on('calib:open', () => startCalib());
ipcMain.on('hotkey:record', (_e, on) => { recordingHotkey = !!on; recBuf = new Set(); recPeak = []; });
ipcMain.on('open:url', (_e, u) => { if (/^https:\/\//.test(u)) shell.openExternal(u); });

// ---------- 全局快捷键（uiohook 能识别「只按 Ctrl+Alt 再松开」这种组合） ----------
const MOD = {
  ctrl: [UiohookKey.Ctrl, UiohookKey.CtrlRight], alt: [UiohookKey.Alt, UiohookKey.AltRight],
  shift: [UiohookKey.Shift, UiohookKey.ShiftRight], meta: [UiohookKey.Meta, UiohookKey.MetaRight]
};
const CODE2NAME = new Map();
for (const [n, codes] of Object.entries(MOD)) codes.forEach(c => CODE2NAME.set(c, n));
for (const k of Object.keys(UiohookKey)) {
  if (/^[A-Z0-9]$/.test(k) || /^F([1-9]|1[0-2])$/.test(k) || k === 'Space' || k === 'Escape') CODE2NAME.set(UiohookKey[k], k);
}
const isMod = n => n in MOD;
const pressed = new Set();
let chordArmed = false, recBuf = new Set(), recPeak = [];

function hotkeyMatches() {
  const want = new Set(cfg.hotkey);
  if (pressed.size !== want.size) return false;
  for (const k of want) if (!pressed.has(k)) return false;
  return true;
}
function trigger() {
  if (mode === 'idle') startAim();
  else if (mode === 'aim' && shot) overlay.webContents.send('aim:confirm');
}

uIOhook.on('keydown', e => {
  const n = CODE2NAME.get(e.keycode) || ('k' + e.keycode);
  if (recordingHotkey) {   // 设置里正在录新的快捷键
    recBuf.add(n); if (recBuf.size > recPeak.length) recPeak = [...recBuf];
    settingsWin && settingsWin.webContents.send('hotkey:preview', recPeak);
    return;
  }
  const wasDown = pressed.has(n);
  pressed.add(n);
  if (wasDown) return;     // 长按的自动重复
  const inHotkey = cfg.hotkey.includes(n);
  // 瞄准或校准时，按了快捷键以外的键 = 取消
  if (!inHotkey && mode === 'aim') { endAim(); chordArmed = false; return; }
  if (n === 'Escape' && mode === 'calib') { overlay.webContents.send('calib:abort'); return; }
  const onlyMods = cfg.hotkey.every(isMod);
  if (onlyMods) {
    chordArmed = hotkeyMatches() ? true : (inHotkey ? chordArmed : false);
    if (!inHotkey) chordArmed = false;
  } else if (hotkeyMatches()) trigger();
});
uIOhook.on('keyup', e => {
  const n = CODE2NAME.get(e.keycode) || ('k' + e.keycode);
  if (recordingHotkey) {
    recBuf.delete(n);
    if (recBuf.size === 0 && recPeak.length) {
      const order = ['ctrl', 'alt', 'shift', 'meta'];
      const keys = recPeak.filter(k => k !== 'Escape').sort((a, b) => (order.indexOf(a) + 1 || 9) - (order.indexOf(b) + 1 || 9));
      recordingHotkey = false;
      if (keys.length && keys.every(k => isMod(k) || CODE2NAME.has(UiohookKey[k]))) {
        cfg.hotkey = keys; saveCfg(); buildTray();
      }
      settingsWin && settingsWin.webContents.send('hotkey:done', { keys: cfg.hotkey, label: hotkeyLabel() });
    }
    return;
  }
  pressed.delete(n);
  if (chordArmed && pressed.size === 0) { chordArmed = false; trigger(); }
});

// ---------- 启动 ----------
app.whenReady().then(() => {
  protocol.handle('app', req => {
    const u = new URL(req.url);
    const p = path.normalize(path.join(ROOT, decodeURIComponent(u.pathname)));
    if (!p.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(p).toString());
  });
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media');
  if (IS_MAC && app.dock) app.dock.hide();
  createOverlay();
  gdiStart();
  buildTray();
  uIOhook.start();
  log('started', app.getVersion(), process.platform, 'hotkey', cfg.hotkey);
  if (process.env.LS_CAPTEST) {     // 开发：记录每块屏幕的色彩信息，并各截一张图，用来对比 HDR 发白
    (async () => { await new Promise(r => setTimeout(r, 6000)); for (const d of screen.getAllDisplays()) {
      log('display', { id: d.id, bounds: d.bounds, scale: d.scaleFactor, colorSpace: d.colorSpace, colorDepth: d.colorDepth, depthPerComponent: d.depthPerComponent, primary: d.id === screen.getPrimaryDisplay().id });
      const img = await captureDisplay(d); if (img) fs.writeFileSync(path.join(app.getPath('userData'), `dc_${d.id}.png`), img.toPNG());
    } log('captest done'); app.quit(); })();
    return;
  }
  if (process.env.LS_SELFTEST) {    // 开发自测：自动出框 3 秒后确认，只复制不粘贴
    setTimeout(() => { startAim(); setTimeout(async () => {
      if (mode !== 'aim') return;
      if (process.env.LS_SHOT) { const img = await overlay.webContents.capturePage(); fs.writeFileSync(path.join(app.getPath('userData'), 'aim.png'), img.toJPEG(80)); log('aim shot saved'); }
      overlay.webContents.send('aim:confirm'); }, 3500); }, 3000);
  } else if (!cfg.calib || process.env.LS_SHOT) openSettings();   // 第一次用：打开设置页，引导校准
});
app.on('second-instance', () => openSettings());
app.on('window-all-closed', e => { /* 托盘程序：关窗口不退出 */ });
app.on('will-quit', () => { try { uIOhook.stop(); } catch {} try { gdi && gdi.kill(); } catch {} });
