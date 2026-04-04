/**
 * editor.ts — Tiptap rich-text editor for DevNotes
 *
 * Bundled by esbuild → media/editor.js
 * Runs inside a VS Code WebviewPanel — no Node.js APIs available.
 *
 * Message protocol (unchanged from Phase 1 textarea):
 *   Extension → Webview : { type: 'setContent', content: string }   (markdown)
 *   Webview → Extension : { type: 'save',       content: string }   (markdown)
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Markdown } from 'tiptap-markdown';

// ── Globals injected by EditorPanel.ts before this script loads ──────────────
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
declare const __INITIAL_CONTENT__: string;
declare const __INITIAL_TITLE__: string;

// ── Bootstrap ────────────────────────────────────────────────────────────────
(function main() {
  const vscode   = acquireVsCodeApi();
  const statusEl = document.getElementById('save-status') as HTMLElement;
  const mountEl  = document.getElementById('editor-mount') as HTMLElement;
  const toolbarEl = document.getElementById('toolbar') as HTMLElement;
  const titleEl  = document.getElementById('title-input') as HTMLInputElement | null;

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Tiptap instance ──────────────────────────────────────────────────────
  // ── Title input ──────────────────────────────────────────────────────────
  if (titleEl) {
    titleEl.value = typeof __INITIAL_TITLE__ !== 'undefined' ? __INITIAL_TITLE__ : '';
    titleEl.addEventListener('blur', () => {
      const t = titleEl!.value.trim();
      if (t) vscode.postMessage({ type: 'saveTitle', title: t });
    });
    titleEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter')  { e.preventDefault(); titleEl!.blur(); }
      if (e.key === 'Escape') titleEl!.blur();
    });
  }

  const editor = new Editor({
    element: mountEl,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({
        html: false,
        linkify: true,
        transformCopiedText: true,
        transformPastedText: true,
      }),
    ],
    content: typeof __INITIAL_CONTENT__ !== 'undefined' ? __INITIAL_CONTENT__ : '',
    autofocus: true,
    editorProps: {
      attributes: {
        class: 'prose',
        spellcheck: 'true',
      },
    },
    onUpdate() {
      statusEl.textContent = 'Unsaved…';
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 1000);
    },
  });

  function save() {
    const storage = editor.storage as unknown as Record<string, { getMarkdown(): string }>;
    const md = storage['markdown'].getMarkdown();
    vscode.postMessage({ type: 'save', content: md });
    statusEl.textContent = 'Saved';
  }

  // ── Toolbar active-state sync ────────────────────────────────────────────
  const ACTIVE_CHECKS: Record<string, () => boolean> = {
    bold:        () => editor.isActive('bold'),
    italic:      () => editor.isActive('italic'),
    strike:      () => editor.isActive('strike'),
    code:        () => editor.isActive('code'),
    h1:          () => editor.isActive('heading', { level: 1 }),
    h2:          () => editor.isActive('heading', { level: 2 }),
    h3:          () => editor.isActive('heading', { level: 3 }),
    bulletList:  () => editor.isActive('bulletList'),
    orderedList: () => editor.isActive('orderedList'),
    taskList:    () => editor.isActive('taskList'),
    blockquote:  () => editor.isActive('blockquote'),
    codeBlock:   () => editor.isActive('codeBlock'),
  };

  function syncToolbar() {
    toolbarEl.querySelectorAll('[data-action]').forEach(el => {
      const btn = el as HTMLButtonElement;
      const action = btn.dataset.action ?? '';
      if (action in ACTIVE_CHECKS) {
        btn.classList.toggle('is-active', ACTIVE_CHECKS[action]());
      }
      if (action === 'undo') btn.disabled = !editor.can().undo();
      if (action === 'redo') btn.disabled = !editor.can().redo();
    });
  }

  editor.on('selectionUpdate', syncToolbar);
  editor.on('transaction', syncToolbar);

  // ── Toolbar click handler ────────────────────────────────────────────────
  // Use mousedown + preventDefault so the editor never loses focus
  toolbarEl.addEventListener('mousedown', e => {
    const btn = (e.target as Element).closest('[data-action]') as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    e.preventDefault();

    const ch = editor.chain().focus();
    switch (btn.dataset.action) {
      case 'bold':        ch.toggleBold().run();                break;
      case 'italic':      ch.toggleItalic().run();              break;
      case 'strike':      ch.toggleStrike().run();              break;
      case 'code':        ch.toggleCode().run();                break;
      case 'h1':          ch.toggleHeading({ level: 1 }).run(); break;
      case 'h2':          ch.toggleHeading({ level: 2 }).run(); break;
      case 'h3':          ch.toggleHeading({ level: 3 }).run(); break;
      case 'bulletList':  ch.toggleBulletList().run();          break;
      case 'orderedList': ch.toggleOrderedList().run();         break;
      case 'taskList':    ch.toggleTaskList().run();            break;
      case 'blockquote':  ch.toggleBlockquote().run();          break;
      case 'codeBlock':   ch.toggleCodeBlock().run();           break;
      case 'undo':        ch.undo().run();                      break;
      case 'redo':        ch.redo().run();                      break;
      case 'applyTemplate':
        vscode.postMessage({ type: 'applyTemplate' });
        break;
      case 'saveAsTemplate': {
        const mdStorage = editor.storage as unknown as Record<string, { getMarkdown(): string }>;
        vscode.postMessage({ type: 'saveAsTemplate', content: mdStorage['markdown'].getMarkdown() });
        break;
      }
    }
  });

  // ── Messages from extension ──────────────────────────────────────────────
  window.addEventListener('message', ({ data }) => {
    if (data?.type === 'setContent') {
      // Pass emitUpdate:false so auto-save doesn't fire on programmatic updates
      editor.commands.setContent(data.content ?? '', { emitUpdate: false } as never);
      if (titleEl && data.title !== undefined) {
        titleEl.value = data.title;
      }
    }
    if (data?.type === 'insertTemplate') {
      // emitUpdate fires onUpdate → schedules auto-save so the template content persists
      editor.commands.setContent(data.content ?? '');
      statusEl.textContent = 'Unsaved…';
    }
  });

  // ── Flush pending save when the panel is closed ──────────────────────────
  window.addEventListener('pagehide', () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      save();
    }
  });
})();
