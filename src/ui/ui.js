'use strict';

const $ = id => document.getElementById(id);
const tabsEl = $('tabs');
const urlInput = $('url');
const findBar = $('find');
const findInput = $('find-input');
const tabEls = new Map();
let state = null;
let firstState = true;
let dragId = null;

const params = new URLSearchParams(location.search);
if (params.get('private') === '1') {
  document.body.classList.add('private');
  $('private-label').hidden = false;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

function setIcon(button, name) {
  button.querySelector('use').setAttribute('href', '#i-' + name);
}

// ------------------------------------------------------------ tabs

function makeTab(id) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.setAttribute('role', 'tab');
  el.draggable = true;
  el.dataset.id = id;

  const fav = document.createElement('span');
  fav.className = 'favicon';
  const title = document.createElement('span');
  title.className = 'title';
  const close = document.createElement('button');
  close.className = 'icon close';
  close.title = 'Close tab';
  close.setAttribute('aria-label', 'Close tab');
  close.append(icon('close'));
  el.append(fav, title, close);

  el.addEventListener('mousedown', e => {
    if (e.button === 0 && !e.target.closest('.close')) graphium.send('tab-activate', id);
  });
  el.addEventListener('auxclick', e => {
    if (e.button === 1) graphium.send('tab-close', id);
  });
  el.addEventListener('mousedown', e => {
    if (e.button === 1) e.preventDefault();
  });
  close.addEventListener('click', e => {
    e.stopPropagation();
    graphium.send('tab-close', id);
  });
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    graphium.send('tab-menu', id, e.clientX, e.clientY);
  });

  el.addEventListener('dragstart', e => {
    dragId = id;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(id));
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    dragId = null;
  });
  el.addEventListener('dragover', e => {
    if (dragId === null || dragId === id) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    const dragged = tabEls.get(dragId);
    if (dragged) tabsEl.insertBefore(dragged, after ? el.nextSibling : el);
  });
  el.addEventListener('drop', e => {
    e.preventDefault();
    if (dragId === null) return;
    const order = [...tabsEl.children].map(c => Number(c.dataset.id));
    graphium.send('tab-move', dragId, order.indexOf(dragId));
  });

  el._fav = fav;
  el._title = title;
  return el;
}

function renderFavicon(el, tab) {
  const key = tab.loading ? 'loading' : tab.favicon || 'none';
  if (el._favKey === key) return;
  el._favKey = key;
  el._fav.textContent = '';
  if (tab.loading) {
    const spin = document.createElement('span');
    spin.className = 'spinner';
    el._fav.append(spin);
  } else if (tab.favicon) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = tab.favicon;
    img.addEventListener('error', () => img.replaceWith(icon('globe')));
    el._fav.append(img);
  } else {
    el._fav.append(icon('globe'));
  }
}

function renderTabs(tabs) {
  const seen = new Set();
  tabs.forEach((tab, i) => {
    seen.add(tab.id);
    let el = tabEls.get(tab.id);
    if (!el) {
      el = makeTab(tab.id);
      tabEls.set(tab.id, el);
    }
    if (tabsEl.children[i] !== el) tabsEl.insertBefore(el, tabsEl.children[i] || null);
    el.classList.toggle('active', tab.active);
    el.classList.toggle('sleeping', tab.sleeping);
    el.classList.toggle('split', !!tab.split);
    el.setAttribute('aria-selected', String(tab.active));
    if (el._title.textContent !== tab.title) el._title.textContent = tab.title;
    el.title = tab.title;
    renderFavicon(el, tab);
    if (tab.active && dragId === null) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  for (const [id, el] of tabEls) {
    if (!seen.has(id)) {
      el.remove();
      tabEls.delete(id);
    }
  }
  fitTabs();
}

function fitTabs() {
  for (const el of tabEls.values()) el.classList.toggle('narrow', el.offsetWidth < 92);
}

tabsEl.addEventListener('wheel', e => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) tabsEl.scrollLeft += e.deltaY;
}, { passive: true });

$('strip').addEventListener('dblclick', e => {
  if (e.target === $('strip') || e.target === tabsEl) graphium.send('tab-new');
});
$('new-tab').addEventListener('click', () => graphium.send('tab-new'));

// ------------------------------------------------------------ toolbar

function renderNav(nav) {
  $('back').disabled = !nav.canBack;
  $('forward').disabled = !nav.canForward;

  const reload = $('reload');
  setIcon(reload, nav.loading ? 'stop' : 'reload');
  reload.title = nav.loading ? 'Stop' : 'Reload';
  reload.setAttribute('aria-label', reload.title);

  if (document.activeElement !== urlInput) urlInput.value = nav.url;

  const site = $('site');
  site.className = '';
  site.textContent = '';
  site.title = '';
  if (nav.insecure) {
    site.className = 'insecure';
    site.textContent = 'Not secure';
  } else if (nav.url.startsWith('https://') && !nav.error) {
    site.append(icon('lock'));
    site.title = 'Connection is encrypted';
  }

  $('popup').hidden = !nav.popup;

  const star = $('star');
  star.hidden = !/^https?:/.test(nav.url) || nav.error;
  star.classList.toggle('on', nav.bookmarked);
  star.title = nav.bookmarked ? 'Remove from new tab page' : 'Add to new tab page';

  const zoom = $('zoom');
  zoom.hidden = nav.zoom === 100;
  zoom.textContent = nav.zoom + '%';

  const shields = $('shields');
  const showShields = nav.shields !== null && !nav.internal && /^https?:/.test(nav.url);
  shields.hidden = !showShields;
  if (showShields) {
    shields.className = 'chip ' + (nav.shields ? 'on' : 'off');
    setIcon(shields, nav.shields ? 'shield' : 'shield-off');
    $('blocked').textContent = nav.shields && nav.blocked > 0 ? String(nav.blocked) : '';
    shields.title = nav.shields
      ? `Blocked ${nav.blocked} ads and trackers here. Page not working right? Click to allow ads on this site.`
      : 'Ads are allowed on this site. Click to block them again.';
  }
}

function renderDownloads(d) {
  const btn = $('downloads');
  btn.hidden = d.count === 0;
  btn.classList.toggle('busy', d.active > 0);
  $('dl-progress').textContent = d.active > 0 && d.progress >= 0 ? Math.floor(d.progress * 100) + '%' : '';
}

function renderUi(ui) {
  document.documentElement.style.setProperty('--accent', ui.accent);
  document.body.classList.toggle('compact', ui.density === 'compact');
  $('home').hidden = !ui.showHomeButton;
  urlInput.placeholder = `Search ${ui.searchName} or type a web address`;
  const css = $('user-css');
  if (css.textContent !== ui.customCss) css.textContent = ui.customCss;
}

graphium.on('state', s => {
  state = s;
  renderUi(s.ui);
  renderTabs(s.tabs);
  renderNav(s.nav);
  renderDownloads(s.downloads);
  if (firstState) {
    firstState = false;
    if (!s.nav.url && !s.nav.internal) focusAddress();
  }
});

function focusAddress() {
  urlInput.focus();
  urlInput.select();
}

graphium.on('focus-address', focusAddress);

urlInput.addEventListener('focus', () => urlInput.select());

// Finish the address from history as you type, like Chrome: "yo" -> "youtube.com".
let completion = 0;
urlInput.addEventListener('input', async e => {
  if (e.inputType !== 'insertText') return;
  const typed = urlInput.value;
  if (urlInput.selectionStart !== typed.length) return;
  const id = ++completion;
  const rest = await graphium.complete(typed);
  if (id !== completion || !rest || urlInput.value !== typed || document.activeElement !== urlInput) return;
  urlInput.value = typed + rest;
  urlInput.setSelectionRange(typed.length, urlInput.value.length);
});
urlInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    urlInput.value = state ? state.nav.url : '';
    graphium.send('focus-page');
  }
});
$('address').addEventListener('submit', e => {
  e.preventDefault();
  const text = urlInput.value.trim();
  if (!text) return;
  urlInput.blur();
  graphium.send('navigate', text);
});

$('back').addEventListener('click', () => graphium.send('back'));
$('forward').addEventListener('click', () => graphium.send('forward'));
$('reload').addEventListener('click', e => graphium.send(state && state.nav.loading ? 'stop' : 'reload', e.shiftKey));
$('home').addEventListener('click', () => graphium.send('home'));
$('zoom').addEventListener('click', () => graphium.send('zoom-reset'));
$('popup').addEventListener('click', () => graphium.send('open-popup'));
$('shields').addEventListener('click', () => graphium.send('shields'));
$('star').addEventListener('click', () => graphium.send('bookmark'));

function popupAt(button, channel) {
  const r = button.getBoundingClientRect();
  graphium.send(channel, r.left, r.bottom + 2);
}
$('menu').addEventListener('click', () => popupAt($('menu'), 'menu'));
$('downloads').addEventListener('click', () => popupAt($('downloads'), 'downloads'));

// ------------------------------------------------------------ find in page

function openFind() {
  findBar.hidden = false;
  findInput.focus();
  findInput.select();
  if (findInput.value) graphium.send('find', findInput.value, true, true);
}

function closeFind() {
  if (findBar.hidden) return;
  findBar.hidden = true;
  $('find-count').textContent = '';
  graphium.send('find-close');
}

function findNext(forward) {
  if (findBar.hidden) return openFind();
  if (findInput.value) graphium.send('find', findInput.value, forward, false);
}

graphium.on('find-open', openFind);
graphium.on('find-close', closeFind);
graphium.on('find-next', findNext);
graphium.on('find-result', r => {
  $('find-count').textContent = r.total ? `${r.active} of ${r.total}` : 'No results';
});

findInput.addEventListener('input', () => {
  if (!findInput.value) $('find-count').textContent = '';
  graphium.send('find', findInput.value, true, true);
});
findInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') findNext(!e.shiftKey);
  if (e.key === 'Escape') closeFind();
});
$('find-prev').addEventListener('click', () => findNext(false));
$('find-next').addEventListener('click', () => findNext(true));
$('find-close').addEventListener('click', closeFind);

// ------------------------------------------------------------ layout

new ResizeObserver(() => {
  graphium.send('ui-height', Math.ceil(document.body.getBoundingClientRect().height));
  fitTabs();
}).observe(document.body);
