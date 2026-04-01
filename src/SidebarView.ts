import * as vscode from 'vscode';
import { NoteStorage, Note, Tag, NOTE_COLORS } from './NoteStorage';

// ─── Message types ────────────────────────────────────────────────────────────

type ToExt =
  | { type: 'ready' }
  | { type: 'createNote'; title: string; color: string }
  | { type: 'updateNote'; id: string; changes: Partial<Note> }
  | { type: 'deleteNote'; id: string }
  | { type: 'openCanvas'; noteId?: string }
  | { type: 'addTag'; label: string; color: string }
  | { type: 'deleteTag'; id: string };

// ─── Provider ────────────────────────────────────────────────────────────────

export class SidebarView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private projectName = 'DevNotes';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly storage: NoteStorage,
    private readonly onOpenCanvas: (noteId?: string) => void
  ) {}

  setProjectName(name: string): void {
    this.projectName = name;
    this.push();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: ToExt) => this.handle(msg));

    // Push fresh data whenever the panel becomes visible
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.push();
    });
  }

  /** Call this after any storage mutation to sync the sidebar. */
  push(): void {
    if (!this.view?.visible) return;
    this.view.webview.postMessage({
      type       : 'init',
      notes      : this.storage.getNotes(),
      tags       : this.storage.getTags(),
      projectName: this.projectName,
    });
  }

  // ── Message handler ──────────────────────────────────────────────────────

  private async handle(msg: ToExt): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.push();
        break;

      case 'createNote':
        await this.storage.createNote({ title: msg.title, color: msg.color });
        this.push();
        break;

      case 'updateNote':
        await this.storage.updateNote(msg.id, msg.changes);
        this.push();
        break;

      case 'deleteNote': {
        const note = this.storage.getNote(msg.id);
        if (!note) break;
        const ans = await vscode.window.showWarningMessage(
          `Delete "${note.title}"?`, { modal: true }, 'Delete'
        );
        if (ans === 'Delete') {
          await this.storage.deleteNote(msg.id);
          this.push();
        }
        break;
      }

      case 'openCanvas':
        this.onOpenCanvas(msg.noteId);
        break;

      case 'addTag': {
        await this.storage.addTag(msg.label, msg.color);
        this.push();
        break;
      }

      case 'deleteTag': {
        await this.storage.deleteTag(msg.id);
        this.push();
        break;
      }
    }
  }

  // ── HTML ─────────────────────────────────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
    const nonce      = getNonce();
    const colorsJson = JSON.stringify(NOTE_COLORS);

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --radius: 10px;
    --gap: 10px;
    --card-text: #1a1a2e;
  }

  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    background: var(--vscode-sideBar-background);
    color: var(--vscode-foreground);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Top bar ─────────────────────────────────────────── */
  .topbar {
    padding: 8px 10px 6px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .topbar-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .project-name {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .04em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .icon-btn {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 3px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: .7;
  }
  .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

  .search-row {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 6px;
    padding: 4px 8px;
  }
  .search-row input {
    flex: 1;
    border: none;
    background: transparent;
    color: var(--vscode-input-foreground);
    outline: none;
    font-size: 12px;
  }
  .search-row input::placeholder { color: var(--vscode-input-placeholderForeground); }

  /* ── Tag filter bar ──────────────────────────────────── */
  .tag-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }

  .tag-chip {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 20px;
    border: 1.5px solid transparent;
    cursor: pointer;
    font-weight: 500;
    color: #1a1a2e;
    transition: opacity .12s;
    white-space: nowrap;
  }
  .tag-chip:hover { opacity: .85; }
  .tag-chip.active { border-color: #1a1a2e; }
  .tag-chip.all { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .tag-chip.all.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }

  .add-tag-btn {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 20px;
    background: none;
    border: 1.5px dashed var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
  }
  .add-tag-btn:hover { border-color: var(--vscode-foreground); color: var(--vscode-foreground); }

  /* ── Card list ───────────────────────────────────────── */
  .card-list {
    flex: 1;
    overflow-y: auto;
    padding: var(--gap);
    display: flex;
    flex-direction: column;
    gap: var(--gap);
  }

  /* ── Card ────────────────────────────────────────────── */
  .card {
    border-radius: var(--radius);
    padding: 10px 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    box-shadow: 0 1px 4px rgba(0,0,0,.1);
    transition: box-shadow .15s, transform .15s;
    color: var(--card-text);
    position: relative;
  }
  .card:hover { box-shadow: 0 4px 14px rgba(0,0,0,.15); transform: translateY(-1px); }
  .card.hidden { display: none; }

  /* Card header row */
  .card-header {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 22px;
  }

  .star-btn {
    background: none; border: none; cursor: pointer;
    font-size: 14px; padding: 0; line-height: 1;
    color: var(--card-text); opacity: .4;
    flex-shrink: 0;
  }
  .star-btn.on { opacity: 1; }
  .star-btn:hover { opacity: .8; }

  .card-title {
    flex: 1;
    font-weight: 700;
    font-size: 13px;
    color: var(--card-text);
    outline: none;
    border: none;
    background: transparent;
    padding: 0;
    min-width: 0;
    cursor: text;
  }
  .card-title:focus {
    border-bottom: 1.5px solid rgba(26,26,46,.35);
  }

  .card-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    opacity: 0;
    transition: opacity .12s;
    flex-shrink: 0;
  }
  .card:hover .card-actions { opacity: 1; }

  .card-btn {
    background: rgba(0,0,0,.12);
    border: none;
    border-radius: 4px;
    width: 22px; height: 22px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    font-size: 12px;
    color: var(--card-text);
    transition: background .1s;
  }
  .card-btn:hover { background: rgba(0,0,0,.22); }

  /* Color picker popover */
  .color-pop {
    position: absolute;
    top: 30px; right: 8px;
    background: var(--vscode-editorWidget-background, #fff);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 8px;
    display: none;
    gap: 6px;
    flex-wrap: wrap;
    width: 128px;
    z-index: 50;
    box-shadow: 0 4px 16px rgba(0,0,0,.18);
  }
  .color-pop.open { display: flex; }

  .color-swatch {
    width: 26px; height: 26px;
    border-radius: 50%;
    border: 2px solid rgba(255,255,255,.6);
    cursor: pointer;
    transition: transform .12s;
    box-shadow: 0 1px 4px rgba(0,0,0,.18);
  }
  .color-swatch:hover { transform: scale(1.15); }
  .color-swatch.selected { border-color: #1a1a2e; }

  /* Card content */
  .card-content {
    font-size: 12px;
    line-height: 1.55;
    color: var(--card-text);
    opacity: .85;
    cursor: text;
  }

  /* Rendered markdown preview */
  .card-preview { pointer-events: none; }
  .card-preview p { margin: 0 0 4px; }
  .card-preview ul, .card-preview ol { padding-left: 1.2em; margin: 0 0 4px; }
  .card-preview li { margin: 1px 0; }
  .card-preview code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: .85em;
    background: rgba(0,0,0,.1);
    padding: 0 3px;
    border-radius: 3px;
  }
  .card-preview strong { font-weight: 700; }
  .card-preview em { font-style: italic; }
  .card-preview.clamped {
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* Textarea for quick editing */
  .card-editor {
    display: none;
    width: 100%;
    background: rgba(0,0,0,.06);
    border: none;
    border-radius: 5px;
    padding: 6px 8px;
    font-size: 12px;
    font-family: var(--vscode-font-family);
    color: var(--card-text);
    resize: vertical;
    min-height: 60px;
    outline: none;
    line-height: 1.55;
  }

  .show-more {
    font-size: 11px;
    cursor: pointer;
    opacity: .6;
    text-align: right;
    color: var(--card-text);
    display: none;
  }
  .show-more:hover { opacity: 1; }

  /* Card footer */
  .card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 4px;
  }

  .card-tags { display: flex; gap: 3px; flex-wrap: wrap; }
  .tag-pill {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 10px;
    font-weight: 600;
    color: #1a1a2e;
    cursor: pointer;
  }
  .tag-pill:hover { filter: brightness(.9); }

  .card-date {
    font-size: 10px;
    opacity: .55;
    color: var(--card-text);
    white-space: nowrap;
  }

  /* ── New note form ───────────────────────────────────── */
  .new-note-form {
    margin: var(--gap) var(--gap) 0;
    border-radius: var(--radius);
    padding: 10px 12px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border);
    display: none;
    flex-direction: column;
    gap: 8px;
    flex-shrink: 0;
  }
  .new-note-form.open { display: flex; }

  .new-note-form input {
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--vscode-panel-border);
    outline: none;
    font-size: 13px;
    font-weight: 600;
    color: var(--vscode-input-foreground);
    padding: 2px 0 4px;
    width: 100%;
  }
  .new-note-form input::placeholder { color: var(--vscode-input-placeholderForeground); }

  .color-strip {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .form-actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }

  .btn {
    padding: 4px 12px;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    font-size: 12px;
    font-family: var(--vscode-font-family);
    font-weight: 600;
  }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-ghost   { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }

  /* ── Add tag form ────────────────────────────────────── */
  .add-tag-form {
    display: none;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border-top: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  .add-tag-form.open { display: flex; }
  .add-tag-form input {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 5px;
    padding: 3px 7px;
    color: var(--vscode-input-foreground);
    outline: none;
    font-size: 12px;
    width: 100%;
  }

  /* ── Empty state ─────────────────────────────────────── */
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
    padding: 24px;
  }
  .empty-icon { font-size: 2.4em; }
  .empty p { font-size: 12px; line-height: 1.5; }
</style>
</head>
<body>

<!-- ── Top bar ── -->
<div class="topbar">
  <div class="topbar-row">
    <span class="project-name" id="project-name">Loading…</span>
    <button class="icon-btn" id="btn-canvas" title="Open Canvas">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
        <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
      </svg>
    </button>
    <button class="icon-btn" id="btn-new" title="New Note">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>
  </div>
  <div class="search-row">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" style="opacity:.5;flex-shrink:0">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
    <input id="search" type="text" placeholder="Search notes…" autocomplete="off">
  </div>
</div>

<!-- ── New note form ── -->
<div class="new-note-form" id="new-note-form">
  <input id="new-title" type="text" placeholder="Note title…" maxlength="120">
  <div class="color-strip" id="new-colors"></div>
  <div class="form-actions">
    <button class="btn btn-ghost" id="btn-cancel-new">Cancel</button>
    <button class="btn btn-primary" id="btn-confirm-new">Create</button>
  </div>
</div>

<!-- ── Tag filter bar ── -->
<div class="tag-bar" id="tag-bar"></div>

<!-- ── Card list ── -->
<div class="card-list" id="card-list"></div>

<!-- ── Add tag form ── -->
<div class="add-tag-form" id="add-tag-form">
  <input id="tag-label" type="text" placeholder="Tag name…" maxlength="24">
  <div class="color-strip" id="tag-colors"></div>
  <div class="form-actions">
    <button class="btn btn-ghost" id="btn-cancel-tag">Cancel</button>
    <button class="btn btn-primary" id="btn-confirm-tag">Add Tag</button>
  </div>
</div>

<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const COLORS  = ${colorsJson};
  const COLOR_KEYS = Object.keys(COLORS);

  let notes        = [];
  let tags         = [];
  let activeTagIds = [];   // empty = show all
  let searchQuery  = '';
  let newColor     = COLOR_KEYS[0];
  let tagColor     = '#74B9FF';
  let openColorPop = null; // noteId whose color pop is open

  // ── DOM refs ────────────────────────────────────────────────────────────
  const projectName  = document.getElementById('project-name');
  const cardList     = document.getElementById('card-list');
  const tagBar       = document.getElementById('tag-bar');
  const searchEl     = document.getElementById('search');
  const newForm      = document.getElementById('new-note-form');
  const newTitleEl   = document.getElementById('new-title');
  const newColorsEl  = document.getElementById('new-colors');
  const addTagForm   = document.getElementById('add-tag-form');
  const tagLabelEl   = document.getElementById('tag-label');
  const tagColorsEl  = document.getElementById('tag-colors');

  // ── Init ────────────────────────────────────────────────────────────────
  vscode.postMessage({ type: 'ready' });

  window.addEventListener('message', ({ data: msg }) => {
    if (msg.type === 'init') {
      notes = msg.notes ?? [];
      tags  = msg.tags  ?? [];
      if (msg.projectName) projectName.textContent = msg.projectName;
      renderTagBar();
      renderCards();
      buildColorStrip(newColorsEl,  c => { newColor = c; highlightSwatch(newColorsEl, c); });
      buildColorStrip(tagColorsEl, c => { tagColor = c; highlightSwatch(tagColorsEl, c); });
      highlightSwatch(newColorsEl, newColor);
      highlightSwatch(tagColorsEl, tagColor);
    }
  });

  // ── Search ──────────────────────────────────────────────────────────────
  searchEl.addEventListener('input', () => {
    searchQuery = searchEl.value.toLowerCase();
    renderCards();
  });

  // ── New note ────────────────────────────────────────────────────────────
  document.getElementById('btn-new').addEventListener('click', () => {
    newForm.classList.add('open');
    newTitleEl.focus();
  });
  document.getElementById('btn-cancel-new').addEventListener('click', closeNewForm);
  document.getElementById('btn-confirm-new').addEventListener('click', confirmNewNote);
  newTitleEl.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); confirmNewNote(); }
    if (e.key === 'Escape') closeNewForm();
  });

  function closeNewForm() {
    newForm.classList.remove('open');
    newTitleEl.value = '';
  }
  function confirmNewNote() {
    const title = newTitleEl.value.trim();
    if (!title) { newTitleEl.focus(); return; }
    vscode.postMessage({ type: 'createNote', title, color: newColor });
    closeNewForm();
  }

  // ── Canvas button ────────────────────────────────────────────────────────
  document.getElementById('btn-canvas').addEventListener('click', () => {
    vscode.postMessage({ type: 'openCanvas' });
  });

  // ── Tag bar ─────────────────────────────────────────────────────────────
  function renderTagBar() {
    tagBar.innerHTML = '';

    // "All" chip
    const all = mkEl('button', 'tag-chip all' + (activeTagIds.length === 0 ? ' active' : ''), 'All');
    all.addEventListener('click', () => { activeTagIds = []; renderTagBar(); renderCards(); });
    tagBar.appendChild(all);

    tags.forEach(tag => {
      const chip = mkEl('button', 'tag-chip' + (activeTagIds.includes(tag.id) ? ' active' : ''));
      chip.textContent = tag.label;
      chip.style.background = tag.color;
      chip.addEventListener('click', () => {
        if (activeTagIds.includes(tag.id)) {
          activeTagIds = activeTagIds.filter(id => id !== tag.id);
        } else {
          activeTagIds = [...activeTagIds, tag.id];
        }
        renderTagBar();
        renderCards();
      });
      tagBar.appendChild(chip);
    });

    const addBtn = mkEl('button', 'add-tag-btn', '+ tag');
    addBtn.addEventListener('click', () => {
      addTagForm.classList.add('open');
      tagLabelEl.focus();
    });
    tagBar.appendChild(addBtn);
  }

  // ── Add tag ─────────────────────────────────────────────────────────────
  document.getElementById('btn-cancel-tag').addEventListener('click', closeTagForm);
  document.getElementById('btn-confirm-tag').addEventListener('click', confirmTag);
  tagLabelEl.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); confirmTag(); }
    if (e.key === 'Escape') closeTagForm();
  });

  function closeTagForm() { addTagForm.classList.remove('open'); tagLabelEl.value = ''; }
  function confirmTag() {
    const label = tagLabelEl.value.trim();
    if (!label) { tagLabelEl.focus(); return; }
    vscode.postMessage({ type: 'addTag', label, color: tagColor });
    closeTagForm();
  }

  // ── Cards ────────────────────────────────────────────────────────────────
  function visibleNotes() {
    return notes.filter(n => {
      if (searchQuery && !n.title.toLowerCase().includes(searchQuery) &&
          !n.content.toLowerCase().includes(searchQuery)) return false;
      if (activeTagIds.length > 0 && !activeTagIds.some(id => n.tags.includes(id))) return false;
      return true;
    });
  }

  function renderCards() {
    cardList.innerHTML = '';
    const visible = visibleNotes();
    if (visible.length === 0) {
      const empty = mkEl('div', 'empty');
      empty.innerHTML = '<div class="empty-icon">📋</div><p>No notes yet.<br>Click <strong>+</strong> to create one.</p>';
      cardList.appendChild(empty);
      return;
    }
    // Starred first, then by updatedAt desc
    [...visible]
      .sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || b.updatedAt - a.updatedAt)
      .forEach(note => cardList.appendChild(buildCard(note)));
  }

  function buildCard(note) {
    const bg   = COLORS[note.color] || COLORS.yellow;
    const card = mkEl('div', 'card');
    card.dataset.id = note.id;
    card.style.background = bg;

    // ── Header ──
    const hdr = mkEl('div', 'card-header');

    const starBtn = mkEl('button', 'star-btn' + (note.starred ? ' on' : ''));
    starBtn.textContent = '★';
    starBtn.title = note.starred ? 'Unstar' : 'Star';
    starBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'updateNote', id: note.id, changes: { starred: !note.starred } });
    });

    const title = mkEl('input', 'card-title');
    title.type  = 'text';
    title.value = note.title;
    title.setAttribute('aria-label', 'Note title');
    title.addEventListener('blur', () => {
      if (title.value.trim() !== note.title) {
        vscode.postMessage({ type: 'updateNote', id: note.id, changes: { title: title.value.trim() || note.title } });
      }
    });
    title.addEventListener('keydown', e => { if (e.key === 'Enter') title.blur(); });

    const actions = mkEl('div', 'card-actions');

    // Color picker button
    const colorBtn = mkEl('button', 'card-btn', '🎨');
    colorBtn.title = 'Change color';
    const colorPop = mkEl('div', 'color-pop');
    COLOR_KEYS.forEach(key => {
      const sw = mkEl('div', 'color-swatch' + (note.color === key ? ' selected' : ''));
      sw.style.background = COLORS[key];
      sw.title = key;
      sw.addEventListener('click', e => {
        e.stopPropagation();
        vscode.postMessage({ type: 'updateNote', id: note.id, changes: { color: key } });
        colorPop.classList.remove('open');
        openColorPop = null;
      });
      colorPop.appendChild(sw);
    });
    colorBtn.addEventListener('click', e => {
      e.stopPropagation();
      const wasOpen = colorPop.classList.contains('open');
      closeAllColorPops();
      if (!wasOpen) { colorPop.classList.add('open'); openColorPop = note.id; }
    });

    // ↗ Canvas button
    const canvasBtn = mkEl('button', 'card-btn', '↗');
    canvasBtn.title = 'Open on canvas';
    canvasBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'openCanvas', noteId: note.id });
    });

    // Delete button
    const delBtn = mkEl('button', 'card-btn', '✕');
    delBtn.title = 'Delete note';
    delBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'deleteNote', id: note.id });
    });

    actions.append(colorBtn, canvasBtn, delBtn);
    hdr.append(starBtn, title, actions);
    card.append(hdr, colorPop);

    // ── Tags on card ──
    if (note.tags.length > 0) {
      const tagRow = mkEl('div', 'card-tags');
      note.tags.forEach(tid => {
        const tag = tags.find(t => t.id === tid);
        if (!tag) return;
        const pill = mkEl('span', 'tag-pill', tag.label);
        pill.style.background = tag.color;
        tagRow.appendChild(pill);
      });
      card.appendChild(tagRow);
    }

    // ── Content ──
    const contentWrap = mkEl('div', 'card-content');

    const preview  = mkEl('div', 'card-preview clamped');
    preview.innerHTML = simpleMarkdown(note.content);

    const showMore = mkEl('div', 'show-more', '▾ more');
    const isLong   = note.content.split('\\n').length > 4 || note.content.length > 200;
    if (isLong) showMore.style.display = 'block';

    let expanded = false;
    showMore.addEventListener('click', () => {
      expanded = !expanded;
      preview.classList.toggle('clamped', !expanded);
      showMore.textContent = expanded ? '▴ less' : '▾ more';
    });

    const editor = mkEl('textarea', 'card-editor');
    editor.value = note.content;
    editor.placeholder = 'Write something…';
    editor.rows = 4;

    // Click preview → switch to editor
    preview.addEventListener('click', () => {
      preview.style.display = 'none';
      showMore.style.display = 'none';
      editor.style.display   = 'block';
      editor.focus();
    });

    // Leave editor → save + show preview
    editor.addEventListener('blur', () => {
      const newContent = editor.value;
      if (newContent !== note.content) {
        vscode.postMessage({ type: 'updateNote', id: note.id, changes: { content: newContent } });
        preview.innerHTML = simpleMarkdown(newContent);
        const stillLong = newContent.split('\\n').length > 4 || newContent.length > 200;
        showMore.style.display = stillLong ? 'block' : 'none';
      }
      preview.style.display = '';
      showMore.style.display = isLong ? 'block' : 'none';
      editor.style.display   = 'none';
    });

    editor.addEventListener('keydown', e => {
      if (e.key === 'Escape') editor.blur();
    });

    contentWrap.append(preview, showMore, editor);
    card.appendChild(contentWrap);

    // ── Footer ──
    const footer = mkEl('div', 'card-footer');
    footer.innerHTML = '<span></span>'; // spacer
    const dateEl = mkEl('span', 'card-date', formatDate(note.updatedAt));
    footer.appendChild(dateEl);
    card.appendChild(footer);

    return card;
  }

  // ── Close color pops on outside click ──────────────────────────────────
  document.addEventListener('click', () => {
    closeAllColorPops();
  });

  function closeAllColorPops() {
    document.querySelectorAll('.color-pop.open').forEach(el => el.classList.remove('open'));
    openColorPop = null;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  function mkEl(tag, cls = '', text = '') {
    const el = document.createElement(tag);
    if (cls)  el.className = cls;
    if (text) el.textContent = text;
    return el;
  }

  function buildColorStrip(container, onSelect) {
    container.innerHTML = '';
    COLOR_KEYS.forEach(key => {
      const sw = mkEl('div', 'color-swatch');
      sw.style.background = COLORS[key];
      sw.title = key;
      sw.dataset.colorKey = key;
      sw.addEventListener('click', () => onSelect(key));
      container.appendChild(sw);
    });
  }

  function highlightSwatch(container, key) {
    container.querySelectorAll('.color-swatch').forEach(sw => {
      sw.classList.toggle('selected', sw.dataset.colorKey === key);
    });
  }

  function formatDate(ts) {
    const d   = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function simpleMarkdown(md) {
    if (!md) return '';
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return md.split('\\n').map(line => {
      let l = esc(line)
        .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
        .replace(/\`(.+?)\`/g, '<code>$1</code>')
        .replace(/~~(.+?)~~/g, '<del>$1</del>');
      if (/^#{1,3}\\s/.test(line)) {
        const lvl = line.match(/^(#+)/)[1].length;
        l = \`<strong>\${l.replace(/^#+\\s/, '')}</strong>\`;
      }
      return \`<p>\${l || '&nbsp;'}</p>\`;
    }).join('');
  }

})();
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
