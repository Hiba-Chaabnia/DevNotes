/**
 * github.ts — minimal GitHub REST API client for DevNotes.
 *
 * Uses a Personal Access Token stored in the DEVNOTES_GITHUB_TOKEN
 * environment variable. Classic PATs need the `repo` scope (or `public_repo`
 * for public repos only). Fine-grained PATs need "Issues: read" permission.
 *
 * No external dependencies — uses Node's built-in fetch (Node 18+).
 */

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  html_url: string;
  labels: { name: string }[];
  assignees: { login: string }[];
  pull_request?: { merged_at: string | null };
  created_at: string;
  updated_at: string;
  user: { login: string };
}

export interface GitHubComment {
  user: { login: string };
  body: string;
  created_at: string;
}

function getToken(): string | null {
  return process.env.DEVNOTES_GITHUB_TOKEN ?? null;
}

function headers(): Record<string, string> {
  const token = getToken();
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function ghFetch<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, { headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

/** Parse a GitHub issue or PR URL into { repo, number, type }. */
export function parseGitHubUrl(url: string): { repo: string; number: number; type: 'issue' | 'pr' } | null {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)/);
  if (!m) return null;
  return {
    repo  : m[1],
    number: parseInt(m[3], 10),
    type  : m[2] === 'pull' ? 'pr' : 'issue',
  };
}

/** Fetch metadata for a single issue or PR. */
export async function fetchIssue(repo: string, number: number): Promise<GitHubIssue> {
  return ghFetch<GitHubIssue>(`/repos/${repo}/issues/${number}`);
}

/** Fetch comments for a single issue or PR (up to 20 most recent). */
export async function fetchComments(repo: string, number: number): Promise<GitHubComment[]> {
  return ghFetch<GitHubComment[]>(`/repos/${repo}/issues/${number}/comments?per_page=20`);
}

/** Derive open/closed/merged status from a raw GitHub issue object. */
export function deriveStatus(issue: GitHubIssue): 'open' | 'closed' | 'merged' {
  if (issue.pull_request) {
    if (issue.pull_request.merged_at) return 'merged';
    return issue.state === 'open' ? 'open' : 'closed';
  }
  return issue.state === 'open' ? 'open' : 'closed';
}
