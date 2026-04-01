import * as vscode from 'vscode';
import * as fs from 'fs';
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
 * Reads the first workspace folder's `.git/config` to find the `origin` remote.
 * Falls back to the workspace folder name when no Git remote is found.
 * Returns `undefined` when no workspace is open.
 */
export function detectProjectIdentity(): ProjectIdentity | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;

  const rootPath = folders[0].uri.fsPath;

  // Try .git/config first
  const gitConfigPath = path.join(rootPath, '.git', 'config');
  if (fs.existsSync(gitConfigPath)) {
    try {
      const content = fs.readFileSync(gitConfigPath, 'utf8');
      const remoteUrl = parseOriginUrl(content);
      if (remoteUrl) {
        const slug = slugFromRemoteUrl(remoteUrl);
        return { id: slug, displayName: slug, remoteUrl };
      }
    } catch {
      // fall through
    }
  }

  // Fallback: workspace folder name
  const folderName = path.basename(rootPath);
  const id = slugify(folderName);
  return { id, displayName: id };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

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
