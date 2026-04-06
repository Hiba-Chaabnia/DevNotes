/**
 * Integration tests for the MCP server — tools, resources, and prompts.
 *
 * Spawns the compiled server as a real child process (using stdio transport),
 * communicates over JSON-RPC, and verifies responses. Each describe block
 * gets a fresh temp workspace so tests are fully isolated.
 */

import { ChildProcess, spawn } from 'child_process';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Note, writeNote, generateId } from '../src/notes.js';

// ─── Path to the compiled server ─────────────────────────────────────────────

const SERVER_PATH = path.join(__dirname, '../dist/index.js');

// ─── JSON-RPC test client ─────────────────────────────────────────────────────

class McpClient {
  private server: ChildProcess;
  private msgId  = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf     = '';

  constructor(workspace: string) {
    this.server = spawn('node', [SERVER_PATH], {
      env : { ...process.env, DEVNOTES_WORKSPACE: workspace },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Route each complete JSON line to its waiting promise
    this.server.stdout!.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString();
      const lines = this.buf.split('\n');
      this.buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
          if (msg.id !== undefined) {
            const handler = this.pending.get(msg.id);
            if (handler) {
              this.pending.delete(msg.id);
              if (msg.error) handler.reject(new Error(JSON.stringify(msg.error)));
              else           handler.resolve(msg.result);
            }
          }
        } catch { /* ignore malformed lines */ }
      }
    });

    this.server.stderr!.on('data', () => {}); // suppress startup log
  }

  /** Send any JSON-RPC request and wait for the response. */
  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.server.stdin!.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
      );
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout: no response to ${method} (id=${id})`));
        }
      }, 8000);
    });
  }

  /** Convenience: call a named tool. */
  async callTool(name: string, args: Record<string, unknown> = {}) {
    return this.request('tools/call', { name, arguments: args }) as Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>;
  }

  /** Convenience: read a resource. */
  async readResource(uri: string) {
    return this.request('resources/read', { uri }) as Promise<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>;
  }

  /** Convenience: get a prompt. */
  async getPrompt(name: string, args: Record<string, string> = {}) {
    return this.request('prompts/get', { name, arguments: args }) as Promise<{
      description?: string;
      messages: Array<{ role: string; content: { type: string; text: string } }>;
    }>;
  }

  /** Extract text from a tool response. */
  text(result: Awaited<ReturnType<typeof this.callTool>>) {
    return result.content.map(c => c.text).join('\n');
  }

  kill() { this.server.kill(); }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devnotes-mcp-test-'));
}

function seedNote(workspace: string, overrides: Partial<Note> = {}): Note {
  const devnotesDir = path.join(workspace, '.devnotes');
  const note: Note = {
    id       : generateId(),
    title    : 'Seed note',
    content  : 'Initial content.',
    color    : 'yellow',
    tags     : [],
    starred  : false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
  writeNote(devnotesDir, note);
  return note;
}

// ─── create_note ─────────────────────────────────────────────────────────────

describe('create_note', () => {
  let client: McpClient;
  let workspace: string;

  beforeAll(() => {
    workspace = makeTmpWorkspace();
    client    = new McpClient(workspace);
  });
  afterAll(() => {
    client.kill();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('creates a note file on disk', async () => {
    const res = await client.callTool('create_note', { title: 'My first note' });
    expect(res.isError).toBeFalsy();
    const text = client.text(res);
    expect(text).toContain('My first note');

    // Extract the ID from the response and verify the file exists
    const match = text.match(/ID: (\S+)/);
    expect(match).not.toBeNull();
    const id = match![1];
    expect(fs.existsSync(path.join(workspace, '.devnotes', `${id}.md`))).toBe(true);
  });

  it('applies tags and color', async () => {
    const res = await client.callTool('create_note', {
      title: 'Tagged note',
      tags : ['bug'],
      color: 'orange',
    });
    expect(client.text(res)).toContain('[bug]');
  });

  it('accepts optional content', async () => {
    const res = await client.callTool('create_note', {
      title  : 'With content',
      content: '## Steps\n\n1. Reproduce\n2. Fix',
    });
    expect(res.isError).toBeFalsy();
  });

  it('accepts a codeLink', async () => {
    const res = await client.callTool('create_note', {
      title         : 'Linked note',
      codeLink_file : 'src/auth.ts',
      codeLink_line : 42,
    });
    expect(res.isError).toBeFalsy();
  });
});

// ─── get_note ─────────────────────────────────────────────────────────────────

describe('get_note', () => {
  let client: McpClient;
  let workspace: string;
  let note: Note;

  beforeAll(() => {
    workspace = makeTmpWorkspace();
    note = seedNote(workspace, { title: 'Auth bug fix', tags: ['bug'], content: '## Description\n\nNull pointer at login.' });
    client = new McpClient(workspace);
  });
  afterAll(() => {
    client.kill();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('retrieves note by exact ID', async () => {
    const res = await client.callTool('get_note', { query: note.id });
    expect(res.isError).toBeFalsy();
    expect(client.text(res)).toContain('Auth bug fix');
  });

  it('retrieves note by exact title', async () => {
    const res = await client.callTool('get_note', { query: 'Auth bug fix' });
    expect(res.isError).toBeFalsy();
    expect(client.text(res)).toContain(note.id);
  });

  it('retrieves note by partial title', async () => {
    const res = await client.callTool('get_note', { query: 'auth bug' });
    expect(res.isError).toBeFalsy();
    expect(client.text(res)).toContain('Auth bug fix');
  });

  it('includes the note body in the output', async () => {
    const res = await client.callTool('get_note', { query: note.id });
    expect(client.text(res)).toContain('Null pointer at login.');
  });

  it('returns an error for an unknown query', async () => {
    const res = await client.callTool('get_note', { query: 'zzz-does-not-exist' });
    expect(res.isError).toBe(true);
  });
});

// ─── list_notes ───────────────────────────────────────────────────────────────

describe('list_notes', () => {
  let client: McpClient;
  let workspace: string;

  beforeAll(() => {
    workspace = makeTmpWorkspace();
    seedNote(workspace, { title: 'Bug one',     tags: ['bug'],     starred: true  });
    seedNote(workspace, { title: 'Todo item',   tags: ['todo'],    starred: false });
    seedNote(workspace, { title: 'Meeting notes', tags: ['meeting'], starred: false });
    client = new McpClient(workspace);
  });
  afterAll(() => {
    client.kill();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('lists all notes when no filter given', async () => {
    const res = await client.callTool('list_notes', {});
    const text = client.text(res);
    expect(text).toContain('Bug one');
    expect(text).toContain('Todo item');
    expect(text).toContain('Meeting notes');
  });

  it('filters by tag', async () => {
    const res  = await client.callTool('list_notes', { tag: 'bug' });
    const text = client.text(res);
    expect(text).toContain('Bug one');
    expect(text).not.toContain('Todo item');
    expect(text).not.toContain('Meeting notes');
  });

  it('filters by search term', async () => {
    const res  = await client.callTool('list_notes', { search: 'meeting' });
    const text = client.text(res);
    expect(text).toContain('Meeting notes');
    expect(text).not.toContain('Bug one');
  });

  it('filters by starred', async () => {
    const res  = await client.callTool('list_notes', { starred: true });
    const text = client.text(res);
    expect(text).toContain('Bug one');
    expect(text).not.toContain('Todo item');
  });

  it('returns a "not found" message when filters match nothing', async () => {
    const res = await client.callTool('list_notes', { tag: 'nonexistent-tag-xyz' });
    expect(client.text(res)).toContain('No notes found');
  });
});

// ─── append_to_note ───────────────────────────────────────────────────────────

describe('append_to_note', () => {
  let client: McpClient;
  let workspace: string;
  let note: Note;

  beforeAll(() => {
    workspace = makeTmpWorkspace();
    note = seedNote(workspace, { title: 'Debug session', content: 'Original content.' });
    client = new McpClient(workspace);
  });
  afterAll(() => {
    client.kill();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('appends content without replacing existing body', async () => {
    const res = await client.callTool('append_to_note', {
      query  : note.id,
      content: 'Appended line.',
    });
    expect(res.isError).toBeFalsy();

    // Read the file directly and verify both parts are present
    const raw = fs.readFileSync(path.join(workspace, '.devnotes', `${note.id}.md`), 'utf-8');
    expect(raw).toContain('Original content.');
    expect(raw).toContain('Appended line.');
  });

  it('inserts a heading when provided', async () => {
    const res = await client.callTool('append_to_note', {
      query  : note.id,
      content: 'The fix was X.',
      heading: 'Solution',
    });
    expect(res.isError).toBeFalsy();
    const raw = fs.readFileSync(path.join(workspace, '.devnotes', `${note.id}.md`), 'utf-8');
    expect(raw).toContain('## Solution');
    expect(raw).toContain('The fix was X.');
  });

  it('returns an error for an unknown note', async () => {
    const res = await client.callTool('append_to_note', {
      query  : 'no-such-note',
      content: 'Should fail.',
    });
    expect(res.isError).toBe(true);
  });
});

// ─── update_note ─────────────────────────────────────────────────────────────

describe('update_note', () => {
  let client: McpClient;
  let workspace: string;
  let note: Note;

  beforeAll(() => {
    workspace = makeTmpWorkspace();
    note = seedNote(workspace, { title: 'Old title', tags: ['todo'], color: 'yellow', starred: false });
    client = new McpClient(workspace);
  });
  afterAll(() => {
    client.kill();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('updates the title', async () => {
    const res = await client.callTool('update_note', { query: note.id, title: 'New title' });
    expect(res.isError).toBeFalsy();
    const raw = fs.readFileSync(path.join(workspace, '.devnotes', `${note.id}.md`), 'utf-8');
    expect(raw).toContain('title: New title');
  });

  it('updates tags', async () => {
    const res = await client.callTool('update_note', { query: note.id, tags: ['bug', 'important'] });
    expect(res.isError).toBeFalsy();
    const raw = fs.readFileSync(path.join(workspace, '.devnotes', `${note.id}.md`), 'utf-8');
    expect(raw).toContain('tags: bug,important');
  });

  it('updates starred status', async () => {
    const res = await client.callTool('update_note', { query: note.id, starred: true });
    expect(res.isError).toBeFalsy();
    const raw = fs.readFileSync(path.join(workspace, '.devnotes', `${note.id}.md`), 'utf-8');
    expect(raw).toContain('starred: true');
  });

  it('does not change the body when updating metadata', async () => {
    const before = fs.readFileSync(path.join(workspace, '.devnotes', `${note.id}.md`), 'utf-8');
    const body   = before.split('---\n').slice(2).join('---\n');
    await client.callTool('update_note', { query: note.id, color: 'pink' });
    const after  = fs.readFileSync(path.join(workspace, '.devnotes', `${note.id}.md`), 'utf-8');
    expect(after.split('---\n').slice(2).join('---\n')).toBe(body);
  });
});

// ─── get_todos ────────────────────────────────────────────────────────────────

describe('get_todos', () => {
  let client: McpClient;
  let workspace: string;

  beforeAll(() => {
    workspace = makeTmpWorkspace();
    seedNote(workspace, {
      title  : 'Sprint tasks',
      tags   : ['todo'],
      content: '- [ ] Write tests\n- [x] Setup repo\n- [ ] Deploy to staging\n',
    });
    seedNote(workspace, {
      title  : 'Bug report',
      tags   : ['bug'],
      content: '## Steps\n\n- [ ] Reproduce on Firefox\n',
    });
    seedNote(workspace, {
      title  : 'Meeting notes',
      tags   : ['meeting'],
      content: 'We discussed the roadmap.',
    });
    client = new McpClient(workspace);
  });
  afterAll(() => {
    client.kill();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('aggregates open todos across all notes', async () => {
    const res  = await client.callTool('get_todos', {});
    const text = client.text(res);
    expect(text).toContain('Write tests');
    expect(text).toContain('Deploy to staging');
    expect(text).toContain('Reproduce on Firefox');
  });

  it('does not include checked items', async () => {
    const res  = await client.callTool('get_todos', {});
    expect(client.text(res)).not.toContain('Setup repo');
  });

  it('reports how many open todos were found', async () => {
    const res  = await client.callTool('get_todos', {});
    expect(client.text(res)).toContain('3 open todo');
  });

  it('returns a "no todos" message when all are done', async () => {
    const ws2  = makeTmpWorkspace();
    seedNote(ws2, { title: 'Done', content: '- [x] All done\n' });
    const c2   = new McpClient(ws2);
    const res  = await c2.callTool('get_todos', {});
    expect(c2.text(res)).toContain('No open todos');
    c2.kill();
    fs.rmSync(ws2, { recursive: true, force: true });
  });

  it('filters todos by tag', async () => {
    const res  = await client.callTool('get_todos', { tag: 'bug' });
    const text = client.text(res);
    expect(text).toContain('Reproduce on Firefox');
    expect(text).not.toContain('Write tests');
  });
});

// ─── get_stale_notes ──────────────────────────────────────────────────────────

describe('get_stale_notes', () => {
  let client: McpClient;
  let workspace: string;
  const OLD = Date.now() - 20 * 24 * 60 * 60 * 1000; // 20 days ago

  beforeAll(() => {
    workspace = makeTmpWorkspace();
    // Old bug note — should appear
    seedNote(workspace, {
      title    : 'Stale bug',
      tags     : ['bug'],
      content  : 'Some description.',
      updatedAt: OLD,
    });
    // Old note with open todos — should appear
    seedNote(workspace, {
      title    : 'Stale todos',
      tags     : [],
      content  : '- [ ] Still open\n',
      updatedAt: OLD,
    });
    // Recent note — should NOT appear
    seedNote(workspace, {
      title    : 'Fresh note',
      tags     : ['bug'],
      content  : '- [ ] Also open\n',
      updatedAt: Date.now(),
    });
    // Old note with no todos and no bug tag — should NOT appear
    seedNote(workspace, {
      title    : 'Clean old note',
      tags     : ['meeting'],
      content  : 'No action items here.',
      updatedAt: OLD,
    });
    client = new McpClient(workspace);
  });
  afterAll(() => {
    client.kill();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('returns old notes that have a bug tag or open todos', async () => {
    const res  = await client.callTool('get_stale_notes', { days: 14 });
    const text = client.text(res);
    expect(text).toContain('Stale bug');
    expect(text).toContain('Stale todos');
  });

  it('does not return recently-updated notes', async () => {
    const res  = await client.callTool('get_stale_notes', { days: 14 });
    expect(client.text(res)).not.toContain('Fresh note');
  });

  it('does not return old notes without issues', async () => {
    const res  = await client.callTool('get_stale_notes', { days: 14 });
    expect(client.text(res)).not.toContain('Clean old note');
  });

  it('returns a "no stale notes" message when nothing qualifies', async () => {
    const res = await client.callTool('get_stale_notes', { days: 21 }); // 21-day threshold — test notes are 20 days old
    expect(client.text(res)).toContain('No stale notes');
  });
});

// ─── log_session ──────────────────────────────────────────────────────────────

describe('log_session', () => {
  let client: McpClient;
  let workspace: string;

  beforeAll(() => {
    workspace = makeTmpWorkspace();
    client    = new McpClient(workspace);
  });
  afterAll(() => {
    client.kill();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('creates the session-log note on first call', async () => {
    const res = await client.callTool('log_session', { done: 'Set up the project' });
    expect(res.isError).toBeFalsy();
    expect(fs.existsSync(path.join(workspace, '.devnotes', 'session-log.md'))).toBe(true);
  });

  it('includes the "done" content in the log', async () => {
    await client.callTool('log_session', { done: 'Finished auth module' });
    const raw = fs.readFileSync(path.join(workspace, '.devnotes', 'session-log.md'), 'utf-8');
    expect(raw).toContain('Finished auth module');
  });

  it('appends on subsequent calls without overwriting previous entries', async () => {
    await client.callTool('log_session', { done: 'Entry A' });
    await client.callTool('log_session', { done: 'Entry B' });
    const raw = fs.readFileSync(path.join(workspace, '.devnotes', 'session-log.md'), 'utf-8');
    expect(raw).toContain('Entry A');
    expect(raw).toContain('Entry B');
  });

  it('includes optional in_progress and blocked fields', async () => {
    await client.callTool('log_session', {
      done       : 'Wrote unit tests',
      in_progress: 'Integration tests',
      blocked    : 'Need DB credentials',
    });
    const raw = fs.readFileSync(path.join(workspace, '.devnotes', 'session-log.md'), 'utf-8');
    expect(raw).toContain('Integration tests');
    expect(raw).toContain('Need DB credentials');
  });
});

// ─── resources ───────────────────────────────────────────────────────────────

describe('resources', () => {
  let client: McpClient;
  let workspace: string;

  beforeAll(() => {
    workspace = makeTmpWorkspace();
    seedNote(workspace, {
      title    : 'Recent note',
      content  : '- [ ] Open todo',
      updatedAt: Date.now(),
    });
    seedNote(workspace, {
      title    : 'Old note',
      content  : 'No todos.',
      updatedAt: Date.now() - 5 * 24 * 60 * 60 * 1000, // 5 days ago
    });
    client = new McpClient(workspace);
  });
  afterAll(() => {
    client.kill();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('devnotes://todos returns open todos', async () => {
    const res  = await client.readResource('devnotes://todos');
    const text = res.contents[0].text;
    expect(text).toContain('Open todo');
  });

  it('devnotes://recent returns only notes from the last 48h', async () => {
    const res  = await client.readResource('devnotes://recent');
    const text = res.contents[0].text;
    expect(text).toContain('Recent note');
    expect(text).not.toContain('Old note');
  });

  it('devnotes://session-log returns a no-entries message before any sessions', async () => {
    const res  = await client.readResource('devnotes://session-log');
    expect(res.contents[0].text).toContain('No session log');
  });
});

// ─── prompts ──────────────────────────────────────────────────────────────────

describe('prompts', () => {
  let client: McpClient;
  let workspace: string;
  let note: Note;

  beforeAll(() => {
    workspace = makeTmpWorkspace();
    note = seedNote(workspace, {
      title  : 'Null pointer in parseConfig',
      tags   : ['bug'],
      content: '## Repro\n\nCalling `parseConfig(null)` throws NPE.',
    });
    seedNote(workspace, {
      title    : 'Yesterday work',
      content  : '- [ ] Fix null pointer\n',
      updatedAt: Date.now() - 12 * 60 * 60 * 1000, // 12h ago
    });
    client = new McpClient(workspace);
  });
  afterAll(() => {
    client.kill();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('solve prompt loads the note content', async () => {
    const res  = await client.getPrompt('solve', { note: note.id });
    const text = res.messages[0].content.text;
    expect(text).toContain('Null pointer in parseConfig');
    expect(text).toContain('parseConfig(null)');
  });

  it('solve prompt asks Claude to provide a solution', async () => {
    const res  = await client.getPrompt('solve', { note: note.id });
    const text = res.messages[0].content.text;
    expect(text).toContain('root cause');
    expect(text).toContain('append_to_note');
  });

  it('standup prompt uses recent notes', async () => {
    const res  = await client.getPrompt('standup', {});
    const text = res.messages[0].content.text;
    expect(text).toContain('standup');
    expect(text).toContain('Done');
    expect(text).toContain('Blocked');
  });

  it('solve prompt returns a message for unknown notes', async () => {
    const res  = await client.getPrompt('solve', { note: 'nonexistent-xyz' });
    expect(res.messages[0].content.text).toContain('No note found');
  });
});
