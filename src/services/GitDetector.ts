import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ProjectIdentity {
  /** Stable storage key derived from the repo slug or folder name. */
  id: string;
  /** Human-readable label shown in the sidebar (same as id initially). */
  displayName: string;
  /** The raw remote URL, if one was found. */
  remoteUrl?: string;
}

/**
 * Resolves the current git user's display name.
 * Checks the local `.git/config` first, then falls back to `~/.gitconfig`.
 * Returns the `name` field if present, otherwise `email`, otherwise undefined.
 */
export async function getGitUser(workspaceRootPath: string): Promise<string | undefined> {
  const candidates = [
    path.join(workspaceRootPath, '.git', 'config'),
    path.join(os.homedir(), '.gitconfig'),
  ];
  const INVALID = new Set(['', 'undefined', 'null', 'unknown']);

  for (const configPath of candidates) {
    try {
      const content     = await fs.promises.readFile(configPath, 'utf8');
      const userSection = content.match(/\[user\]([^\[]*)/)?.[1] ?? '';
      const name        = userSection.match(/name\s*=\s*(.+)/)?.[1]?.trim() ?? '';
      if (name && !INVALID.has(name))  return name;
      const email = userSection.match(/email\s*=\s*(.+)/)?.[1]?.trim() ?? '';
      if (email && !INVALID.has(email)) return email;
    } catch { /* file missing or unreadable — try next */ }
  }
  return undefined;
}

/**
 * Reads the current branch from `.git/HEAD`.
 * Returns `undefined` when not on a named branch (detached HEAD) or no git repo.
 */
export async function getCurrentBranch(workspaceRootPath: string): Promise<string | undefined> {
  const headPath = path.join(workspaceRootPath, '.git', 'HEAD');
  try {
    const content = (await fs.promises.readFile(headPath, 'utf8')).trim();
    if (content.startsWith('ref: refs/heads/')) {
      return content.slice('ref: refs/heads/'.length);
    }
    return undefined; // detached HEAD
  } catch {
    return undefined;
  }
}

/**
 * Reads the first workspace folder's `.git/config` to find the `origin` remote.
 * Falls back to the workspace folder name when no Git remote is found.
 * Returns `undefined` when no workspace is open.
 */
export async function detectProjectIdentity(): Promise<ProjectIdentity | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;

  const rootPath = folders[0].uri.fsPath;

  // Try .git/config first
  const gitConfigPath = path.join(rootPath, '.git', 'config');
  try {
    const content  = await fs.promises.readFile(gitConfigPath, 'utf8');
    const remoteUrl = parseOriginUrl(content);
    if (remoteUrl) {
      const slug = slugFromRemoteUrl(remoteUrl);
      return { id: slug, displayName: slug, remoteUrl };
    }
  } catch {
    // fall through
  }

  // Fallback: workspace folder name
  const folderName = path.basename(rootPath);
  const id = slugify(folderName);
  return { id, displayName: id };
}

/**
 * Lists all local branch names by reading `.git/refs/heads/` (unpacked refs)
 * and `.git/packed-refs` (packed refs). Returns a sorted, deduplicated array.
 * Returns an empty array when the directory is not a git repository.
 */
export async function getLocalBranches(workspaceRootPath: string): Promise<string[]> {
  const branches = new Set<string>();

  // Unpacked refs
  const headsDir = path.join(workspaceRootPath, '.git', 'refs', 'heads');
  try { await collectBranchRefs(headsDir, '', branches); } catch { /* not a git repo */ }

  // Packed refs
  const packedRefs = path.join(workspaceRootPath, '.git', 'packed-refs');
  try {
    const content = await fs.promises.readFile(packedRefs, 'utf8');
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || line.startsWith('^')) continue;
      const m = line.match(/^\S+ refs\/heads\/(.+)$/);
      if (m) branches.add(m[1].trim());
    }
  } catch { /* no packed-refs */ }

  return [...branches].sort();
}

async function collectBranchRefs(dir: string, prefix: string, out: Set<string>): Promise<void> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await collectBranchRefs(path.join(dir, entry.name), `${prefix}${entry.name}/`, out);
    } else {
      out.add(prefix + entry.name);
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parses the `[remote "origin"]` block in a `.git/config` file and returns
 * the `url` value, or `undefined` if not found.
 */
function parseOriginUrl(gitConfig: string): string | undefined {
  // Locate the [remote "origin"] section, then grab the next `url = …` line
  // before the next `[` section header.
  const sectionMatch = gitConfig.match(
    /\[remote\s+"origin"\][^\[]*?url\s*=\s*([^\r\n]+)/
  );
  return sectionMatch ? sectionMatch[1].trim() : undefined;
}

/**
 * Derives a stable slug from a Git remote URL.
 *
 * SSH  : `git@github.com:owner/repo.git`  → `owner/repo`
 * HTTPS: `https://github.com/owner/repo`  → `owner/repo`
 */
function slugFromRemoteUrl(url: string): string {
  // Strip trailing .git
  const cleaned = url.replace(/\.git$/, '');

  // SSH: git@host:path
  const sshMatch = cleaned.match(/^[^@]+@[^:]+:(.+)$/);
  if (sshMatch) return slugify(sshMatch[1]);

  // HTTPS / git://: take the last two path segments (owner/repo)
  const urlParts = cleaned.split('/').filter(Boolean);
  if (urlParts.length >= 2) {
    return slugify(urlParts.slice(-2).join('/'));
  }

  return slugify(cleaned);
}

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9/_-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}
