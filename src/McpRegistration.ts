import { execSync } from 'child_process';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface McpRegistrationResult {
  success          : boolean;
  message          : string;
  alreadyRegistered: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns true when the `claude` CLI is available in PATH. */
export function isClaudeCodeInstalled(): boolean {
  try {
    execSync('claude --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Returns true when the devnotes MCP server is registered in Claude Code. */
export function isMcpRegistered(): boolean {
  try {
    const output = execSync('claude mcp list', { stdio: 'pipe' }).toString();
    return output.toLowerCase().includes('devnotes');
  } catch {
    return false;
  }
}

/**
 * Register (or update) the DevNotes MCP server using the Claude Code CLI.
 *
 * Runs: claude mcp add --scope user devnotes node "<serverDistPath>"
 * If a previous entry exists it is removed first so the path is always current.
 *
 * Pure function — only depends on child_process. Safe to import in tests.
 */
export function registerDevNotesMcp(serverDistPath: string): McpRegistrationResult {
  const normalizedPath = serverDistPath.replace(/\\/g, '/');
  let alreadyRegistered = false;

  // Remove any existing entry so re-registration always uses the latest path
  try {
    execSync('claude mcp remove devnotes', { stdio: 'pipe' });
    alreadyRegistered = true;
  } catch { /* not registered yet — fine */ }

  try {
    execSync(
      `claude mcp add --scope user devnotes node "${normalizedPath}"`,
      { stdio: 'pipe' },
    );
    return { success: true, message: '', alreadyRegistered };
  } catch (err) {
    return {
      success          : false,
      message          : `claude mcp add failed: ${err instanceof Error ? err.message : String(err)}`,
      alreadyRegistered: false,
    };
  }
}
