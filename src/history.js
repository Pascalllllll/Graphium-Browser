'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_ENTRIES = 3000;

let file;
let entries = []; // oldest first: { url, title, time, visits }
let saveTimer;

function load() {
  file = path.join(app.getPath('userData'), 'history.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(data)) entries = data.filter(e => e && typeof e.url === 'string');
  } catch {
    entries = [];
  }
}

function writeNow() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  try {
    fs.writeFileSync(file + '.tmp', JSON.stringify(entries));
    fs.renameSync(file + '.tmp', file);
  } catch (err) {
    console.warn('Could not save history:', err.message);
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 2000);
}

function add(url, title) {
  if (!/^https?:\/\//.test(url) || url.length > 2000) return;
  const at = entries.findIndex(e => e.url === url);
  const visits = at >= 0 ? entries[at].visits + 1 : 1;
  const oldTitle = at >= 0 ? entries[at].title : '';
  if (at >= 0) entries.splice(at, 1);
  entries.push({ url, title: title || oldTitle, time: Date.now(), visits });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  save();
}

function setTitle(url, title) {
  const entry = entries.findLast(e => e.url === url);
  if (entry && title && entry.title !== title) {
    entry.title = title.slice(0, 300);
    save();
  }
}

function list(query = '', limit = 300) {
  const q = query.trim().toLowerCase();
  const out = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const e = entries[i];
    if (!q || e.url.toLowerCase().includes(q) || e.title.toLowerCase().includes(q)) out.push(e);
  }
  return out;
}

function remove(url) {
  entries = entries.filter(e => e.url !== url);
  save();
}

function clear() {
  entries = [];
  writeNow();
}

const bare = url => url.replace(/^https?:\/\//, '').replace(/^www\./, '');

// Chrome-style inline completion. Returns the text to add after what was
// typed: "yout" -> "ube.com".
function complete(typed) {
  const text = typed.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  if (text.length < 1 || /\s/.test(text)) return '';
  const scores = new Map();
  for (const e of entries) {
    const b = bare(e.url);
    // Whole sites first, so "you" finishes as "youtube.com", not a video URL.
    const site = text.includes('/') ? b : b.split('/')[0];
    if (!site.toLowerCase().startsWith(text) || site.length === text.length) continue;
    scores.set(site, (scores.get(site) || 0) + e.visits);
  }
  let best = '';
  let bestScore = 0;
  for (const [site, score] of scores) {
    if (score > bestScore || (score === bestScore && site.length < best.length)) {
      best = site;
      bestScore = score;
    }
  }
  return best ? best.slice(text.length) : '';
}

module.exports = { load, add, setTitle, list, remove, clear, complete, flush: writeNow };
