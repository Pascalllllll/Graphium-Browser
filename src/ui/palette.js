'use strict';

// The command palette (Ctrl+K). One box for everything: switch to a tab, reopen a closed one, open a
// bookmark or a page from history, run a browser action, or do quick arithmetic. Matching is fuzzy and
// runs here; history comes from the main process as you type. Nothing leaves the computer.

(() => {
  const $ = id => document.getElementById(id);
  const root = $('palette');
  const input = $('palette-input');
  const list = $('palette-list');
  const modeEl = $('palette-mode');

  let data = null;
  let mode = 'all';
  let items = [];
  let sel = 0;
  let historyHits = [];
  let historyFor = '';
  let memory = null;
  let seq = 0;

  const COMMANDS = [
    { id: 'new-tab', label: 'New tab', keys: 'T', icon: 'plus' },
    { id: 'new-window', label: 'New window', keys: 'N', icon: 'plus' },
    { id: 'private-window', label: 'New private window', keys: 'Shift+N', icon: 'lock' },
    { id: 'split', label: 'Split view with another tab', keys: 'Shift+S', icon: 'split', pick: 'split', when: d => !d.split && d.tabs.length > 1 },
    { id: 'split-new', run: 'split', label: 'Split view with a new tab', icon: 'split', when: d => !d.split },
    { id: 'unsplit', label: 'Exit split view', keys: 'Shift+S', icon: 'split', when: d => d.split },
    { id: 'swap-split', label: 'Swap the two sides', icon: 'split', when: d => d.split },
    { id: 'split-wider', label: 'Make the left side wider', icon: 'split', when: d => d.split },
    { id: 'split-narrower', label: 'Make the right side wider', icon: 'split', when: d => d.split },
    { id: 'memory', label: 'Memory use per tab', icon: 'chip', pick: 'memory', words: 'ram process task manager' },
    { id: 'sleep-others', label: 'Sleep all background tabs', icon: 'chip', words: 'free memory ram discard' },
    { id: 'mute', label: 'Mute or unmute this tab', icon: 'bolt', words: 'sound audio silence' },
    { id: 'mute-others', label: 'Mute all other tabs', icon: 'bolt', words: 'sound audio silence' },
    { id: 'pip', label: 'Picture-in-picture for the video on this page', icon: 'bolt', words: 'pip float video youtube', when: d => d.page?.web },
    { id: 'copy-url', label: 'Copy page address', icon: 'bolt', words: 'link url clipboard', when: d => d.page?.web },
    { id: 'copy-md', label: 'Copy link as Markdown', icon: 'bolt', words: 'link clipboard notes', when: d => d.page?.web },
    { id: 'duplicate', label: 'Duplicate tab', icon: 'plus' },
    { id: 'close-others', label: 'Close other tabs', icon: 'close', when: d => d.tabs.length > 1 },
    { id: 'close-right', label: 'Close tabs to the right', icon: 'close', when: d => d.tabs.findIndex(t => t.active) < d.tabs.length - 1 },
    { id: 'reopen', label: 'Reopen closed tab', keys: 'Shift+T', icon: 'undo', when: d => d.closed.length > 0 },
    { id: 'bookmark', label: 'Add to or remove from the new tab page', keys: 'D', icon: 'star', when: d => d.page?.web },
    { id: 'shields', label: 'Turn ad blocking on or off for this site', icon: 'shield', when: d => d.page?.web },
    { id: 'find', label: 'Find in page', keys: 'F', icon: 'search' },
    { id: 'zoom-in', label: 'Zoom in', keys: '+', icon: 'plus' },
    { id: 'zoom-out', label: 'Zoom out', keys: '-', icon: 'plus' },
    { id: 'zoom-reset', label: 'Actual size', keys: '0', icon: 'plus' },
    { id: 'print', label: 'Print', keys: 'P', icon: 'bolt' },
    { id: 'reload-hard', label: 'Reload without the cache', keys: 'Shift+R', icon: 'reload' },
    { id: 'history', label: 'History', keys: 'H', icon: 'clock' },
    { id: 'downloads', label: 'Downloads', keys: 'J', icon: 'download' },
    { id: 'settings', label: 'Settings', keys: ',', icon: 'menu' },
    { id: 'theme', label: 'Switch theme (system, light, dark)', icon: 'bolt', words: 'dark mode light mode appearance' },
    { id: 'devtools', label: 'Developer tools', keys: 'F12', icon: 'bolt', words: 'inspect console' },
  ];

  // ---------------------------------------------------------- matching

  /** Subsequence match with bonuses for word starts and runs; -1 when the letters aren't all there in order. */
  function score(text, q) {
    if (!q) return 0;
    const t = text.toLowerCase();
    const direct = t.indexOf(q);
    if (direct >= 0) return 100 - Math.min(direct, 40) + (direct === 0 || /[\s./:-]/.test(t[direct - 1]) ? 30 : 0);
    let s = 0;
    let ti = 0;
    let run = 0;
    for (const ch of q) {
      if (ch === ' ') continue;
      const at = t.indexOf(ch, ti);
      if (at < 0) return -1;
      run = at === ti ? run + 1 : 0;
      s += 1 + run * 2 + (at === 0 || /[\s./:-]/.test(t[at - 1]) ? 4 : 0);
      ti = at + 1;
    }
    return s;
  }

  // ---------------------------------------------------------- arithmetic

  /** A tiny calculator: + - * / % ^ and brackets. No eval (the toolbar's CSP forbids it anyway). */
  function calc(text) {
    const src = text.replace(/^=/, '').replace(/,/g, '').replace(/×/g, '*').replace(/÷/g, '/');
    if (!/^[\d\s.+\-*/%^()]+$/.test(src) || !/\d/.test(src) || !/[+\-*/%^]/.test(src.replace(/^\s*-/, ''))) return null;
    const tokens = src.match(/\d*\.?\d+(?:e[+-]?\d+)?|[+\-*/%^()]/g);
    if (!tokens) return null;
    let i = 0;
    const peek = () => tokens[i];
    const next = () => tokens[i++];
    const expr = () => {
      let v = term();
      while (peek() === '+' || peek() === '-') v = next() === '+' ? v + term() : v - term();
      return v;
    };
    const term = () => {
      let v = power();
      while (peek() === '*' || peek() === '/' || peek() === '%') {
        const op = next();
        const r = power();
        v = op === '*' ? v * r : op === '/' ? v / r : v % r;
      }
      return v;
    };
    const power = () => {
      const b = unary();
      return peek() === '^' ? (next(), b ** power()) : b;
    };
    const unary = () => (peek() === '-' ? (next(), -unary()) : peek() === '+' ? (next(), unary()) : atom());
    const atom = () => {
      const t = next();
      if (t === '(') {
        const v = expr();
        if (next() !== ')') throw new Error('bracket');
        return v;
      }
      const n = Number(t);
      if (!Number.isFinite(n)) throw new Error('number');
      return n;
    };
    try {
      const v = expr();
      if (i !== tokens.length || !Number.isFinite(v)) return null;
      return Math.abs(v) >= 1e15 || (Math.abs(v) < 1e-6 && v !== 0) ? v.toExponential(6) : String(+v.toPrecision(12));
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------- results

  const looksLikeUrl = q => /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(q) || /^(https?|graphium):\/\//.test(q) || /^localhost(:\d+)?/.test(q);
  const fmtMB = b => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`);

  function build(raw) {
    const text = raw.trim();
    const commandsOnly = mode === 'all' && text.startsWith('>');
    const q = (commandsOnly ? text.slice(1) : text).trim().toLowerCase();
    const out = [];
    const push = (section, list, limit) => {
      const ranked = list
        .map(it => ({ it, s: q ? score(`${it.title} ${it.sub || ''} ${it.words || ''}`, q) : 0 }))
        .filter(x => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit);
      if (ranked.length) out.push({ section }, ...ranked.map(x => x.it));
    };

    if (mode === 'memory') {
      modeEl.textContent = memory ? `Memory · ${fmtMB(memory.total)} in all` : 'Memory';
      if (!memory) return [{ section: 'Measuring…' }];
      push(
        'Enter puts a tab to sleep and gives its memory back',
        memory.rows.map(r => ({
          title: r.title,
          sub: r.sleeping ? 'Asleep' : r.active ? 'This tab, can’t sleep' : 'Awake',
          hint: r.sleeping ? '0 MB' : fmtMB(r.bytes),
          icon: 'chip',
          run: () => {
            if (!r.sleeping && !r.active) {
              graphium.send('palette-run', 'sleep-tab', r.id);
              setTimeout(() => graphium.memory().then(m => {
                memory = m;
                if (mode === 'memory' && !root.hidden) render();
              }), 400);
            }
            return 'stay';
          },
        })),
        50,
      );
      return out;
    }

    const tabItems = data.tabs
      .filter(t => mode !== 'split' || !t.active)
      .map(t => ({
        title: t.title,
        sub: t.url,
        favicon: t.favicon,
        icon: 'globe',
        hint: mode === 'split' ? 'Put beside this tab' : t.active ? 'This tab' : t.sleeping ? 'Asleep' : t.audible ? (t.muted ? 'Muted' : 'Playing') : 'Switch to tab',
        run: () => graphium.send('palette-run', mode === 'split' ? 'split' : 'tab', t.id),
      }));

    if (mode === 'split') {
      modeEl.textContent = 'Split with';
      push('Tabs', tabItems, 30);
      return out;
    }
    modeEl.textContent = mode === 'tabs' ? 'Tabs' : '';
    if (mode === 'tabs') {
      push('Tabs', tabItems, 40);
      return out;
    }

    if (!commandsOnly) {
      const result = calc(text);
      if (result !== null) {
        out.push({ section: 'Calculator' }, { title: `= ${result}`, sub: 'Enter copies the result', icon: 'calc', run: () => graphium.send('palette-run', 'copy', result) });
      }
    }

    const commands = COMMANDS.filter(c => !c.when || c.when(data)).map(c => ({
      title: c.label,
      words: c.words,
      keys: c.keys ? `${data.mod}+${c.keys}`.replace(`${data.mod}+F12`, 'F12') : '',
      icon: c.icon,
      run: () => {
        if (c.pick) return switchMode(c.pick);
        graphium.send('palette-run', c.run || c.id);
      },
    }));

    if (commandsOnly) {
      push('Commands', commands, 40);
      return out;
    }

    push('Tabs', tabItems.filter(t => q || t.hint !== 'This tab'), q ? 5 : 6);
    push('Commands', commands, q ? 5 : 4);
    if (q) {
      push('New tab page', data.bookmarks.map(b => ({ title: b.title, sub: b.url.replace(/^https?:\/\/(www\.)?/, ''), icon: 'star', run: () => graphium.send('palette-run', 'go', b.url) })), 3);
    }
    push(
      'Recently closed',
      data.closed.map(c => ({ title: c.title, sub: c.url, icon: 'undo', hint: 'Reopen', run: () => graphium.send('palette-run', 'reopen', c.i) })),
      q ? 3 : 3,
    );
    if (q && historyHits.length) {
      const open = new Set(data.tabs.map(t => t.url));
      push(
        'History',
        historyHits.filter(h => !open.has(h.url.replace(/^https?:\/\/(www\.)?/, ''))).map(h => ({ title: h.title, sub: h.url.replace(/^https?:\/\/(www\.)?/, ''), icon: 'clock', run: () => graphium.send('palette-run', 'go', h.url) })),
        5,
      );
    }
    if (q) {
      const url = looksLikeUrl(text);
      out.push(
        { section: '' },
        { title: url ? `Go to ${text}` : `Search for “${text}”`, icon: url ? 'globe' : 'search', hint: 'Enter', run: () => graphium.send('palette-run', 'go', text) },
      );
    }
    return out;
  }

  // ---------------------------------------------------------- rendering

  function iconEl(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  function render() {
    items = build(input.value);
    const runnable = items.filter(it => it.run);
    sel = Math.max(0, Math.min(sel, runnable.length - 1));
    list.textContent = '';
    let k = 0;
    for (const it of items) {
      if (!it.run) {
        if (it.section) {
          const h = document.createElement('div');
          h.className = 'p-section';
          h.textContent = it.section;
          list.append(h);
        }
        continue;
      }
      const index = k++;
      const row = document.createElement('div');
      row.className = 'p-item';
      row.id = `p-item-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === sel));
      const ic = document.createElement('span');
      ic.className = 'p-icon';
      if (it.favicon && /^(https?|data):/.test(it.favicon)) {
        const img = document.createElement('img');
        img.src = it.favicon;
        img.alt = '';
        img.onerror = () => img.replaceWith(iconEl(it.icon || 'globe'));
        ic.append(img);
      } else ic.append(iconEl(it.icon || 'bolt'));
      const text = document.createElement('span');
      text.className = 'p-text';
      const title = document.createElement('span');
      title.className = 'p-title';
      title.textContent = it.title;
      text.append(title);
      if (it.sub) {
        const sub = document.createElement('span');
        sub.className = 'p-sub';
        sub.textContent = it.sub;
        text.append(sub);
      }
      row.append(ic, text);
      if (it.keys || it.hint) {
        const hint = document.createElement('span');
        hint.className = it.keys ? 'p-keys' : 'p-hint';
        hint.textContent = it.keys || it.hint;
        row.append(hint);
      }
      row.addEventListener('mousemove', () => {
        if (sel !== index) {
          sel = index;
          mark();
        }
      });
      row.addEventListener('mousedown', e => {
        e.preventDefault();
        choose(index);
      });
      list.append(row);
    }
    if (!k) {
      const empty = document.createElement('div');
      empty.className = 'p-section';
      empty.textContent = 'Nothing matches.';
      list.append(empty);
    }
    mark();
  }

  function mark() {
    list.querySelectorAll('.p-item').forEach((row, i) => row.setAttribute('aria-selected', String(i === sel)));
    const current = $(`p-item-${sel}`);
    input.setAttribute('aria-activedescendant', current ? current.id : '');
    current?.scrollIntoView({ block: 'nearest' });
  }

  function choose(index) {
    const it = items.filter(x => x.run)[index];
    if (!it) return;
    const stays = it.run() === 'stay';
    if (!stays && mode !== 'memory' && root.hidden === false && !pendingMode) close(false);
    pendingMode = false;
  }

  let pendingMode = false;
  function switchMode(next) {
    pendingMode = true;
    mode = next;
    sel = 0;
    input.value = '';
    input.placeholder = next === 'split' ? 'Which tab goes beside this one?' : next === 'memory' ? 'Filter tabs' : placeholder();
    if (next === 'memory') {
      memory = null;
      graphium.memory().then(m => {
        memory = m;
        if (mode === 'memory') render();
      });
    }
    render();
  }

  const placeholder = () => (data && data.private ? 'Search tabs or type a command' : 'Search tabs, history, or type a command');

  function open(d, m) {
    data = d;
    mode = m === 'tabs' ? 'tabs' : 'all';
    historyHits = [];
    historyFor = '';
    sel = 0;
    input.value = '';
    input.placeholder = mode === 'tabs' ? 'Find a tab' : placeholder();
    document.documentElement.classList.add('palette');
    root.hidden = false;
    render();
    input.focus();
  }

  // `notify` is false when a command already closed the palette in the main process.
  function close(notify = true) {
    if (root.hidden) return;
    root.hidden = true;
    document.documentElement.classList.remove('palette');
    if (notify) graphium.send('palette-close');
  }

  input.addEventListener('input', () => {
    sel = 0;
    render();
    const q = input.value.trim();
    if (mode !== 'all' || !q || q.startsWith('>') || data.private || q === historyFor) return;
    const mine = ++seq;
    graphium.searchHistory(q).then(hits => {
      if (mine !== seq || root.hidden) return;
      historyFor = q;
      historyHits = hits || [];
      render();
    });
  });

  input.addEventListener('keydown', e => {
    const count = items.filter(x => x.run).length;
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      sel = count ? (sel + 1) % count : 0;
      mark();
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      sel = count ? (sel - 1 + count) % count : 0;
      mark();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(sel);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (mode === 'split' || mode === 'memory') switchMode('all');
      else close();
    } else if (e.key === 'Backspace' && !input.value && mode !== 'all') {
      e.preventDefault();
      switchMode('all');
    }
  });

  $('palette-backdrop').addEventListener('mousedown', e => {
    e.preventDefault();
    close();
  });
  window.addEventListener('blur', () => close());

  graphium.on('palette-open', (d, m) => open(d, m));
  window.graphiumPalette = { close };
})();
