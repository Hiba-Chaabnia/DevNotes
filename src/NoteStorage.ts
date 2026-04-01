import * as vscode from 'vscode';

// ─── Data model ──────────────────────────────────────────────────────────────

export interface Note {
  id: string;
  title: string;
  content: string;       // stored as markdown
  color: string;         // key from NOTE_COLORS
  tags: string[];        // array of Tag ids
  starred: boolean;
  createdAt: number;
  updatedAt: number;
  /** Set when the note has been placed on the freeform canvas. */
  canvas?: { x: number; y: number; w: number; h: number };
}

export interface Tag {
  id: string;
  label: string;
  color: string;         // hex color for the tag pill
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const NOTE_COLORS: Record<string, string> = {
  yellow : '#FFD166',
  orange : '#EF6C57',
  purple : '#B5A4E8',
  cyan   : '#06D6D6',
  green  : '#C5E17A',
  pink   : '#FF9EBA',
  blue   : '#74B9FF',
  white  : '#F8F9FA',
};

export const DEFAULT_TAGS: Tag[] = [
  { id: 'idea',      label: 'Idea',      color: '#FFD166' },
  { id: 'todo',      label: 'Todo',      color: '#06D6D6' },
  { id: 'bug',       label: 'Bug',       color: '#EF6C57' },
  { id: 'meeting',   label: 'Meeting',   color: '#B5A4E8' },
  { id: 'important', label: 'Important', color: '#C5E17A' },
  { id: 'reference', label: 'Reference', color: '#74B9FF' },
];

const NOTES_KEY = 'devnotes.v2.notes';
const TAGS_KEY  = 'devnotes.v2.tags';   // custom tags only (defaults always merged in)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ─── Storage ─────────────────────────────────────────────────────────────────

/**
 * Notes are workspace-scoped (one pool per project).
 * Tags are global (shared across all projects — "Bug", "Todo" etc. are universal).
 */
export class NoteStorage {
  constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly globalState: vscode.Memento
  ) {}

  // ── Notes ─────────────────────────────────────────────────────────────────

  getNotes(): Note[] {
    return this.workspaceState.get<Note[]>(NOTES_KEY, []);
  }

  getNote(id: string): Note | undefined {
    return this.getNotes().find(n => n.id === id);
  }

  async createNote(partial: { title: string; color?: string; tags?: string[] }): Promise<Note> {
    const note: Note = {
      id       : generateId(),
      title    : partial.title,
      content  : '',
      color    : partial.color ?? 'yellow',
      tags     : partial.tags  ?? [],
      starred  : false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.workspaceState.update(NOTES_KEY, [...this.getNotes(), note]);
    return note;
  }

  async updateNote(id: string, changes: Partial<Omit<Note, 'id' | 'createdAt'>>): Promise<void> {
    const notes = this.getNotes();
    const idx   = notes.findIndex(n => n.id === id);
    if (idx === -1) return;
    notes[idx] = { ...notes[idx], ...changes, updatedAt: Date.now() };
    await this.workspaceState.update(NOTES_KEY, notes);
  }

  async deleteNote(id: string): Promise<void> {
    await this.workspaceState.update(
      NOTES_KEY,
      this.getNotes().filter(n => n.id !== id)
    );
  }

  // ── Tags ──────────────────────────────────────────────────────────────────

  /** Returns predefined defaults merged with user-created custom tags. */
  getTags(): Tag[] {
    const custom    = this.globalState.get<Tag[]>(TAGS_KEY, []);
    const customIds = new Set(custom.map(t => t.id));
    return [
      ...DEFAULT_TAGS.filter(t => !customIds.has(t.id)),
      ...custom,
    ];
  }

  async addTag(label: string, color: string): Promise<Tag> {
    const tag: Tag = { id: generateId(), label, color };
    const custom   = this.globalState.get<Tag[]>(TAGS_KEY, []);
    await this.globalState.update(TAGS_KEY, [...custom, tag]);
    return tag;
  }

  async deleteTag(id: string): Promise<void> {
    // Remove from custom list
    await this.globalState.update(
      TAGS_KEY,
      this.globalState.get<Tag[]>(TAGS_KEY, []).filter(t => t.id !== id)
    );
    // Scrub from all notes
    const notes = this.getNotes().map(n => ({
      ...n,
      tags: n.tags.filter(t => t !== id),
    }));
    await this.workspaceState.update(NOTES_KEY, notes);
  }
}
