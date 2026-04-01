import * as vscode from 'vscode';
import { NoteStorage, NOTE_COLORS } from './NoteStorage';

// ─── Panel ───────────────────────────────────────────────────────────────────

export class CanvasPanel {
  static current?: CanvasPanel;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private focusNoteId?: string;

  // ── Static factory ──────────────────────────────────────────────────────

  static show(
    context: vscode.ExtensionContext,
    storage: NoteStorage,
    focusNoteId?: string,
    onUpdate?: () => void
  ): void {
    if (CanvasPanel.current) {
      CanvasPanel.current.panel.reveal(vscode.ViewColumn.One);
      CanvasPanel.current.push(focusNoteId);
      return;
    }
    new CanvasPanel(context, storage, focusNoteId, onUpdate);
  }

  // ── Constructor ─────────────────────────────────────────────────────────

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly storage: NoteStorage,
    focusNoteId?: string,
    private readonly onUpdate?: () => void
  ) {
    this.focusNoteId = focusNoteId;

    this.panel = vscode.window.createWebviewPanel(
      'devnotes.canvas',
      'DevNotes Canvas',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      }
    );

    const canvasJsUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'media', 'canvas.js')
    );

    this.panel.webview.html = this.buildHtml(canvasJsUri);

    this.panel.webview.onDidReceiveMessage(
      (msg: unknown) => this.handle(msg),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => {
      CanvasPanel.current = undefined;
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);

    CanvasPanel.current = this;
  }

  // ── Push data to webview ────────────────────────────────────────────────

  push(focusNoteId?: string): void {
    if (focusNoteId !== undefined) this.focusNoteId = focusNoteId;
    this.panel.webview.postMessage({
      type        : 'init',
      notes       : this.storage.getNotes(),
      tags        : this.storage.getTags(),
      focusNoteId : this.focusNoteId,
    });
  }

  // ── Message handler ─────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handle(msg: any): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.push();
        break;

      case 'updateNote':
        await this.storage.updateNote(msg.id, msg.changes);
        this.onUpdate?.();
        break;

      case 'createNote': {
        const note = await this.storage.createNote({
          title: msg.title || 'Untitled',
          color: msg.color ?? 'yellow',
        });
        this.focusNoteId = note.id;
        this.onUpdate?.();
        this.push(note.id);
        break;
      }

      case 'deleteNote': {
        const note = this.storage.getNote(msg.id);
        if (!note) break;
        const ans = await vscode.window.showWarningMessage(
          `Delete "${note.title}"?`, { modal: true }, 'Delete'
        );
        if (ans === 'Delete') {
          await this.storage.deleteNote(msg.id);
          this.focusNoteId = undefined;
          this.onUpdate?.();
          this.push();
        }
        break;
      }
    }
  }

  // ── HTML ────────────────────────────────────────────────────────────────

  private buildHtml(canvasJsUri: vscode.Uri): string {
    const nonce      = getNonce();
    const colorsJson = JSON.stringify(NOTE_COLORS);
    const cspSrc     = this.panel.webview.cspSource;

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${cspSrc};">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DevNotes Canvas</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root { --card-text: #1a1a2e; --radius: 10px; --gap: 16px; }

  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Toolbar ─────────────────────────────────────────── */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 14px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    background: var(--vscode-titleBar-activeBackground, var(--vscode-sideBar-background));
  }
  .toolbar-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .05em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tb-group { display: flex; gap: 2px; }
  .tb-btn {
    padding: 4px 10px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 5px;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 11px;
    font-family: var(--vscode-font-family);
    font-weight: 600;
    opacity: .7;
    transition: opacity .1s, background .1s;
  }
  .tb-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .tb-btn.active { opacity: 1; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  .tb-btn-new {
    padding: 4px 12px;
    border: none;
    border-radius: 5px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    cursor: pointer;
    font-size: 12px;
    font-family: var(--vscode-font-family);
    font-weight: 700;
  }
  .tb-btn-new:hover { filter: brightness(1.1); }

  /* ── Canvas area ─────────────────────────────────────── */
  .canvas-scroll {
    flex: 1;
    overflow: auto;
  }
  .canvas-area {
    min-height: 100%;
    padding: var(--gap);
  }
  .canvas-area.grid-mode {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: var(--gap);
    align-content: start;
  }
  .canvas-area.free-mode {
    position: relative;
    min-height: 2400px;
    min-width: 2400px;
  }

  /* ── Card ────────────────────────────────────────────── */
  .card {
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
    box-shadow: 0 2px 8px rgba(0,0,0,.12);
    color: var(--card-text);
    overflow: visible;
    transition: box-shadow .15s;
  }
  .card:hover { box-shadow: 0 4px 18px rgba(0,0,0,.18); }
  .card.editing { box-shadow: 0 4px 20px rgba(0,0,0,.22); }

  .free-mode .card {
    position: absolute;
    overflow: hidden;
  }
  .grid-mode .card { min-height: 220px; }

  /* Card header */
  .card-header {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 9px 10px 7px;
    border-radius: var(--radius) var(--radius) 0 0;
    background: rgba(0,0,0,.06);
    flex-shrink: 0;
    position: relative;
  }
  .drag-handle {
    cursor: grab;
    font-size: 16px;
    opacity: .35;
    flex-shrink: 0;
    line-height: 1;
    user-select: none;
    display: none;
  }
  .free-mode .drag-handle { display: block; }
  .drag-handle:active { cursor: grabbing; }

  .card-title {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    font-size: 13px;
    font-weight: 700;
    color: var(--card-text);
    min-width: 0;
    padding: 0;
  }
  .card-title:focus { border-bottom: 1.5px solid rgba(26,26,46,.35); }

  .card-actions { display: flex; gap: 2px; flex-shrink: 0; }
  .card-btn {
    width: 22px; height: 22px;
    background: rgba(0,0,0,.1);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    color: var(--card-text);
    display: flex; align-items: center; justify-content: center;
  }
  .card-btn:hover { background: rgba(0,0,0,.2); }

  /* Color picker */
  .color-pop {
    position: absolute;
    top: 32px; right: 8px;
    background: var(--vscode-editorWidget-background, #fff);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 8px;
    display: none;
    flex-wrap: wrap;
    gap: 6px;
    width: 132px;
    z-index: 200;
    box-shadow: 0 4px 16px rgba(0,0,0,.2);
  }
  .color-pop.open { display: flex; }
  .color-swatch {
    width: 26px; height: 26px;
    border-radius: 50%;
    border: 2px solid rgba(255,255,255,.6);
    cursor: pointer;
    box-shadow: 0 1px 4px rgba(0,0,0,.18);
    transition: transform .1s;
  }
  .color-swatch:hover { transform: scale(1.15); }
  .color-swatch.selected { border-color: #1a1a2e; }

  /* Tiptap mini toolbar */
  .tiptap-toolbar {
    display: none;
    gap: 2px;
    padding: 4px 10px;
    background: rgba(0,0,0,.05);
    border-bottom: 1px solid rgba(0,0,0,.08);
    flex-wrap: wrap;
    flex-shrink: 0;
  }
  .tiptap-toolbar button {
    padding: 2px 7px;
    border: none;
    border-radius: 3px;
    background: rgba(0,0,0,.08);
    cursor: pointer;
    font-size: 11px;
    color: var(--card-text);
    font-family: inherit;
    line-height: 1.6;
  }
  .tiptap-toolbar button:hover { background: rgba(0,0,0,.18); }
  .tiptap-toolbar button.is-active { background: rgba(0,0,0,.22); }
  .tiptap-toolbar .sep {
    width: 1px;
    background: rgba(0,0,0,.15);
    margin: 2px 2px;
    align-self: stretch;
  }

  /* Card content */
  .card-content {
    flex: 1;
    padding: 10px 12px 8px;
    min-height: 80px;
    overflow-y: auto;
    cursor: text;
  }
  .free-mode .card-content { overflow-y: auto; }

  /* Preview (rendered markdown) */
  .card-preview { font-size: 12px; line-height: 1.6; color: var(--card-text); opacity: .88; }
  .card-preview p        { margin: 0 0 4px; }
  .card-preview strong   { font-weight: 700; }
  .card-preview em       { font-style: italic; }
  .card-preview del      { text-decoration: line-through; }
  .card-preview code     { background: rgba(0,0,0,.1); border-radius: 3px; padding: 0 3px; font-size: .85em; }
  .card-preview ul, .card-preview ol { padding-left: 1.2em; margin: 0 0 4px; }
  .card-preview.empty    { opacity: .4; font-style: italic; }

  /* Tiptap editor mount */
  .tiptap-mount { display: none; }
  .tiptap-mount .ProseMirror {
    outline: none;
    min-height: 60px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--card-text);
  }
  .tiptap-mount .ProseMirror p      { margin: 0 0 4px; }
  .tiptap-mount .ProseMirror h1     { font-size: 1.3em; font-weight: 700; margin: 0 0 4px; }
  .tiptap-mount .ProseMirror h2     { font-size: 1.15em; font-weight: 700; margin: 0 0 4px; }
  .tiptap-mount .ProseMirror h3     { font-size: 1.05em; font-weight: 700; margin: 0 0 4px; }
  .tiptap-mount .ProseMirror strong { font-weight: 700; }
  .tiptap-mount .ProseMirror em     { font-style: italic; }
  .tiptap-mount .ProseMirror code   { background: rgba(0,0,0,.1); border-radius: 3px; padding: 0 3px; font-size: .85em; }
  .tiptap-mount .ProseMirror pre    { background: rgba(0,0,0,.1); border-radius: 5px; padding: 8px; margin: 4px 0; font-size: .85em; overflow-x: auto; }
  .tiptap-mount .ProseMirror ul, .tiptap-mount .ProseMirror ol { padding-left: 1.2em; margin: 0 0 4px; }
  .tiptap-mount .ProseMirror li     { margin: 1px 0; }
  .tiptap-mount .ProseMirror blockquote { border-left: 3px solid rgba(0,0,0,.25); padding-left: 8px; margin: 4px 0; opacity: .8; }
  .tiptap-mount .ProseMirror ul[data-type="taskList"] { list-style: none; padding-left: 0; }
  .tiptap-mount .ProseMirror ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 5px; }
  .tiptap-mount .ProseMirror ul[data-type="taskList"] li > label { flex-shrink: 0; margin-top: 2px; }

  /* Card footer */
  .card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    padding: 5px 12px 8px;
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .card-tags { display: flex; gap: 3px; flex-wrap: wrap; }
  .tag-pill  { font-size: 10px; padding: 1px 6px; border-radius: 10px; font-weight: 600; color: #1a1a2e; }
  .card-date { font-size: 10px; opacity: .5; white-space: nowrap; }

  /* Resize handle */
  .resize-handle {
    display: none;
    position: absolute;
    bottom: 0; right: 0;
    width: 16px; height: 16px;
    cursor: nwse-resize;
    border-radius: 0 0 var(--radius) 0;
    opacity: .4;
    background: linear-gradient(135deg, transparent 50%, rgba(0,0,0,.35) 50%);
  }
  .free-mode .resize-handle { display: block; }

  /* ── Empty state ─────────────────────────────────────── */
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
    padding: 60px 24px;
  }
  .empty-icon { font-size: 3em; opacity: .5; }
  .empty p    { font-size: 13px; line-height: 1.5; }

  /* ── New note quick-add form ─────────────────────────── */
  .quick-add-overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,.35);
    display: flex; align-items: center; justify-content: center;
    z-index: 500;
    display: none;
  }
  .quick-add-overlay.open { display: flex; }
  .quick-add-box {
    background: var(--vscode-editorWidget-background, #fff);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px;
    padding: 20px;
    width: 320px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,.25);
  }
  .quick-add-box h3 { font-size: 14px; font-weight: 700; color: var(--vscode-foreground); }
  .quick-add-box input {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 5px;
    padding: 7px 10px;
    font-size: 13px;
    color: var(--vscode-input-foreground);
    outline: none;
    font-family: var(--vscode-font-family);
    width: 100%;
  }
  .quick-add-box input:focus { border-color: var(--vscode-focusBorder); }
  .quick-add-colors { display: flex; gap: 6px; flex-wrap: wrap; }
  .quick-add-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .qa-btn {
    padding: 5px 14px;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    font-size: 12px;
    font-family: var(--vscode-font-family);
    font-weight: 600;
  }
  .qa-btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .qa-btn-ghost   { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
</style>
</head>
<body>

<!-- ── Toolbar ── -->
<div class="toolbar">
  <span class="toolbar-title" id="toolbar-title">DevNotes Canvas</span>
  <div class="tb-group">
    <button class="tb-btn active" id="btn-grid" title="Grid layout">Grid</button>
    <button class="tb-btn"        id="btn-free" title="Freeform layout">Freeform</button>
  </div>
  <button class="tb-btn-new" id="btn-new">+ Note</button>
</div>

<!-- ── Canvas scroll wrapper ── -->
<div class="canvas-scroll">
  <div class="canvas-area grid-mode" id="canvas-area"></div>
</div>

<!-- ── New note quick-add overlay ── -->
<div class="quick-add-overlay" id="qa-overlay">
  <div class="quick-add-box">
    <h3>New Note</h3>
    <input id="qa-title" type="text" placeholder="Note title…" maxlength="120" autocomplete="off">
    <div class="quick-add-colors" id="qa-colors"></div>
    <div class="quick-add-actions">
      <button class="qa-btn qa-btn-ghost"   id="qa-cancel">Cancel</button>
      <button class="qa-btn qa-btn-primary" id="qa-confirm">Create</button>
    </div>
  </div>
</div>

<script src="${canvasJsUri}" nonce="${nonce}"></script>
<script nonce="${nonce}">
(function () {
  'use strict';

  const vscode     = acquireVsCodeApi();
  const COLORS     = ${colorsJson};
  const COLOR_KEYS = Object.keys(COLORS);

  let notes        = [];
  let tags         = [];
  let isFreeMode   = false;
  let activeCardId = null;
  let activeEditor = null;
  let saveDebounce = null;
  let qaColor      = COLOR_KEYS[0];

  const canvasArea = document.getElementById('canvas-area');
  const qaOverlay  = document.getElementById('qa-overlay');
  const qaTitleEl  = document.getElementById('qa-title');
  const qaColorsEl = document.getElementById('qa-colors');

  // ── Bootstrap ──────────────────────────────────────────────────────────
  vscode.postMessage({ type: 'ready' });

  window.addEventListener('message', function (ev) {
    var msg = ev.data;
    if (msg.type !== 'init') return;
    notes = msg.notes || [];
    tags  = msg.tags  || [];
    if (msg.projectName) {
      document.getElementById('toolbar-title').textContent = msg.projectName + ' — Canvas';
    }
    // If an editor was open, save it before re-render
    if (activeEditor && activeCardId) flushEditor();
    renderCanvas(msg.focusNoteId);
  });

  // ── Mode toggle ────────────────────────────────────────────────────────
  document.getElementById('btn-grid').addEventListener('click', function () {
    if (!isFreeMode) return;
    isFreeMode = false;
    document.getElementById('btn-grid').classList.add('active');
    document.getElementById('btn-free').classList.remove('active');
    renderCanvas();
  });

  document.getElementById('btn-free').addEventListener('click', function () {
    if (isFreeMode) return;
    isFreeMode = true;
    document.getElementById('btn-free').classList.add('active');
    document.getElementById('btn-grid').classList.remove('active');
    renderCanvas();
  });

  // ── New note ───────────────────────────────────────────────────────────
  document.getElementById('btn-new').addEventListener('click', openQuickAdd);
  document.getElementById('qa-cancel').addEventListener('click', closeQuickAdd);
  document.getElementById('qa-confirm').addEventListener('click', confirmQuickAdd);

  qaOverlay.addEventListener('click', function (e) {
    if (e.target === qaOverlay) closeQuickAdd();
  });

  qaTitleEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter')  { e.preventDefault(); confirmQuickAdd(); }
    if (e.key === 'Escape') closeQuickAdd();
  });

  function openQuickAdd() {
    buildColorStrip(qaColorsEl, function (k) { qaColor = k; highlightStrip(qaColorsEl, k); });
    highlightStrip(qaColorsEl, qaColor);
    qaOverlay.classList.add('open');
    qaTitleEl.value = '';
    setTimeout(function () { qaTitleEl.focus(); }, 50);
  }

  function closeQuickAdd() {
    qaOverlay.classList.remove('open');
    qaTitleEl.value = '';
  }

  function confirmQuickAdd() {
    var title = qaTitleEl.value.trim();
    if (!title) { qaTitleEl.focus(); return; }
    vscode.postMessage({ type: 'createNote', title: title, color: qaColor });
    closeQuickAdd();
  }

  // ── Render ─────────────────────────────────────────────────────────────
  function renderCanvas(focusNoteId) {
    if (activeEditor) { activeEditor.destroy(); activeEditor = null; }
    activeCardId = null;

    canvasArea.innerHTML = '';
    canvasArea.className = 'canvas-area ' + (isFreeMode ? 'free-mode' : 'grid-mode');

    if (notes.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      var icon = document.createElement('div');
      icon.className = 'empty-icon';
      icon.textContent = '📋';
      var txt = document.createElement('p');
      txt.innerHTML = 'No notes yet.<br>Click <strong>+ Note</strong> to create one.';
      empty.append(icon, txt);
      canvasArea.appendChild(empty);
      return;
    }

    var sorted = notes.slice().sort(function (a, b) {
      return (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || b.updatedAt - a.updatedAt;
    });

    sorted.forEach(function (note, idx) {
      var card = buildCard(note);
      canvasArea.appendChild(card);

      if (isFreeMode) {
        var pos = note.canvas || defaultPos(idx);
        card.style.left   = pos.x + 'px';
        card.style.top    = pos.y + 'px';
        card.style.width  = (pos.w || 250) + 'px';
        card.style.height = (pos.h || 280) + 'px';
        setupDrag(card, note);
        setupResize(card, note);
      }

      if (focusNoteId && note.id === focusNoteId) {
        setTimeout(function () { activateCard(card, note); }, 80);
      }
    });
  }

  function defaultPos(idx) {
    var col = idx % 4, row = Math.floor(idx / 4);
    return { x: 20 + col * 270, y: 20 + row * 310, w: 250, h: 280 };
  }

  // ── Build card DOM ─────────────────────────────────────────────────────
  function buildCard(note) {
    var bg   = COLORS[note.color] || COLORS['yellow'];
    var card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = note.id;
    card.style.background = bg;

    // ─ Header ─
    var hdr  = document.createElement('div');
    hdr.className = 'card-header';

    var dragH = document.createElement('div');
    dragH.className = 'drag-handle';
    dragH.title = 'Drag';
    dragH.textContent = '⠿';

    var titleEl = document.createElement('input');
    titleEl.className = 'card-title';
    titleEl.type = 'text';
    titleEl.value = note.title;
    titleEl.setAttribute('aria-label', 'Note title');

    var actions = document.createElement('div');
    actions.className = 'card-actions';

    var colorBtn = document.createElement('button');
    colorBtn.className = 'card-btn';
    colorBtn.title = 'Change color';
    colorBtn.textContent = '🎨';

    var delBtn = document.createElement('button');
    delBtn.className = 'card-btn';
    delBtn.title = 'Delete note';
    delBtn.textContent = '✕';

    actions.append(colorBtn, delBtn);
    hdr.append(dragH, titleEl, actions);

    // ─ Color pop ─
    var colorPop = document.createElement('div');
    colorPop.className = 'color-pop';
    COLOR_KEYS.forEach(function (key) {
      var sw = document.createElement('div');
      sw.className = 'color-swatch' + (note.color === key ? ' selected' : '');
      sw.style.background = COLORS[key];
      sw.title = key;
      sw.dataset.key = key;
      colorPop.appendChild(sw);
    });
    hdr.appendChild(colorPop);

    // ─ Tiptap mini toolbar ─
    var tbar = document.createElement('div');
    tbar.className = 'tiptap-toolbar';
    [
      ['bold',        '<strong>B</strong>'],
      ['italic',      '<em>I</em>'],
      ['h2',          'H2'],
      ['bulletList',  '• —'],
      ['taskList',    '☐'],
      ['codeBlock',   '</>', true],
      ['undo',        '↩'],
      ['redo',        '↪'],
    ].forEach(function (item) {
      var action = item[0], label = item[1], isSafe = item[2];
      var btn = document.createElement('button');
      btn.dataset.action = action;
      if (isSafe) {
        btn.textContent = label;
      } else {
        btn.innerHTML = label;
      }
      tbar.appendChild(btn);
    });

    // ─ Content ─
    var contentWrap = document.createElement('div');
    contentWrap.className = 'card-content';

    var preview = document.createElement('div');
    preview.className = 'card-preview';
    if (note.content) {
      preview.innerHTML = simpleMarkdown(note.content);
    } else {
      preview.className += ' empty';
      preview.textContent = 'Click to write…';
    }

    var mount = document.createElement('div');
    mount.className = 'tiptap-mount';

    contentWrap.append(preview, mount);

    // ─ Footer ─
    var footer = document.createElement('div');
    footer.className = 'card-footer';

    var tagRow = document.createElement('div');
    tagRow.className = 'card-tags';
    (note.tags || []).forEach(function (tid) {
      var tag = tags.find(function (t) { return t.id === tid; });
      if (!tag) return;
      var pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.style.background = tag.color;
      pill.textContent = tag.label;
      tagRow.appendChild(pill);
    });

    var dateEl = document.createElement('span');
    dateEl.className = 'card-date';
    dateEl.textContent = formatDate(note.updatedAt);

    footer.append(tagRow, dateEl);

    // ─ Resize handle ─
    var resizeH = document.createElement('div');
    resizeH.className = 'resize-handle';

    card.append(hdr, tbar, contentWrap, footer, resizeH);

    // ─ Events ─

    titleEl.addEventListener('blur', function () {
      var v = titleEl.value.trim() || note.title;
      if (v !== note.title) {
        note.title = v;
        vscode.postMessage({ type: 'updateNote', id: note.id, changes: { title: v } });
      }
    });
    titleEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
    });

    colorBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var wasOpen = colorPop.classList.contains('open');
      closeAllColorPops();
      if (!wasOpen) colorPop.classList.add('open');
    });

    colorPop.addEventListener('click', function (e) {
      e.stopPropagation();
      var sw = e.target.closest('.color-swatch');
      if (!sw) return;
      var key = sw.dataset.key;
      card.style.background = COLORS[key];
      note.color = key;
      colorPop.querySelectorAll('.color-swatch').forEach(function (s) {
        s.classList.toggle('selected', s.dataset.key === key);
      });
      colorPop.classList.remove('open');
      vscode.postMessage({ type: 'updateNote', id: note.id, changes: { color: key } });
    });

    delBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      vscode.postMessage({ type: 'deleteNote', id: note.id });
    });

    contentWrap.addEventListener('click', function () {
      activateCard(card, note);
    });

    tbar.addEventListener('mousedown', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      e.preventDefault();
      if (!activeEditor || activeCardId !== note.id) return;
      var ch = activeEditor.chain().focus();
      switch (btn.dataset.action) {
        case 'bold':        ch.toggleBold().run();                break;
        case 'italic':      ch.toggleItalic().run();              break;
        case 'h2':          ch.toggleHeading({ level: 2 }).run(); break;
        case 'bulletList':  ch.toggleBulletList().run();          break;
        case 'taskList':    ch.toggleTaskList().run();            break;
        case 'codeBlock':   ch.toggleCodeBlock().run();           break;
        case 'undo':        ch.undo().run();                      break;
        case 'redo':        ch.redo().run();                      break;
      }
    });

    return card;
  }

  // ── Activate / deactivate Tiptap ───────────────────────────────────────
  function activateCard(card, note) {
    if (activeCardId === note.id) return;
    if (activeCardId) deactivateCard();

    activeCardId = note.id;
    card.classList.add('editing');

    var preview = card.querySelector('.card-preview');
    var mount   = card.querySelector('.tiptap-mount');
    var tbar    = card.querySelector('.tiptap-toolbar');

    preview.style.display = 'none';
    mount.style.display   = 'block';
    tbar.style.display    = 'flex';

    if (typeof window.initTiptap === 'function') {
      activeEditor = window.initTiptap(mount, note.content || '', function (md) {
        note.content = md;
        scheduleSave(note.id, md);
        syncToolbarState(tbar, activeEditor);
      });
      activeEditor.on('selectionUpdate', function () { syncToolbarState(tbar, activeEditor); });
      setTimeout(function () { if (activeEditor) activeEditor.commands.focus('end'); }, 30);
    }
  }

  function deactivateCard() {
    if (!activeCardId) return;
    var card = canvasArea.querySelector('.card[data-id="' + activeCardId + '"]');
    if (card) {
      var preview = card.querySelector('.card-preview');
      var mount   = card.querySelector('.tiptap-mount');
      var tbar    = card.querySelector('.tiptap-toolbar');

      if (activeEditor) {
        var storage = activeEditor.storage;
        var md = storage && storage.markdown && typeof storage.markdown.getMarkdown === 'function'
          ? storage.markdown.getMarkdown()
          : '';
        if (saveDebounce) { clearTimeout(saveDebounce); saveDebounce = null; }
        var noteForCard = notes.find(function (n) { return n.id === activeCardId; });
        if (noteForCard) noteForCard.content = md;
        vscode.postMessage({ type: 'updateNote', id: activeCardId, changes: { content: md } });

        // Refresh preview
        if (md) {
          preview.className = 'card-preview';
          preview.innerHTML = simpleMarkdown(md);
        } else {
          preview.className = 'card-preview empty';
          preview.textContent = 'Click to write…';
        }

        activeEditor.destroy();
        activeEditor = null;
      }

      mount.innerHTML    = '';
      mount.style.display   = 'none';
      tbar.style.display    = 'none';
      preview.style.display = '';
      card.classList.remove('editing');
    }
    activeCardId = null;
  }

  function flushEditor() {
    deactivateCard();
  }

  function syncToolbarState(tbar, editor) {
    if (!editor) return;
    tbar.querySelectorAll('[data-action]').forEach(function (btn) {
      switch (btn.dataset.action) {
        case 'bold':       btn.classList.toggle('is-active', editor.isActive('bold'));              break;
        case 'italic':     btn.classList.toggle('is-active', editor.isActive('italic'));            break;
        case 'h2':         btn.classList.toggle('is-active', editor.isActive('heading', {level:2})); break;
        case 'bulletList': btn.classList.toggle('is-active', editor.isActive('bulletList'));        break;
        case 'taskList':   btn.classList.toggle('is-active', editor.isActive('taskList'));          break;
        case 'codeBlock':  btn.classList.toggle('is-active', editor.isActive('codeBlock'));         break;
      }
    });
  }

  var pendingSaves = {};
  function scheduleSave(id, md) {
    pendingSaves[id] = md;
    if (saveDebounce) clearTimeout(saveDebounce);
    saveDebounce = setTimeout(function () {
      Object.keys(pendingSaves).forEach(function (noteId) {
        vscode.postMessage({ type: 'updateNote', id: noteId, changes: { content: pendingSaves[noteId] } });
      });
      pendingSaves = {};
    }, 800);
  }

  // ── Drag (freeform) ────────────────────────────────────────────────────
  function setupDrag(card, note) {
    var handle = card.querySelector('.drag-handle');
    var sx, sy, sl, st;

    handle.addEventListener('pointerdown', function (e) {
      if (!isFreeMode) return;
      e.preventDefault();
      sx = e.clientX; sy = e.clientY;
      sl = parseInt(card.style.left) || 0;
      st = parseInt(card.style.top)  || 0;
      handle.setPointerCapture(e.pointerId);
      card.style.zIndex = '100';
    });
    handle.addEventListener('pointermove', function (e) {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      card.style.left = (sl + e.clientX - sx) + 'px';
      card.style.top  = (st + e.clientY - sy) + 'px';
    });
    handle.addEventListener('pointerup', function (e) {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      handle.releasePointerCapture(e.pointerId);
      card.style.zIndex = '';
      var x = parseInt(card.style.left), y = parseInt(card.style.top);
      var w = card.offsetWidth, h = card.offsetHeight;
      note.canvas = { x: x, y: y, w: w, h: h };
      vscode.postMessage({ type: 'updateNote', id: note.id, changes: { canvas: note.canvas } });
    });
  }

  // ── Resize (freeform) ──────────────────────────────────────────────────
  function setupResize(card, note) {
    var handle = card.querySelector('.resize-handle');
    var sx, sy, sw, sh;

    handle.addEventListener('pointerdown', function (e) {
      if (!isFreeMode) return;
      e.preventDefault(); e.stopPropagation();
      sx = e.clientX; sy = e.clientY;
      sw = card.offsetWidth; sh = card.offsetHeight;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', function (e) {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      card.style.width  = Math.max(180, sw + e.clientX - sx) + 'px';
      card.style.height = Math.max(150, sh + e.clientY - sy) + 'px';
    });
    handle.addEventListener('pointerup', function (e) {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      handle.releasePointerCapture(e.pointerId);
      var x = parseInt(card.style.left), y = parseInt(card.style.top);
      var w = card.offsetWidth, h = card.offsetHeight;
      note.canvas = { x: x, y: y, w: w, h: h };
      vscode.postMessage({ type: 'updateNote', id: note.id, changes: { canvas: note.canvas } });
    });
  }

  // ── Outside-click cleanup ──────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    // Close color pops
    if (!e.target.closest('.color-pop') && !e.target.closest('.card-btn')) {
      closeAllColorPops();
    }
    // Deactivate editor if click is outside any card
    if (activeCardId && !e.target.closest('.card')) {
      deactivateCard();
    }
  });

  function closeAllColorPops() {
    canvasArea.querySelectorAll('.color-pop.open').forEach(function (el) {
      el.classList.remove('open');
    });
  }

  // ── Color strip helpers ────────────────────────────────────────────────
  function buildColorStrip(container, onSelect) {
    container.innerHTML = '';
    COLOR_KEYS.forEach(function (key) {
      var sw = document.createElement('div');
      sw.className = 'color-swatch';
      sw.style.background = COLORS[key];
      sw.title = key;
      sw.dataset.colorKey = key;
      sw.addEventListener('click', function () { onSelect(key); });
      container.appendChild(sw);
    });
  }

  function highlightStrip(container, key) {
    container.querySelectorAll('.color-swatch').forEach(function (sw) {
      sw.classList.toggle('selected', sw.dataset.colorKey === key);
    });
  }

  // ── Markdown preview helper ────────────────────────────────────────────
  function simpleMarkdown(md) {
    if (!md) return '';
    function esc(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    return md.split('\n').map(function (line) {
      var l = esc(line)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g,     '<em>$1</em>')
        .replace(/\`(.+?)\`/g,     '<code>$1</code>')
        .replace(/~~(.+?)~~/g,     '<del>$1</del>');
      if (/^#{1,3}\s/.test(line)) {
        l = '<strong>' + l.replace(/^#+\s/, '') + '</strong>';
      }
      return '<p>' + (l || '&nbsp;') + '</p>';
    }).join('');
  }

  // ── Date formatter ─────────────────────────────────────────────────────
  function formatDate(ts) {
    var d   = new Date(ts);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

}());
</script>
</body>
</html>`;
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
