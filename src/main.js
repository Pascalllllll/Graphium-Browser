'use strict';

const {
  app,
  BaseWindow,
  WebContentsView,
  Menu,
  session,
  ipcMain,
  protocol,
  net,
  dialog,
  shell,
  nativeTheme,
  clipboard,
  webContents: AllWebContents,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const os = require('os');
const settings = require('./settings');
const history = require('./history');

const IS_MAC = process.platform === 'darwin';
const PAGES_DIR = path.join(__dirname, 'pages');
const UI_FILE = path.join(__dirname, 'ui', 'index.html');
const PRELOAD_UI = path.join(__dirname, 'preload-ui.js');
const PRELOAD_TAB = path.join(__dirname, 'preload-tab.js');
const ICON = path.join(__dirname, 'icon.png');
const NEW_TAB = 'graphium://newtab/';
const INTERNAL_PAGES = new Set(['newtab', 'settings', 'history', 'error']);
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const MAX_CLOSED = 25;
const MAX_HISTORY = 50;
const GESTURES = new Set(['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'char', 'touchStart', 'touchEnd', 'gestureTap']);

// A plain Chrome user agent. Some sites (Google sign-in among them) refuse
// browsers that advertise "Electron" in the UA.
const CHROME_MAJOR = process.versions.chrome.split('.')[0];
const UA_PLATFORM = {
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  win32: 'Windows NT 10.0; Win64; x64',
}[process.platform] || 'X11; Linux x86_64';
const USER_AGENT = `Mozilla/5.0 (${UA_PLATFORM}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

protocol.registerSchemesAsPrivileged([
  { scheme: 'graphium', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.userAgentFallback = USER_AGENT;
// Tabs on the same site share one process instead of one each. Saves memory
// when several tabs of one site are open.
app.commandLine.appendSwitch('process-per-site');
// The GPU stays in its own process on purpose. 'in-process-gpu' saved about
// 110 MB, but broke WebGL and screenshots on Mesa 26, and a driver crash
// would take the whole browser down instead of just restarting the GPU.
app.setName('Graphium');

const wins = new Set();
const tabsByWc = new Map(); // webContents id -> { win, tab }
const upgradedHosts = new Set(); // hosts we switched to https ourselves
const httpAllowed = new Set(); // hosts where https failed, so plain http is used
const certAllowed = new Set(); // hosts the user chose to open despite a bad certificate
const downloads = [];
const privatePermissions = new WeakMap(); // session -> { origin: { perm: bool } }
let blocker = null;
let lastFocused = null;
let tabSeq = 0;
let privateSeq = 0;
let downloadSeq = 0;
let quitting = false;
let cleanedUp = false;
let sessionSaveTimer;

// ---------------------------------------------------------------- helpers

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isInternalUrl(url) {
  return typeof url === 'string' && url.startsWith('graphium://');
}

function isLocalHost(host) {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.startsWith('[') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    !host.includes('.')
  );
}

// Turns whatever the user typed into something loadable.
function toUrl(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  if (/^(https?|graphium|file):/i.test(text) || /^about:blank$/i.test(text)) return text;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i.test(text)) return 'http://' + text;
  if (!/\s/.test(text) && /^[^\s/?#:]+\.[a-z][a-z0-9-]{1,62}\.?(:\d+)?([/?#].*)?$/i.test(text)) {
    const url = 'https://' + text;
    const host = hostOf(url);
    if (host) upgradedHosts.add(host);
    return url;
  }
  return settings.searchUrl(text);
}

function displayUrl(url) {
  if (!url || url === NEW_TAB) return '';
  if (url.startsWith('graphium://error/')) {
    try {
      return new URL(url).searchParams.get('u') || '';
    } catch {
      return '';
    }
  }
  return url;
}

function fallbackTitle(url) {
  if (!url || url === NEW_TAB) return 'New tab';
  if (url.startsWith('graphium://settings')) return 'Settings';
  if (url.startsWith('graphium://history')) return 'History';
  return hostOf(displayUrl(url)) || displayUrl(url) || 'New tab';
}

function shieldsOnFor(url) {
  if (!settings.get('shields')) return false;
  const host = hostOf(url);
  return !host || !settings.get('allowlist').includes(host);
}

function uniquePath(dir, name) {
  const safe = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || 'download';
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

function urlsFromArgv(argv) {
  const out = [];
  for (const arg of argv.slice(1)) {
    if (/^https?:\/\//i.test(arg)) out.push(arg);
    else if (/\.(html?|pdf|svg|txt)$/i.test(arg) && fs.existsSync(arg)) out.push(pathToFileURL(path.resolve(arg)).href);
  }
  return out;
}

function themeBackground() {
  return nativeTheme.shouldUseDarkColors ? '#1c1c1f' : '#ffffff';
}

// ---------------------------------------------------------------- sessions

async function serveInternal(request) {
  const url = new URL(request.url);
  if (!INTERNAL_PAGES.has(url.hostname)) return new Response('Not found', { status: 404 });
  const name = url.pathname === '/' ? `${url.hostname}.html` : path.posix.basename(url.pathname);
  const match = /\.(html|css|js|svg|woff2)$/.exec(name);
  if (!match) return new Response('Not found', { status: 404 });
  try {
    const body = await fs.promises.readFile(path.join(PAGES_DIR, name));
    const type = {
      html: 'text/html; charset=utf-8',
      css: 'text/css; charset=utf-8',
      js: 'text/javascript; charset=utf-8',
      svg: 'image/svg+xml; charset=utf-8',
      woff2: 'font/woff2',
    }[match[1]];
    return new Response(body, {
      headers: {
        'content-type': type,
        'content-security-policy':
          "default-src 'none'; script-src 'self'; font-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function maybeUpgrade(url) {
  if (!settings.get('httpsUpgrade') || !url.startsWith('http://')) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  if (isLocalHost(host) || httpAllowed.has(host)) return null;
  upgradedHosts.add(host);
  parsed.protocol = 'https:';
  return parsed.href;
}

function pageUrlForRequest(details) {
  const wc = details.webContentsId ? AllWebContents.fromId(details.webContentsId) : null;
  return wc && !wc.isDestroyed() ? wc.getURL() : '';
}

const PERMISSION_TEXT = {
  media: 'use your camera or microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'read your clipboard',
  midi: 'use your MIDI devices',
  midiSysex: 'use your MIDI devices',
  openExternal: 'open an app on your computer',
  'idle-detection': 'know when you are idle',
};
const AUTO_ALLOW = new Set([
  'fullscreen',
  'clipboard-sanitized-write',
  'pointerLock',
  'keyboardLock',
  'storage-access',
  'top-level-storage-access',
  'speaker-selection',
  'window-management',
]);

function permissionStore(ses) {
  if (ses === session.fromPartition('persist:graphium')) return settings.get('sitePermissions');
  if (!privatePermissions.has(ses)) privatePermissions.set(ses, {});
  return privatePermissions.get(ses);
}

function rememberPermission(ses, origin, permission, allowed) {
  const store = permissionStore(ses);
  store[origin] = { ...(store[origin] || {}), [permission]: allowed };
  if (ses === session.fromPartition('persist:graphium')) settings.setTrusted('sitePermissions', store);
}

function setupSession(ses) {
  ses.setUserAgent(USER_AGENT);
  ses.protocol.handle('graphium', serveInternal);

  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (details.resourceType === 'mainFrame') {
      const upgraded = maybeUpgrade(details.url);
      callback(upgraded ? { redirectURL: upgraded } : {});
      return;
    }
    if (!blocker || !shieldsOnFor(pageUrlForRequest(details))) {
      callback({});
      return;
    }
    blocker.onBeforeRequest(details, response => {
      if (response.cancel || response.redirectURL) {
        const entry = tabsByWc.get(details.webContentsId);
        if (entry) {
          entry.tab.blocked++;
          if (entry.win.activeId === entry.tab.id) entry.win.sendState();
        }
      }
      callback(response);
    });
  });

  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
    if (!blocker || details.resourceType !== 'mainFrame' || !shieldsOnFor(details.url)) {
      callback({});
      return;
    }
    blocker.onHeadersReceived(details, callback);
  });

  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    if (settings.get('gpc')) details.requestHeaders['Sec-GPC'] = '1';
    callback({ requestHeaders: details.requestHeaders });
  });

  try {
    const from = path.dirname(require.resolve('@ghostery/adblocker-electron'));
    const filePath = require.resolve('@ghostery/adblocker-electron-preload', { paths: [from] });
    ses.registerPreloadScript({ type: 'frame', filePath });
  } catch (err) {
    console.warn('Cosmetic filtering unavailable:', err.message);
  }

  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    if (AUTO_ALLOW.has(permission)) return true;
    const store = permissionStore(ses);
    return store[origin]?.[permission] === true;
  });

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (AUTO_ALLOW.has(permission)) return callback(true);
    const what = PERMISSION_TEXT[permission];
    if (!what) return callback(false);
    let origin;
    try {
      origin = new URL(details.requestingUrl).origin;
    } catch {
      return callback(false);
    }
    // Internal pages never need anything.
    if (origin.startsWith('graphium:')) return callback(false);
    const saved = permissionStore(ses)[origin]?.[permission];
    if (typeof saved === 'boolean') return callback(saved);

    let message = `${hostOf(origin) || origin} wants to ${what}.`;
    if (permission === 'media' && details.mediaTypes?.length) {
      const kinds = details.mediaTypes.map(t => (t === 'video' ? 'camera' : 'microphone'));
      message = `${hostOf(origin)} wants to use your ${kinds.join(' and ')}.`;
    }
    if (permission === 'openExternal' && details.externalURL) {
      message = `${hostOf(origin)} wants to open ${details.externalURL.split(':')[0]}: links with an app on your computer.`;
    }
    const entry = tabsByWc.get(wc.id);
    const parent = entry ? entry.win.win : undefined;
    dialog
      .showMessageBox(parent, {
        type: 'question',
        message,
        buttons: ['Allow', 'Block'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        const allowed = response === 0;
        rememberPermission(ses, origin, permission, allowed);
        callback(allowed);
      })
      .catch(() => callback(false));
  });

  ses.on('will-download', (_event, item) => {
    const dir = settings.get('downloadDir') || app.getPath('downloads');
    if (settings.get('askDownloadLocation')) {
      item.setSaveDialogOptions({ defaultPath: path.join(dir, item.getFilename()) });
    } else {
      try {
        fs.mkdirSync(dir, { recursive: true });
        item.setSavePath(uniquePath(dir, item.getFilename()));
      } catch {
        item.setSaveDialogOptions({ defaultPath: item.getFilename() });
      }
    }
    const record = { id: ++downloadSeq, name: item.getFilename(), file: '', received: 0, total: item.getTotalBytes(), state: 'progressing', item };
    downloads.unshift(record);
    if (downloads.length > 30) downloads.pop();
    let lastSent = 0;
    item.on('updated', () => {
      record.received = item.getReceivedBytes();
      record.total = item.getTotalBytes();
      record.file = item.getSavePath();
      if (Date.now() - lastSent > 500) {
        lastSent = Date.now();
        broadcastState();
      }
    });
    item.once('done', (_e, state) => {
      record.state = state;
      record.file = item.getSavePath();
      record.name = path.basename(record.file) || record.name;
      record.item = null;
      broadcastState();
    });
    broadcastState();
  });
}

async function initBlocker() {
  const { ElectronBlocker } = require('@ghostery/adblocker-electron');
  const cache = path.join(app.getPath('userData'), 'adblock-engine.bin');
  let fresh = false;
  try {
    const age = Date.now() - fs.statSync(cache).mtimeMs;
    blocker = ElectronBlocker.deserialize(new Uint8Array(fs.readFileSync(cache)));
    fresh = age < 3 * 24 * 3600 * 1000;
  } catch {
    // No cache, or it was written by another engine version.
  }
  if (fresh) return lighten();
  try {
    const engine = await ElectronBlocker.fromPrebuiltAdsAndTracking((url, init) => net.fetch(url, init));
    blocker = engine;
    fs.writeFileSync(cache, engine.serialize());
    lighten();
  } catch (err) {
    console.warn('Could not update block lists:', err.message);
    lighten();
  }
}

// Hiding leftover ad boxes once per page is enough; re-scanning the page on
// every DOM change costs CPU and memory in every tab.
function lighten() {
  if (blocker) blocker.config.enableMutationObserver = false;
}

ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (event, url, msg) => {
  if (!blocker || !shieldsOnFor(event.sender.getURL())) return undefined;
  return blocker.onInjectCosmeticFilters(event, url, msg);
});
ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', event =>
  blocker ? blocker.onIsMutationObserverEnabled(event) : false,
);

// ---------------------------------------------------------------- windows

class BrowserWin {
  constructor({ isPrivate = false, urls = [], restore = null } = {}) {
    this.isPrivate = isPrivate;
    this.ses = isPrivate ? session.fromPartition(`graphium-private-${++privateSeq}`) : session.fromPartition('persist:graphium');
    if (isPrivate) setupSession(this.ses);
    this.tabs = [];
    this.closedTabs = [];
    this.activeId = null;
    this.uiHeight = 78;
    this.htmlFullscreen = false;
    this.findOpen = false;
    this.statePending = false;
    // Two tabs side by side: { left, right, ratio }. The active tab is whichever pane was used last.
    this.split = null;
    // While the command palette is open the toolbar view covers the whole window, see openPalette().
    this.paletteOpen = false;

    const saved = settings.get('windowBounds');
    const bounds = saved && Number.isFinite(saved.width) && Number.isFinite(saved.height) ? saved : { width: 1280, height: 820 };
    this.win = new BaseWindow({
      ...bounds,
      minWidth: 420,
      minHeight: 300,
      title: 'Graphium',
      icon: IS_MAC ? undefined : ICON,
      backgroundColor: themeBackground(),
      autoHideMenuBar: true,
    });

    this.ui = new WebContentsView({
      webPreferences: { preload: PRELOAD_UI, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    this.ui.setBackgroundColor(themeBackground());
    this.win.contentView.addChildView(this.ui);
    const uiWc = this.ui.webContents;
    uiWc.loadFile(UI_FILE, { query: { private: isPrivate ? '1' : '0', platform: process.platform } });
    uiWc.on('will-navigate', e => e.preventDefault());
    uiWc.setWindowOpenHandler(() => ({ action: 'deny' }));
    uiWc.on('before-input-event', (event, input) => {
      if (handleShortcut(this, input)) event.preventDefault();
    });
    uiWc.on('did-finish-load', () => this.sendState(true));

    this.win.on('resize', () => this.layout());
    this.win.on('focus', () => {
      lastFocused = this;
    });
    this.win.on('enter-full-screen', () => this.layout());
    this.win.on('leave-full-screen', () => {
      this.htmlFullscreen = false;
      this.layout();
    });
    this.win.on('close', () => {
      if (!this.isPrivate && !this.win.isFullScreen()) settings.setTrusted('windowBounds', this.win.getNormalBounds());
    });
    this.win.on('closed', () => this.destroy());

    wins.add(this);
    lastFocused = this;

    if (restore && restore.tabs.length) {
      restore.tabs.forEach((saved, i) => {
        const tab = this.makeTab(saved.url);
        tab.title = saved.title || '';
        tab.history = saved.history || null;
        this.tabs.push(tab);
        if (i === restore.active) this.activate(tab.id);
      });
      if (!this.activeId) this.activate(this.tabs[0].id);
    } else if (urls.length) {
      urls.forEach((url, i) => this.addTab({ url, background: i > 0 }));
    } else {
      this.addTab({ url: settings.get('homepage') || NEW_TAB });
    }
    this.layout();
  }

  get(id) {
    return this.tabs.find(t => t.id === id);
  }

  active() {
    return this.get(this.activeId);
  }

  activeWc() {
    const tab = this.active();
    return tab && tab.view ? tab.view.webContents : null;
  }

  makeTab(url) {
    return {
      id: ++tabSeq,
      url: url || NEW_TAB,
      title: '',
      favicon: '',
      loading: false,
      view: null,
      blocked: 0,
      blockedPopup: '',
      lastGesture: 0,
      lastActive: Date.now(),
      history: null,
    };
  }

  addTab({ url = NEW_TAB, background = false, adopt = null, index = null } = {}) {
    const tab = this.makeTab(url);
    const at = index === null ? this.tabs.length : Math.max(0, Math.min(index, this.tabs.length));
    this.tabs.splice(at, 0, tab);
    this.createView(tab, adopt);
    if (!adopt) tab.view.webContents.loadURL(tab.url).catch(() => {});
    if (background) this.sendState();
    else this.activate(tab.id);
    if (!background && tab.url === NEW_TAB) this.focusAddress();
    scheduleSessionSave();
    return tab;
  }

  createView(tab, adopt) {
    const view = adopt
      ? new WebContentsView({ webContents: adopt })
      : new WebContentsView({
          webPreferences: {
            session: this.ses,
            preload: PRELOAD_TAB,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            webviewTag: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            plugins: true,
            spellcheck: false,
            safeDialogs: true,
            navigateOnDragDrop: false,
          },
        });
    view.setBackgroundColor(themeBackground());
    tab.view = view;
    this.wireTab(tab);
    return view;
  }

  wireTab(tab) {
    const wc = tab.view.webContents;
    const wcId = wc.id;
    tabsByWc.set(wcId, { win: this, tab });
    wc.setWebRTCIPHandlingPolicy('default_public_interface_only');

    const view = tab.view;
    wc.on('destroyed', () => {
      tabsByWc.delete(wcId);
      // Still the tab's live view, so we did not close it: the page called
      // window.close(), or it was a pop-up whose opener went away.
      if (tab.view !== view || this.closing || !this.tabs.includes(tab)) return;
      tab.view = null;
      this.win.contentView.removeChildView(view);
      setImmediate(() => this.closeTab(tab.id));
    });
    wc.on('focus', () => {
      // In split view the address bar follows whichever pane was clicked last.
      if (!this.inSplit(tab) || this.activeId === tab.id) return;
      this.activeId = tab.id;
      tab.lastActive = Date.now();
      this.sendState();
    });
    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      if (!this.isPrivate) history.setTitle(tab.url, title);
      this.sendState();
    });
    wc.on('page-favicon-updated', (_e, icons) => {
      tab.favicon = icons.find(u => /^(https?|data):/.test(u)) || '';
      this.sendState();
    });
    wc.on('did-start-loading', () => {
      tab.loading = true;
      this.sendState();
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      this.sendState();
    });
    wc.on('did-navigate', (_e, url) => {
      tab.url = url;
      tab.blocked = 0;
      tab.blockedPopup = '';
      tab.favicon = '';
      if (isInternalUrl(url)) tab.title = '';
      if (!this.isPrivate) history.add(url, '');
      this.sendState();
      scheduleSessionSave();
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.url = url;
      this.sendState();
      scheduleSessionSave();
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => this.onLoadFailed(tab, code, desc, url, isMainFrame));
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit' || wc.isDestroyed()) return;
      this.showError(tab, 'crashed', '', displayUrl(tab.url));
    });
    const guardInternal = event => {
      // Web pages may not open internal pages.
      if (isInternalUrl(event.url) && !isInternalUrl(wc.getURL())) event.preventDefault();
    };
    wc.on('will-navigate', guardInternal);
    wc.on('will-redirect', guardInternal);
    wc.on('input-event', (_e, input) => {
      if (GESTURES.has(input.type)) tab.lastGesture = Date.now();
    });
    wc.on('enter-html-full-screen', () => {
      this.htmlFullscreen = true;
      this.wasFullscreen = this.win.isFullScreen();
      this.win.setFullScreen(true);
      this.layout();
    });
    wc.on('leave-html-full-screen', () => {
      this.htmlFullscreen = false;
      if (!this.wasFullscreen) this.win.setFullScreen(false);
      this.layout();
    });
    wc.on('found-in-page', (_e, result) => {
      if (this.activeId === tab.id) this.ui.webContents.send('find-result', { active: result.activeMatchOrdinal, total: result.matches });
    });
    wc.on('zoom-changed', (_e, direction) => this.zoom(direction === 'in' ? 1 : -1));
    wc.on('before-input-event', (event, input) => {
      if (handleShortcut(this, input)) event.preventDefault();
    });
    wc.on('context-menu', (_e, params) => this.pageMenu(tab, params));
    wc.setWindowOpenHandler(details => this.onWindowOpen(tab, details));
  }

  onWindowOpen(tab, { url, disposition, features }) {
    if (!/^(https?:|about:blank|blob:)/i.test(url)) return { action: 'deny' };
    // Pop-up blocking: only open windows the user just asked for with a click or key.
    if (Date.now() - tab.lastGesture > 5000) {
      if (/^https?:/i.test(url)) tab.blockedPopup = url;
      this.sendState();
      return { action: 'deny' };
    }
    tab.lastGesture = 0;
    const index = this.tabs.indexOf(tab) + 1;
    // Links and plain window.open() become normal, independent tabs (like
    // Chrome's noopener default). Electron destroys a window-opened page when
    // its opener closes, so only real pop-ups, which need window.opener for
    // things like sign-in, stay attached to the page that opened them.
    if (disposition !== 'new-window' || !features) {
      this.addTab({ url, background: disposition === 'background-tab', index });
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      createWindow: options => {
        const popup = this.addTab({ url, adopt: options.webContents, index });
        popup.openerId = tab.id;
        return popup.view.webContents;
      },
    };
  }

  onLoadFailed(tab, code, desc, url, isMainFrame) {
    if (!isMainFrame || code === -3 || !tab.view) return;
    const host = hostOf(url);
    const httpsFailed = (code <= -200 && code > -300) || [-100, -101, -102, -107, -113, -118, -310, -324, -501].includes(code);
    if (url.startsWith('https://') && upgradedHosts.has(host) && httpsFailed) {
      upgradedHosts.delete(host);
      httpAllowed.add(host);
      tab.view.webContents.loadURL('http://' + url.slice('https://'.length)).catch(() => {});
      return;
    }
    this.showError(tab, String(code), desc, url);
  }

  showError(tab, code, desc, url) {
    if (!tab.view || tab.view.webContents.isDestroyed()) {
      if (tab.view) this.dropView(tab);
      this.createView(tab);
      if (this.activeId === tab.id) this.attach(tab);
    }
    const query = new URLSearchParams({ c: code, d: desc || '', u: url || '' });
    tab.view.webContents.loadURL(`graphium://error/?${query}`).catch(() => {});
  }

  inSplit(tab) {
    return !!this.split && !!tab && (tab.id === this.split.left || tab.id === this.split.right);
  }

  /** The tabs on screen: the active one, or both halves of a split. */
  shownTabs(tab) {
    if (!this.split) return [tab];
    const pair = [this.get(this.split.left), this.get(this.split.right)];
    return pair.every(Boolean) ? pair : [tab];
  }

  attach(tab) {
    const shown = this.shownTabs(tab);
    for (const t of this.tabs) {
      if (!shown.includes(t) && t.view) this.win.contentView.removeChildView(t.view);
    }
    for (const t of shown) {
      if (!t.view) this.wake(t);
      this.win.contentView.addChildView(t.view);
    }
    // The palette draws over the page, so the toolbar view stays on top while it is open.
    if (this.paletteOpen) this.win.contentView.addChildView(this.ui);
    this.layout();
  }

  /** Puts `otherId` (or the most recently used other tab, or a new tab) next to the active tab. */
  splitWith(otherId = null) {
    const tab = this.active();
    if (!tab) return;
    let other = otherId === null ? null : this.get(otherId);
    if (!other || other === tab) {
      other = this.tabs.filter(t => t !== tab).sort((a, b) => b.lastActive - a.lastActive)[0] || null;
    }
    if (!other) other = this.addTab({ background: true, index: this.tabs.indexOf(tab) + 1 });
    this.split = { left: tab.id, right: other.id, ratio: 0.5 };
    this.attach(tab);
    this.sendState();
  }

  unsplit() {
    if (!this.split) return;
    this.split = null;
    const tab = this.active();
    if (tab) this.attach(tab);
    this.sendState();
  }

  resizeSplit(delta) {
    if (!this.split) return;
    this.split.ratio = Math.min(0.8, Math.max(0.2, this.split.ratio + delta));
    this.layout();
  }

  swapSplit() {
    if (!this.split) return;
    this.split = { ...this.split, left: this.split.right, right: this.split.left, ratio: 1 - this.split.ratio };
    this.layout();
    this.sendState();
  }

  activate(id) {
    const tab = this.get(id);
    if (!tab) return;
    const prev = this.active();
    if (prev && prev !== tab) {
      prev.lastActive = Date.now();
      if (prev.view && !prev.view.webContents.isDestroyed()) prev.view.webContents.stopFindInPage('clearSelection');
    }
    // Choosing a tab outside the pair leaves split view; the two tabs stay open.
    if (this.split && !this.inSplit(tab)) this.split = null;
    this.activeId = id;
    tab.lastActive = Date.now();
    if (!tab.view) this.wake(tab);
    this.attach(tab);
    if (tab.url !== NEW_TAB) tab.view.webContents.focus();
    if (this.findOpen) this.ui.webContents.send('find-close');
    this.findOpen = false;
    this.sendState();
  }

  wake(tab) {
    this.createView(tab);
    const wc = tab.view.webContents;
    const entries = (tab.history?.entries || []).filter(e => /^(https?|graphium|file):/.test(e.url));
    if (entries.length) {
      const index = Math.min(Math.max(tab.history.index, 0), entries.length - 1);
      wc.navigationHistory.restore({ entries, index }).catch(() => wc.loadURL(tab.url).catch(() => {}));
    } else {
      wc.loadURL(tab.url).catch(() => {});
    }
    tab.history = null;
  }

  historyOf(tab) {
    if (!tab.view || tab.view.webContents.isDestroyed()) return tab.history;
    const nav = tab.view.webContents.navigationHistory;
    let entries = nav.getAllEntries().map(e => ({ url: e.url, title: e.title }));
    let index = nav.getActiveIndex();
    if (entries.length > MAX_HISTORY) {
      const cut = entries.length - MAX_HISTORY;
      entries = entries.slice(cut);
      index = Math.max(0, index - cut);
    }
    return { entries, index };
  }

  dropView(tab) {
    const view = tab.view;
    if (!view) return;
    tab.view = null;
    this.win.contentView.removeChildView(view);
    const wc = view.webContents;
    if (wc && !wc.isDestroyed()) {
      tabsByWc.delete(wc.id);
      wc.close();
    }
  }

  sleep(tab) {
    if (!tab.view || tab.id === this.activeId || this.inSplit(tab)) return;
    tab.history = this.historyOf(tab);
    tab.loading = false;
    this.dropView(tab);
    this.sendState();
  }

  closeTab(id) {
    const index = this.tabs.findIndex(t => t.id === id);
    if (index < 0) return;
    const tab = this.tabs[index];
    if (this.inSplit(tab)) this.split = null;
    if (!this.isPrivate && tab.url !== NEW_TAB) {
      this.closedTabs.push({ url: tab.url, title: tab.title, history: this.historyOf(tab), index });
      if (this.closedTabs.length > MAX_CLOSED) this.closedTabs.shift();
    }
    this.tabs.splice(index, 1);
    this.dropView(tab);
    if (!this.tabs.length) {
      this.win.close();
      return;
    }
    if (this.activeId === id) this.activate(this.tabs[Math.min(index, this.tabs.length - 1)].id);
    else this.sendState();
    scheduleSessionSave();
  }

  reopenClosed() {
    const saved = this.closedTabs.pop();
    if (!saved) return;
    const tab = this.makeTab(saved.url);
    tab.title = saved.title;
    tab.history = saved.history;
    this.tabs.splice(Math.min(saved.index, this.tabs.length), 0, tab);
    this.activate(tab.id);
  }

  moveTab(id, to) {
    const from = this.tabs.findIndex(t => t.id === id);
    if (from < 0 || !Number.isInteger(to)) return;
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(Math.max(0, Math.min(to, this.tabs.length)), 0, tab);
    this.sendState();
    scheduleSessionSave();
  }

  cycle(step) {
    const index = this.tabs.findIndex(t => t.id === this.activeId);
    const next = (index + step + this.tabs.length) % this.tabs.length;
    this.activate(this.tabs[next].id);
  }

  navigate(text) {
    const url = toUrl(text);
    const wc = this.activeWc();
    if (!url || !wc) return;
    wc.loadURL(url).catch(() => {});
    wc.focus();
  }

  reload(hard = false) {
    const tab = this.active();
    const wc = this.activeWc();
    if (!wc) return;
    if (tab.url.startsWith('graphium://error/')) {
      const original = displayUrl(tab.url);
      if (original) wc.loadURL(original).catch(() => {});
      return;
    }
    if (hard) wc.reloadIgnoringCache();
    else wc.reload();
  }

  zoom(step) {
    const wc = this.activeWc();
    if (!wc) return;
    if (step === 0) {
      wc.setZoomFactor(1);
    } else {
      const current = wc.getZoomFactor();
      const next = step > 0 ? ZOOM_STEPS.find(z => z > current + 0.001) : [...ZOOM_STEPS].reverse().find(z => z < current - 0.001);
      if (next) wc.setZoomFactor(next);
    }
    this.sendState();
  }

  toggleShields() {
    const tab = this.active();
    const host = hostOf(tab?.url);
    if (!host || isInternalUrl(tab.url)) return;
    const list = settings.get('allowlist').slice();
    const at = list.indexOf(host);
    if (at >= 0) list.splice(at, 1);
    else list.push(host);
    settings.setTrusted('allowlist', list);
    this.reload();
    broadcastState();
  }

  toggleBookmark() {
    const tab = this.active();
    if (!tab || !/^https?:/.test(tab.url)) return;
    const list = settings.get('shortcuts');
    if (list.some(s => s.url === tab.url)) {
      settings.setTrusted('shortcuts', list.filter(s => s.url !== tab.url));
    } else if (list.length < 48) {
      settings.setTrusted('shortcuts', [...list, { title: (tab.title || hostOf(tab.url)).slice(0, 80), url: tab.url }]);
    }
    broadcastSettings();
  }

  focusAddress() {
    this.ui.webContents.focus();
    this.ui.webContents.send('focus-address');
  }

  openFind() {
    this.findOpen = true;
    this.ui.webContents.focus();
    this.ui.webContents.send('find-open');
  }

  layout() {
    if (this.win.isDestroyed()) return;
    const { width, height } = this.win.getContentBounds();
    const top = this.htmlFullscreen ? 0 : this.uiHeight;
    this.ui.setVisible(!this.htmlFullscreen);
    this.ui.setBounds({ x: 0, y: 0, width, height: this.paletteOpen ? height : top });
    const tab = this.active();
    const h = Math.max(0, height - top);
    const shown = this.htmlFullscreen || !tab ? [tab] : this.shownTabs(tab);
    if (shown.length === 2 && shown.every(t => t && t.view)) {
      const GAP = 2;
      const left = Math.round((width - GAP) * this.split.ratio);
      shown[0].view.setBounds({ x: 0, y: top, width: left, height: h });
      shown[1].view.setBounds({ x: left + GAP, y: top, width: Math.max(0, width - left - GAP), height: h });
    } else if (tab && tab.view) {
      tab.view.setBounds({ x: 0, y: top, width, height: h });
    }
  }

  buildState() {
    const tab = this.active();
    const wc = this.activeWc();
    const url = tab ? tab.url : '';
    let zoom = 100;
    let canBack = false;
    let canForward = false;
    if (wc) {
      zoom = Math.round(wc.getZoomFactor() * 100);
      canBack = wc.navigationHistory.canGoBack();
      canForward = wc.navigationHistory.canGoForward();
    }
    const active = downloads.filter(d => d.state === 'progressing');
    const received = active.reduce((n, d) => n + d.received, 0);
    const total = active.reduce((n, d) => n + d.total, 0);
    return {
      private: this.isPrivate,
      tabs: this.tabs.map(t => ({
        id: t.id,
        title: t.title || fallbackTitle(t.url),
        favicon: t.favicon,
        loading: t.loading,
        active: t.id === this.activeId,
        sleeping: !t.view,
        split: this.inSplit(t),
      })),
      split: !!this.split,
      nav: {
        url: displayUrl(url),
        internal: isInternalUrl(url) && !url.startsWith('graphium://error/'),
        error: url.startsWith('graphium://error/'),
        insecure: url.startsWith('http://'),
        canBack,
        canForward,
        loading: !!tab?.loading,
        blocked: tab ? tab.blocked : 0,
        bookmarked: !!tab && settings.get('shortcuts').some(s => s.url === tab.url),
        popup: tab ? tab.blockedPopup : '',
        shields: settings.get('shields') ? shieldsOnFor(url) : null,
        zoom,
      },
      downloads: { count: downloads.length, active: active.length, progress: total > 0 ? received / total : -1 },
      ui: {
        accent: settings.get('accent'),
        density: settings.get('density'),
        showHomeButton: settings.get('showHomeButton'),
        customCss: settings.get('customCss'),
        searchName:
          settings.get('searchEngine') === 'custom'
            ? 'the web'
            : (settings.SEARCH_ENGINES[settings.get('searchEngine')] || settings.SEARCH_ENGINES.google).name,
      },
    };
  }

  sendState(now = false) {
    const send = () => {
      this.statePending = false;
      if (this.win.isDestroyed() || this.ui.webContents.isDestroyed()) return;
      this.ui.webContents.send('state', this.buildState());
      const tab = this.active();
      const title = tab ? tab.title || fallbackTitle(tab.url) : 'Graphium';
      this.win.setTitle(`${title} - Graphium${this.isPrivate ? ' (Private)' : ''}`);
    };
    if (now) return send();
    if (this.statePending) return;
    this.statePending = true;
    setImmediate(send);
  }

  pageMenu(tab, p) {
    const wc = tab.view.webContents;
    const index = this.tabs.indexOf(tab) + 1;
    const items = [];
    const sep = { type: 'separator' };
    if (p.linkURL && /^(https?|file):/.test(p.linkURL)) {
      items.push(
        { label: 'Open link in new tab', click: () => this.addTab({ url: p.linkURL, background: true, index }) },
        { label: 'Open link in private window', click: () => new BrowserWin({ isPrivate: true, urls: [p.linkURL] }) },
        { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
        sep,
      );
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push(
        { label: 'Open image in new tab', click: () => this.addTab({ url: p.srcURL, background: true, index }) },
        { label: 'Save image as...', click: () => wc.downloadURL(p.srcURL) },
        { label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) },
        { label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) },
        sep,
      );
    }
    if (p.isEditable) {
      const f = p.editFlags;
      items.push(
        { label: 'Undo', enabled: f.canUndo, click: () => wc.undo() },
        { label: 'Redo', enabled: f.canRedo, click: () => wc.redo() },
        sep,
        { label: 'Cut', enabled: f.canCut, click: () => wc.cut() },
        { label: 'Copy', enabled: f.canCopy, click: () => wc.copy() },
        { label: 'Paste', enabled: f.canPaste, click: () => wc.paste() },
        { label: 'Paste as plain text', enabled: f.canPaste, click: () => wc.pasteAndMatchStyle() },
        { label: 'Select all', enabled: f.canSelectAll, click: () => wc.selectAll() },
        sep,
      );
    } else if (p.selectionText && p.selectionText.trim()) {
      const text = p.selectionText.trim();
      const short = text.length > 24 ? text.slice(0, 24) + '...' : text;
      items.push(
        { label: 'Copy', click: () => wc.copy() },
        { label: `Search for "${short}"`, click: () => this.addTab({ url: settings.searchUrl(text), index }) },
        sep,
      );
    }
    if (!items.length) {
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => this.reload() },
        sep,
        { label: 'Print...', click: () => wc.print() },
        sep,
      );
    }
    items.push({ label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  tabMenu(id, x, y) {
    const tab = this.get(id);
    if (!tab) return;
    const index = this.tabs.indexOf(tab);
    Menu.buildFromTemplate([
      { label: 'New tab', click: () => this.addTab({ index: index + 1 }) },
      { type: 'separator' },
      { label: 'Reload', click: () => (tab.view ? tab.view.webContents.reload() : this.activate(id)) },
      { label: 'Duplicate', click: () => this.addTab({ url: tab.url, index: index + 1 }) },
      this.inSplit(tab)
        ? { label: 'Exit split view', click: () => this.unsplit() }
        : { label: 'Open in split view', enabled: this.tabs.length > 1 || id !== this.activeId, click: () => (id === this.activeId ? this.splitWith() : this.splitWith(id)) },
      { type: 'separator' },
      { label: 'Close tab', click: () => this.closeTab(id) },
      {
        label: 'Close other tabs',
        enabled: this.tabs.length > 1,
        click: () => this.tabs.filter(t => t.id !== id).forEach(t => this.closeTab(t.id)),
      },
      {
        label: 'Close tabs to the right',
        enabled: index < this.tabs.length - 1,
        click: () => this.tabs.slice(index + 1).forEach(t => this.closeTab(t.id)),
      },
      { label: 'Reopen closed tab', enabled: this.closedTabs.length > 0, click: () => this.reopenClosed() },
    ]).popup({ window: this.win, x, y });
  }

  mainMenu(x, y) {
    const mod = IS_MAC ? 'Cmd' : 'Ctrl';
    const wc = this.activeWc();
    const tab = this.active();
    const zoom = wc ? Math.round(wc.getZoomFactor() * 100) : 100;
    const show = accelerator => ({ accelerator, registerAccelerator: false });
    const canBookmark = !!tab && /^https?:/.test(tab.url);
    const bookmarked = canBookmark && settings.get('shortcuts').some(s => s.url === tab.url);
    Menu.buildFromTemplate([
      { label: 'New tab', ...show(`${mod}+T`), click: () => this.addTab() },
      { label: 'New window', ...show(`${mod}+N`), click: () => new BrowserWin() },
      { label: 'New private window', ...show(`${mod}+Shift+N`), click: () => new BrowserWin({ isPrivate: true }) },
      { type: 'separator' },
      { label: 'Command palette', ...show(`${mod}+K`), click: () => this.openPalette() },
      this.split
        ? { label: 'Exit split view', ...show(`${mod}+Shift+S`), click: () => this.unsplit() }
        : { label: 'Split view', ...show(`${mod}+Shift+S`), click: () => this.splitWith() },
      { type: 'separator' },
      { label: 'History', ...show(`${mod}+H`), click: () => openInternal(this, 'history') },
      { label: 'Downloads', ...show(`${mod}+J`), click: () => this.downloadsMenu() },
      {
        label: bookmarked ? 'Remove from new tab page' : 'Add to new tab page',
        ...show(`${mod}+D`),
        enabled: canBookmark,
        click: () => this.toggleBookmark(),
      },
      { label: 'Reopen closed tab', ...show(`${mod}+Shift+T`), enabled: this.closedTabs.length > 0, click: () => this.reopenClosed() },
      { type: 'separator' },
      {
        label: `Zoom (${zoom}%)`,
        submenu: [
          { label: 'Zoom in', ...show(`${mod}+=`), click: () => this.zoom(1) },
          { label: 'Zoom out', ...show(`${mod}+-`), click: () => this.zoom(-1) },
          { label: 'Actual size', ...show(`${mod}+0`), click: () => this.zoom(0) },
        ],
      },
      { label: 'Find in page', ...show(`${mod}+F`), click: () => this.openFind() },
      { label: 'Print', ...show(`${mod}+P`), enabled: !!wc, click: () => wc && wc.print() },
      { type: 'separator' },
      { label: 'Settings', click: () => openInternal(this, 'settings') },
      { label: 'Developer tools', ...show('F12'), enabled: !!wc, click: () => wc && wc.toggleDevTools() },
      { type: 'separator' },
      { label: 'Quit', ...show(IS_MAC ? 'Cmd+Q' : 'Ctrl+Shift+Q'), click: () => app.quit() },
    ]).popup({ window: this.win, x, y });
  }

  downloadsMenu(x, y) {
    if (!downloads.length) {
      shell.openPath(settings.get('downloadDir') || app.getPath('downloads'));
      return;
    }
    const items = downloads.map(d => {
      let status = 'Done';
      if (d.state === 'progressing') status = d.total > 0 ? `${Math.floor((d.received / d.total) * 100)}%` : 'Downloading';
      else if (d.state === 'cancelled') status = 'Cancelled';
      else if (d.state === 'interrupted') status = 'Failed';
      const label = `${d.name.length > 48 ? d.name.slice(0, 45) + '...' : d.name}   ${status}`;
      if (d.state === 'progressing') return { label, submenu: [{ label: 'Cancel', click: () => d.item && d.item.cancel() }] };
      if (d.state === 'completed') {
        return {
          label,
          submenu: [
            { label: 'Open', click: () => shell.openPath(d.file) },
            { label: 'Show in folder', click: () => shell.showItemInFolder(d.file) },
          ],
        };
      }
      return { label, enabled: false };
    });
    items.push(
      { type: 'separator' },
      { label: 'Open downloads folder', click: () => shell.openPath(settings.get('downloadDir') || app.getPath('downloads')) },
      {
        label: 'Clear list',
        click: () => {
          for (let i = downloads.length - 1; i >= 0; i--) if (downloads[i].state !== 'progressing') downloads.splice(i, 1);
          broadcastState();
        },
      },
    );
    Menu.buildFromTemplate(items).popup({ window: this.win, x, y });
  }

  // ------------------------------------------------------------ command palette

  openPalette(mode = 'all') {
    if (this.htmlFullscreen) return;
    this.paletteOpen = true;
    // The toolbar view grows over the page with a see-through background, so the page stays visible behind.
    this.ui.setBackgroundColor('#00000000');
    this.win.contentView.addChildView(this.ui);
    this.layout();
    this.ui.webContents.focus();
    this.ui.webContents.send('palette-open', this.paletteData(), mode);
  }

  closePalette() {
    if (!this.paletteOpen) return;
    this.paletteOpen = false;
    this.win.contentView.addChildView(this.ui, 0);
    this.ui.setBackgroundColor(themeBackground());
    this.layout();
    this.activeWc()?.focus();
  }

  paletteData() {
    const tab = this.active();
    return {
      private: this.isPrivate,
      split: !!this.split,
      tabs: this.tabs.map(t => ({
        id: t.id,
        title: t.title || fallbackTitle(t.url),
        url: displayUrl(t.url),
        favicon: t.favicon,
        active: t.id === this.activeId,
        sleeping: !t.view,
        split: this.inSplit(t),
        audible: !!t.view && !t.view.webContents.isDestroyed() && t.view.webContents.isCurrentlyAudible(),
        muted: !!t.view && !t.view.webContents.isDestroyed() && t.view.webContents.isAudioMuted(),
      })),
      closed: this.closedTabs
        .slice(-8)
        .reverse()
        .map((c, i) => ({ i, title: c.title || fallbackTitle(c.url), url: displayUrl(c.url) })),
      bookmarks: settings.get('shortcuts').map(b => ({ title: b.title || fallbackTitle(b.url), url: b.url })),
      page: tab ? { url: tab.url, title: tab.title, web: /^https?:/.test(tab.url) } : null,
      theme: settings.get('theme'),
      mod: IS_MAC ? 'Cmd' : 'Ctrl',
    };
  }

  /** Memory per tab, from the OS process each page runs in. Tabs on one site share a process. */
  memoryReport() {
    const byPid = new Map(app.getAppMetrics().map(m => [m.pid, m.memory.workingSetSize * 1024]));
    const rows = this.tabs.map(t => {
      const wc = t.view && !t.view.webContents.isDestroyed() ? t.view.webContents : null;
      const pid = wc ? wc.getOSProcessId() : 0;
      return { id: t.id, title: t.title || fallbackTitle(t.url), pid, bytes: pid ? byPid.get(pid) || 0 : 0, sleeping: !wc, active: t.id === this.activeId };
    });
    // Split a shared process's memory evenly across its tabs, so the total adds up.
    const share = new Map();
    for (const r of rows) if (r.pid) share.set(r.pid, (share.get(r.pid) || 0) + 1);
    for (const r of rows) if (r.pid) r.bytes = r.bytes / share.get(r.pid);
    const total = app.getAppMetrics().reduce((n, m) => n + m.memory.workingSetSize * 1024, 0);
    return { rows: rows.sort((a, b) => b.bytes - a.bytes), total };
  }

  runCommand(cmd, arg) {
    const tab = this.active();
    const wc = this.activeWc();
    const id = Number(arg);
    switch (cmd) {
      case 'go': return typeof arg === 'string' && this.navigate(arg.slice(0, 8000));
      case 'open-tab-url': return typeof arg === 'string' && /^(https?|graphium):/.test(arg) && this.addTab({ url: arg });
      case 'tab': return this.get(id) && this.activate(id);
      case 'close-tab': return this.get(id) && this.closeTab(id);
      case 'reopen': {
        // arg is how far back in the closed list, newest first.
        const n = Math.max(0, Math.min(Number(arg) || 0, this.closedTabs.length - 1));
        const [saved] = this.closedTabs.splice(this.closedTabs.length - 1 - n, 1);
        if (saved) {
          this.closedTabs.push(saved);
          this.reopenClosed();
        }
        return;
      }
      case 'new-tab': return this.addTab();
      case 'new-window': return new BrowserWin();
      case 'private-window': return new BrowserWin({ isPrivate: true });
      case 'split': return this.splitWith(Number.isFinite(id) && arg !== undefined ? id : null);
      case 'unsplit': return this.unsplit();
      case 'swap-split': return this.swapSplit();
      case 'split-wider': return this.resizeSplit(0.1);
      case 'split-narrower': return this.resizeSplit(-0.1);
      case 'sleep-tab': {
        const t = this.get(id);
        return t && this.sleep(t);
      }
      case 'sleep-others':
        for (const t of this.tabs) {
          const twc = t.view && !t.view.webContents.isDestroyed() ? t.view.webContents : null;
          if (twc && !twc.isCurrentlyAudible()) this.sleep(t);
        }
        return;
      case 'mute': return wc && wc.setAudioMuted(!wc.isAudioMuted());
      case 'mute-others':
        for (const t of this.tabs) if (t.view && t.id !== this.activeId && !t.view.webContents.isDestroyed()) t.view.webContents.setAudioMuted(true);
        return;
      case 'pip':
        // A user gesture lets the page enter picture-in-picture: the biggest video that is playing, else the biggest.
        return (
          wc &&
          wc
            .executeJavaScript(
              `(() => { const v = [...document.querySelectorAll('video')].sort((a, b) => a.paused - b.paused || b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
                if (!v) return false; if (document.pictureInPictureElement) { document.exitPictureInPicture(); return true; }
                v.requestPictureInPicture().catch(() => {}); return true; })()`,
              true,
            )
            .catch(() => false)
        );
      case 'copy': return typeof arg === 'string' && clipboard.writeText(arg.slice(0, 1000));
      case 'copy-url': return tab && clipboard.writeText(tab.url);
      case 'copy-md': return tab && clipboard.writeText(`[${(tab.title || fallbackTitle(tab.url)).replace(/[[\]]/g, '')}](${tab.url})`);
      case 'duplicate': return tab && this.addTab({ url: tab.url, index: this.tabs.indexOf(tab) + 1 });
      case 'close-others': return this.tabs.filter(t => t.id !== this.activeId).forEach(t => this.closeTab(t.id));
      case 'close-right': {
        const i = this.tabs.indexOf(tab);
        return this.tabs.slice(i + 1).forEach(t => this.closeTab(t.id));
      }
      case 'shields': return this.toggleShields();
      case 'bookmark': return this.toggleBookmark();
      case 'zoom-in': return this.zoom(1);
      case 'zoom-out': return this.zoom(-1);
      case 'zoom-reset': return this.zoom(0);
      case 'find': return setImmediate(() => this.openFind());
      case 'print': return wc && wc.print();
      case 'reload-hard': return this.reload(true);
      case 'history': return openInternal(this, 'history');
      case 'settings': return openInternal(this, 'settings');
      case 'downloads': return setImmediate(() => this.downloadsMenu());
      case 'devtools': return wc && wc.toggleDevTools();
      case 'theme': {
        const next = { system: 'light', light: 'dark', dark: 'system' }[settings.get('theme')] || 'system';
        settings.setTrusted('theme', next);
        return broadcastSettings();
      }
      default:
    }
  }

  snapshot() {
    return {
      tabs: this.tabs.filter(t => t.url !== NEW_TAB || this.tabs.length === 1).map(t => ({ url: t.url, title: t.title, history: this.historyOf(t) })),
      active: Math.max(0, this.tabs.filter(t => t.url !== NEW_TAB || this.tabs.length === 1).findIndex(t => t.id === this.activeId)),
    };
  }

  destroy() {
    this.closing = true;
    for (const tab of this.tabs) {
      const wc = tab.view && tab.view.webContents;
      if (wc && !wc.isDestroyed()) {
        tabsByWc.delete(wc.id);
        wc.close();
      }
    }
    if (!this.ui.webContents.isDestroyed()) this.ui.webContents.close();
    wins.delete(this);
    if (lastFocused === this) lastFocused = [...wins].pop() || null;
    if (this.isPrivate) {
      this.ses.clearStorageData().catch(() => {});
      this.ses.clearCache().catch(() => {});
    } else if (!quitting && [...wins].some(w => !w.isPrivate)) {
      saveSessionNow();
    }
  }
}

// ---------------------------------------------------------------- shortcuts

function handleShortcut(w, input) {
  if (input.type !== 'keyDown') return false;
  const mod = IS_MAC ? input.meta : input.control;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  const wc = w.activeWc();

  if (mod && !input.alt) {
    if (key === '=' || key === '+') return w.zoom(1), true;
    if (key === '-' || key === '_') return w.zoom(-1), true;
    if (key === '0' && !input.shift) return w.zoom(0), true;
    if (input.shift) {
      switch (key) {
        case 't': return w.reopenClosed(), true;
        case 'n': return new BrowserWin({ isPrivate: true }), true;
        case 'r': return w.reload(true), true;
        case 'i': return wc && wc.toggleDevTools(), true;
        case 'a': return w.openPalette('tabs'), true;
        case 's': return w.split ? w.unsplit() : w.splitWith(), true;
        case 'Tab': return w.cycle(-1), true;
        case 'q': return !IS_MAC && (app.quit(), true);
        default: return false;
      }
    }
    if (/^[1-9]$/.test(key)) {
      const n = Number(key);
      const tab = n === 9 ? w.tabs[w.tabs.length - 1] : w.tabs[n - 1];
      if (tab) w.activate(tab.id);
      return true;
    }
    switch (key) {
      case 't': return w.addTab(), true;
      case 'k': return w.openPalette(), true;
      case 'w': return w.closeTab(w.activeId), true;
      case 'n': return new BrowserWin(), true;
      case 'l': return w.focusAddress(), true;
      case 'r': return w.reload(), true;
      case 'f': return w.openFind(), true;
      case 'g': return w.ui.webContents.send('find-next', true), true;
      case 'd': return w.toggleBookmark(), true;
      case 'h': return openInternal(w, 'history'), true;
      case 'j': return w.downloadsMenu(), true;
      case 'p': return wc && wc.print(), true;
      case 'Tab':
      case 'PageDown': return w.cycle(1), true;
      case 'PageUp': return w.cycle(-1), true;
      case '[': return wc && wc.navigationHistory.goBack(), true;
      case ']': return wc && wc.navigationHistory.goForward(), true;
      case ',': return openInternal(w, 'settings'), true;
      default: return false;
    }
  }
  if (input.alt && !mod && !input.shift) {
    if (key === 'ArrowLeft') return wc && wc.navigationHistory.goBack(), true;
    if (key === 'ArrowRight') return wc && wc.navigationHistory.goForward(), true;
    if (key === 'Home') return wc && wc.loadURL(settings.get('homepage') || NEW_TAB).catch(() => {}), true;
    if (key === 'd') return w.focusAddress(), true;
    return false;
  }
  if (!mod && !input.alt) {
    switch (key) {
      case 'F5': return w.reload(input.shift), true;
      case 'F6': return w.focusAddress(), true;
      case 'F11': return w.win.setFullScreen(!w.win.isFullScreen()), true;
      case 'F12': return wc && wc.toggleDevTools(), true;
      case 'F3': return w.ui.webContents.send('find-next', !input.shift), true;
      case 'BrowserBack': return wc && wc.navigationHistory.goBack(), true;
      case 'BrowserForward': return wc && wc.navigationHistory.goForward(), true;
      default: return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------- ui ipc

function winForUi(sender) {
  for (const w of wins) if (w.ui.webContents === sender) return w;
  return null;
}

function onUi(channel, handler) {
  ipcMain.on('ui:' + channel, (event, ...args) => {
    const w = winForUi(event.sender);
    if (w) handler(w, ...args);
  });
}

const num = v => (Number.isFinite(v) ? Math.round(v) : 0);

onUi('navigate', (w, text) => typeof text === 'string' && w.navigate(text.slice(0, 8000)));
onUi('tab-new', w => w.addTab());
onUi('tab-close', (w, id) => w.closeTab(id));
onUi('tab-activate', (w, id) => w.activate(id));
onUi('tab-move', (w, id, to) => w.moveTab(id, to));
onUi('tab-menu', (w, id, x, y) => w.tabMenu(id, num(x), num(y)));
onUi('back', w => w.activeWc()?.navigationHistory.goBack());
onUi('forward', w => w.activeWc()?.navigationHistory.goForward());
onUi('reload', (w, hard) => w.reload(!!hard));
onUi('stop', w => w.activeWc()?.stop());
onUi('home', w => w.activeWc()?.loadURL(settings.get('homepage') || NEW_TAB).catch(() => {}));
onUi('shields', w => w.toggleShields());
onUi('zoom-reset', w => w.zoom(0));
onUi('open-popup', w => {
  const tab = w.active();
  if (!tab || !tab.blockedPopup) return;
  const url = tab.blockedPopup;
  tab.blockedPopup = '';
  w.addTab({ url, index: w.tabs.indexOf(tab) + 1 });
});
onUi('menu', (w, x, y) => w.mainMenu(num(x), num(y)));
onUi('downloads', (w, x, y) => w.downloadsMenu(num(x), num(y)));
onUi('focus-page', w => w.activeWc()?.focus());
onUi('ui-height', (w, h) => {
  const height = num(h);
  if (height > 20 && height < 400 && height !== w.uiHeight) {
    w.uiHeight = height;
    w.layout();
  }
});
onUi('find', (w, text, forward, fresh) => {
  const wc = w.activeWc();
  if (!wc || typeof text !== 'string') return;
  if (!text) return wc.stopFindInPage('clearSelection');
  wc.findInPage(text.slice(0, 500), { forward: forward !== false, findNext: !!fresh });
});
ipcMain.handle('ui:complete', (event, text) => {
  const w = winForUi(event.sender);
  if (!w || w.isPrivate || typeof text !== 'string') return '';
  return history.complete(text.slice(0, 500));
});
onUi('bookmark', w => w.toggleBookmark());
onUi('palette-close', w => w.closePalette());
onUi('palette-run', (w, cmd, arg) => {
  if (typeof cmd !== 'string') return;
  // Sleeping a tab from the memory list keeps the palette open so the numbers can update.
  if (cmd !== 'sleep-tab') w.closePalette();
  w.runCommand(cmd, typeof arg === 'string' || typeof arg === 'number' ? arg : undefined);
});
ipcMain.handle('ui:palette-search', (event, text) => {
  const w = winForUi(event.sender);
  if (!w || w.isPrivate || typeof text !== 'string' || !text.trim()) return [];
  return history.list(text.slice(0, 200), 8).map(e => ({ title: e.title || fallbackTitle(e.url), url: e.url }));
});
ipcMain.handle('ui:palette-memory', event => {
  const w = winForUi(event.sender);
  return w ? w.memoryReport() : null;
});

onUi('find-close', w => {
  w.findOpen = false;
  const wc = w.activeWc();
  if (wc) {
    wc.stopFindInPage('keepSelection');
    wc.focus();
  }
});

// ---------------------------------------------------------------- internal page ipc

function internalPage(event) {
  const frame = event.senderFrame;
  if (!frame || frame.parent || !isInternalUrl(frame.url)) return null;
  return new URL(frame.url).hostname;
}

function publicSettings() {
  const s = settings.get();
  return {
    ...s,
    engines: Object.fromEntries(Object.entries(settings.SEARCH_ENGINES).map(([k, v]) => [k, v.name])),
  };
}

function broadcastSettings() {
  nativeTheme.themeSource = settings.get('theme');
  const data = publicSettings();
  for (const { tab } of tabsByWc.values()) {
    if (tab.view && isInternalUrl(tab.view.webContents.getURL())) tab.view.webContents.send('settings-changed', data);
  }
  broadcastState();
}

function broadcastState() {
  for (const w of wins) w.sendState();
}

function openInternal(w, page) {
  const existing = w.tabs.find(t => t.url.startsWith(`graphium://${page}`));
  if (existing) w.activate(existing.id);
  else w.addTab({ url: `graphium://${page}/`, index: w.tabs.indexOf(w.active()) + 1 });
}

ipcMain.handle('page:get-settings', event => (internalPage(event) ? publicSettings() : null));

ipcMain.handle('page:set', (event, key, value) => {
  const page = internalPage(event);
  if (page !== 'settings' && !(page === 'newtab' && key === 'shortcuts')) return false;
  const ok = settings.setFromPage(key, value);
  if (ok) broadcastSettings();
  return ok;
});

ipcMain.handle('page:action', async (event, name, arg) => {
  const page = internalPage(event);
  if (!page) return null;
  const entry = tabsByWc.get(event.sender.id);
  const parent = entry ? entry.win.win : undefined;
  const ses = entry ? entry.win.ses : session.fromPartition('persist:graphium');

  if (name === 'open-settings') return entry && openInternal(entry.win, 'settings');
  if (name === 'navigate' && page === 'newtab' && typeof arg === 'string') {
    const url = toUrl(arg.slice(0, 8000));
    if (url) event.sender.loadURL(url).catch(() => {});
    return true;
  }
  if (page === 'error' && name === 'allow-certificate') {
    let url;
    try {
      url = new URL(String(arg));
    } catch {
      return false;
    }
    if (url.protocol !== 'https:') return false;
    certAllowed.add(url.hostname);
    event.sender.loadURL(url.href).catch(() => {});
    return true;
  }
  if (page === 'history') {
    if (name === 'history-list') return history.list(typeof arg === 'string' ? arg.slice(0, 200) : '');
    if (name === 'history-remove') return history.remove(String(arg)), true;
    if (name === 'history-clear') return history.clear(), true;
    if (name === 'open' && /^https?:/.test(String(arg)) && entry) {
      entry.win.addTab({ url: String(arg), index: entry.win.tabs.indexOf(entry.tab) + 1 });
      return true;
    }
    return null;
  }
  if (page !== 'settings') return null;

  switch (name) {
    case 'pick-download-dir': {
      const res = await dialog.showOpenDialog(parent, { properties: ['openDirectory', 'createDirectory'] });
      if (!res.canceled && res.filePaths[0]) {
        settings.setTrusted('downloadDir', res.filePaths[0]);
        broadcastSettings();
      }
      return settings.get('downloadDir');
    }
    case 'reset-download-dir':
      settings.setTrusted('downloadDir', '');
      broadcastSettings();
      return '';
    case 'clear-data': {
      const main = session.fromPartition('persist:graphium');
      await main.clearStorageData();
      await main.clearCache();
      await main.clearAuthCache();
      history.clear();
      for (const w of wins) w.closedTabs.length = 0;
      return true;
    }
    case 'reset-permissions':
      settings.setTrusted('sitePermissions', {});
      broadcastSettings();
      return true;
    case 'reset-settings':
      settings.reset();
      broadcastSettings();
      return true;
    case 'make-default':
      return app.setAsDefaultProtocolClient('http') && app.setAsDefaultProtocolClient('https');
    case 'is-default':
      return app.isDefaultProtocolClient('https');
    case 'about':
      return { version: app.getVersion(), chromium: process.versions.chrome, electron: process.versions.electron, lists: !!blocker };
    case 'update-lists': {
      try {
        fs.unlinkSync(path.join(app.getPath('userData'), 'adblock-engine.bin'));
      } catch {
        // Nothing cached yet.
      }
      await initBlocker();
      return !!blocker;
    }
    default:
      return null;
  }
});

// ---------------------------------------------------------------- session restore

function sessionFile() {
  return path.join(app.getPath('userData'), 'session.json');
}

function saveSessionNow() {
  clearTimeout(sessionSaveTimer);
  if (settings.get('clearOnExit') || !settings.get('restoreTabs')) {
    fs.rmSync(sessionFile(), { force: true });
    return;
  }
  const windows = [...wins].filter(w => !w.isPrivate && w.tabs.length).map(w => w.snapshot());
  if (!windows.length) return;
  try {
    fs.writeFileSync(sessionFile() + '.tmp', JSON.stringify({ windows }));
    fs.renameSync(sessionFile() + '.tmp', sessionFile());
  } catch (err) {
    console.warn('Could not save session:', err.message);
  }
}

function scheduleSessionSave() {
  if (quitting || !settings.get('restoreTabs')) return;
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveSessionNow, 2000);
}

function readSession() {
  try {
    const data = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
    return Array.isArray(data.windows) ? data.windows.filter(w => Array.isArray(w.tabs) && w.tabs.length) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- tab sleeping

function sleepIdleTabs() {
  const minutes = settings.get('sleepTabsMinutes');
  const lowMemory = os.freemem() / os.totalmem() < 0.1;
  if (!minutes && !lowMemory) return;
  // When the computer is short on memory, every background tab sleeps.
  const cutoff = lowMemory ? Date.now() : Date.now() - minutes * 60 * 1000;
  for (const w of wins) {
    const openers = new Set(w.tabs.filter(t => t.view && t.openerId).map(t => t.openerId));
    for (const tab of w.tabs) {
      if (!tab.view || tab.id === w.activeId || tab.lastActive > cutoff || openers.has(tab.id)) continue;
      const wc = tab.view.webContents;
      if (wc.isDestroyed() || wc.isCurrentlyAudible() || wc.isLoading() || wc.isDevToolsOpened()) continue;
      w.sleep(tab);
    }
  }
}

// ---------------------------------------------------------------- app lifecycle

function openUrls(urls) {
  const target = lastFocused && !lastFocused.isPrivate ? lastFocused : [...wins].find(w => !w.isPrivate);
  if (!target) return new BrowserWin({ urls });
  urls.forEach((url, i) => target.addTab({ url, background: i > 0 }));
  if (target.win.isMinimized()) target.win.restore();
  target.win.focus();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const urls = urlsFromArgv(argv);
    if (urls.length) openUrls(urls);
    else if (lastFocused) lastFocused.win.focus();
    else new BrowserWin();
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (app.isReady()) openUrls([url]);
    else app.once('ready', () => setImmediate(() => openUrls([url])));
  });

  app.on('certificate-error', (event, _wc, url, _error, _cert, callback) => {
    if (certAllowed.has(hostOf(url))) {
      event.preventDefault();
      callback(true);
    } else {
      callback(false);
    }
  });

  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', event => event.preventDefault());
  });

  app.whenReady().then(() => {
    settings.load();
    history.load();
    nativeTheme.themeSource = settings.get('theme');
    nativeTheme.on('updated', broadcastState);

    Menu.setApplicationMenu(
      IS_MAC
        ? Menu.buildFromTemplate([
            { role: 'appMenu' },
            { role: 'editMenu' },
            { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
          ])
        : null,
    );

    const main = session.fromPartition('persist:graphium');
    setupSession(main);

    const urls = urlsFromArgv(process.argv);
    const restored = settings.get('restoreTabs') && !settings.get('clearOnExit') ? readSession() : [];
    if (restored.length) {
      restored.forEach(r => new BrowserWin({ restore: r }));
      if (urls.length) openUrls(urls);
    } else {
      new BrowserWin({ urls });
    }

    initBlocker();
    setInterval(sleepIdleTabs, 60 * 1000);
  });

  app.on('activate', () => {
    if (!wins.size) new BrowserWin();
  });

  app.on('window-all-closed', () => {
    if (!IS_MAC) app.quit();
  });

  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());

  app.on('before-quit', event => {
    if (!quitting) {
      quitting = true;
      saveSessionNow();
      settings.flush();
      if (settings.get('clearOnExit')) history.clear();
      else history.flush();
    }
    if (settings.get('clearOnExit') && !cleanedUp) {
      event.preventDefault();
      cleanedUp = true;
      const main = session.fromPartition('persist:graphium');
      Promise.allSettled([main.clearStorageData(), main.clearCache()]).finally(() => app.quit());
    }
  });
}

// Lets test/smoke.js look inside without changing behavior.
module.exports = { wins, sleepIdleTabs };
