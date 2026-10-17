'use strict';
// Boots the real browser with a throwaway profile, drives it through the
// toolbar, and saves a screenshot of each step.
// Run: npx electron test/smoke.js <output-dir>

const { app, BaseWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const out = path.resolve(process.argv[2] || 'smoke-shots');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'graphium-smoke-')));
const graphium = require('../src/main.js');

const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

function views() {
  const win = BaseWindow.getAllWindows()[0];
  const [ui, ...rest] = win.contentView.children;
  return { win, ui: ui.webContents, tab: rest.length ? rest[rest.length - 1].webContents : null };
}

async function shot(name) {
  try {
    await capture(name);
  } catch (err) {
    console.log(`(screenshot ${name} skipped: ${err.message})`);
  }
}

async function capture(name) {
  const { ui, tab } = views();
  const a = path.join(out, `${name}-ui.png`);
  fs.writeFileSync(a, (await ui.capturePage()).toPNG());
  if (tab) fs.writeFileSync(path.join(out, `${name}-tab.png`), (await tab.capturePage()).toPNG());
}

const inUi = js => views().ui.executeJavaScript(js);

async function go(text, settle = 4000) {
  await inUi(`(() => { const i = document.getElementById('url'); i.value = ${JSON.stringify(text)};
    document.getElementById('address').requestSubmit(); })()`);
  await wait(settle);
}

async function untilLoaded(timeout = 20000) {
  const start = Date.now();
  await wait(500);
  while (Date.now() - start < timeout) {
    const { tab } = views();
    if (tab && !tab.isLoading()) return;
    await wait(300);
  }
}

app.whenReady().then(async () => {
  await wait(3000);
  try {
    let { tab } = views();
    check('new tab page loads', tab && tab.getURL() === 'graphium://newtab/', tab && tab.getURL());
    const tiles = await tab.executeJavaScript('document.querySelectorAll(".tile:not(.add)").length');
    check('new tab shows shortcuts', tiles === 4, `${tiles} tiles`);
    await shot('01-newtab');

    await go('example.com');
    await untilLoaded();
    ({ tab } = views());
    check('typed domain opens over https', tab.getURL() === 'https://example.com/', tab.getURL());
    const addr = await inUi('document.getElementById("url").value');
    check('address bar shows url', addr === 'https://example.com/', addr);
    const title = await inUi('document.querySelector(".tab.active .title").textContent');
    check('tab title updates', /Example Domain/.test(title), title);
    await shot('02-example');

    await go('graphium browser test search');
    await untilLoaded();
    ({ tab } = views());
    // Google may answer automated runs with its /sorry rate-limit page; either way the search went to Google.
    check('plain words search Google', /^https:\/\/www\.google\.com\/(search\?q=graphium|sorry)/.test(tab.getURL()), tab.getURL().slice(0, 60));
    const ua = await tab.executeJavaScript('navigator.userAgent');
    check('user agent hides Electron', !/Electron|graphium/i.test(ua), ua);
    await shot('03-google');

    await go('http://http.badssl.com', 1000);
    await untilLoaded(25000);
    await wait(1500);
    ({ tab } = views());
    check('https upgrade falls back to http when needed', tab.getURL().startsWith('http://http.badssl.com'), tab.getURL());
    const insecure = await inUi('document.getElementById("site").textContent');
    check('http page marked not secure', insecure === 'Not secure', insecure);

    await go('https://doesnotexist.invalid', 1000);
    await untilLoaded();
    ({ tab } = views());
    const errTitle = await tab.executeJavaScript('document.getElementById("title")?.textContent');
    check('error page for unknown host', errTitle === "Can't find this site", `${tab.getURL().slice(0, 40)} ${errTitle}`);
    const errAddr = await inUi('document.getElementById("url").value');
    check('error page keeps the typed address', errAddr === 'https://doesnotexist.invalid/', errAddr);
    await shot('04-error');

    await go('https://www.theverge.com', 1000);
    await untilLoaded(30000);
    await wait(4000);
    const blocked = await inUi('document.getElementById("blocked").textContent');
    check('ads and trackers blocked', Number(blocked) > 0, `${blocked} blocked`);
    await shot('05-shields');

    await inUi('document.getElementById("new-tab").click()');
    await wait(1500);
    const count = await inUi('document.querySelectorAll(".tab").length');
    check('new tab button adds a tab', count === 2, `${count} tabs`);
    const focused = await inUi('document.activeElement.id');
    check('address bar focused on new tab', focused === 'url', focused);

    await go('graphium://settings', 2500);
    ({ tab } = views());
    const hasApi = await tab.executeJavaScript('typeof window.graphium');
    check('settings page gets its API', hasApi === 'object', hasApi);
    await tab.executeJavaScript(`(() => { const s = document.getElementById('theme'); s.value = 'dark'; s.dispatchEvent(new Event('change')); })()`);
    await wait(1200);
    const dark = await inUi('matchMedia("(prefers-color-scheme: dark)").matches');
    check('theme setting applies to toolbar', dark === true);
    await shot('06-settings-dark');

    await go('example.com');
    await untilLoaded();
    ({ tab } = views());
    const leaked = await tab.executeJavaScript('typeof window.graphium');
    check('web pages do not get the internal API', leaked === 'undefined', leaked);
    const blockedNav = await tab.executeJavaScript(`new Promise(r => { location.href = 'graphium://settings'; setTimeout(() => r(location.href), 1500); })`);
    check('web pages cannot open graphium:// pages', blockedNav.startsWith('https://example.com'), blockedNav);

    await inUi('document.querySelector(".tab").dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }))');
    await wait(800);
    const activeIdx = await inUi('[...document.querySelectorAll(".tab")].findIndex(t => t.classList.contains("active"))');
    check('clicking a tab switches to it', activeIdx === 0, String(activeIdx));

    // ---- pop-ups
    await go('example.com');
    await untilLoaded();
    ({ tab } = views());
    let before = await inUi('document.querySelectorAll(".tab").length');
    await tab.executeJavaScript(`window.open('https://example.org/'); 1`);
    await wait(1200);
    let after = await inUi('document.querySelectorAll(".tab").length');
    const chip = await inUi('!document.getElementById("popup").hidden');
    check('pop-up without a click is blocked', after === before && chip, `${before} -> ${after}, chip ${chip}`);
    tab.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 });
    tab.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 });
    await wait(200);
    await tab.executeJavaScript(`window.open('https://example.org/'); 1`, true);
    await wait(2500);
    after = await inUi('document.querySelectorAll(".tab").length');
    check('pop-up after a click opens a tab', after === before + 1, `${before} -> ${after}`);

    // A sign-in style pop-up keeps window.opener, and closing itself removes its tab.
    const opener = views().tab;
    opener.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 });
    opener.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 });
    await wait(200);
    await opener.executeJavaScript(`window.open('https://example.net/', 'login', 'width=500,height=600'); 1`, true);
    await wait(2500);
    ({ tab } = views());
    const hasOpener = await tab.executeJavaScript('!!window.opener');
    check('sign-in pop-up keeps window.opener', hasOpener === true, String(hasOpener));
    const withPopup = [...graphium.wins][0].tabs.length;
    await tab.executeJavaScript('window.close(); 1');
    await wait(1200);
    const afterClose = [...graphium.wins][0].tabs.length;
    check('window.close() removes the tab cleanly', afterClose === withPopup - 1, `${withPopup} -> ${afterClose}`);

    // ---- keyboard
    const w = [...graphium.wins][0];
    const ui = views().ui;
    before = w.tabs.length;
    ui.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    await wait(1000);
    check('Ctrl+T opens a tab', w.tabs.length === before + 1, `${before} -> ${w.tabs.length}`);
    ui.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    await wait(1000);
    check('Ctrl+W closes it', w.tabs.length === before, `${w.tabs.length}`);

    // ---- find in page
    w.activate(w.tabs[w.tabs.length - 1].id);
    await wait(500);
    w.openFind();
    await wait(300);
    await inUi(`(() => { const i = document.getElementById('find-input'); i.value = 'domain'; i.dispatchEvent(new Event('input')); })()`);
    await wait(1200);
    const found = await inUi('document.getElementById("find-count").textContent');
    check('find in page counts matches', /^1 of \d+$/.test(found), found);
    await inUi(`document.getElementById('find-close').click()`);

    // ---- sleep and wake keeps history
    const first = w.tabs[0];
    w.activate(first.id);
    await go('example.com');
    await untilLoaded();
    await go('https://www.iana.org/help/example-domains', 1000);
    await untilLoaded();
    w.activate(w.tabs[w.tabs.length - 1].id);
    await wait(500);
    first.lastActive = 0;
    graphium.sleepIdleTabs();
    check('idle background tab goes to sleep', first.view === null);
    w.activate(first.id);
    await untilLoaded();
    await wait(800);
    const wc = first.view.webContents;
    check('woken tab restores page and back history', /iana\.org/.test(wc.getURL()) && wc.navigationHistory.canGoBack(), wc.getURL());

    const independent = w.tabs.filter(t => t.view && !t.view.webContents).length;
    check('tabs opened from a sleeping tab survive', independent === 0, `${independent} dead views`);

    // ---- reopen closed tab
    const tabCount = w.tabs.length;
    w.closeTab(first.id);
    await wait(500);
    w.reopenClosed();
    await untilLoaded();
    await wait(500);
    const reopened = w.active();
    check('reopen closed tab', w.tabs.length === tabCount && /iana\.org/.test(reopened.url), reopened.url);

    // ---- friendly features
    await inUi(`(() => { const i = document.getElementById('url'); i.focus(); i.value = 'exa';
      i.setSelectionRange(3, 3); i.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'a' })); })()`);
    await wait(600);
    const completed = await inUi('document.getElementById("url").value');
    check('address bar finishes sites from history', completed === 'example.com', completed);
    await inUi('document.getElementById("url").blur()');

    await go('example.com');
    await untilLoaded();
    const settingsMod = require('../src/settings.js');
    await inUi('document.getElementById("star").click()');
    await wait(500);
    const starred = settingsMod.get('shortcuts').some(x => x.url === 'https://example.com/');
    const starOn = await inUi('document.getElementById("star").classList.contains("on")');
    check('star adds page to new tab', starred && starOn);
    await inUi('document.getElementById("star").click()');
    await wait(500);
    check('star again removes it', !settingsMod.get('shortcuts').some(x => x.url === 'https://example.com/'));

    await go('graphium://history', 2000);
    ({ tab } = views());
    const rows = await tab.executeJavaScript('document.querySelectorAll(".item").length');
    check('history page lists visited pages', rows >= 3, `${rows} rows`);
    await shot('08-history');

    await go('graphium://newtab', 2000);
    ({ tab } = views());
    await tab.executeJavaScript(`(() => { document.getElementById('q').value = 'example.com'; document.getElementById('search').requestSubmit(); })()`);
    await untilLoaded();
    ({ tab } = views());
    check('new tab search box works', tab.getURL() === 'https://example.com/', tab.getURL());

    await go('https://self-signed.badssl.com/', 1000);
    await untilLoaded();
    ({ tab } = views());
    const certTitle = await tab.executeJavaScript('document.getElementById("title")?.textContent');
    check('bad certificate shows a warning', certTitle === 'Connection is not private', certTitle);
    await shot('09-cert');
    await tab.executeJavaScript('document.getElementById("proceed").click(); 1');
    await untilLoaded();
    await wait(800);
    ({ tab } = views());
    check('"Continue anyway" opens the site', tab.getURL() === 'https://self-signed.badssl.com/', tab.getURL());

    // ---- command palette and split view
    const gw = [...graphium.wins][0];
    // While the palette is open the toolbar is the top view, not the first, so talk to it directly.
    const inBar = js => gw.ui.webContents.executeJavaScript(js);
    const typeInPalette = async (text, key) => {
      await inBar(`(() => { const i = document.getElementById('palette-input'); i.value = ${JSON.stringify(text)};
        i.dispatchEvent(new Event('input'));
        ${key ? `i.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));` : ''} })()`);
      await wait(400);
    };
    gw.openPalette();
    await wait(700);
    check('command palette opens', await inBar('!document.getElementById("palette").hidden'));
    check('palette draws over the page', views().win.contentView.children.at(-1) === gw.ui);
    await typeInPalette('12*(3+4)^2/7');
    const calcText = await inBar('document.querySelector(".p-item .p-title")?.textContent');
    check('palette does arithmetic', calcText === '= 84', calcText);
    await typeInPalette('slfsigned');
    const firstHit = await inBar('document.querySelector(".p-item .p-sub")?.textContent || ""');
    check('palette finds the open tab with a typo', /self-signed\.badssl/.test(firstHit), firstHit);
    await typeInPalette('>split');
    try {
      await wait(300);
      const { width, height } = gw.ui.getBounds();
      fs.writeFileSync(path.join(out, '10-palette-ui.png'), (await gw.ui.webContents.capturePage({ x: 0, y: 0, width, height })).toPNG());
    } catch (err) {
      console.log(`(screenshot 10-palette skipped: ${err.message})`);
    }
    await typeInPalette('split view with a new', 'Enter');
    await wait(1500);
    const kids = views().win.contentView.children;
    check('palette closes after a command', await inBar('document.getElementById("palette").hidden') && kids[0] === gw.ui);
    const shown = gw.shownTabs(gw.active()).filter(t => t && t.view);
    const [a, b] = shown.map(t => t.view.getBounds());
    check('split view shows two pages side by side', !!gw.split && shown.length === 2 && kids.length === 3 && a && b && a.x === 0 && b.x > a.width && Math.abs(a.width - b.width) <= 2, JSON.stringify({ a, b }));
    await shot('11-split');
    gw.sleep(shown[0]);
    gw.sleep(shown[1]);
    check('split tabs never sleep', shown.every(t => !!t.view));
    shown[1].view.webContents.focus();
    shown[1].view.webContents.emit('focus');
    await wait(200);
    check('address bar follows the focused pane', gw.activeId === shown[1].id);
    gw.unsplit();
    await wait(300);
    check('exit split view', !gw.split && views().win.contentView.children.length === 2);
    gw.openPalette();
    await wait(400);
    await inBar(`document.getElementById('palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await wait(400);
    check('Escape closes the palette', views().win.contentView.children[0] === gw.ui && !gw.paletteOpen);

    ({ tab } = views());
    const gpu = await tab.executeJavaScript(`(() => {
      const gl = !!document.createElement('canvas').getContext('webgl2');
      const v = document.createElement('video');
      return { gl, h264: v.canPlayType('video/mp4; codecs="avc1.42E01E"'), vp9: v.canPlayType('video/webm; codecs="vp9"') };
    })()`);
    check('WebGL and video work', gpu.gl && !!gpu.h264 && !!gpu.vp9, JSON.stringify(gpu));
    await shot('07-final');
  } catch (err) {
    check('no exceptions', false, err.stack);
  }
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  app.exit(failed ? 1 : 0);
});
