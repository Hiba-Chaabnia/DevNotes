import * as vscode from 'vscode';
import { NoteStorage, BUILTIN_TEMPLATES } from './NoteStorage';

// ─── Panel ───────────────────────────────────────────────────────────────────

export class EditorPanel {
  static current?: EditorPanel;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  readonly noteId: string;

  // Maps webview-safe image URIs → workspace-relative storage paths.
  // Populated when images are pasted or when a note with images is loaded.
  // Used to convert URIs back to paths before writing markdown to disk.
  private readonly imageUriMap = new Map<string, string>();

  // ── Static factory ──────────────────────────────────────────────────────

  static show(
    context: vscode.ExtensionContext,
    storage: NoteStorage,
    noteId: string,
    onUpdate?: () => void
  ): void {
    if (!storage.getNote(noteId)) return;

    if (EditorPanel.current) {
      if (EditorPanel.current.noteId === noteId) {
        EditorPanel.current.panel.reveal(vscode.ViewColumn.One);
        return;
      }
      EditorPanel.current.panel.dispose();
    }
    new EditorPanel(context, storage, noteId, onUpdate);
  }

  // ── Push updated content (e.g. after external file change) ─────────────

  push(): void {
    const note = this.storage.getNote(this.noteId);
    if (!note) return;
    this.panel.webview.postMessage({
      type   : 'setContent',
      content: this.toDisplayContent(note.content),
      title  : note.title,
    });
    this.panel.title = `✏ ${note.title}`;
  }

  // ── Constructor ─────────────────────────────────────────────────────────

  private constructor(
    context: vscode.ExtensionContext,
    private readonly storage: NoteStorage,
    noteId: string,
    private readonly onUpdate?: () => void
  ) {
    this.noteId = noteId;
    const note  = storage.getNote(noteId)!; // validated by show()

    const editorJsUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'editor.js');

    this.panel = vscode.window.createWebviewPanel(
      'devnotes.editor',
      `✏ ${note.title}`,
      vscode.ViewColumn.One,
      {
        enableScripts          : true,
        retainContextWhenHidden: true,
        localResourceRoots     : [
          vscode.Uri.joinPath(context.extensionUri, 'media'),
          vscode.Uri.joinPath(storage.folderUri, 'assets'),
        ],
      }
    );

    // Convert stored image paths to webview URIs for display
    const displayContent = this.toDisplayContent(note.content);

    this.panel.webview.html = this.buildHtml(
      this.panel.webview.asWebviewUri(editorJsUri),
      this.panel.webview.cspSource,
      displayContent,
      note.title
    );

    this.panel.webview.onDidReceiveMessage(
      async (msg: { type: string; content?: string; title?: string; base64?: string; mimeType?: string; ext?: string }) => {
        if (msg.type === 'save' && msg.content !== undefined) {
          // Convert webview image URIs back to storage-relative paths before saving
          const content = this.toStorageContent(msg.content);
          await this.storage.updateNote(this.noteId, { content });
          this.onUpdate?.();

        } else if (msg.type === 'saveTitle' && msg.title) {
          const trimmed = msg.title.trim();
          if (trimmed) {
            await this.storage.updateNote(this.noteId, { title: trimmed });
            this.panel.title = `✏ ${trimmed}`;
            this.onUpdate?.();
          }

        } else if (msg.type === 'applyTemplate') {
          const templates = this.storage.getTemplates();
          type TplItem = vscode.QuickPickItem & { templateId?: string };
          const items: TplItem[] = templates.map(t => ({
            label      : t.name,
            description: t.content.replace(/#+\s/g, '').replace(/\n/g, ' ').slice(0, 72),
            templateId : t.id,
          }));
          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Choose a template to apply',
          });
          if (!picked?.templateId) return;
          const tpl = templates.find(t => t.id === picked.templateId);
          if (!tpl) return;
          this.panel.webview.postMessage({ type: 'insertTemplate', content: tpl.content });

        } else if (msg.type === 'pasteImage' && msg.base64) {
          await this.handlePasteImage(msg.base64, msg.ext ?? 'png');

        } else if (msg.type === 'exportCurrentNote') {
          vscode.commands.executeCommand('devnotes.exportNote', this.noteId);

        } else if (msg.type === 'saveAsTemplate' && msg.content !== undefined) {
          const name = await vscode.window.showInputBox({
            prompt     : 'Template name',
            placeHolder: 'e.g. My Sprint Note',
          });
          if (!name?.trim()) return;
          await this.storage.addTemplate({ name: name.trim(), content: msg.content });
          vscode.window.showInformationMessage(`Template "${name.trim()}" saved.`);
          this.onUpdate?.();
        }
      },
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => {
      EditorPanel.current = undefined;
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);

    EditorPanel.current = this;
  }

  // ── Image helpers ───────────────────────────────────────────────────────

  /** Writes a pasted image to .devnotes/assets/ and inserts it into the editor. */
  private async handlePasteImage(base64: string, rawExt: string): Promise<void> {
    const ext       = rawExt.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'png';
    const filename  = `${this.noteId}-${Date.now()}.${ext}`;
    const assetUri  = vscode.Uri.joinPath(this.storage.folderUri, 'assets', filename);

    // Ensure .devnotes/assets/ exists
    try {
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.joinPath(this.storage.folderUri, 'assets')
      );
    } catch { /* already exists */ }

    // Write image bytes decoded from base64
    await vscode.workspace.fs.writeFile(assetUri, Buffer.from(base64, 'base64'));

    // Register the webview URI → storage path mapping
    const webviewUri = this.panel.webview.asWebviewUri(assetUri).toString();
    this.imageUriMap.set(webviewUri, `.devnotes/assets/${filename}`);

    this.panel.webview.postMessage({ type: 'insertImage', src: webviewUri });
  }

  /**
   * Converts stored image paths (.devnotes/assets/...) to webview-safe URIs
   * so the editor can display images. Also populates imageUriMap.
   */
  private toDisplayContent(markdown: string): string {
    return markdown.replace(
      /!\[([^\]]*)\]\(\.devnotes\/assets\/([^)]+)\)/g,
      (_, alt: string, filename: string) => {
        const assetUri   = vscode.Uri.joinPath(this.storage.folderUri, 'assets', filename);
        const webviewUri = this.panel.webview.asWebviewUri(assetUri).toString();
        this.imageUriMap.set(webviewUri, `.devnotes/assets/${filename}`);
        return `![${alt}](${webviewUri})`;
      }
    );
  }

  /**
   * Converts webview image URIs back to storage-relative paths before saving
   * to disk. Uses the imageUriMap built up during paste and load operations.
   */
  private toStorageContent(markdown: string): string {
    let content = markdown;
    for (const [webviewUri, storagePath] of this.imageUriMap) {
      // split/join avoids regex issues with special characters in webview URIs
      content = content.split(webviewUri).join(storagePath);
    }
    return content;
  }

  // ── HTML ────────────────────────────────────────────────────────────────

  private buildHtml(editorJsUri: vscode.Uri, cspSource: string, initialContent: string, initialTitle: string): string {
    const nonce   = getNonce();
    const content = JSON.stringify(initialContent);
    const title   = JSON.stringify(initialTitle);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src 'unsafe-inline'; img-src ${cspSource} data:;">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: 14px;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Note title ── */
  #title-input {
    display: block;
    width: 100%;
    background: transparent;
    border: none;
    border-bottom: 1px solid transparent;
    outline: none;
    font-size: 1.55em;
    font-weight: 700;
    color: var(--vscode-editor-foreground);
    padding: 18px min(10%, 80px) 10px;
    font-family: var(--vscode-font-family);
    flex-shrink: 0;
    transition: border-color .15s;
  }
  #title-input:focus {
    border-bottom-color: var(--vscode-focusBorder, var(--vscode-panel-border));
  }
  #title-input::placeholder {
    color: var(--vscode-input-placeholderForeground);
    font-weight: 400;
  }

  /* ── Toolbar ── */
  #toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    flex-wrap: wrap;
    background: var(--vscode-sideBar-background);
  }
  #toolbar button {
    background: none;
    border: none;
    border-radius: 4px;
    padding: 3px 7px;
    cursor: pointer;
    font-size: 12px;
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    min-width: 26px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: .72;
    transition: background .1s, opacity .1s;
  }
  #toolbar button:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground);
    opacity: 1;
  }
  #toolbar button.is-active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    opacity: 1;
  }
  #toolbar button:disabled { opacity: .28; cursor: default; }
  .tb-sep { width: 1px; height: 16px; background: var(--vscode-panel-border); margin: 0 3px; flex-shrink: 0; }

  /* ── Editor area ── */
  #editor-mount {
    flex: 1;
    overflow-y: auto;
    padding: 14px min(10%, 80px) 28px;
  }
  .ProseMirror {
    outline: none;
    min-height: 100%;
    line-height: 1.72;
    font-size: 14px;
    max-width: 760px;
    margin: 0 auto;
  }
  .ProseMirror p { margin-bottom: .75em; }
  .ProseMirror h1 { font-size: 1.8em; font-weight: 700; margin: 1.1em 0 .45em; line-height: 1.25; }
  .ProseMirror h2 { font-size: 1.35em; font-weight: 700; margin: 1em 0 .4em; }
  .ProseMirror h3 { font-size: 1.1em; font-weight: 700; margin: .9em 0 .35em; }
  .ProseMirror ul, .ProseMirror ol { padding-left: 1.6em; margin-bottom: .75em; }
  .ProseMirror li { margin: 2px 0; }
  .ProseMirror blockquote {
    border-left: 3px solid var(--vscode-panel-border);
    margin: .75em 0;
    padding-left: 1em;
    opacity: .8;
  }
  .ProseMirror code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: .875em;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.15));
    padding: 1px 5px;
    border-radius: 3px;
  }
  .ProseMirror pre {
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.15));
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: .75em;
    overflow-x: auto;
  }
  .ProseMirror pre code { background: none; padding: 0; font-size: .9em; }
  .ProseMirror ul[data-type="taskList"] { list-style: none; padding-left: 0; }
  .ProseMirror ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 8px; }
  .ProseMirror ul[data-type="taskList"] li > label { margin-top: 3px; flex-shrink: 0; }

  /* ── Images ── */
  .ProseMirror img {
    max-width: 100%;
    height: auto;
    border-radius: 5px;
    display: block;
    margin: .75em 0;
    cursor: default;
  }
  .ProseMirror img.ProseMirror-selectednode {
    outline: 2px solid var(--vscode-focusBorder, #0078d4);
    border-radius: 5px;
  }

  /* ── Status bar ── */
  #save-status {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    padding: 3px 10px;
    border-top: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    min-height: 20px;
    background: var(--vscode-sideBar-background);
  }
</style>
</head>
<body>

<input id="title-input" type="text" placeholder="Untitled" spellcheck="false" autocomplete="off">

<div id="toolbar">
  <button data-action="bold"        title="Bold (Ctrl+B)"><b>B</b></button>
  <button data-action="italic"      title="Italic (Ctrl+I)"><i>I</i></button>
  <button data-action="strike"      title="Strikethrough"><s>S</s></button>
  <button data-action="code"        title="Inline code" style="font-family:monospace;letter-spacing:-.5px">\`\`</button>
  <div class="tb-sep"></div>
  <button data-action="h1"          title="Heading 1">H1</button>
  <button data-action="h2"          title="Heading 2">H2</button>
  <button data-action="h3"          title="Heading 3">H3</button>
  <div class="tb-sep"></div>
  <button data-action="bulletList"  title="Bullet list">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
      <circle cx="4" cy="7"  r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="4" cy="12" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="4" cy="17" r="1.5" fill="currentColor" stroke="none"/>
      <line x1="9" y1="7"  x2="20" y2="7"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="17" x2="20" y2="17"/>
    </svg>
  </button>
  <button data-action="orderedList" title="Ordered list">1.</button>
  <button data-action="taskList"    title="Task list">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
      <rect x="3" y="5" width="5" height="5" rx="1"/><rect x="3" y="14" width="5" height="5" rx="1"/>
      <line x1="11" y1="7.5" x2="21" y2="7.5"/><line x1="11" y1="16.5" x2="21" y2="16.5"/>
    </svg>
  </button>
  <div class="tb-sep"></div>
  <button data-action="blockquote"  title="Blockquote">❝</button>
  <button data-action="codeBlock"   title="Code block" style="font-family:monospace">{}</button>
  <div class="tb-sep"></div>
  <button data-action="undo"        title="Undo (Ctrl+Z)">↩</button>
  <button data-action="redo"        title="Redo">↪</button>
  <div class="tb-sep"></div>
  <button data-action="applyTemplate"      title="Apply a template to this note" style="font-size:11px;padding:2px 6px">Tpl↓</button>
  <button data-action="saveAsTemplate"     title="Save this note as a custom template" style="font-size:11px;padding:2px 6px">Tpl↑</button>
  <div class="tb-sep"></div>
  <button data-action="exportCurrentNote"  title="Export this note" style="font-size:11px;padding:2px 6px">Export</button>
</div>

<div id="editor-mount"></div>
<div id="save-status"></div>

<script nonce="${nonce}">var __INITIAL_CONTENT__ = ${content}; var __INITIAL_TITLE__ = ${title};</script>
<script src="${editorJsUri}" nonce="${nonce}"></script>
</body>
</html>`;
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
