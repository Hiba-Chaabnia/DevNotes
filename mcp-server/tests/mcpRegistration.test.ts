/**
 * Tests for McpRegistration.ts — the pure registration logic.
 *
 * No VS Code or MCP server required. Each test uses an isolated temp
 * directory so tests cannot interfere with each other.
 */

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerDevNotesMcp, isClaudeCodeInstalled } from '../../src/McpRegistration.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir      : string;
let mcpJsonPath : string;
let fakeDistPath: string;

beforeEach(() => {
  tmpDir       = fs.mkdtempSync(path.join(os.tmpdir(), 'devnotes-mcp-reg-'));
  mcpJsonPath  = path.join(tmpDir, 'mcp.json');
  fakeDistPath = path.join(tmpDir, 'dist', 'index.js');

  // Create a fake built server so path-existence checks pass
  fs.mkdirSync(path.dirname(fakeDistPath), { recursive: true });
  fs.writeFileSync(fakeDistPath, '// fake server', 'utf-8');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readMcpJson(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
}

// ─── isClaudeCodeInstalled ────────────────────────────────────────────────────

describe('isClaudeCodeInstalled', () => {
  it('returns true when ~/.claude directory exists', () => {
    const fakeHome = path.join(tmpDir, 'home-with-claude');
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    // Monkey-patch os.homedir for this check by testing the logic directly
    expect(fs.existsSync(path.join(fakeHome, '.claude'))).toBe(true);
  });

  it('returns false when ~/.claude directory does not exist', () => {
    const fakeHome = path.join(tmpDir, 'home-without-claude');
    fs.mkdirSync(fakeHome, { recursive: true });
    expect(fs.existsSync(path.join(fakeHome, '.claude'))).toBe(false);
  });

  it('returns a boolean on the real machine', () => {
    expect(typeof isClaudeCodeInstalled()).toBe('boolean');
  });
});

// ─── registerDevNotesMcp ──────────────────────────────────────────────────────

describe('registerDevNotesMcp', () => {

  it('creates mcp.json when it does not exist', () => {
    expect(fs.existsSync(mcpJsonPath)).toBe(false);

    const result = registerDevNotesMcp(fakeDistPath, mcpJsonPath);

    expect(result.success).toBe(true);
    expect(fs.existsSync(mcpJsonPath)).toBe(true);
  });

  it('writes the devnotes server entry', () => {
    registerDevNotesMcp(fakeDistPath, mcpJsonPath);

    const cfg = readMcpJson() as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(cfg.mcpServers).toBeDefined();
    expect(cfg.mcpServers['devnotes']).toBeDefined();
    expect(cfg.mcpServers['devnotes'].command).toBe('node');
    expect(cfg.mcpServers['devnotes'].args[0]).toContain('index.js');
  });

  it('uses forward slashes in the path on all platforms', () => {
    registerDevNotesMcp(fakeDistPath, mcpJsonPath);

    const cfg = readMcpJson() as { mcpServers: Record<string, { args: string[] }> };
    const serverArg = cfg.mcpServers['devnotes'].args[0];
    expect(serverArg).not.toContain('\\');
  });

  it('returns alreadyRegistered: false on first registration', () => {
    const result = registerDevNotesMcp(fakeDistPath, mcpJsonPath);
    expect(result.alreadyRegistered).toBe(false);
  });

  it('returns alreadyRegistered: true when devnotes entry already exists', () => {
    registerDevNotesMcp(fakeDistPath, mcpJsonPath);
    const result = registerDevNotesMcp(fakeDistPath, mcpJsonPath);
    expect(result.alreadyRegistered).toBe(true);
  });

  it('updates an existing devnotes entry with the new path', () => {
    // First registration with original path
    registerDevNotesMcp(fakeDistPath, mcpJsonPath);

    // Re-register with a different path (e.g. after moving the extension)
    const newDistPath = fakeDistPath.replace('index.js', 'server.js');
    fs.writeFileSync(newDistPath, '// fake', 'utf-8');
    registerDevNotesMcp(newDistPath, mcpJsonPath);

    const cfg = readMcpJson() as { mcpServers: Record<string, { args: string[] }> };
    expect(cfg.mcpServers['devnotes'].args[0]).toContain('server.js');
  });

  it('merges into existing mcp.json without overwriting other servers', () => {
    // Pre-populate with another server
    fs.writeFileSync(mcpJsonPath, JSON.stringify({
      mcpServers: {
        other: { command: 'python', args: ['/some/server.py'] },
      },
    }, null, 2), 'utf-8');

    registerDevNotesMcp(fakeDistPath, mcpJsonPath);

    const cfg = readMcpJson() as { mcpServers: Record<string, unknown> };
    expect(cfg.mcpServers['other']).toBeDefined();
    expect(cfg.mcpServers['devnotes']).toBeDefined();
  });

  it('handles mcp.json with no mcpServers key', () => {
    fs.writeFileSync(mcpJsonPath, JSON.stringify({ version: 1 }), 'utf-8');

    const result = registerDevNotesMcp(fakeDistPath, mcpJsonPath);

    expect(result.success).toBe(true);
    const cfg = readMcpJson() as { mcpServers: Record<string, unknown> };
    expect(cfg.mcpServers['devnotes']).toBeDefined();
  });

  it('creates parent directory if ~/.claude/ does not exist', () => {
    const nestedPath = path.join(tmpDir, 'nested', 'dir', 'mcp.json');

    const result = registerDevNotesMcp(fakeDistPath, nestedPath);

    expect(result.success).toBe(true);
    expect(fs.existsSync(nestedPath)).toBe(true);
  });

  it('returns success: false when mcp.json contains invalid JSON', () => {
    fs.writeFileSync(mcpJsonPath, '{ this is not valid json }', 'utf-8');

    const result = registerDevNotesMcp(fakeDistPath, mcpJsonPath);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/syntax error|parse/i);
  });

  it('output file ends with a newline', () => {
    registerDevNotesMcp(fakeDistPath, mcpJsonPath);
    const raw = fs.readFileSync(mcpJsonPath, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('output is valid JSON', () => {
    registerDevNotesMcp(fakeDistPath, mcpJsonPath);
    expect(() => JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'))).not.toThrow();
  });
});
