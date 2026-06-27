import { execSync, exec } from 'child_process';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface McpRegistrationResult {
  success          : boolean;
  message          : string;
  alreadyRegistered: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function execAsync(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** Returns true when the `claude` CLI is available in PATH. */
export function isClaudeCodeInstalled(): Promise<boolean> {
  return new Promise(resolve => {
    exec('claude --version', err => resolve(!err));
  });
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

/** Non-blocking version of isMcpRegistered — resolves on the next event loop tick. */
export function isMcpRegisteredAsync(): Promise<boolean> {
  return new Promise(resolve => {
    exec('claude mcp list', (err, stdout) => {
      if (err) { resolve(false); return; }
      resolve(stdout.toLowerCase().includes('devnotes'));
    });
  });
}

/**
 * Register (or update) the DevNotes MCP server using the Claude Code CLI.
 *
 * Runs: claude mcp add --scope user devnotes node "<serverDistPath>"
 * If a previous entry exists it is removed first so the path is always current.
 *
 * Pure function — only depends on child_process. Safe to import in tests.
 */
export async function registerDevNotesMcp(serverDistPath: string): Promise<McpRegistrationResult> {
  const normalizedPath = serverDistPath.replace(/\\/g, '/');
  let alreadyRegistered = false;

  // Remove any existing entry so re-registration always uses the latest path
  try {
    await execAsync('claude mcp remove devnotes');
    alreadyRegistered = true;
  } catch { /* not registered yet — fine */ }

  try {
    await execAsync(`claude mcp add --scope user devnotes node "${normalizedPath}"`);
    return { success: true, message: '', alreadyRegistered };
  } catch (err) {
    return {
      success          : false,
      message          : `claude mcp add failed: ${err instanceof Error ? err.message : String(err)}`,
      alreadyRegistered: false,
    };
  }
}
