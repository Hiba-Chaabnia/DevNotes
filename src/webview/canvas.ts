/**
 * canvas.ts — Tiptap rich-text editor for DevNotes Canvas
 *
 * Bundled by esbuild → media/canvas.js
 * Runs inside the Canvas WebviewPanel — no Node.js APIs available.
 *
 * Exposes two globals used by the inline canvas script:
 *   window.initTiptap(el, markdownContent, onChange) → Editor
 *   window.destroyTiptap(editor) → void
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Markdown } from 'tiptap-markdown';

declare global {
  interface Window {
    initTiptap: (
      el: HTMLElement,
      content: string,
      onChange: (md: string) => void
    ) => Editor;
    destroyTiptap: (editor: Editor) => void;
  }
}

window.initTiptap = (
  el: HTMLElement,
  content: string,
  onChange: (md: string) => void
): Editor => {
  const editor = new Editor({
    element: el,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content,
    editorProps: {
      attributes: {
        class: 'ProseMirror',
        spellcheck: 'true',
      },
    },
    onUpdate({ editor }) {
      const storage = editor.storage as unknown as Record<string, { getMarkdown(): string }>;
      const md = storage['markdown']?.getMarkdown?.() ?? '';
      onChange(md);
    },
  });
  return editor;
};

window.destroyTiptap = (editor: Editor): void => {
  editor.destroy();
};
