/**
 * Tests for McpRegistration.ts — the Claude Code CLI registration logic.
 *
 * child_process.execSync is mocked so no real CLI calls are made.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';
import { isClaudeCodeInstalled, registerDevNotesMcp } from '../../src/McpRegistration.js';

const mockExec = vi.mocked(execSync);

beforeEach(() => {
  mockExec.mockReset();
});

// ─── isClaudeCodeInstalled ────────────────────────────────────────────────────

describe('isClaudeCodeInstalled', () => {
  it('returns true when claude CLI is available', () => {
    mockExec.mockReturnValue(Buffer.from('claude/2.1.0'));
    expect(isClaudeCodeInstalled()).toBe(true);
    expect(mockExec).toHaveBeenCalledWith('claude --version', expect.anything());
  });

  it('returns false when claude CLI is not found', () => {
    mockExec.mockImplementation(() => { throw new Error('command not found'); });
    expect(isClaudeCodeInstalled()).toBe(false);
  });
});

// ─── registerDevNotesMcp ──────────────────────────────────────────────────────

describe('registerDevNotesMcp', () => {

  it('calls claude mcp add --scope user with the server path', () => {
    mockExec
      .mockImplementationOnce(() => { throw new Error('not found'); }) // remove fails = not registered
      .mockReturnValueOnce(Buffer.from(''));                            // add succeeds

    registerDevNotesMcp('/path/to/dist/index.js');

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('claude mcp add --scope user devnotes node'),
      expect.anything(),
    );
  });

  it('uses forward slashes in the path on all platforms', () => {
    mockExec
      .mockImplementationOnce(() => { throw new Error(); })
      .mockReturnValueOnce(Buffer.from(''));

    registerDevNotesMcp('C:\\Users\\hibac\\dist\\index.js');

    const addCall = mockExec.mock.calls.find(c => String(c[0]).includes('mcp add'));
    expect(String(addCall?.[0])).not.toContain('\\');
  });

  it('returns success: true on first registration', () => {
    mockExec
      .mockImplementationOnce(() => { throw new Error(); })
      .mockReturnValueOnce(Buffer.from(''));

    const result = registerDevNotesMcp('/path/index.js');
    expect(result.success).toBe(true);
    expect(result.alreadyRegistered).toBe(false);
  });

  it('removes existing entry before re-adding and sets alreadyRegistered: true', () => {
    mockExec
      .mockReturnValueOnce(Buffer.from(''))  // remove succeeds = was registered
      .mockReturnValueOnce(Buffer.from(''));  // add succeeds

    const result = registerDevNotesMcp('/path/index.js');

    expect(mockExec).toHaveBeenCalledWith('claude mcp remove devnotes', expect.anything());
    expect(result.success).toBe(true);
    expect(result.alreadyRegistered).toBe(true);
  });

  it('returns success: false when claude mcp add fails', () => {
    mockExec
      .mockImplementationOnce(() => { throw new Error(); })           // remove fails
      .mockImplementationOnce(() => { throw new Error('add failed'); }); // add fails

    const result = registerDevNotesMcp('/path/index.js');

    expect(result.success).toBe(false);
    expect(result.message).toContain('claude mcp add failed');
  });

  it('includes the error message in the failure result', () => {
    mockExec
      .mockImplementationOnce(() => { throw new Error(); })
      .mockImplementationOnce(() => { throw new Error('permission denied'); });

    const result = registerDevNotesMcp('/path/index.js');
    expect(result.message).toContain('permission denied');
  });

  it('still attempts add even when remove throws', () => {
    mockExec
      .mockImplementationOnce(() => { throw new Error('nothing to remove'); })
      .mockReturnValueOnce(Buffer.from(''));

    const result = registerDevNotesMcp('/path/index.js');

    expect(result.success).toBe(true);
    expect(mockExec).toHaveBeenCalledTimes(2);
  });
});
