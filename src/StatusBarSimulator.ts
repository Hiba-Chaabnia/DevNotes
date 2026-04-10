import * as vscode from 'vscode';

export class StatusBarSimulator {
  static show(context: vscode.ExtensionContext): void {
    const panel = vscode.window.createWebviewPanel(
      'devnotes.statusBarSim',
      'DevNotes — Status Bar Simulator',
      vscode.ViewColumn.One,
      { enableScripts: true }
    );
    panel.webview.html = getHtml();
  }
}

function getHtml(): string {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  h1 { font-size: 16px; font-weight: 700; opacity: .9; }
  h2 { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; opacity: .5; margin-bottom: 10px; }

  /* ── Layout ── */
  .layout { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }

  /* ── Notes panel ── */
  .notes-panel {
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .note-row {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .note-title {
    font-weight: 600;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .note-controls {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  label {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    opacity: .8;
    cursor: pointer;
    user-select: none;
  }
  label input { cursor: pointer; }

  select {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 11px;
    font-family: var(--vscode-font-family);
    cursor: pointer;
  }

  .pill {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 10px;
    font-weight: 600;
  }
  .pill-archived  { background: rgba(128,128,128,.2); color: var(--vscode-descriptionForeground); }
  .pill-overdue   { background: rgba(239,108,87,.2);  color: #ef6c57; }
  .pill-future    { background: rgba(6,214,160,.18);  color: #06d6a0; }
  .pill-linked    { background: rgba(116,185,255,.2); color: #74b9ff; }

  /* ── Active file picker ── */
  .file-picker {
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 12px 14px;
  }
  .file-picker label { font-size: 12px; font-weight: 600; opacity: .85; }
  .file-picker select { font-size: 12px; min-width: 220px; }

  /* ── Status bar preview ── */
  .statusbar-preview {
    background: var(--vscode-statusBar-background, #007acc);
    color: var(--vscode-statusBar-foreground, #fff);
    border-radius: 6px;
    padding: 0 10px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
    font-size: 12px;
    position: relative;
    overflow: hidden;
  }

  .statusbar-empty {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    opacity: .4;
    font-size: 11px;
    pointer-events: none;
  }

  .sb-item {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 10px;
    height: 100%;
    font-size: 12px;
    font-weight: 500;
    cursor: default;
    border-radius: 4px;
    transition: background .12s;
    white-space: nowrap;
    position: relative;
  }
  .sb-item:hover { background: rgba(255,255,255,.15); }
  .sb-item.warning {
    background: var(--vscode-statusBarItem-warningBackground, #c96d00);
    color: var(--vscode-statusBarItem-warningForeground, #fff);
  }
  .sb-item.warning:hover { filter: brightness(1.1); }

  /* Tooltip */
  .sb-tooltip {
    display: none;
    position: absolute;
    bottom: calc(100% + 6px);
    right: 0;
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 11px;
    line-height: 1.6;
    white-space: pre;
    color: var(--vscode-foreground);
    box-shadow: 0 4px 16px rgba(0,0,0,.3);
    z-index: 10;
    min-width: 200px;
  }
  .sb-item:hover .sb-tooltip { display: block; }

  /* ── Scenarios ── */
  .scenarios {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .scenario {
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .scenario-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .05em;
    opacity: .55;
  }
  .scenario-bar {
    background: var(--vscode-statusBar-background, #007acc);
    color: var(--vscode-statusBar-foreground, #fff);
    border-radius: 4px;
    height: 28px;
    padding: 0 8px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
    font-size: 11px;
  }
  .scenario-item {
    padding: 0 8px;
    height: 100%;
    display: flex;
    align-items: center;
    border-radius: 3px;
  }
  .scenario-item.warn {
    background: var(--vscode-statusBarItem-warningBackground, #c96d00);
  }
  .scenario-empty { opacity: .35; font-size: 11px; }
</style>
</head>
<body>

<h1>Status Bar Simulator</h1>

<!-- Active file picker -->
<div class="file-picker">
  <label for="active-file">Active editor file:</label>
  <select id="active-file">
    <option value="">(no file open)</option>
    <option value="src/auth.ts">src/auth.ts</option>
    <option value="src/api.ts">src/api.ts</option>
    <option value="src/utils.ts">src/utils.ts</option>
    <option value="src/index.ts">src/index.ts</option>
  </select>
</div>

<!-- Live preview + note controls -->
<div class="layout">

  <!-- Left: notes -->
  <div class="notes-panel">
    <h2>Mock Notes</h2>
    <div id="notes-container"></div>
  </div>

  <!-- Right: live status bar + scenarios -->
  <div style="display:flex;flex-direction:column;gap:16px;">

    <div>
      <h2>Live Status Bar Preview</h2>
      <div class="statusbar-preview" id="live-bar">
        <span class="statusbar-empty">status bar empty</span>
      </div>
    </div>

    <div class="scenarios">
      <h2>Fixed Scenarios</h2>
      <div id="scenarios-container"></div>
    </div>

  </div>
</div>

<script>
(() => {
  const now = Date.now();
  const hour = 3600000;
  const day  = 86400000;

  // ── State ──────────────────────────────────────────────────────────────────
  let notes = [
    { id:'n1', title:'Fix auth token expiry',   archived:false, reminder:'overdue-2h',  codeLink:'src/auth.ts:42'  },
    { id:'n2', title:'Refactor login flow',      archived:false, reminder:'overdue-1d',  codeLink:''                },
    { id:'n3', title:'Update docs',              archived:false, reminder:'future',       codeLink:''                },
    { id:'n4', title:'Old archived bug',         archived:true,  reminder:'overdue-2h',  codeLink:'src/auth.ts:10'  },
    { id:'n5', title:'Auth middleware note',     archived:false, reminder:'none',         codeLink:'src/auth.ts:88'  },
    { id:'n6', title:'API rate limiting',        archived:false, reminder:'none',         codeLink:'src/api.ts:15'   },
  ];

  function reminderTs(key) {
    if (key === 'overdue-2h')  return now - 2 * hour;
    if (key === 'overdue-1d')  return now - day;
    if (key === 'future')      return now + day;
    return null;
  }

  // ── Controller logic (mirrors StatusBarController.ts) ─────────────────────
  function getReminderItem(notes) {
    const overdue = notes.filter(n => !n.archived && reminderTs(n.reminder) && reminderTs(n.reminder) <= now);
    if (!overdue.length) return null;
    const count = overdue.length;
    return {
      text   : count === 1 ? \`🔔 1 overdue\` : \`🔔 \${count} overdue\`,
      tooltip: count === 1
        ? \`1 overdue reminder:\\n"\${overdue[0].title}"\\n\\nClick to open DevNotes\`
        : overdue.map(n => \`• \${n.title}\`).join('\\n') + \`\\n\\n\${count} overdue reminders\\nClick to open DevNotes\`,
      warning: true,
    };
  }

  function getLinkedItem(notes, activeFile) {
    if (!activeFile) return null;
    const linked = notes.filter(n => !n.archived && n.codeLink && n.codeLink.split(':')[0] === activeFile);
    if (!linked.length) return null;
    const count = linked.length;
    return {
      text   : \`📒 \${count} note\${count !== 1 ? 's' : ''} here\`,
      tooltip: linked.map(n => \`• \${n.title}\`).join('\\n') + '\\n\\nClick to open DevNotes',
      warning: false,
    };
  }

  // ── Render notes list ──────────────────────────────────────────────────────
  function renderNotes() {
    const container = document.getElementById('notes-container');
    container.innerHTML = '';
    notes.forEach((note, i) => {
      const row = document.createElement('div');
      row.className = 'note-row';

      const titleRow = document.createElement('div');
      titleRow.className = 'note-title';
      titleRow.textContent = note.title;

      if (note.archived) {
        const p = document.createElement('span');
        p.className = 'pill pill-archived'; p.textContent = 'archived';
        titleRow.appendChild(p);
      }
      const rem = reminderTs(note.reminder);
      if (rem && rem <= now && !note.archived) {
        const p = document.createElement('span');
        p.className = 'pill pill-overdue'; p.textContent = 'overdue';
        titleRow.appendChild(p);
      } else if (rem && rem > now && !note.archived) {
        const p = document.createElement('span');
        p.className = 'pill pill-future'; p.textContent = 'future';
        titleRow.appendChild(p);
      }
      if (note.codeLink && !note.archived) {
        const p = document.createElement('span');
        p.className = 'pill pill-linked'; p.textContent = note.codeLink;
        titleRow.appendChild(p);
      }

      const controls = document.createElement('div');
      controls.className = 'note-controls';

      // Archived toggle
      const archLabel = document.createElement('label');
      const archCheck = document.createElement('input');
      archCheck.type = 'checkbox'; archCheck.checked = note.archived;
      archCheck.addEventListener('change', () => { notes[i].archived = archCheck.checked; update(); });
      archLabel.append(archCheck, 'Archived');
      controls.appendChild(archLabel);

      // Reminder select
      const remLabel = document.createElement('label');
      remLabel.textContent = 'Reminder: ';
      const remSel = document.createElement('select');
      [['none','None'],['future','Future'],['overdue-2h','Overdue 2h'],['overdue-1d','Overdue 1d']]
        .forEach(([val, txt]) => {
          const opt = document.createElement('option');
          opt.value = val; opt.textContent = txt;
          if (val === note.reminder) opt.selected = true;
          remSel.appendChild(opt);
        });
      remSel.addEventListener('change', () => { notes[i].reminder = remSel.value; update(); });
      remLabel.appendChild(remSel);
      controls.appendChild(remLabel);

      // Code link select
      const linkLabel = document.createElement('label');
      linkLabel.textContent = 'Link: ';
      const linkSel = document.createElement('select');
      [['','None'],['src/auth.ts:42','auth.ts:42'],['src/auth.ts:88','auth.ts:88'],['src/api.ts:15','api.ts:15'],['src/index.ts:5','index.ts:5']]
        .forEach(([val, txt]) => {
          const opt = document.createElement('option');
          opt.value = val; opt.textContent = txt;
          if (val === note.codeLink) opt.selected = true;
          linkSel.appendChild(opt);
        });
      linkSel.addEventListener('change', () => { notes[i].codeLink = linkSel.value; update(); });
      linkLabel.appendChild(linkSel);
      controls.appendChild(linkLabel);

      row.append(titleRow, controls);
      container.appendChild(row);
    });
  }

  // ── Render live bar ────────────────────────────────────────────────────────
  function renderLiveBar() {
    const bar        = document.getElementById('live-bar');
    const activeFile = document.getElementById('active-file').value;
    const r          = getReminderItem(notes);
    const l          = getLinkedItem(notes, activeFile);

    bar.innerHTML = '';

    if (!r && !l) {
      const empty = document.createElement('span');
      empty.className = 'statusbar-empty';
      empty.textContent = 'status bar empty';
      bar.appendChild(empty);
      return;
    }

    [r, l].filter(Boolean).forEach(item => {
      const el = document.createElement('div');
      el.className = 'sb-item' + (item.warning ? ' warning' : '');
      el.textContent = item.text;
      const tip = document.createElement('div');
      tip.className = 'sb-tooltip';
      tip.textContent = item.tooltip;
      el.appendChild(tip);
      bar.appendChild(el);
    });
  }

  // ── Render fixed scenarios ─────────────────────────────────────────────────
  function renderScenarios() {
    const scenarios = [
      { title: 'No active editor',             file: '' },
      { title: 'src/auth.ts open',             file: 'src/auth.ts' },
      { title: 'src/utils.ts open (no notes)', file: 'src/utils.ts' },
    ];

    const container = document.getElementById('scenarios-container');
    container.innerHTML = '';

    scenarios.forEach(sc => {
      const r = getReminderItem(notes);
      const l = getLinkedItem(notes, sc.file);

      const wrap = document.createElement('div');
      wrap.className = 'scenario';

      const titleEl = document.createElement('div');
      titleEl.className = 'scenario-title';
      titleEl.textContent = sc.title;

      const barEl = document.createElement('div');
      barEl.className = 'scenario-bar';

      if (!r && !l) {
        const e = document.createElement('span');
        e.className = 'scenario-empty'; e.textContent = 'nothing shown';
        barEl.appendChild(e);
      } else {
        [r, l].filter(Boolean).forEach(item => {
          const el = document.createElement('div');
          el.className = 'scenario-item' + (item.warning ? ' warn' : '');
          el.textContent = item.text;
          barEl.appendChild(el);
        });
      }

      wrap.append(titleEl, barEl);
      container.appendChild(wrap);
    });
  }

  // ── Update all ─────────────────────────────────────────────────────────────
  function update() {
    renderNotes();
    renderLiveBar();
    renderScenarios();
  }

  document.getElementById('active-file').addEventListener('change', update);

  update();
})();
</script>
</body>
</html>`;
}
