import * as vscode from 'vscode';
import { parseFrontmatter, serializeFrontmatter } from './Frontmatter';

// ─── Data model ──────────────────────────────────────────────────────────────

export interface Note {
  id: string;
  title: string;
  content: string;       // stored as markdown
  color: string;         // key from NOTE_COLORS
  tags: string[];        // array of Tag ids
  starred: boolean;
  shared?: boolean;      // when true, note file is un-ignored in .devnotes/.gitignore
  createdAt: number;
  updatedAt: number;
}

export interface Tag {
  id: string;
  label: string;
  color: string;         // hex color for the tag pill
}

export interface CanvasLayout {
  [noteId: string]: { x: number; y: number; w: number; h: number };
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

// Legacy Memento keys — used only during one-time migration
const LEGACY_NOTES_KEY = 'devnotes.v2.notes';
const LEGACY_TAGS_KEY  = 'devnotes.v2.tags';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ─── Storage ─────────────────────────────────────────────────────────────────

/**
 * Persists notes as individual Markdown files with YAML frontmatter inside a
 * .devnotes/ folder at the workspace root.
 *
 * File layout
 * ───────────
 *   .devnotes/
 *     .gitignore          – ignores everything except .gitignore and tags.json
 *     tags.json           – custom Tag definitions (committed; shared with team)
 *     canvas-layout.json  – freeform card positions (gitignored; personal)
 *     <id>.md             – one file per note (personal by default; opt-in sharing
 *                           via the `shared` field which un-ignores the file)
 *
 * Concurrency model
 * ─────────────────
 *   • getNotes() / getTags() / getCanvasLayout() are synchronous reads from an
 *     in-memory cache — SidebarView and CanvasPanel callers need no changes.
 *   • Writes to individual note files are serialised per note ID via writeQueues.
 *   • Writes to canvas-layout.json and .gitignore are serialised via dedicated
 *     single-file queues so read-modify-write operations never race.
 *   • Self-triggered watcher events (our own writes) are suppressed via
 *     selfWrites (notes) and tagsWriteInflight (tags.json).
 *
 * External change detection
 * ─────────────────────────
 *   File watchers on *.md and tags.json update the cache and call
 *   onExternalChange() when files are modified outside the extension
 *   (e.g. after a git pull that brings in a teammate's shared notes).
 */
export class NoteStorage {
  private notes:  Note[]        = [];
  private tags:   Tag[]         = [];
  private layout: CanvasLayout  = {};

  /** Called when the cache is updated due to external file changes (e.g. git pull). */
  onExternalChange?: () => void;

  // Per-note write queue — prevents concurrent writes to the same note file
  private readonly writeQueues = new Map<string, Promise<void>>();
  // IDs of notes currently being written by us — suppresses self-triggered watcher events
  private readonly selfWrites  = new Set<string>();

  // Serialised queues for shared files (read-modify-write operations must not race)
  private layoutWriteQueue:    Promise<void> = Promise.resolve();
  private gitignoreWriteQueue: Promise<void> = Promise.resolve();

  // Counter for in-flight tags.json writes — suppresses self-triggered watcher events
  private tagsWriteInflight = 0;

  private readonly folder: vscode.Uri;

  constructor(
    workspaceRoot: vscode.Uri,
    private readonly legacyWorkspaceState: vscode.Memento,
    private readonly legacyGlobalState:   vscode.Memento,
  ) {
    this.folder = vscode.Uri.joinPath(workspaceRoot, '.devnotes');
  }

  /**
   * Must be awaited once before any other method is called.
   * Returns a Disposable for the file watcher — add it to context.subscriptions.
   */
  async init(): Promise<vscode.Disposable> {
    await this.ensureFolder();
    await this.migrate();
    this.notes  = await this.readAllNotes();
    this.tags   = await this.readTags();
    this.layout = await this.readCanvasLayout();
    return this.setupWatcher();
  }

  // ── Sync reads (from cache) ───────────────────────────────────────────────

  getNotes(): Note[] { return this.notes; }

  getNote(id: string): Note | undefined {
    return this.notes.find(n => n.id === id);
  }

  getTags(): Tag[] { return this.tags; }

  getCanvasLayout(): CanvasLayout { return this.layout; }

  // ── Notes ─────────────────────────────────────────────────────────────────

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
    this.notes.push(note);
    await this.writeNote(note);
    return note;
  }

  async updateNote(id: string, changes: Partial<Omit<Note, 'id' | 'createdAt'>>): Promise<void> {
    const idx = this.notes.findIndex(n => n.id === id);
    if (idx === -1) return;
    this.notes[idx] = { ...this.notes[idx], ...changes, updatedAt: Date.now() };
    await this.writeNote(this.notes[idx]);
    if ('shared' in changes) {
      await this.updateGitignore(id, changes.shared ?? false);
    }
  }

  async deleteNote(id: string): Promise<void> {
    this.notes = this.notes.filter(n => n.id !== id);
    try {
      await vscode.workspace.fs.delete(this.noteUri(id));
    } catch { /* already gone */ }
    // Only rewrite canvas layout if the note actually had a position
    if (id in this.layout) {
      delete this.layout[id];
      await this.writeCanvasLayout();
    }
    await this.updateGitignore(id, false);
  }

  // ── Canvas layout ─────────────────────────────────────────────────────────

  async updateCanvasLayout(
    id: string,
    rect: { x: number; y: number; w: number; h: number }
  ): Promise<void> {
    this.layout[id] = rect;
    await this.writeCanvasLayout();
  }

  // ── Tags ──────────────────────────────────────────────────────────────────

  async addTag(label: string, color: string): Promise<Tag> {
    const tag: Tag = { id: generateId(), label, color };
    this.tags = [...this.tags, tag];
    await this.writeTags();
    return tag;
  }

  async deleteTag(id: string): Promise<void> {
    const isDefault = DEFAULT_TAGS.some(t => t.id === id);

    if (!isDefault) {
      this.tags = this.tags.filter(t => t.id !== id);
      await this.writeTags();
    }

    // Scrub tag from affected notes, bumping updatedAt so git history reflects the change
    const affected = this.notes.filter(n => n.tags.includes(id));
    if (affected.length > 0) {
      const now = Date.now();
      this.notes = this.notes.map(n =>
        n.tags.includes(id)
          ? { ...n, tags: n.tags.filter(t => t !== id), updatedAt: now }
          : n
      );
      await Promise.all(
        affected.map(n => this.writeNote(this.notes.find(m => m.id === n.id)!))
      );
    }
  }

  // ── Private: folder setup ─────────────────────────────────────────────────

  private async ensureFolder(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.folder);
    } catch { /* already exists */ }

    const gitignorePath = vscode.Uri.joinPath(this.folder, '.gitignore');
    try {
      await vscode.workspace.fs.stat(gitignorePath);
    } catch {
      // Ignore everything by default — the folder stays invisible to git until
      // the user explicitly marks a note as shared. Nothing surfaces without consent.
      await vscode.workspace.fs.writeFile(gitignorePath, enc.encode('*\n'));
    }
  }

  // ── Private: file I/O ─────────────────────────────────────────────────────

  private noteUri(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.folder, `${id}.md`);
  }

  private async readAllNotes(): Promise<Note[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.folder);
      const results = await Promise.all(
        entries
          .filter(([name]) => name.endsWith('.md'))
          .map(async ([name]) => {
            try {
              const raw = await vscode.workspace.fs.readFile(
                vscode.Uri.joinPath(this.folder, name)
              );
              return this.parseNoteFile(dec.decode(raw), name);
            } catch (err) {
              console.warn(`[DevNotes] Could not read note file "${name}":`, err);
              return null;
            }
          })
      );
      return results.filter((n): n is Note => n !== null);
    } catch {
      return [];
    }
  }

  private parseNoteFile(raw: string, fileName = '<unknown>'): Note | null {
    try {
      const { meta, body } = parseFrontmatter(raw);
      const id = String(meta.id ?? '');
      if (!id) {
        console.warn(`[DevNotes] Skipping "${fileName}": missing id in frontmatter`);
        return null;
      }
      return {
        id,
        title    : String(meta.title    ?? 'Untitled'),
        content  : body,
        color    : String(meta.color    ?? 'yellow'),
        tags     : meta.tags ? String(meta.tags).split(',').filter(Boolean) : [],
        starred  : meta.starred  === true,
        shared   : meta.shared   === true,
        createdAt: Number(meta.createdAt ?? Date.now()),
        updatedAt: Number(meta.updatedAt ?? Date.now()),
      };
    } catch (err) {
      console.warn(`[DevNotes] Failed to parse "${fileName}":`, err);
      return null;
    }
  }

  // ── Write queue — serialises concurrent writes to the same file ───────────

  private writeNote(note: Note): Promise<void> {
    const prev = this.writeQueues.get(note.id) ?? Promise.resolve();
    const next = prev.then(() => this.doWriteNote(note));
    // Non-rejecting entry so future writes are never blocked by an error.
    // Cleans itself up once settled and no newer write has replaced it.
    const entry = next.catch(() => {}).finally(() => {
      if (this.writeQueues.get(note.id) === entry) this.writeQueues.delete(note.id);
    });
    this.writeQueues.set(note.id, entry);
    return next;
  }

  private async doWriteNote(note: Note): Promise<void> {
    this.selfWrites.add(note.id);
    try {
      const meta: Record<string, unknown> = {
        id       : note.id,
        title    : note.title,
        color    : note.color,
        tags     : note.tags.join(','),
        starred  : note.starred,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      };
      if (note.shared) meta.shared = true;
      await vscode.workspace.fs.writeFile(
        this.noteUri(note.id),
        enc.encode(serializeFrontmatter(meta, note.content))
      );
    } finally {
      // Clear after a short delay — watcher events arrive asynchronously
      setTimeout(() => this.selfWrites.delete(note.id), 500);
    }
  }

  private async readTags(): Promise<Tag[]> {
    try {
      const raw    = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(this.folder, 'tags.json')
      );
      const custom = JSON.parse(dec.decode(raw)) as Tag[];
      const customIds = new Set(custom.map(t => t.id));
      return [
        ...DEFAULT_TAGS.filter(t => !customIds.has(t.id)),
        ...custom,
      ];
    } catch {
      return [...DEFAULT_TAGS];
    }
  }

  private async writeTags(): Promise<void> {
    this.tagsWriteInflight++;
    try {
      const defaultIds = new Set(DEFAULT_TAGS.map(t => t.id));
      const custom = this.tags.filter(t => !defaultIds.has(t.id));
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(this.folder, 'tags.json'),
        enc.encode(JSON.stringify(custom, null, 2))
      );
    } finally {
      setTimeout(() => this.tagsWriteInflight--, 500);
    }
  }

  private async readCanvasLayout(): Promise<CanvasLayout> {
    try {
      const raw = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(this.folder, 'canvas-layout.json')
      );
      return JSON.parse(dec.decode(raw)) as CanvasLayout;
    } catch {
      return {};
    }
  }

  // Serialised via layoutWriteQueue — concurrent drag/resize events never race
  private writeCanvasLayout(): Promise<void> {
    this.layoutWriteQueue = this.layoutWriteQueue
      .then(() => this.doWriteCanvasLayout())
      .catch(() => {});
    return this.layoutWriteQueue;
  }

  private async doWriteCanvasLayout(): Promise<void> {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(this.folder, 'canvas-layout.json'),
      enc.encode(JSON.stringify(this.layout, null, 2))
    );
  }

  // Serialised via gitignoreWriteQueue — each read-modify-write sees the previous result
  private updateGitignore(id: string, shared: boolean): Promise<void> {
    this.gitignoreWriteQueue = this.gitignoreWriteQueue
      .then(() => this.doUpdateGitignore(id, shared))
      .catch(() => {});
    return this.gitignoreWriteQueue;
  }

  private async doUpdateGitignore(id: string, shared: boolean): Promise<void> {
    const gitignorePath = vscode.Uri.joinPath(this.folder, '.gitignore');
    let content: string;
    try {
      content = dec.decode(await vscode.workspace.fs.readFile(gitignorePath));
    } catch {
      return;
    }

    const noteEntry      = `!${id}.md`;
    const gitignoreEntry = '!.gitignore';

    const lines = content.split('\n').filter(l => l.trim() !== noteEntry);

    if (shared) {
      // Un-ignore .gitignore itself the first time any note is shared so
      // teammates can pull the sharing rules alongside the note.
      if (!lines.some(l => l.trim() === gitignoreEntry)) {
        lines.push(gitignoreEntry);
      }
      lines.push(noteEntry);
    }

    await vscode.workspace.fs.writeFile(gitignorePath, enc.encode(lines.join('\n')));
  }

  // ── Private: file watcher ─────────────────────────────────────────────────

  private setupWatcher(): vscode.Disposable {
    // ── Notes watcher (.devnotes/*.md) ──────────────────────────────────
    const notesWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.folder, '*.md')
    );

    const reload = async (uri: vscode.Uri): Promise<void> => {
      const fileName = uri.path.split('/').pop() ?? '';
      const id = fileName.endsWith('.md') ? fileName.slice(0, -3) : '';
      if (!id || this.selfWrites.has(id)) return;
      try {
        const raw  = dec.decode(await vscode.workspace.fs.readFile(uri));
        const note = this.parseNoteFile(raw, fileName);
        if (!note) return;
        const idx = this.notes.findIndex(n => n.id === note.id);
        if (idx === -1) this.notes.push(note);
        else this.notes[idx] = note;
        this.onExternalChange?.();
      } catch { /* file removed between event and read — ignore */ }
    };

    const evict = (uri: vscode.Uri): void => {
      const fileName = uri.path.split('/').pop() ?? '';
      const id = fileName.endsWith('.md') ? fileName.slice(0, -3) : '';
      if (!id || this.selfWrites.has(id)) return;
      const before = this.notes.length;
      this.notes = this.notes.filter(n => n.id !== id);
      if (this.notes.length !== before) this.onExternalChange?.();
    };

    notesWatcher.onDidCreate(reload);
    notesWatcher.onDidChange(reload);
    notesWatcher.onDidDelete(evict);

    // ── Tags watcher (.devnotes/tags.json) ──────────────────────────────
    const tagsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.folder, 'tags.json')
    );

    const reloadTags = async (): Promise<void> => {
      if (this.tagsWriteInflight > 0) return;
      this.tags = await this.readTags();
      this.onExternalChange?.();
    };

    tagsWatcher.onDidChange(reloadTags);
    tagsWatcher.onDidCreate(reloadTags);

    return vscode.Disposable.from(notesWatcher, tagsWatcher);
  }

  // ── Private: one-time migration from Memento ──────────────────────────────

  private async migrate(): Promise<void> {
    // ── Notes (workspace-scoped → .md files) ────────────────────────────
    const legacyNotes = this.legacyWorkspaceState.get<any[]>(LEGACY_NOTES_KEY, []);
    if (legacyNotes.length > 0) {
      const migratedLayout: CanvasLayout = {};
      for (const raw of legacyNotes) {
        // Extract canvas position into layout map
        if (raw.canvas) {
          migratedLayout[raw.id] = raw.canvas;
        }
        // Write note without the canvas field
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { canvas, ...note } = raw;
        await this.writeNote(note as Note);
      }
      if (Object.keys(migratedLayout).length > 0) {
        this.layout = migratedLayout;
        await this.writeCanvasLayout();
      }
      await this.legacyWorkspaceState.update(LEGACY_NOTES_KEY, undefined);
    }

    // ── Tags (global → tags.json, only if file doesn't exist yet) ───────
    const tagsPath = vscode.Uri.joinPath(this.folder, 'tags.json');
    let tagsFileExists = false;
    try {
      await vscode.workspace.fs.stat(tagsPath);
      tagsFileExists = true;
    } catch { /* file doesn't exist */ }

    if (!tagsFileExists) {
      const legacyTags = this.legacyGlobalState.get<Tag[]>(LEGACY_TAGS_KEY, []);
      if (legacyTags.length > 0) {
        await vscode.workspace.fs.writeFile(
          tagsPath,
          enc.encode(JSON.stringify(legacyTags, null, 2))
        );
      }
      // Note: legacyGlobalState is NOT cleared — other workspaces need it for their own migration
    }
  }
}
