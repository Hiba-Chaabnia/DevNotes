import * as vscode from 'vscode';
import { NoteStorage, Note, Tag, NOTE_COLORS, DEFAULT_TAGS } from './NoteStorage';

// ─── Message types ────────────────────────────────────────────────────────────

type ToExt =
  | { type: 'ready' }
  | { type: 'createNote'; title: string; color: string; tags: string[] }
  | { type: 'updateNote'; id: string; changes: Partial<Note> }
  | { type: 'deleteNote'; id: string }
  | { type: 'openEditor'; noteId: string }
  | { type: 'addTag'; label: string; color: string }
  | { type: 'deleteTag'; id: string }
  | { type: 'updateTag'; id: string; changes: Partial<Pick<Tag, 'label' | 'color'>> };

// ─── Provider ────────────────────────────────────────────────────────────────

export class SidebarView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private projectName = 'DevNotes';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly storage: NoteStorage,
    private readonly onOpenEditor: (noteId: string) => void,
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

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.push();
    });
  }

  /** Call this after any storage mutation to sync the sidebar. */
  push(): void {
    if (!this.view?.visible) return;
    this.view.webview.postMessage({
      type         : 'init',
      notes        : this.storage.getNotes(),
      tags         : this.storage.getTags(),
      defaultTagIds: DEFAULT_TAGS.map(t => t.id),
      projectName  : this.projectName,
    });
  }

  // ── Message handler ──────────────────────────────────────────────────────

  private async handle(msg: ToExt): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.push();
        break;

      case 'createNote':
        await this.storage.createNote({ title: msg.title, color: msg.color, tags: msg.tags });
        this.push();
        break;

      case 'updateNote': {
        const prevShared = this.storage.getNote(msg.id)?.shared;
        await this.storage.updateNote(msg.id, msg.changes);
        this.push();

        if ('shared' in msg.changes) {
          const note = this.storage.getNote(msg.id);
          if (!note) break;
          if (msg.changes.shared && !prevShared) {
            const action = await vscode.window.showInformationMessage(
              `"${note.title}" is now shared. Commit it to git to share with teammates.`,
              'Copy git commands'
            );
            if (action === 'Copy git commands') {
              await vscode.env.clipboard.writeText(
                `git add .devnotes/.gitignore .devnotes/${note.id}.md\ngit commit -m "share: ${note.title}"`
              );
            }
          } else if (!msg.changes.shared && prevShared) {
            vscode.window.showInformationMessage(
              `"${note.title}" unshared. Commit the updated .devnotes/.gitignore to remove it for teammates.`
            );
          }
        }
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
          this.push();
        }
        break;
      }

      case 'openEditor':
        this.onOpenEditor(msg.noteId);
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

      case 'updateTag': {
        await this.storage.updateTag(msg.id, msg.changes);
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

  .search-clear {
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    padding: 0 2px;
    font-size: 11px;
    line-height: 1;
    opacity: .7;
    flex-shrink: 0;
  }
  .search-clear:hover { opacity: 1; }

  mark.match-highlight {
    background: var(--vscode-editor-findMatchHighlightBackground, rgba(255,200,0,.4));
    color: inherit;
    border-radius: 2px;
    padding: 0 1px;
  }

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
    padding: 2px 7px;
    border-radius: 20px;
    border: 1.5px solid transparent;
    cursor: pointer;
    font-weight: 500;
    color: #1a1a2e;
    transition: opacity .12s;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .tag-chip:hover { opacity: .85; }
  .tag-chip.active { border-color: #1a1a2e; }
  .tag-chip.all { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .tag-chip.all.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }

  .tag-chip-delete {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    opacity: 0;
    transition: opacity .12s;
    cursor: pointer;
    padding: 0 1px;
    line-height: 1;
    border-radius: 50%;
  }
  .tag-chip:hover .tag-chip-delete { opacity: .65; }
  .tag-chip-delete:hover { opacity: 1 !important; background: rgba(0,0,0,.15); border-radius: 50%; }

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

  .manage-tags-btn {
    font-size: 12px;
    padding: 2px 7px;
    border-radius: 20px;
    background: none;
    border: 1.5px solid transparent;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    margin-left: auto;
  }
  .manage-tags-btn:hover { color: var(--vscode-foreground); border-color: var(--vscode-panel-border); }
  .manage-tags-btn.active {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border-color: transparent;
  }

  /* ── Tag manager panel ───────────────────────────────── */
  .tag-manager {
    padding: 8px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    background: var(--vscode-input-background);
    max-height: 240px;
    overflow-y: auto;
  }

  .tag-mgr-section {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .05em;
    color: var(--vscode-descriptionForeground);
    padding: 6px 0 3px;
    margin-top: 2px;
  }
  .tag-mgr-section:first-child { padding-top: 0; }

  .tag-mgr-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    position: relative;
  }

  .tag-mgr-swatch {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1.5px solid rgba(0,0,0,.2);
    cursor: pointer;
    flex-shrink: 0;
    transition: transform .1s;
  }
  .tag-mgr-swatch:hover { transform: scale(1.2); }
  .tag-mgr-swatch-ro { cursor: default; }
  .tag-mgr-swatch-ro:hover { transform: none; }

  .tag-mgr-input {
    flex: 1;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-input-foreground);
    font-family: var(--vscode-font-family);
    outline: none;
    min-width: 0;
  }
  .tag-mgr-input:hover { border-color: var(--vscode-panel-border); }
  .tag-mgr-input:focus {
    border-color: var(--vscode-focusBorder, var(--vscode-panel-border));
    background: var(--vscode-input-background);
  }

  .tag-mgr-del {
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 11px;
    padding: 2px 5px;
    border-radius: 3px;
    opacity: .45;
    flex-shrink: 0;
  }
  .tag-mgr-del:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

  .tag-mgr-ro-label {
    flex: 1;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
    opacity: .6;
  }

  .tag-mgr-ro-hint {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    opacity: .5;
    font-style: italic;
  }

  .tag-mgr-empty {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    padding: 4px 0;
    opacity: .7;
  }

  /* Color picker popover inside the manager */
  .tag-mgr-color-pop {
    position: absolute;
    left: 22px;
    top: 22px;
    background: var(--vscode-editorWidget-background, #fff);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 8px;
    display: none;
    gap: 6px;
    flex-wrap: wrap;
    width: 128px;
    z-index: 100;
    box-shadow: 0 4px 16px rgba(0,0,0,.18);
  }
  .tag-mgr-color-pop.open { display: flex; }

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

  /* Shared indicator — left-edge stripe */
  .card.is-shared::before {
    content: '';
    position: absolute;
    left: 0; top: 8px; bottom: 8px;
    width: 3px;
    background: rgba(6, 214, 214, 0.75);
    border-radius: 0 3px 3px 0;
  }

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
  .card-btn.is-active {
    background: rgba(6, 214, 214, 0.35);
  }
  .card-btn.is-active:hover { background: rgba(6, 214, 214, 0.5); }

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

  /* Tag assignment popover */
  .tag-pop {
    position: absolute;
    top: 30px; right: 8px;
    background: var(--vscode-editorWidget-background, #fff);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 5px;
    display: none;
    flex-direction: column;
    gap: 2px;
    min-width: 140px;
    max-width: 200px;
    max-height: 220px;
    overflow-y: auto;
    z-index: 50;
    box-shadow: 0 4px 16px rgba(0,0,0,.18);
  }
  .tag-pop.open { display: flex; }
  .tag-pop-empty {
    font-size: 11px;
    padding: 6px 8px;
    opacity: .55;
    color: #1a1a2e;
  }
  .tag-pop-item {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 8px;
    border-radius: 5px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    color: #1a1a2e;
    transition: filter .1s;
  }
  .tag-pop-item:hover { filter: brightness(.93); }
  .tag-pop-check {
    font-size: 10px;
    margin-left: auto;
    opacity: 0;
    flex-shrink: 0;
  }
  .tag-pop-item.selected .tag-pop-check { opacity: 1; }

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

  .new-note-tags {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
    min-height: 22px;
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
    <button class="search-clear" id="search-clear" title="Clear search" style="display:none">✕</button>
  </div>
</div>

<!-- ── New note form ── -->
<div class="new-note-form" id="new-note-form">
  <input id="new-title" type="text" placeholder="Note title…" maxlength="120">
  <div class="color-strip" id="new-colors"></div>
  <div class="new-note-tags" id="new-tags"></div>
  <div class="form-actions">
    <button class="btn btn-ghost" id="btn-cancel-new">Cancel</button>
    <button class="btn btn-primary" id="btn-confirm-new">Create</button>
  </div>
</div>

<!-- ── Tag filter bar ── -->
<div class="tag-bar" id="tag-bar"></div>

<!-- ── Tag manager panel ── -->
<div class="tag-manager" id="tag-manager" style="display:none"></div>

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

  let notes         = [];
  let tags          = [];
  let defaultTagIds = [];
  let activeTagIds  = [];
  let searchQuery   = '';
  let newColor      = COLOR_KEYS[0];
  let newTags       = [];
  let tagColor      = '#74B9FF';
  let openColorPop    = null;
  let openTagPop      = null;
  let isManagingTags  = false;
  let openMgrColorPop = null;

  // ── DOM refs ────────────────────────────────────────────────────────────
  const projectName    = document.getElementById('project-name');
  const cardList       = document.getElementById('card-list');
  const tagBar         = document.getElementById('tag-bar');
  const searchEl       = document.getElementById('search');
  const searchClearEl  = document.getElementById('search-clear');
  const newForm        = document.getElementById('new-note-form');
  const newTitleEl     = document.getElementById('new-title');
  const newColorsEl    = document.getElementById('new-colors');
  const newTagsEl      = document.getElementById('new-tags');
  const addTagForm     = document.getElementById('add-tag-form');
  const tagLabelEl     = document.getElementById('tag-label');
  const tagColorsEl    = document.getElementById('tag-colors');

  // ── Init ────────────────────────────────────────────────────────────────
  vscode.postMessage({ type: 'ready' });

  window.addEventListener('message', ({ data: msg }) => {
    if (msg.type === 'init') {
      notes         = msg.notes         ?? [];
      tags          = msg.tags          ?? [];
      defaultTagIds = msg.defaultTagIds ?? [];
      if (msg.projectName) projectName.textContent = msg.projectName;
      // Drop filter state for tags that no longer exist
      activeTagIds = activeTagIds.filter(id => tags.some(t => t.id === id));
      renderTagBar();
      if (isManagingTags) renderTagManager();
      renderCards();
      renderNewNoteTags();
      buildColorStrip(newColorsEl,  c => { newColor = c; highlightSwatch(newColorsEl, c); });
      buildColorStrip(tagColorsEl, c => { tagColor = c; highlightSwatch(tagColorsEl, c); });
      highlightSwatch(newColorsEl, newColor);
      highlightSwatch(tagColorsEl, tagColor);
    }
  });

  // ── Search ──────────────────────────────────────────────────────────────
  searchEl.addEventListener('input', () => {
    searchQuery = searchEl.value.toLowerCase();
    searchClearEl.style.display = searchQuery ? 'block' : 'none';
    renderCards();
  });
  searchClearEl.addEventListener('click', () => {
    searchQuery = '';
    searchEl.value = '';
    searchClearEl.style.display = 'none';
    searchEl.focus();
    renderCards();
  });
  searchEl.addEventListener('keydown', e => {
    if (e.key === 'Escape' && searchQuery) {
      searchQuery = '';
      searchEl.value = '';
      searchClearEl.style.display = 'none';
      renderCards();
    }
  });

  // ── New note ────────────────────────────────────────────────────────────
  document.getElementById('btn-new').addEventListener('click', () => {
    newTags = [];
    renderNewNoteTags();
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
    newTags = [];
  }
  function confirmNewNote() {
    const title = newTitleEl.value.trim();
    if (!title) { newTitleEl.focus(); return; }
    vscode.postMessage({ type: 'createNote', title, color: newColor, tags: [...newTags] });
    closeNewForm();
  }

  function renderNewNoteTags() {
    newTagsEl.innerHTML = '';
    if (tags.length === 0) return;
    tags.forEach(tag => {
      const chip = mkEl('button', 'tag-chip' + (newTags.includes(tag.id) ? ' active' : ''));
      chip.type = 'button';
      chip.textContent = tag.label;
      chip.style.background = tag.color;
      chip.addEventListener('click', () => {
        newTags = newTags.includes(tag.id)
          ? newTags.filter(id => id !== tag.id)
          : [...newTags, tag.id];
        renderNewNoteTags();
      });
      newTagsEl.appendChild(chip);
    });
  }

  // ── Tag bar ─────────────────────────────────────────────────────────────
  function renderTagBar() {
    tagBar.innerHTML = '';

    const all = mkEl('button', 'tag-chip all' + (activeTagIds.length === 0 ? ' active' : ''), 'All');
    all.addEventListener('click', () => { activeTagIds = []; renderTagBar(); renderCards(); });
    tagBar.appendChild(all);

    tags.forEach(tag => {
      const isDefault = defaultTagIds.includes(tag.id);

      const chip = mkEl('button', 'tag-chip' + (activeTagIds.includes(tag.id) ? ' active' : ''));
      chip.style.background = tag.color;
      chip.appendChild(mkEl('span', '', tag.label));

      if (!isDefault) {
        const delBtn = mkEl('span', 'tag-chip-delete', '✕');
        delBtn.title = 'Delete tag';
        delBtn.addEventListener('click', e => {
          e.stopPropagation();
          vscode.postMessage({ type: 'deleteTag', id: tag.id });
        });
        chip.appendChild(delBtn);
      }

      chip.addEventListener('click', () => {
        activeTagIds = activeTagIds.includes(tag.id)
          ? activeTagIds.filter(id => id !== tag.id)
          : [...activeTagIds, tag.id];
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

    const mgrBtn = mkEl('button', 'manage-tags-btn' + (isManagingTags ? ' active' : ''), '⚙');
    mgrBtn.title = isManagingTags ? 'Close tag manager' : 'Manage tags (rename, recolor)';
    mgrBtn.addEventListener('click', () => {
      isManagingTags = !isManagingTags;
      const mgr = document.getElementById('tag-manager');
      mgr.style.display = isManagingTags ? '' : 'none';
      if (isManagingTags) renderTagManager();
      renderTagBar();
    });
    tagBar.appendChild(mgrBtn);
  }

  // ── Tag manager ─────────────────────────────────────────────────────────
  function renderTagManager() {
    const mgr = document.getElementById('tag-manager');
    mgr.innerHTML = '';

    const customTags  = tags.filter(t => !defaultTagIds.includes(t.id));
    const builtinTags = tags.filter(t =>  defaultTagIds.includes(t.id));

    if (customTags.length > 0) {
      mgr.appendChild(mkEl('div', 'tag-mgr-section', 'Custom tags'));
      customTags.forEach(tag => {
        const row = mkEl('div', 'tag-mgr-row');

        const swatch = mkEl('div', 'tag-mgr-swatch');
        swatch.style.background = tag.color;
        swatch.title = 'Change color';

        const colorPop = mkEl('div', 'tag-mgr-color-pop');
        COLOR_KEYS.forEach(key => {
          const sw = mkEl('div', 'color-swatch' + (COLORS[key] === tag.color ? ' selected' : ''));
          sw.style.background = COLORS[key];
          sw.title = key;
          sw.addEventListener('click', e => {
            e.stopPropagation();
            colorPop.classList.remove('open');
            openMgrColorPop = null;
            vscode.postMessage({ type: 'updateTag', id: tag.id, changes: { color: COLORS[key] } });
          });
          colorPop.appendChild(sw);
        });

        swatch.addEventListener('click', e => {
          e.stopPropagation();
          const wasOpen = colorPop.classList.contains('open');
          document.querySelectorAll('.tag-mgr-color-pop.open').forEach(p => p.classList.remove('open'));
          openMgrColorPop = null;
          if (!wasOpen) { colorPop.classList.add('open'); openMgrColorPop = tag.id; }
        });

        const input = mkEl('input', 'tag-mgr-input');
        input.type = 'text';
        input.value = tag.label;
        input.maxLength = 24;
        let pendingLabel = tag.label;
        input.addEventListener('input', e => { pendingLabel = e.target.value; });
        input.addEventListener('blur', () => {
          const newLabel = pendingLabel.trim();
          if (newLabel && newLabel !== tag.label) {
            vscode.postMessage({ type: 'updateTag', id: tag.id, changes: { label: newLabel } });
          }
        });
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
          if (e.key === 'Escape') { input.value = tag.label; pendingLabel = tag.label; input.blur(); }
        });

        const delBtn = mkEl('button', 'tag-mgr-del', '✕');
        delBtn.title = 'Delete tag';
        delBtn.addEventListener('click', () => {
          vscode.postMessage({ type: 'deleteTag', id: tag.id });
        });

        row.append(swatch, colorPop, input, delBtn);
        mgr.appendChild(row);
      });
    }

    if (builtinTags.length > 0) {
      mgr.appendChild(mkEl('div', 'tag-mgr-section', 'Built-in tags'));
      builtinTags.forEach(tag => {
        const row  = mkEl('div', 'tag-mgr-row');
        const dot  = mkEl('div', 'tag-mgr-swatch tag-mgr-swatch-ro');
        dot.style.background = tag.color;
        const lbl  = mkEl('span', 'tag-mgr-ro-label', tag.label);
        const hint = mkEl('span', 'tag-mgr-ro-hint', 'built-in');
        row.append(dot, lbl, hint);
        mgr.appendChild(row);
      });
    }

    if (customTags.length === 0 && builtinTags.length === 0) {
      mgr.appendChild(mkEl('div', 'tag-mgr-empty', 'No tags yet — click "+ tag" to create one.'));
    }
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
      if (searchQuery) {
        const tagText = n.tags.map(tid => { const t = tags.find(t => t.id === tid); return t ? t.label : ''; }).join(' ').toLowerCase();
        if (!n.title.toLowerCase().includes(searchQuery) &&
            !n.content.toLowerCase().includes(searchQuery) &&
            !tagText.includes(searchQuery)) return false;
      }
      if (activeTagIds.length > 0 && !activeTagIds.some(id => n.tags.includes(id))) return false;
      return true;
    });
  }

  function renderCards() {
    cardList.innerHTML = '';
    const visible = visibleNotes();
    if (visible.length === 0) {
      const empty = mkEl('div', 'empty');
      if (notes.length === 0) {
        empty.innerHTML = '<div class="empty-icon">📋</div><p>No notes yet.<br>Click <strong>+</strong> to create one.</p>';
      } else {
        empty.innerHTML = '<div class="empty-icon">🔍</div><p>No notes match<br><strong>' + esc(searchQuery || 'the selected filter') + '</strong>.</p>';
      }
      cardList.appendChild(empty);
      return;
    }
    [...visible]
      .sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || b.updatedAt - a.updatedAt)
      .forEach(note => cardList.appendChild(buildCard(note)));
  }

  function buildCard(note) {
    const bg   = COLORS[note.color] || COLORS.yellow;
    const card = mkEl('div', 'card' + (note.shared ? ' is-shared' : ''));
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

    // ── Tag assignment button ──
    const tagBtn = mkEl('button', 'card-btn', '#');
    tagBtn.title = 'Assign tags';
    const tagPop = mkEl('div', 'tag-pop');

    if (tags.length === 0) {
      tagPop.appendChild(mkEl('div', 'tag-pop-empty', 'No tags yet'));
    } else {
      tags.forEach(tag => {
        const item  = mkEl('div', 'tag-pop-item' + (note.tags.includes(tag.id) ? ' selected' : ''));
        item.style.background = tag.color;
        const lbl   = mkEl('span', '', tag.label);
        const check = mkEl('span', 'tag-pop-check', '✓');
        item.append(lbl, check);
        item.addEventListener('click', e => {
          e.stopPropagation();
          const newNoteTags = note.tags.includes(tag.id)
            ? note.tags.filter(t => t !== tag.id)
            : [...note.tags, tag.id];
          vscode.postMessage({ type: 'updateNote', id: note.id, changes: { tags: newNoteTags } });
          tagPop.classList.remove('open');
          openTagPop = null;
        });
        tagPop.appendChild(item);
      });
    }

    tagBtn.addEventListener('click', e => {
      e.stopPropagation();
      const wasOpen = tagPop.classList.contains('open');
      closeAllPops();
      if (!wasOpen) { tagPop.classList.add('open'); openTagPop = note.id; }
    });

    // ── Share toggle button ──
    const shareBtn = mkEl('button', 'card-btn' + (note.shared ? ' is-active' : ''));
    shareBtn.title = note.shared ? 'Unshare note' : 'Share note (opt into git)';
    shareBtn.innerHTML = \`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
      <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
      <line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/>
    </svg>\`;
    shareBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'updateNote', id: note.id, changes: { shared: !note.shared } });
    });

    // ── Color picker button ──
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
      closeAllPops();
      if (!wasOpen) { colorPop.classList.add('open'); openColorPop = note.id; }
    });

    // ── Open in rich editor button ──
    const editBtn = mkEl('button', 'card-btn', '✏');
    editBtn.title = 'Open in rich editor';
    editBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'openEditor', noteId: note.id });
    });

    // ── Delete button ──
    const delBtn = mkEl('button', 'card-btn', '✕');
    delBtn.title = 'Delete note';
    delBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'deleteNote', id: note.id });
    });

    actions.append(tagBtn, shareBtn, colorBtn, editBtn, delBtn);
    hdr.append(starBtn, title, actions);
    card.append(hdr, colorPop, tagPop);

    // ── Tags on card ──
    if (note.tags.length > 0) {
      const tagRow = mkEl('div', 'card-tags');
      note.tags.forEach(tid => {
        const tag = tags.find(t => t.id === tid);
        if (!tag) return;
        const pill = mkEl('span', 'tag-pill', tag.label);
        pill.style.background = tag.color;
        pill.title = 'Filter by ' + tag.label;
        pill.addEventListener('click', () => {
          if (!activeTagIds.includes(tid)) {
            activeTagIds = [...activeTagIds, tid];
            renderTagBar();
            renderCards();
          }
        });
        tagRow.appendChild(pill);
      });
      card.appendChild(tagRow);
    }

    // ── Content ──
    const contentWrap = mkEl('div', 'card-content');

    const preview  = mkEl('div', 'card-preview clamped');
    preview.innerHTML = searchQuery ? matchSnippet(note.content, searchQuery) : simpleMarkdown(note.content);

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

    preview.addEventListener('click', () => {
      preview.style.display = 'none';
      showMore.style.display = 'none';
      editor.style.display   = 'block';
      editor.focus();
    });

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
    footer.innerHTML = '<span></span>';
    const dateEl = mkEl('span', 'card-date', formatDate(note.updatedAt));
    footer.appendChild(dateEl);
    card.appendChild(footer);

    return card;
  }

  // ── Close all popover on outside click ─────────────────────────────────
  document.addEventListener('click', () => {
    closeAllPops();
  });

  function closeAllPops() {
    document.querySelectorAll('.color-pop.open, .tag-pop.open, .tag-mgr-color-pop.open').forEach(el => el.classList.remove('open'));
    openColorPop    = null;
    openTagPop      = null;
    openMgrColorPop = null;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function matchSnippet(content, query) {
    if (!content) return '';
    const lower = content.toLowerCase();
    const idx   = lower.indexOf(query);
    if (idx === -1) return simpleMarkdown(content);
    const start  = Math.max(0, idx - 40);
    const end    = Math.min(content.length, idx + query.length + 80);
    const text   = (start > 0 ? '\\u2026' : '') + content.slice(start, end) + (end < content.length ? '\\u2026' : '');
    const li     = text.toLowerCase().indexOf(query);
    return '<p>' + esc(text.slice(0, li)) + '<mark class="match-highlight">' + esc(text.slice(li, li + query.length)) + '</mark>' + esc(text.slice(li + query.length)) + '</p>';
  }

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
