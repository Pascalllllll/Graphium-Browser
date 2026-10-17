'use strict';
// Opens a typical set of tabs and prints total memory use of all processes.
// Run: npx electron test/memory.js
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
app.setPath('userData', process.env.GRAPHIUM_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'graphium-mem-')));
const graphium = require('../src/main.js');
const wait = ms => new Promise(r => setTimeout(r, ms));

const URLS = [
  'https://en.wikipedia.org/wiki/Web_browser',
  'https://en.wikipedia.org/wiki/Chromium_(web_browser)',
  'https://github.com/electron/electron',
  'https://www.theverge.com',
  'https://news.ycombinator.com',
  'https://www.bbc.com/news',
];

app.whenReady().then(async () => {
  await wait(4000);
  const w = [...graphium.wins][0];
  for (const url of URLS) w.addTab({ url, background: true });
  await wait(20000);
  const metrics = app.getAppMetrics();
  const mb = metrics.reduce((n, m) => n + m.memory.workingSetSize, 0) / 1024;
  const byType = {};
  for (const m of metrics) byType[m.type] = (byType[m.type] || 0) + m.memory.workingSetSize / 1024;
  console.log(`MEMORY total ${mb.toFixed(0)} MB in ${metrics.length} processes`);
  for (const [type, v] of Object.entries(byType)) console.log(`MEMORY   ${type}: ${v.toFixed(0)} MB`);
  for (const tab of w.tabs) if (tab.id !== w.activeId) tab.lastActive = 0;
  graphium.sleepIdleTabs();
  await wait(8000);
  const later = app.getAppMetrics();
  const after = later.reduce((n, m) => n + m.memory.workingSetSize, 0) / 1024;
  console.log(`MEMORY after background tabs sleep: ${after.toFixed(0)} MB in ${later.length} processes`);
  for (const m of later) console.log(`MEMORY     ${m.type} ${(m.memory.workingSetSize / 1024).toFixed(0)} MB`);
  const u = process.memoryUsage();
  console.log(`MEMORY   main JS: heap ${(u.heapUsed / 1048576).toFixed(0)} MB, external ${(u.external / 1048576).toFixed(0)} MB, arrayBuffers ${(u.arrayBuffers / 1048576).toFixed(0)} MB`);
  app.exit(0);
});
