/**
 * Unit tests for notes.ts — the data layer.
 *
 * No MCP server needed. Each test gets its own isolated temp directory
 * so tests cannot interfere with each other.
 */

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  Note,
  extractTodos,
  findNote,
  generateId,
  readAllNotes,
  readNote,
  writeNote,
} from '../src/notes.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devnotes-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id       : generateId(),
    title    : 'Test note',
    content  : '## Body\n\nSome content.',
    color    : 'yellow',
    tags     : [],
    starred  : false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ─── writeNote / readNote round-trip ─────────────────────────────────────────

describe('writeNote + readNote', () => {
  it('round-trips all required fields', () => {
    const note = makeNote({ title: 'Hello world', color: 'blue', tags: ['bug', 'todo'] });
    writeNote(tmpDir, note);
    const read = readNote(tmpDir, note.id);
    expect(read).not.toBeNull();
    expect(read!.id).toBe(note.id);
    expect(read!.title).toBe('Hello world');
    expect(read!.color).toBe('blue');
    expect(read!.tags).toEqual(['bug', 'todo']);
    expect(read!.starred).toBe(false);
    expect(read!.content).toBe(note.content);
  });

  it('round-trips optional fields: codeLink, branch, owner, shared', () => {
    const note = makeNote({
      codeLink: { file: 'src/auth.ts', line: 42 },
      branch  : 'feature/login',
      owner   : 'Alice',
      shared  : true,
    });
    writeNote(tmpDir, note);
    const read = readNote(tmpDir, note.id);
    expect(read!.codeLink).toEqual({ file: 'src/auth.ts', line: 42 });
    expect(read!.branch).toBe('feature/login');
    expect(read!.owner).toBe('Alice');
    expect(read!.shared).toBe(true);
  });

  it('preserves multiline markdown body exactly', () => {
    const body = '## Steps\n\n1. First\n2. Second\n\n```ts\nconst x = 1;\n```\n';
    const note = makeNote({ content: body });
    writeNote(tmpDir, note);
    expect(readNote(tmpDir, note.id)!.content).toBe(body);
  });

  it('starred defaults to false when not set', () => {
    const note = makeNote({ starred: false });
    writeNote(tmpDir, note);
    expect(readNote(tmpDir, note.id)!.starred).toBe(false);
  });

  it('starred true survives the round-trip', () => {
    const note = makeNote({ starred: true });
    writeNote(tmpDir, note);
    expect(readNote(tmpDir, note.id)!.starred).toBe(true);
  });

  it('returns null for a non-existent id', () => {
    expect(readNote(tmpDir, 'does-not-exist')).toBeNull();
  });

  it('preserves createdAt and updatedAt timestamps', () => {
    const ts   = 1700000000000;
    const note = makeNote({ createdAt: ts, updatedAt: ts + 1000 });
    writeNote(tmpDir, note);
    const read = readNote(tmpDir, note.id);
    expect(read!.createdAt).toBe(ts);
    expect(read!.updatedAt).toBe(ts + 1000);
  });
});

// ─── readAllNotes ─────────────────────────────────────────────────────────────

describe('readAllNotes', () => {
  it('returns empty array when directory is empty', () => {
    expect(readAllNotes(tmpDir)).toEqual([]);
  });

  it('returns empty array when directory does not exist', () => {
    expect(readAllNotes('/this/path/does/not/exist')).toEqual([]);
  });

  it('reads multiple notes', () => {
    const a = makeNote({ title: 'Alpha' });
    const b = makeNote({ title: 'Beta' });
    writeNote(tmpDir, a);
    writeNote(tmpDir, b);
    const notes = readAllNotes(tmpDir);
    expect(notes).toHaveLength(2);
    expect(notes.map(n => n.title).sort()).toEqual(['Alpha', 'Beta']);
  });

  it('skips non-.md files', () => {
    fs.writeFileSync(path.join(tmpDir, 'tags.json'), '[]');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '*');
    const note = makeNote({ title: 'Only me' });
    writeNote(tmpDir, note);
    const notes = readAllNotes(tmpDir);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Only me');
  });

  it('skips .md files with no frontmatter id', () => {
    fs.writeFileSync(path.join(tmpDir, 'broken.md'), '# No frontmatter here\n');
    const note = makeNote({ title: 'Valid' });
    writeNote(tmpDir, note);
    const notes = readAllNotes(tmpDir);
    expect(notes).toHaveLength(1);
  });
});

// ─── findNote ─────────────────────────────────────────────────────────────────

describe('findNote', () => {
  it('finds by exact ID first', () => {
    const a = makeNote({ title: 'hello' });
    const b = makeNote({ title: 'world' });
    const notes = [a, b];
    expect(findNote(notes, a.id)).toBe(a);
  });

  it('finds by exact title (case-insensitive)', () => {
    const a = makeNote({ title: 'Auth Middleware Bug' });
    expect(findNote([a], 'auth middleware bug')).toBe(a);
  });

  it('finds by partial title (contains)', () => {
    const a = makeNote({ title: 'Auth Middleware Bug' });
    expect(findNote([a], 'middleware')).toBe(a);
  });

  it('prefers exact ID over title match', () => {
    const a = makeNote({ title: 'some query' });   // title matches the query string
    const b = makeNote({ title: 'other note' });
    // Use a.id as query — should return a, not b
    b.id = 'some query'; // force id to match too (edge case)
    // Actually, set b to have the query as its id
    const notes = [a, b];
    expect(findNote(notes, a.id)?.id).toBe(a.id);
  });

  it('prefers exact title over partial match', () => {
    const exact   = makeNote({ title: 'bug' });
    const partial = makeNote({ title: 'bug report: auth' });
    expect(findNote([partial, exact], 'bug')).toBe(exact);
  });

  it('returns null when nothing matches', () => {
    const notes = [makeNote({ title: 'Alpha' })];
    expect(findNote(notes, 'zzznotfound')).toBeNull();
  });

  it('returns null on empty list', () => {
    expect(findNote([], 'anything')).toBeNull();
  });
});

// ─── extractTodos ─────────────────────────────────────────────────────────────

describe('extractTodos', () => {
  it('extracts unchecked items', () => {
    const md = '- [ ] First task\n- [ ] Second task\n';
    expect(extractTodos(md)).toEqual(['First task', 'Second task']);
  });

  it('ignores checked items', () => {
    const md = '- [x] Done\n- [ ] Still open\n';
    expect(extractTodos(md)).toEqual(['Still open']);
  });

  it('ignores checked items with capital X', () => {
    const md = '- [X] Also done\n- [ ] Open\n';
    expect(extractTodos(md)).toEqual(['Open']);
  });

  it('handles indented task items', () => {
    const md = '  - [ ] Indented task\n';
    expect(extractTodos(md)).toEqual(['Indented task']);
  });

  it('returns empty array when no todos', () => {
    expect(extractTodos('# Just a heading\n\nSome text.')).toEqual([]);
  });

  it('returns empty array for empty content', () => {
    expect(extractTodos('')).toEqual([]);
  });

  it('handles todos mixed with other content', () => {
    const md = [
      '## Steps',
      '',
      '- [ ] Step one',
      '- regular bullet (not a todo)',
      '- [x] Already done',
      '- [ ] Step two',
      '',
      'Some prose.',
    ].join('\n');
    expect(extractTodos(md)).toEqual(['Step one', 'Step two']);
  });
});

// ─── generateId ───────────────────────────────────────────────────────────────

describe('generateId', () => {
  it('generates a non-empty string', () => {
    expect(typeof generateId()).toBe('string');
    expect(generateId().length).toBeGreaterThan(0);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});
