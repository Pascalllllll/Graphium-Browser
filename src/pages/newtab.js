'use strict';

const grid = document.getElementById('grid');
const form = document.getElementById('add-form');
const titleInput = document.getElementById('add-title');
const urlInput = document.getElementById('add-url');
const q = document.getElementById('q');
let shortcuts = [];

function letterFor(title) {
  return (title.trim()[0] || '?').toUpperCase();
}

function render() {
  grid.textContent = '';
  shortcuts.forEach((s, i) => {
    const a = document.createElement('a');
    a.className = 'tile';
    a.href = s.url;
    a.title = s.url;

    const icon = document.createElement('span');
    icon.className = 'icon';
    const img = document.createElement('img');
    img.alt = '';
    img.src = new URL('/favicon.ico', s.url).href;
    img.addEventListener('error', () => {
      icon.textContent = letterFor(s.title);
    });
    icon.append(img);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.title;

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.type = 'button';
    remove.title = `Remove ${s.title}`;
    remove.setAttribute('aria-label', `Remove ${s.title}`);
    remove.textContent = '×';
    remove.addEventListener('click', e => {
      e.preventDefault();
      save(shortcuts.filter((_, j) => j !== i));
    });

    a.append(icon, name, remove);
    grid.append(a);
  });

  if (shortcuts.length < 48) {
    const add = document.createElement('button');
    add.className = 'tile add';
    add.type = 'button';
    add.innerHTML = '<span class="icon">+</span><span class="name">Add shortcut</span>';
    add.addEventListener('click', () => {
      form.hidden = false;
      urlInput.focus();
    });
    grid.append(add);
  }
}

async function save(list) {
  if (await graphium.set('shortcuts', list)) {
    shortcuts = list;
    render();
  }
}

document.getElementById('search').addEventListener('submit', e => {
  e.preventDefault();
  if (q.value.trim()) graphium.action('navigate', q.value);
});

form.addEventListener('submit', e => {
  e.preventDefault();
  let url = urlInput.value.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let parsed;
  try {
    parsed = new URL(url);
    if (!parsed.hostname.includes('.')) throw new Error('no dot');
  } catch {
    urlInput.setCustomValidity('That web address does not look right');
    urlInput.reportValidity();
    return;
  }
  const fallback = parsed.hostname.replace(/^www\./, '').split('.')[0];
  const title = titleInput.value.trim() || fallback.charAt(0).toUpperCase() + fallback.slice(1);
  save([...shortcuts, { title: title.slice(0, 80), url: parsed.href }]);
  form.reset();
  form.hidden = true;
});
urlInput.addEventListener('input', () => urlInput.setCustomValidity(''));
document.getElementById('add-cancel').addEventListener('click', () => {
  form.reset();
  form.hidden = true;
});
document.getElementById('settings').addEventListener('click', () => graphium.action('open-settings'));
document.getElementById('history').addEventListener('click', () => (location.href = 'graphium://history/'));

function apply(s) {
  document.documentElement.style.setProperty('--accent', s.accent);
  const engine = s.searchEngine === 'custom' ? 'the web' : s.engines[s.searchEngine] || 'Google';
  q.placeholder = `Search ${engine} or type a web address`;
  shortcuts = s.shortcuts;
  render();
}

graphium.getSettings().then(apply);
graphium.onSettings(apply);
