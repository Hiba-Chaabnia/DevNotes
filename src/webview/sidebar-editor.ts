import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';

let editor: Editor | null = null;

const SidebarEditor = {
  init(el: HTMLElement): void {
    if (editor) {
      editor.destroy();
      editor = null;
    }
    editor = new Editor({
      element: el,
      extensions: [StarterKit, Markdown],
      content: '',
      onCreate({ editor: e }) {
        el.classList.toggle('is-empty', e.isEmpty);
      },
      onUpdate({ editor: e }) {
        el.classList.toggle('is-empty', e.isEmpty);
      },
    });
    el.classList.toggle('is-empty', editor.isEmpty);
  },

  getMarkdown(): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((editor?.storage as any)?.markdown?.getMarkdown() as string | undefined) ?? '';
  },

  clear(): void {
    editor?.commands.clearContent(true);
  },

  toggleFormat(cmd: string): void {
    if (!editor) { return; }
    const chain = editor.chain().focus();
    switch (cmd) {
      case 'bold':       chain.toggleBold().run();       break;
      case 'italic':     chain.toggleItalic().run();     break;
      case 'strike':     chain.toggleStrike().run();     break;
      case 'bulletList': chain.toggleBulletList().run(); break;
    }
  },

  isActive(name: string): boolean {
    return editor?.isActive(name) ?? false;
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).SidebarEditor = SidebarEditor;
