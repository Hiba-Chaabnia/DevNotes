import * as vscode from 'vscode';
import { NoteStorage, Note } from './NoteStorage';
import { ACTIVITY_PALETTE, UI_COLORS } from './colors';

// ─── Entry model ─────────────────────────────────────────────────────────────

const CLAUDE_OWNER = 'Claude Code';

interface ActivityEntry {
  noteId   : string;
  title    : string;
  owner    : string | null;
  isYou    : boolean;     // true when owner matches the detected git user
  isClaude : boolean;     // true when note was created/modified by the MCP server
  action   : 'created' | 'updated';
  timestamp: number;      // updatedAt Unix ms
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class ActivityFeedView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private currentUser: string | undefined;

  constructor(
    private readonly context    : vscode.ExtensionContext,
    private readonly storage    : NoteStorage,
    private readonly onOpenNote : (noteId: string) => void,
  ) {}

  setCurrentUser(user: string | undefined): void {
    this.currentUser = user;
    this.push();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildHtml();
    webviewView.webview.onDidReceiveMessage((msg: { type: string; noteId?: string }) => {
      if (msg.type === 'ready')    this.push();
      if (msg.type === 'refresh')  this.push();
      if (msg.type === 'openNote' && msg.noteId) this.onOpenNote(msg.noteId);
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.push();
    });
  }

  push(): void {
    if (!this.view?.visible) return;
    const entries = this.generateEntries();
    this.view.webview.postMessage({ type: 'init', entries, currentUser: this.currentUser ?? null });
  }

  // ── Entry generation ──────────────────────────────────────────────────────

  private generateEntries(): ActivityEntry[] {
    const notes = this.storage.getNotes();

    // Collect shared notes and Claude-authored notes, deduplicated by ID
    const seen = new Set<string>();
    const toEntry = (n: Note): ActivityEntry => ({
      noteId   : n.id,
      title    : n.title,
      owner    : n.owner ?? null,
      isYou    : !!n.owner && n.owner === this.currentUser,
      isClaude : n.owner === CLAUDE_OWNER,
      action   : (n.updatedAt - n.createdAt) < 10_000 ? 'created' : 'updated',
      timestamp: n.updatedAt,
    });

    const entries: ActivityEntry[] = [];
    for (const n of notes) {
      if (!n.shared && n.owner !== CLAUDE_OWNER) continue;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      entries.push(toEntry(n));
    }

    return entries
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 40);
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  private buildHtml(): string {
    const nonce = getNonce();
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    background: var(--vscode-sideBar-background);
    color: var(--vscode-foreground);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Feed list ── */
  .feed {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }

  /* ── Entry ── */
  .entry {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 9px 12px;
    transition: background .1s;
    cursor: default;
  }
  .entry:hover { background: var(--vscode-list-hoverBackground); }

  .avatar {
    width: 28px; height: 28px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    color: ${UI_COLORS.white};
    flex-shrink: 0;
    margin-top: 1px;
    letter-spacing: -.3px;
  }

  .entry-body { flex: 1; min-width: 0; }

  .entry-who {
    font-size: 11px;
    font-weight: 600;
    color: var(--vscode-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .you-badge {
    font-size: 9px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    flex-shrink: 0;
  }
  .ai-badge {
    font-size: 9px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 3px;
    background: ${UI_COLORS.activityBg};
    color: ${UI_COLORS.white};
    flex-shrink: 0;
    letter-spacing: .02em;
  }
  .avatar-claude {
    background: ${UI_COLORS.activityBg} !important;
  }
  .action-label {
    font-size: 11px;
    font-weight: 400;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
  }

  .entry-title {
    font-size: 12px;
    color: var(--vscode-foreground);
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
    opacity: .9;
  }
  .entry-title:hover {
    opacity: 1;
    text-decoration: underline;
    color: var(--vscode-textLink-foreground);
  }

  .entry-time {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    margin-top: 2px;
    opacity: .7;
  }

  /* ── Divider ── */
  .day-divider {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .06em;
    color: var(--vscode-descriptionForeground);
    padding: 10px 12px 4px;
    opacity: .6;
  }

  /* ── Empty state ── */
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
    padding: 24px;
  }
  .empty-icon { font-size: 2em; }
  .empty p { font-size: 12px; line-height: 1.55; }

  /* ── Footer ── */
  .feed-footer {
    font-size: 10px;
    text-align: center;
    padding: 8px;
    color: var(--vscode-descriptionForeground);
    opacity: .5;
    flex-shrink: 0;
    border-top: 1px solid var(--vscode-panel-border);
  }
</style>
</head>
<body>

<div class="feed" id="feed"></div>
<div class="feed-footer" id="feed-footer"></div>

<script nonce="${nonce}">
(() => {
  const vscode   = acquireVsCodeApi();
  const feedEl   = document.getElementById('feed');
  const footerEl = document.getElementById('feed-footer');

  vscode.postMessage({ type: 'ready' });

  window.addEventListener('message', ({ data: msg }) => {
    if (msg.type === 'init') render(msg.entries, msg.currentUser);
  });

  function render(entries, currentUser) {
    feedEl.innerHTML = '';

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML =
        '<div class="empty-icon">📡</div>' +
        '<p>No activity yet.<br>Share notes with teammates or ask Claude Code to create notes to see activity here.</p>';
      feedEl.appendChild(empty);
      footerEl.textContent = '';
      return;
    }

    // Group entries by day for dividers
    let lastDay = '';
    entries.forEach(entry => {
      const day = dayLabel(entry.timestamp);
      if (day !== lastDay) {
        const div = document.createElement('div');
        div.className = 'day-divider';
        div.textContent = day;
        feedEl.appendChild(div);
        lastDay = day;
      }
      feedEl.appendChild(buildEntry(entry, currentUser));
    });

    const sharedCount = entries.filter(e => !e.isClaude).length;
    const claudeCount = entries.filter(e => e.isClaude).length;
    const parts = [];
    if (sharedCount > 0) parts.push(sharedCount + ' shared note' + (sharedCount !== 1 ? 's' : ''));
    if (claudeCount > 0) parts.push(claudeCount + ' from Claude');
    footerEl.textContent = parts.join(' · ');
  }

  function buildEntry(entry, currentUser) {
    const el = document.createElement('div');
    el.className = 'entry';

    // Avatar
    const avatar = document.createElement('div');
    avatar.className = entry.isClaude ? 'avatar avatar-claude' : 'avatar';
    if (!entry.isClaude) avatar.style.background = ownerColor(entry.isYou ? (currentUser || 'You') : (entry.owner || 'Unknown'));
    avatar.textContent = entry.isClaude ? 'CC' : initials(entry.isYou ? (currentUser || 'You') : (entry.owner || 'Unknown'));
    el.appendChild(avatar);

    // Body
    const body = document.createElement('div');
    body.className = 'entry-body';

    // Who + action
    const who = document.createElement('div');
    who.className = 'entry-who';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = entry.isClaude ? 'Claude Code' : (entry.isYou ? 'You' : (entry.owner || 'Unknown'));
    who.appendChild(nameSpan);

    if (entry.isClaude) {
      const badge = document.createElement('span');
      badge.className = 'ai-badge';
      badge.textContent = 'AI';
      who.appendChild(badge);
    } else if (entry.isYou) {
      const badge = document.createElement('span');
      badge.className = 'you-badge';
      badge.textContent = 'you';
      who.appendChild(badge);
    }

    const actionSpan = document.createElement('span');
    actionSpan.className = 'action-label';
    actionSpan.textContent = entry.action === 'created' ? 'created' : 'updated';
    who.appendChild(actionSpan);
    body.appendChild(who);

    // Title
    const title = document.createElement('div');
    title.className = 'entry-title';
    title.textContent = entry.title;
    title.title = 'Open note';
    title.addEventListener('click', () => {
      vscode.postMessage({ type: 'openNote', noteId: entry.noteId });
    });
    body.appendChild(title);

    // Timestamp
    const time = document.createElement('div');
    time.className = 'entry-time';
    time.textContent = timeAgo(entry.timestamp);
    body.appendChild(time);

    el.appendChild(body);
    return el;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function ownerColor(name) {
    if (!name) return ACTIVITY_PALETTE[0];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return ACTIVITY_PALETTE[h % ACTIVITY_PALETTE.length];
  }

  function initials(name) {
    if (typeof name !== 'string' || !name.trim()) return '?';
    const parts = name.trim().split(/\\s+/).filter(p => p.length > 0);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return (parts[0][0] || '?').toUpperCase();
    return ((parts[0][0] || '') + (parts[parts.length - 1][0] || '')).toUpperCase() || '?';
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1)   return 'just now';
    if (m < 60)  return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24)  return h + 'h ago';
    const d = Math.floor(h / 24);
    if (d === 1) return 'yesterday';
    if (d < 7)   return d + 'd ago';
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function dayLabel(ts) {
    const d   = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }
})();
</script>
</body>
</html>`;
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
