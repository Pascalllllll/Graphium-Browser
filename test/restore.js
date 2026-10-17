'use strict';
// Two-run check that "Reopen tabs from last time" works.
// Run: npx electron test/restore.js <profile-dir> save   then   ... check
const { app } = require('electron');
const path = require('path');
const [dir, phase] = process.argv.slice(2);
app.setPath('userData', path.resolve(dir));
const graphium = require('../src/main.js');
const settings = require('../src/settings.js');
const wait = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  await wait(2500);
  const w = [...graphium.wins][0];
  if (phase === 'save') {
    settings.setFromPage('restoreTabs', true);
    w.navigate('example.com');
    w.addTab({ url: 'https://www.iana.org/help/example-domains' });
    await wait(5000);
    app.quit();
  } else {
    const urls = w.tabs.map(t => t.url);
    const ok = urls.length === 2 && urls[0] === 'https://example.com/' && /iana\.org/.test(urls[1]) && w.activeId === w.tabs[1].id;
    console.log(`${ok ? 'PASS' : 'FAIL'}  tabs restored after restart  ${JSON.stringify(urls)}`);
    app.exit(ok ? 0 : 1);
  }
});
