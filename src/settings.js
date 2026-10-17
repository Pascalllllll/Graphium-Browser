'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
  ecosia: { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' },
};

const DEFAULTS = {
  searchEngine: 'google',
  customSearch: '',
  homepage: 'graphium://newtab',
  theme: 'system',
  accent: '#4c7dff',
  density: 'comfortable',
  showHomeButton: false,
  customCss: '',
  shields: true,
  httpsUpgrade: true,
  gpc: true,
  restoreTabs: false,
  sleepTabsMinutes: 10,
  clearOnExit: false,
  askDownloadLocation: false,
  downloadDir: '',
  allowlist: [],
  sitePermissions: {},
  windowBounds: null,
  shortcuts: [
    { title: 'Google', url: 'https://www.google.com' },
    { title: 'YouTube', url: 'https://www.youtube.com' },
    { title: 'Wikipedia', url: 'https://www.wikipedia.org' },
    { title: 'GitHub', url: 'https://github.com' },
  ],
};

// What the renderer may write, and the shape each value must have.
const VALIDATORS = {
  searchEngine: v => v === 'custom' || Object.hasOwn(SEARCH_ENGINES, v),
  customSearch: v => v === '' || (/^https?:\/\//.test(v) && v.includes('%s') && v.length < 2000),
  homepage: v => typeof v === 'string' && v.length < 2000,
  theme: v => ['system', 'light', 'dark'].includes(v),
  accent: v => /^#[0-9a-f]{6}$/i.test(v),
  density: v => ['comfortable', 'compact'].includes(v),
  showHomeButton: v => typeof v === 'boolean',
  customCss: v => typeof v === 'string' && v.length < 100000,
  shields: v => typeof v === 'boolean',
  httpsUpgrade: v => typeof v === 'boolean',
  gpc: v => typeof v === 'boolean',
  restoreTabs: v => typeof v === 'boolean',
  sleepTabsMinutes: v => Number.isInteger(v) && v >= 0 && v <= 1440,
  clearOnExit: v => typeof v === 'boolean',
  askDownloadLocation: v => typeof v === 'boolean',
  allowlist: v => Array.isArray(v) && v.length < 5000 && v.every(h => typeof h === 'string' && h.length < 256),
  sitePermissions: v => v && typeof v === 'object' && !Array.isArray(v),
  shortcuts: v =>
    Array.isArray(v) &&
    v.length <= 48 &&
    v.every(s => s && typeof s.title === 'string' && s.title.length <= 80 && typeof s.url === 'string' && /^https?:\/\//.test(s.url) && s.url.length < 2000),
};

let file;
let data;
let saveTimer;

function load() {
  file = path.join(app.getPath('userData'), 'settings.json');
  data = structuredClone(DEFAULTS);
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of Object.keys(DEFAULTS)) {
      if (!(key in saved)) continue;
      const valid = VALIDATORS[key] ? VALIDATORS[key](saved[key]) : true;
      if (valid) data[key] = saved[key];
    }
  } catch {
    // First run or unreadable file: keep defaults.
  }
  return data;
}

function writeNow() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('Could not save settings:', err.message);
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 300);
}

function get(key) {
  return key === undefined ? data : data[key];
}

// Used for values set by the main process itself (downloadDir, shortcuts).
function setTrusted(key, value) {
  data[key] = value;
  save();
}

// Used for values coming from a settings page. Returns false if rejected.
function setFromPage(key, value) {
  if (!VALIDATORS[key] || !VALIDATORS[key](value)) return false;
  data[key] = value;
  save();
  return true;
}

function reset() {
  data = structuredClone(DEFAULTS);
  save();
}

function searchUrl(query) {
  const tpl =
    data.searchEngine === 'custom' && data.customSearch
      ? data.customSearch
      : (SEARCH_ENGINES[data.searchEngine] || SEARCH_ENGINES.google).url;
  return tpl.replace('%s', encodeURIComponent(query));
}

module.exports = { load, get, setTrusted, setFromPage, reset, flush: writeNow, searchUrl, SEARCH_ENGINES, DEFAULTS };
