import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface McpRegistrationResult {
  success          : boolean;
  message          : string;
  alreadyRegistered: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Default path to Claude Code's MCP configuration file. */
export function getMcpJsonPath(): string {
  return path.join(os.homedir(), '.claude', 'mcp.json');
}

/**
 * Register (or update) the DevNotes MCP server entry in ~/.claude/mcp.json.
 *
 * Pure function — no VS Code dependencies. Safe to import in tests.
 *
 * @param serverDistPath  Absolute path to mcp-server/dist/index.js
 * @param mcpJsonPath     Target config file — defaults to ~/.claude/mcp.json
 */
export function isClaudeCodeInstalled(): boolean {
  return fs.existsSync(path.join(os.homedir(), '.claude'));
}

export function registerDevNotesMcp(
  serverDistPath: string,
  mcpJsonPath   : string = getMcpJsonPath(),
): McpRegistrationResult {
  // Read existing config or start with an empty object
  let config: { mcpServers?: Record<string, unknown> } = {};

  if (fs.existsSync(mcpJsonPath)) {
    try {
      config = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    } catch {
      return {
        success          : false,
        message          : `Could not parse ${path.basename(mcpJsonPath)} — check it for JSON syntax errors.`,
        alreadyRegistered: false,
      };
    }
  }

  config.mcpServers = config.mcpServers ?? {};
  const alreadyRegistered = 'devnotes' in config.mcpServers;

  // Write / overwrite the devnotes entry (forward slashes for cross-platform compat)
  config.mcpServers['devnotes'] = {
    command: 'node',
    args   : [serverDistPath.replace(/\\/g, '/')],
  };

  // Ensure ~/.claude/ exists before writing
  fs.mkdirSync(path.dirname(mcpJsonPath), { recursive: true });
  fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  return { success: true, message: '', alreadyRegistered };
}
