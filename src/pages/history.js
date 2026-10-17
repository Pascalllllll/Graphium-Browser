'use strict';

const list = document.getElementById('list');
const q = document.getElementById('q');
const clearBtn = document.getElementById('clear');

function dayLabel(time) {
  const d = new Date(time);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

async function render() {
  const entries = await graphium.action('history-list', q.value);
  list.textContent = '';
  if (!entries || !entries.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = q.value ? 'Nothing matches that search.' : 'Pages you visit will show up here.';
    list.append(p);
    return;
  }
  let lastDay = '';
  for (const e of entries) {
    const day = dayLabel(e.time);
    if (day !== lastDay) {
      const h = document.createElement('h2');
      h.textContent = day;
      list.append(h);
      lastDay = day;
    }
    const row = document.createElement('div');
    row.className = 'item';

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = new Date(e.time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    const link = document.createElement('a');
    link.href = e.url;
    link.title = e.url;
    link.textContent = e.title || e.url;
    link.addEventListener('click', ev => {
      if (ev.ctrlKey || ev.metaKey || ev.button === 1) {
        ev.preventDefault();
        graphium.action('open', e.url);
      }
    });
    const host = document.createElement('span');
    host.className = 'host';
    try {
      host.textContent = new URL(e.url).hostname.replace(/^www\./, '');
    } catch {
      host.textContent = '';
    }
    link.append(host);

    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${e.title || e.url} from history`);
    remove.addEventListener('click', async () => {
      await graphium.action('history-remove', e.url);
      render();
    });

    row.append(time, link, remove);
    list.append(row);
  }
}

let timer;
q.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(render, 150);
});

let armed = false;
clearBtn.addEventListener('click', async () => {
  if (!armed) {
    armed = true;
    clearBtn.textContent = 'Click again to clear';
    setTimeout(() => {
      armed = false;
      clearBtn.textContent = 'Clear all';
    }, 4000);
    return;
  }
  await graphium.action('history-clear');
  armed = false;
  clearBtn.textContent = 'Clear all';
  render();
});

graphium.getSettings().then(s => document.documentElement.style.setProperty('--accent', s.accent));
render();
q.focus();
