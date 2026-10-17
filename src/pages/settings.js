'use strict';

const $ = id => document.getElementById(id);
const ACCENTS = ['#4c7dff', '#1a8a6e', '#7a52cc', '#c2410c', '#be185d', '#52525b'];
const TOGGLES = ['showHomeButton', 'shields', 'httpsUpgrade', 'gpc', 'clearOnExit', 'askDownloadLocation'];
let current = {};
let savedTimer;

function flashSaved(text = 'Saved') {
  const el = $('saved');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

async function set(key, value) {
  const ok = await graphium.set(key, value);
  flashSaved(ok ? 'Saved' : 'That value was not accepted');
  return ok;
}

function render(s) {
  current = s;
  document.documentElement.style.setProperty('--accent', s.accent);

  const engine = $('searchEngine');
  if (!engine.options.length) {
    for (const [value, name] of Object.entries(s.engines)) engine.add(new Option(name, value));
    engine.add(new Option('Other...', 'custom'));
  }
  engine.value = s.searchEngine;
  $('custom-search').hidden = s.searchEngine !== 'custom';
  if (document.activeElement !== $('custom-search')) $('custom-search').value = s.customSearch;
  $('startup').value = s.restoreTabs ? 'restore' : 'new';

  $('theme').value = s.theme;
  $('accent').value = s.accent;
  for (const sw of $('swatches').children) sw.setAttribute('aria-pressed', String(sw.dataset.color === s.accent));
  $('download-dir').textContent = s.downloadDir || 'Your Downloads folder';

  if (document.activeElement !== $('homepage')) $('homepage').value = s.homepage === 'graphium://newtab' ? '' : s.homepage;
  $('compact').checked = s.density === 'compact';
  if (document.activeElement !== $('customCss')) $('customCss').value = s.customCss;
  for (const key of TOGGLES) $(key).checked = s[key];
  const sleep = $('sleepTabsMinutes');
  if (![...sleep.options].some(o => o.value === String(s.sleepTabsMinutes))) {
    sleep.add(new Option(`After ${s.sleepTabsMinutes} minutes`, String(s.sleepTabsMinutes)));
  }
  sleep.value = String(s.sleepTabsMinutes);

  const allow = $('allowlist');
  allow.textContent = '';
  if (!s.allowlist.length) {
    const li = document.createElement('li');
    li.className = 'note';
    li.textContent = 'None. Ads are blocked everywhere.';
    allow.append(li);
  }
  for (const host of s.allowlist) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = host;
    const btn = document.createElement('button');
    btn.textContent = 'Block ads again';
    btn.addEventListener('click', () => set('allowlist', current.allowlist.filter(h => h !== host)));
    li.append(name, btn);
    allow.append(li);
  }
}

for (const color of ACCENTS) {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.type = 'button';
  b.dataset.color = color;
  b.style.background = color;
  b.setAttribute('aria-label', `Color ${color}`);
  b.addEventListener('click', () => set('accent', color));
  $('swatches').append(b);
}

$('searchEngine').addEventListener('change', e => {
  $('custom-search').hidden = e.target.value !== 'custom';
  if (e.target.value === 'custom') {
    $('custom-search').focus();
    if (current.customSearch) set('searchEngine', 'custom');
  } else {
    set('searchEngine', e.target.value);
  }
});
$('custom-search').addEventListener('change', async e => {
  if (await set('customSearch', e.target.value.trim())) set('searchEngine', 'custom');
});
$('startup').addEventListener('change', e => set('restoreTabs', e.target.value === 'restore'));
$('homepage').addEventListener('change', e => {
  let v = e.target.value.trim();
  if (v && !/^(https?|graphium):\/\//.test(v)) v = 'https://' + v;
  set('homepage', v || 'graphium://newtab');
});
$('theme').addEventListener('change', e => set('theme', e.target.value));
$('accent').addEventListener('change', e => set('accent', e.target.value));
$('compact').addEventListener('change', e => set('density', e.target.checked ? 'compact' : 'comfortable'));
$('customCss').addEventListener('change', e => set('customCss', e.target.value));
for (const key of TOGGLES) $(key).addEventListener('change', e => set(key, e.target.checked));
$('sleepTabsMinutes').addEventListener('change', e => set('sleepTabsMinutes', Number(e.target.value)));
$('pick-dir').addEventListener('click', () => graphium.action('pick-download-dir'));

$('reset-permissions').addEventListener('click', async () => {
  await graphium.action('reset-permissions');
  flashSaved('Forgotten');
});

function confirmButton(button, question, run) {
  let armed = false;
  let timer;
  const label = button.textContent;
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.textContent = question;
      timer = setTimeout(() => {
        armed = false;
        button.textContent = label;
      }, 4000);
      return;
    }
    clearTimeout(timer);
    armed = false;
    button.textContent = label;
    await run();
  });
}

confirmButton($('clear-data'), 'Click again to clear', async () => {
  await graphium.action('clear-data');
  flashSaved('Cleared');
});
confirmButton($('reset-settings'), 'Click again to reset', async () => {
  await graphium.action('reset-settings');
  flashSaved('Settings reset');
});

async function renderSystem() {
  const isDefault = await graphium.action('is-default');
  $('default-status').textContent = isDefault ? 'Graphium is already your default browser.' : 'Links you click in other apps will open in Graphium.';
  $('make-default').hidden = isDefault;
  const about = await graphium.action('about');
  $('lists-status').textContent = about.lists ? 'Up to date. They refresh by themselves every 3 days.' : 'Not downloaded yet. Needs an internet connection.';
  $('about').textContent = `Graphium ${about.version}, based on Chromium ${about.chromium}. Free and open source.`;
}

$('make-default').addEventListener('click', async () => {
  const ok = await graphium.action('make-default');
  flashSaved(ok ? 'Done' : "Your computer didn't allow it. Choose Graphium in your system settings.");
  renderSystem();
});
$('update-lists').addEventListener('click', async () => {
  $('lists-status').textContent = 'Updating...';
  const ok = await graphium.action('update-lists');
  $('lists-status').textContent = ok ? 'Updated just now.' : 'Update failed. Check your connection.';
});

graphium.getSettings().then(render);
graphium.onSettings(render);
renderSystem();
