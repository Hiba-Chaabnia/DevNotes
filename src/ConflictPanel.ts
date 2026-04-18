import * as vscode from 'vscode';
import { NoteStorage, Note, Tag, NOTE_COLORS } from './NoteStorage';
import { UI_COLORS, RGB } from './colors';

export class ConflictPanel {
  static current?: ConflictPanel;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  // ── Static factory ──────────────────────────────────────────────────────

  static async show(
    context    : vscode.ExtensionContext,
    storage    : NoteStorage,
    noteId     : string,
    onResolved : () => void,
  ): Promise<void> {
    const versions = await storage.getConflictVersions(noteId);
    if (!versions) {
      vscode.window.showInformationMessage('DevNotes: this note no longer has a conflict.');
      return;
    }

    if (ConflictPanel.current) {
      ConflictPanel.current.panel.dispose();
    }

    new ConflictPanel(context, storage, noteId, versions.ours, versions.theirs, versions.incomingRef, onResolved);
  }

  // ── Constructor ─────────────────────────────────────────────────────────

  private constructor(
    context      : vscode.ExtensionContext,
    private readonly storage    : NoteStorage,
    private readonly noteId     : string,
    ours         : Note,
    theirs       : Note,
    incomingRef  : string,
    private readonly onResolved : () => void,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'devnotes.conflict',
      `⚠ Conflict — ${ours.title}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.webview.html = this.buildHtml(ours, theirs, incomingRef, this.storage.getTags());

    this.panel.webview.onDidReceiveMessage(
      async (msg: { type: string; side?: 'ours' | 'theirs' | 'both' }) => {
        if (msg.type === 'resolve' && msg.side) {
          await this.storage.resolveConflict(this.noteId, msg.side);
          this.onResolved();
          this.panel.dispose();

        } else if (msg.type === 'openRaw') {
          const uri = this.storage.getNoteFileUri(this.noteId);
          try {
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: false });
          } catch {
            vscode.window.showErrorMessage('DevNotes: could not open the note file.');
          }
        }
      },
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => {
      ConflictPanel.current = undefined;
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);

    ConflictPanel.current = this;
  }

  // ── HTML ─────────────────────────────────────────────────────────────────

  private buildHtml(ours: Note, theirs: Note, incomingRef: string, tags: Tag[]): string {
    const nonce      = getNonce();
    const oursJson   = JSON.stringify(ours);
    const theirsJson = JSON.stringify(theirs);
    const tagsJson   = JSON.stringify(tags);
    const colorsJson = JSON.stringify(NOTE_COLORS);
    const refJson    = JSON.stringify(incomingRef);

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Header ── */
  .conflict-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 24px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    background: rgba(${RGB.red},.08);
  }
  .conflict-icon { font-size: 1.5em; flex-shrink: 0; }
  .conflict-title { font-size: 1.05em; font-weight: 700; margin-bottom: 3px; }
  .conflict-sub { font-size: 11px; color: var(--vscode-descriptionForeground); }

  /* ── Columns ── */
  .columns {
    display: grid;
    grid-template-columns: 1fr 1px 1fr;
    flex: 1;
    overflow: hidden;
  }
  .col { display: flex; flex-direction: column; overflow: hidden; }
  .col-divider { background: var(--vscode-panel-border); }

  .col-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 18px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  .col-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .06em;
    text-transform: uppercase;
    padding: 2px 7px;
    border-radius: 3px;
  }
  .label-ours   { background: rgba(${RGB.blue},.2);  color: var(--vscode-foreground); }
  .label-theirs { background: rgba(${RGB.red},.2);   color: var(--vscode-foreground); }
  .col-ref {
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-descriptionForeground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── Note card ── */
  .note-card {
    flex: 1;
    overflow-y: auto;
    padding: 14px 18px;
  }

  .field-row {
    margin-bottom: 10px;
  }
  .field-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: .05em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 3px;
  }
  .field-value { font-size: 12px; }

  .field-row.changed {
    background: rgba(${RGB.amber},.1);
    border-left: 3px solid rgba(${RGB.amber},.6);
    padding: 6px 8px;
    border-radius: 0 4px 4px 0;
    margin-left: -8px;
  }

  .color-swatch {
    display: inline-block;
    width: 16px; height: 16px;
    border-radius: 3px;
    border: 1px solid rgba(128,128,128,.3);
    vertical-align: middle;
    margin-right: 5px;
  }
  .tag-pill {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
    color: ${UI_COLORS.text};
    margin-right: 3px;
  }

  .content-preview {
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.08));
    border-radius: 6px;
    padding: 10px 12px;
    max-height: 260px;
    overflow-y: auto;
    border: 1px solid var(--vscode-panel-border);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
  }
  .content-empty {
    font-style: italic;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }

  /* ── Resolve button ── */
  .col-footer {
    padding: 12px 18px;
    border-top: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  .btn-resolve {
    width: 100%;
    padding: 7px 16px;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    font-family: var(--vscode-font-family);
    transition: filter .1s;
  }
  .btn-resolve:hover { filter: brightness(1.1); }
  .btn-ours   { background: var(--vscode-button-background);          color: var(--vscode-button-foreground); }
  .btn-theirs { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }

  /* ── Footer ── */
  .conflict-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 10px 18px;
    border-top: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  .btn-both {
    padding: 6px 16px;
    border-radius: 5px;
    border: 1.5px solid var(--vscode-panel-border);
    background: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    font-family: var(--vscode-font-family);
    transition: background .1s, border-color .1s;
  }
  .btn-both:hover {
    background: var(--vscode-toolbar-hoverBackground);
    border-color: var(--vscode-focusBorder, var(--vscode-panel-border));
  }
  .btn-raw {
    background: none;
    border: 1px solid transparent;
    color: var(--vscode-foreground);
    padding: 5px 14px;
    border-radius: 5px;
    cursor: pointer;
    font-size: 11px;
    font-family: var(--vscode-font-family);
    opacity: .55;
  }
  .btn-raw:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
</style>
</head>
<body>

<div class="conflict-header">
  <div class="conflict-icon">⚠</div>
  <div>
    <div class="conflict-title" id="conflict-title"></div>
    <div class="conflict-sub">This note was edited concurrently. Choose which version to keep — the other will be discarded.</div>
  </div>
</div>

<div class="columns">
  <div class="col">
    <div class="col-header">
      <span class="col-label label-ours">Your version</span>
      <span class="col-ref">HEAD</span>
    </div>
    <div class="note-card" id="card-ours"></div>
    <div class="col-footer">
      <button class="btn-resolve btn-ours" id="keep-ours">✓ Keep mine</button>
    </div>
  </div>

  <div class="col-divider"></div>

  <div class="col">
    <div class="col-header">
      <span class="col-label label-theirs">Incoming</span>
      <span class="col-ref" id="incoming-ref"></span>
    </div>
    <div class="note-card" id="card-theirs"></div>
    <div class="col-footer">
      <button class="btn-resolve btn-theirs" id="keep-theirs">✓ Keep theirs</button>
    </div>
  </div>
</div>

<div class="conflict-footer">
  <button class="btn-both" id="keep-both" title="Union tags, concatenate content with a divider — single-value fields (color, title) come from your version">⊕ Keep both</button>
  <button class="btn-raw" id="open-raw">Edit raw file manually</button>
</div>

<script nonce="${nonce}">
(() => {
  const vscode     = acquireVsCodeApi();
  const ours       = ${oursJson};
  const theirs     = ${theirsJson};
  const tags       = ${tagsJson};
  const COLORS     = ${colorsJson};
  const incomingRef = ${refJson};

  document.getElementById('conflict-title').textContent = 'Conflict in "' + ours.title + '"';
  document.getElementById('incoming-ref').textContent   = incomingRef;

  // ── Render both columns ────────────────────────────────────────────────
  renderCard(document.getElementById('card-ours'),   ours,   theirs);
  renderCard(document.getElementById('card-theirs'), theirs, ours);

  function renderCard(container, note, other) {
    // Title
    appendField(container, 'Title', note.title, note.title !== other.title);

    // Color
    const colorEl = document.createElement('div');
    const swatch  = document.createElement('span');
    swatch.className = 'color-swatch';
    swatch.style.background = COLORS[note.color] || NOTE_COLORS.yellow;
    colorEl.appendChild(swatch);
    colorEl.appendChild(document.createTextNode(note.color));
    appendFieldEl(container, 'Color', colorEl, note.color !== other.color);

    // Tags
    const tagsEl = document.createElement('div');
    if (note.tags.length === 0) {
      tagsEl.textContent = '—';
      tagsEl.style.opacity = '.5';
    } else {
      note.tags.forEach(tid => {
        const t   = tags.find(t => t.id === tid);
        if (!t) return;
        const pill = document.createElement('span');
        pill.className = 'tag-pill';
        pill.style.background = t.color;
        pill.textContent = t.label;
        tagsEl.appendChild(pill);
      });
    }
    const tagsChanged = JSON.stringify([...note.tags].sort()) !== JSON.stringify([...other.tags].sort());
    appendFieldEl(container, 'Tags', tagsEl, tagsChanged);

    // Content
    const pre = document.createElement('div');
    if (note.content.trim()) {
      pre.className = 'content-preview';
      pre.textContent = note.content.trim();
    } else {
      pre.className = 'content-empty';
      pre.textContent = 'Empty';
    }
    appendFieldEl(container, 'Content', pre, note.content.trim() !== other.content.trim());
  }

  function appendField(container, label, value, changed) {
    const span = document.createElement('span');
    span.textContent = value;
    appendFieldEl(container, label, span, changed);
  }

  function appendFieldEl(container, label, valueEl, changed) {
    const row   = document.createElement('div');
    row.className = 'field-row' + (changed ? ' changed' : '');
    const lbl   = document.createElement('div');
    lbl.className = 'field-label';
    lbl.textContent = label;
    const val   = document.createElement('div');
    val.className = 'field-value';
    val.appendChild(valueEl);
    row.appendChild(lbl);
    row.appendChild(val);
    container.appendChild(row);
  }

  // ── Buttons ────────────────────────────────────────────────────────────
  document.getElementById('keep-ours').addEventListener('click', () => {
    vscode.postMessage({ type: 'resolve', side: 'ours' });
  });
  document.getElementById('keep-theirs').addEventListener('click', () => {
    vscode.postMessage({ type: 'resolve', side: 'theirs' });
  });
  document.getElementById('keep-both').addEventListener('click', () => {
    vscode.postMessage({ type: 'resolve', side: 'both' });
  });
  document.getElementById('open-raw').addEventListener('click', () => {
    vscode.postMessage({ type: 'openRaw' });
  });
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
