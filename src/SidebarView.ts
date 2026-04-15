import * as vscode from 'vscode';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { NoteStorage, Note, Tag, Template, GitHubLink, NOTE_COLORS, DEFAULT_TAGS } from './NoteStorage';
import { detectProjectIdentity } from './GitDetector';
import {
  Plus, Search, X, Ellipsis, User, Archive, Clock, LayoutList, Bot,
  Palette, SquarePen, Bell, Copy, Link2, Unlink2, Share2, Download,
  Trash2, GitBranch, ArrowLeftRight, Star, FolderGit, FolderOpen,
  ClockArrowDown, ArrowDownAZ, Tag as TagIcon,
} from 'lucide';
import type { IconNode as LucideNode } from 'lucide';

// ─── Lucide icon helper ───────────────────────────────────────────────────────

function svgIcon(nodes: LucideNode, size = 14, style = ''): string {
  const inner = nodes.map(([tag, attrs]) => {
    const a = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
    return `<${tag} ${a}/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${style ? ` style="${style}"` : ''}>${inner}</svg>`;
}

// ─── Message types ────────────────────────────────────────────────────────────

type ToExt =
  | { type: 'ready' }
  | { type: 'createNote'; title: string; color: string; tags: string[]; templateId?: string; branch?: string; body?: string }
  | { type: 'setBranchScope'; noteId: string; branch: string | null }
  | { type: 'branchFilterChanged'; active: boolean }
  | { type: 'setReminder'; noteId: string }
  | { type: 'exportNotes'; noteIds: string[] }
  | { type: 'openConflict'; noteId: string }
  | { type: 'updateNote'; id: string; changes: Partial<Note> }
  | { type: 'deleteNote'; id: string }
  | { type: 'openEditor'; noteId: string }
  | { type: 'addTag'; label: string; color: string }
  | { type: 'deleteTag'; id: string }
  | { type: 'updateTag'; id: string; changes: Partial<Pick<Tag, 'label' | 'color'>> }
  | { type: 'jumpToLink'; file: string; line: number }
  | { type: 'linkToEditor'; noteId: string }
  | { type: 'removeCodeLink'; noteId: string }
  | { type: 'openGitHubLink'; url: string }
  | { type: 'connectGitHub' }
  | { type: 'archiveNote'; id: string }
  | { type: 'unarchiveNote'; id: string }
  | { type: 'registerMcp' }
  | { type: 'createGitHubIssue'; noteId: string }
  | { type: 'bulkArchive';    noteIds: string[] }
  | { type: 'bulkDelete';     noteIds: string[] }
  | { type: 'bulkTag';        noteIds: string[] }
  | { type: 'duplicateNote';  noteId: string }
  | { type: 'linkNote'; noteId: string }
  | { type: 'unlinkNote'; noteId: string; targetId: string }
  | { type: 'openLinkedNote'; noteId: string }
  | { type: 'switchBranch' }
  | { type: 'openFolder' };

// ─── Provider ────────────────────────────────────────────────────────────────

export class SidebarView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private projectName        = 'DevNotes';
  private currentBranch: string | undefined;
  private currentUser:   string | undefined;
  private availableBranches: string[] = [];
  private _branchFilterActive = false;
  private _githubConnected    = false;

  isBranchFilterActive(): boolean { return this._branchFilterActive; }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly storage: NoteStorage,
    private readonly onOpenEditor: (noteId: string) => void,
    private readonly onNoteLinkChanged: () => void = () => {},
  ) {}

  setProjectName(name: string): void {
    this.projectName = name;
    this.push();
  }

  setCurrentBranch(branch: string | undefined): void {
    this.currentBranch = branch;
    this.push();
  }

  setCurrentUser(user: string | undefined): void {
    this.currentUser = user;
    this.push();
  }

  setAvailableBranches(branches: string[]): void {
    this.availableBranches = branches;
    this.push();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: ToExt) => this.handle(msg));

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.push();
    });
  }

  /** Call this after any storage mutation to sync the sidebar. */
  push(): void {
    if (!this.view?.visible) return;
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;

    // Refresh GitHub connection status from the token file
    if (wsRoot) {
      const tokenFile = path.join(wsRoot.fsPath, '.devnotes', '.github-token');
      this._githubConnected = fs.existsSync(tokenFile);
    }

    const notes = this.storage.getNotes().map(n => {
      if (!n.codeLink || !wsRoot) return n;
      const absPath = path.join(wsRoot.fsPath, n.codeLink.file);
      return { ...n, codeLinkStale: !fs.existsSync(absPath) };
    });
    this.view.webview.postMessage({
      type              : 'init',
      notes,
      tags              : this.storage.getTags(),
      templates         : this.storage.getTemplates(),
      defaultTagIds     : DEFAULT_TAGS.map(t => t.id),
      projectName       : this.projectName,
      currentBranch     : this.currentBranch     ?? null,
      currentUser       : this.currentUser       ?? null,
      availableBranches : this.availableBranches,
      githubConnected   : this._githubConnected,
    });
  }

  /** Push mock notes into the webview to simulate Phase 7 footer animations. */
  pushSim(): void {
    if (!this.view?.visible) return;
    const now = Date.now();
    const mockNotes: Note[] = [
      {
        id: 'sim-1', title: 'Owner + Branch — hover for branch',
        content: 'Left: hover owner to reveal branch.\nRight: reminder > 24 h away → date shown, hover to peek reminder.',
        color: 'yellow', tags: [], starred: true, createdAt: now - 86400000, updatedAt: now - 3600000,
        owner: this.currentUser ?? 'Hiba Chaabnia', branch: this.currentBranch ?? 'feat/phase-7',
        remindAt: now + 172800000, // 48 h away — not urgent
      },
      {
        id: 'sim-2', title: 'Reminder within 24 h — shown by default',
        content: 'Right: reminder is imminent (< 24 h) → reminder shown by default, hover to see date.',
        color: 'orange', tags: [], starred: false, createdAt: now - 43200000, updatedAt: now - 1800000,
        owner: this.currentUser ?? 'Hiba Chaabnia', branch: this.currentBranch ?? 'feat/phase-7',
        remindAt: now + 7200000, // 2 h away — imminent
      },
      {
        id: 'sim-3', title: 'Overdue reminder — shown by default',
        content: 'Right: reminder is overdue → shown in red by default, hover to see date.',
        color: 'red', tags: [], starred: false, createdAt: now - 172800000, updatedAt: now - 86400000,
        owner: this.currentUser ?? 'Hiba Chaabnia',
        remindAt: now - 3600000, // 1 h overdue
      },
      {
        id: 'sim-4', title: 'Branch only + far reminder',
        content: 'Left: static branch badge.\nRight: date shown, hover reveals reminder.',
        color: 'green', tags: [], starred: false, createdAt: now - 7200000, updatedAt: now - 7200000,
        branch: this.currentBranch ?? 'fix/checkbox',
        remindAt: now + 259200000, // 3 days away
      },
      {
        id: 'sim-5', title: 'No owner, no branch, no reminder',
        content: 'Both slots static — date only.',
        color: 'purple', tags: [], starred: false, createdAt: now - 3600000, updatedAt: now - 3600000,
      },
      {
        id: 'sim-6', title: 'Just created',
        content: 'createdAt ≈ updatedAt → shows "created" timestamp.',
        color: 'blue', tags: [], starred: false, createdAt: now - 30000, updatedAt: now - 30000,
      },
    ];
    this.view.webview.postMessage({ type: 'sim', notes: mockNotes });
  }

  // ── Message handler ──────────────────────────────────────────────────────

  private async handle(msg: ToExt): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.push();
        break;

      case 'createNote': {
        const tpl = msg.templateId
          ? this.storage.getTemplates().find(t => t.id === msg.templateId)
          : undefined;
        await this.storage.createNote({
          title  : msg.title,
          color  : msg.color,
          tags   : msg.tags,
          content: msg.body || tpl?.content,
          branch : msg.branch,
          owner  : this.currentUser,
        });
        this.push();
        break;
      }

      case 'setBranchScope':
        await this.storage.updateNote(msg.noteId, { branch: msg.branch ?? undefined });
        this.push();
        break;

      case 'branchFilterChanged':
        this._branchFilterActive = msg.active;
        break;

      case 'exportNotes':
        vscode.commands.executeCommand('devnotes.exportSelected', msg.noteIds);
        break;

      case 'openConflict':
        vscode.commands.executeCommand('devnotes.openConflict', msg.noteId);
        break;

      case 'setReminder': {
        const note = this.storage.getNote(msg.noteId);
        if (!note) break;

        const now  = new Date();
        const make = (offsetDays: number, hour = 9): Date => {
          const d = new Date(now);
          d.setDate(d.getDate() + offsetDays);
          d.setHours(hour, 0, 0, 0);
          return d;
        };
        const fmt = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

        type RItem = vscode.QuickPickItem & { ts: number | null | undefined };
        const items: RItem[] = [];

        if (note.remindAt) {
          items.push({ label: '$(bell-slash) Remove reminder', description: 'Clear the current reminder', ts: null });
          items.push({ kind: vscode.QuickPickItemKind.Separator, label: '', ts: undefined });
        }
        items.push(
          { label: '$(bell) Tomorrow morning',  description: fmt(make(1)),  ts: make(1).getTime()  },
          { label: '$(bell) In 2 days',         description: fmt(make(2)),  ts: make(2).getTime()  },
          { label: '$(bell) Next week',         description: fmt(make(7)),  ts: make(7).getTime()  },
          { label: '$(bell) Next month',        description: fmt(make(30)), ts: make(30).getTime() },
          { label: '$(calendar) Custom date…',  description: 'Enter a specific date', ts: undefined },
        );

        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Set a reminder for this note' });
        if (!picked) break;

        let remindAt: number | undefined;

        if (picked.ts === null) {
          remindAt = undefined; // remove
        } else if (picked.ts === undefined) {
          // Custom date input
          const input = await vscode.window.showInputBox({
            prompt      : 'Reminder date',
            placeHolder : new Date().toISOString().slice(0, 10),
            validateInput: v => {
              const d = new Date(v);
              return isNaN(d.getTime()) ? 'Use YYYY-MM-DD format' : undefined;
            },
          });
          if (!input) break;
          const d = new Date(input);
          d.setHours(9, 0, 0, 0);
          remindAt = d.getTime();
        } else {
          remindAt = picked.ts;
        }

        await this.storage.updateNote(msg.noteId, { remindAt });
        this.push();
        break;
      }

      case 'updateNote': {
        const prevShared = this.storage.getNote(msg.id)?.shared;
        await this.storage.updateNote(msg.id, msg.changes);
        this.push();

        if ('shared' in msg.changes) {
          const note = this.storage.getNote(msg.id);
          if (!note) break;
          if (msg.changes.shared && !prevShared) {
            // Determine whether custom tags exist so we know to include tags.json
            const defaultIds = new Set(DEFAULT_TAGS.map(t => t.id));
            const hasCustomTags = this.storage.getTags().some(t => !defaultIds.has(t.id));
            const tagsCmdPart = hasCustomTags ? ' .devnotes/tags.json' : '';
            const action = await vscode.window.showInformationMessage(
              `"${note.title}" is now shared. Commit it to git to make it visible to teammates.`,
              'Copy git commands'
            );
            if (action === 'Copy git commands') {
              await vscode.env.clipboard.writeText(
                `git add .devnotes/.gitignore${tagsCmdPart} ".devnotes/${note.id}.md"\ngit commit -m "share: ${note.title}"`
              );
            }
          } else if (!msg.changes.shared && prevShared) {
            const action = await vscode.window.showInformationMessage(
              `"${note.title}" unshared. Remove it from git tracking and push to update teammates.`,
              'Copy git commands'
            );
            if (action === 'Copy git commands') {
              await vscode.env.clipboard.writeText(
                `git rm --cached ".devnotes/${note.id}.md"\ngit add .devnotes/.gitignore\ngit commit -m "unshare: ${note.title}"`
              );
            }
          }
        }
        break;
      }

      case 'deleteNote': {
        const note = this.storage.getNote(msg.id);
        if (!note) break;
        const ans = await vscode.window.showWarningMessage(
          `Delete "${note.title}"?`, { modal: true }, 'Delete'
        );
        if (ans === 'Delete') {
          await this.storage.deleteNote(msg.id);
          this.push();
        }
        break;
      }

      case 'openEditor':
        this.onOpenEditor(msg.noteId);
        break;

      case 'addTag': {
        await this.storage.addTag(msg.label, msg.color);
        this.push();
        break;
      }

      case 'deleteTag': {
        await this.storage.deleteTag(msg.id);
        this.push();
        break;
      }

      case 'updateTag': {
        await this.storage.updateTag(msg.id, msg.changes);
        this.push();
        break;
      }

      case 'jumpToLink':
        vscode.commands.executeCommand('devnotes.jumpToLink', msg.file, msg.line);
        break;

      case 'linkToEditor': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showInformationMessage('DevNotes: open a file and place your cursor on the line you want to link.');
          break;
        }
        const filePath = vscode.workspace.asRelativePath(editor.document.uri, false);
        if (filePath === editor.document.uri.fsPath) {
          vscode.window.showWarningMessage('DevNotes: file is outside the current workspace.');
          break;
        }
        const line = editor.selection.active.line + 1;
        await this.storage.updateNote(msg.noteId, { codeLink: { file: filePath, line } });
        this.push();
        this.onNoteLinkChanged();
        break;
      }

      case 'removeCodeLink':
        await this.storage.updateNote(msg.noteId, { codeLink: undefined });
        this.push();
        this.onNoteLinkChanged();
        break;

      case 'archiveNote': {
        await this.storage.updateNote(msg.id, { archived: true, starred: false });
        this.push();
        break;
      }

      case 'unarchiveNote': {
        await this.storage.updateNote(msg.id, { archived: undefined });
        this.push();
        break;
      }

      case 'duplicateNote': {
        const src = this.storage.getNote(msg.noteId);
        if (!src) break;
        await this.storage.createNote({
          title  : `Copy of ${src.title}`,
          content: src.content,
          color  : src.color,
          tags   : [...src.tags],
          branch : src.branch,
          owner  : this.currentUser,
        });
        this.push();
        break;
      }

      case 'openGitHubLink':
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;

      case 'connectGitHub': {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!wsRoot) {
          vscode.window.showErrorMessage('DevNotes: open a workspace folder first.');
          break;
        }
        try {
          const session = await vscode.authentication.getSession(
            'github', ['repo'], { createIfNone: true }
          );
          const devnotesDir = path.join(wsRoot.fsPath, '.devnotes');
          fs.mkdirSync(devnotesDir, { recursive: true });
          fs.writeFileSync(path.join(devnotesDir, '.github-token'), session.accessToken, 'utf-8');
          this._githubConnected = true;
          this.push();
          vscode.window.showInformationMessage('GitHub connected! Claude can now link notes to issues and PRs.');
        } catch {
          vscode.window.showErrorMessage('GitHub sign-in was cancelled or failed.');
        }
        break;
      }

      case 'bulkArchive': {
        for (const id of msg.noteIds) {
          await this.storage.updateNote(id, { archived: true, starred: false });
        }
        this.push();
        break;
      }

      case 'bulkDelete': {
        const n = msg.noteIds.length;
        const ans = await vscode.window.showWarningMessage(
          `Delete ${n} note${n !== 1 ? 's' : ''}? This cannot be undone.`,
          { modal: true },
          'Delete'
        );
        if (ans !== 'Delete') break;
        for (const id of msg.noteIds) {
          await this.storage.deleteNote(id);
        }
        this.push();
        break;
      }

      case 'bulkTag': {
        if (this.storage.getTags().length === 0) {
          vscode.window.showInformationMessage('No tags exist yet — create a tag first.');
          break;
        }
        type TItem = vscode.QuickPickItem & { id: string };
        const items: TItem[] = this.storage.getTags().map(t => ({
          id   : t.id,
          label: t.label,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Choose a tag to add to all selected notes…',
        });
        if (!picked) break;
        for (const id of msg.noteIds) {
          const note = this.storage.getNote(id);
          if (!note) continue;
          if (!note.tags.includes(picked.id)) {
            await this.storage.updateNote(id, { tags: [...note.tags, picked.id] });
          }
        }
        this.push();
        break;
      }

      case 'createGitHubIssue': {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!wsRoot) break;

        const note = this.storage.getNote(msg.noteId);
        if (!note) break;

        const tokenFile = path.join(wsRoot.fsPath, '.devnotes', '.github-token');
        let token: string | undefined;
        try { token = fs.readFileSync(tokenFile, 'utf-8').trim(); } catch {}
        if (!token) {
          vscode.window.showErrorMessage('DevNotes: connect to GitHub first (click the Octocat button in the sidebar).');
          break;
        }

        // Detect owner/repo from git remote
        const identity = detectProjectIdentity();
        let ownerRepo = identity?.remoteUrl ? parseGitHubOwnerRepo(identity.remoteUrl) : undefined;

        if (!ownerRepo) {
          const input = await vscode.window.showInputBox({
            prompt      : 'GitHub repository (owner/repo)',
            placeHolder : 'e.g. microsoft/vscode',
            validateInput: v => v.includes('/') ? undefined : 'Use owner/repo format',
          });
          if (!input) break;
          const [owner, repo] = input.trim().split('/');
          ownerRepo = { owner, repo };
        }

        const title = await vscode.window.showInputBox({
          prompt: `Create issue in ${ownerRepo.owner}/${ownerRepo.repo}`,
          value : note.title,
        });
        if (!title) break;

        try {
          const issue = await githubCreateIssue(token, ownerRepo.owner, ownerRepo.repo, title, note.content);
          const github: GitHubLink = {
            url   : issue.html_url,
            repo  : `${ownerRepo.owner}/${ownerRepo.repo}`,
            number: issue.number,
            type  : 'issue',
            status: 'open',
            title : issue.title,
          };
          await this.storage.updateNote(msg.noteId, { github });
          this.push();
          const action = await vscode.window.showInformationMessage(
            `Issue #${issue.number} created: "${issue.title}"`,
            'Open in Browser'
          );
          if (action === 'Open in Browser') {
            vscode.env.openExternal(vscode.Uri.parse(issue.html_url));
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`DevNotes: failed to create issue — ${err.message ?? err}`);
        }
        break;
      }

      case 'linkNote': {
        const note = this.storage.getNote(msg.noteId);
        if (!note) break;
        const candidates = this.storage.getNotes()
          .filter(n => n.id !== msg.noteId && !n.archived && !note.linkedNoteIds?.includes(n.id));
        if (candidates.length === 0) {
          vscode.window.showInformationMessage('No other notes available to link.');
          break;
        }
        type NItem = vscode.QuickPickItem & { id: string };
        const items: NItem[] = candidates.map(n => ({
          id         : n.id,
          label      : n.title,
          description: n.tags.length ? n.tags.join(', ') : undefined,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder      : 'Select a note to link to…',
          matchOnDescription: true,
        });
        if (!picked) break;
        // Forward link: A → B
        const existing = note.linkedNoteIds ?? [];
        await this.storage.updateNote(msg.noteId, { linkedNoteIds: [...existing, picked.id] });
        // Back-link: B → A
        const target = this.storage.getNote(picked.id);
        if (target && !target.linkedNoteIds?.includes(msg.noteId)) {
          const targetExisting = target.linkedNoteIds ?? [];
          await this.storage.updateNote(picked.id, { linkedNoteIds: [...targetExisting, msg.noteId] });
        }
        this.push();
        break;
      }

      case 'unlinkNote': {
        const note = this.storage.getNote(msg.noteId);
        if (!note) break;
        // Remove forward link: A → B
        const updated = (note.linkedNoteIds ?? []).filter(id => id !== msg.targetId);
        await this.storage.updateNote(msg.noteId, { linkedNoteIds: updated.length ? updated : undefined });
        // Remove back-link: B → A
        const target = this.storage.getNote(msg.targetId);
        if (target) {
          const targetUpdated = (target.linkedNoteIds ?? []).filter(id => id !== msg.noteId);
          await this.storage.updateNote(msg.targetId, { linkedNoteIds: targetUpdated.length ? targetUpdated : undefined });
        }
        this.push();
        break;
      }

      case 'openLinkedNote':
        this.onOpenEditor(msg.noteId);
        break;

      case 'switchBranch':
        vscode.commands.executeCommand('git.checkout');
        break;

      case 'openFolder':
        vscode.commands.executeCommand('workbench.action.openRecent');
        break;

      case 'registerMcp':
        vscode.commands.executeCommand('devnotes.registerMcp');
        break;
    }
  }

  // ── HTML ─────────────────────────────────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
    const nonce             = getNonce();
    const colorsJson        = JSON.stringify(NOTE_COLORS);
    const sidebarEditorUri  = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sidebar-editor.js')
    );

    // SVG strings injected into the webview script (browser side can't import lucide)
    const jsSvg = {
      edit:        JSON.stringify(svgIcon(SquarePen, 14)),
      remind:      JSON.stringify(svgIcon(Bell,      14)),
      dup:         JSON.stringify(svgIcon(Copy,      14)),
      link:        JSON.stringify(svgIcon(Link2,     14)),
      unlink:      JSON.stringify(svgIcon(Unlink2,   14)),
      archive:     JSON.stringify(svgIcon(Archive,   14)),
      share:       JSON.stringify(svgIcon(Share2,    14)),
      export:      JSON.stringify(svgIcon(Download,  14)),
      trash:       JSON.stringify(svgIcon(Trash2,    14)),
      colorPicker: JSON.stringify(svgIcon(Palette,   13)),
      overflow:    JSON.stringify(svgIcon(Ellipsis,  14)),
      star:        JSON.stringify(svgIcon(Star,      14)),
      unlinkSmall: JSON.stringify(svgIcon(X,           10)),
      folderGit:   JSON.stringify(svgIcon(FolderGit,  13, 'flex-shrink:0')),
      folderOpen:  JSON.stringify(svgIcon(FolderOpen, 13, 'flex-shrink:0')),
      branch:      JSON.stringify(svgIcon(GitBranch,     11, 'flex-shrink:0')),
      branchSwitch: JSON.stringify(svgIcon(ArrowLeftRight, 11, 'flex-shrink:0')),
      sortUpdated: JSON.stringify(svgIcon(ClockArrowDown, 13)),
      sortAlpha:   JSON.stringify(svgIcon(ArrowDownAZ, 13)),
    };

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --radius: 10px;
    --gap: 10px;
    --card-text: var(--vscode-foreground);
  }

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

  /* ── Top bar ─────────────────────────────────────────── */
  .topbar {
    padding: 8px 10px 6px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .topbar-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .project-pill {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px 2px 6px;
    border-radius: 10px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    min-width: 0;
    flex-shrink: 1;
    display: flex;
    align-items: center;
    cursor: pointer;
    position: relative;
    overflow: hidden;
    height: 20px;
  }
  .project-pill:hover {
    background: var(--vscode-button-secondaryBackground, rgba(255,255,255,.12));
    color: var(--vscode-button-secondaryForeground, var(--vscode-badge-foreground));
  }
  .project-pill:hover .pill-primary { opacity: 0; transform: translateY(-5px); }
  .project-pill:hover .pill-action  { opacity: 1; transform: translateY(0); }

  .pill-primary {
    display: flex;
    align-items: center;
    gap: 4px;
    overflow: hidden;
    min-width: 0;
    transition: opacity .15s, transform .15s;
  }
  .pill-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .pill-action {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px 2px 6px;
    overflow: hidden;
    opacity: 0;
    transform: translateY(5px);
    transition: opacity .15s, transform .15s;
    font-style: italic;
  }

  .new-note-pill {
    display: flex;
    align-items: center;
    gap: 3px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 10px;
    padding: 2px 9px 2px 6px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    flex-shrink: 0;
    line-height: 1.4;
  }
  .new-note-pill:hover { background: var(--vscode-button-hoverBackground); }

  .icon-btn {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 3px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: .7;
  }
  .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

  .search-row {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 6px;
    padding: 4px 8px;
  }
  .search-row input {
    flex: 1;
    border: none;
    background: transparent;
    color: var(--vscode-input-foreground);
    outline: none;
    font-size: 12px;
  }
  .search-row input::placeholder { color: var(--vscode-input-placeholderForeground); }

  .search-clear {
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    padding: 0 2px;
    display: flex;
    align-items: center;
    opacity: .7;
    flex-shrink: 0;
  }
  .search-clear:hover { opacity: 1; }

  mark.match-highlight {
    background: var(--vscode-editor-findMatchHighlightBackground, rgba(255,200,0,.4));
    color: inherit;
    border-radius: 2px;
    padding: 0 1px;
  }

  /* ── Overflow menu (⋯) ──────────────────────────────── */
  .overflow-menu {
    position: fixed;
    z-index: 500;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,.28);
    padding: 4px;
    min-width: 176px;
    display: none;
    flex-direction: column;
  }
  .overflow-menu.open { display: flex; }

  .ovf-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border: none;
    background: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    border-radius: 5px;
    font-size: 12px;
    font-family: var(--vscode-font-family);
    text-align: left;
    width: 100%;
  }
  .ovf-item:hover { background: var(--vscode-toolbar-hoverBackground); }
  .ovf-icon { flex-shrink: 0; width: 16px; display: flex; align-items: center; justify-content: center; opacity: .75; }
  .ovf-item:hover .ovf-icon { opacity: 1; }
  .ovf-label { flex: 1; }
  .ovf-check { font-size: 11px; opacity: 0; transition: opacity .1s; flex-shrink: 0; color: var(--vscode-button-background); font-weight: 700; }
  .ovf-item.active .ovf-check { opacity: 1; }
  .ovf-item.active .ovf-label { font-weight: 600; }
  .ovf-divider { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 4px 0; }
  .ovf-item.danger       { color: #e05252; }
  .ovf-item.danger:hover { background: rgba(224,82,82,.12); }
  .ovf-item.confirm      { color: #e05252; font-weight: 600; }

  .overflow-btn.active { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

  /* ── Tag filter bar ──────────────────────────────────── */
  .tag-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }

  .github-filter-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  .github-filter-bar .gh-chip {
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 20px;
    border: 1.5px solid transparent;
    cursor: pointer;
    font-weight: 500;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
    transition: opacity .12s;
  }
  .github-filter-bar .gh-chip:hover { opacity: .85; }
  .github-filter-bar .gh-chip.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: transparent;
  }
  .github-filter-bar .gh-chip .gh-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .github-filter-bar .gh-chip.open-chip  .gh-dot { background: #06d6a0; }
  .github-filter-bar .gh-chip.closed-chip .gh-dot { background: #888; }
  .github-filter-bar .gh-chip.merged-chip .gh-dot { background: #8250df; }
  .github-filter-bar .gh-filter-label {
    font-size: 10px;
    opacity: .5;
    margin-right: 2px;
    white-space: nowrap;
  }

  .tag-chip {
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 20px;
    border: 1.5px solid transparent;
    cursor: pointer;
    font-weight: 500;
    color: #1a1a2e;
    transition: opacity .12s;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .tag-chip:hover { opacity: .85; }
  .tag-chip.active { border-color: #1a1a2e; }
  .tag-chip.all { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .tag-chip.all.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }

  .tag-chip-delete {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    opacity: 0;
    transition: opacity .12s;
    cursor: pointer;
    padding: 0 1px;
    line-height: 1;
    border-radius: 50%;
  }
  .tag-chip:hover .tag-chip-delete { opacity: .65; }
  .tag-chip-delete:hover { opacity: 1 !important; background: rgba(0,0,0,.15); border-radius: 50%; }
  .tag-chip.confirming { outline: 2px solid #EF6C57; outline-offset: 1px; }
  .tag-chip.confirming .tag-chip-delete { opacity: 1; color: #EF6C57; font-weight: 700; }

  .add-tag-btn {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 20px;
    background: none;
    border: 1.5px dashed var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
  }
  .add-tag-btn:hover { border-color: var(--vscode-foreground); color: var(--vscode-foreground); }

  .manage-tags-btn {
    font-size: 12px;
    padding: 2px 7px;
    border-radius: 20px;
    background: none;
    border: 1.5px solid transparent;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    margin-left: auto;
  }
  .manage-tags-btn:hover { color: var(--vscode-foreground); border-color: var(--vscode-panel-border); }
  .manage-tags-btn.active {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border-color: transparent;
  }

  /* ── Tag manager panel ───────────────────────────────── */
  .tag-manager {
    padding: 8px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    background: var(--vscode-input-background);
    max-height: 240px;
    overflow-y: auto;
  }

  .tag-mgr-section {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .05em;
    color: var(--vscode-descriptionForeground);
    padding: 6px 0 3px;
    margin-top: 2px;
  }
  .tag-mgr-section:first-child { padding-top: 0; }

  .tag-mgr-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    position: relative;
  }

  .tag-mgr-swatch {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1.5px solid rgba(0,0,0,.2);
    cursor: pointer;
    flex-shrink: 0;
    transition: transform .1s;
  }
  .tag-mgr-swatch:hover { transform: scale(1.2); }
  .tag-mgr-swatch-ro { cursor: default; }
  .tag-mgr-swatch-ro:hover { transform: none; }

  .tag-mgr-input {
    flex: 1;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-input-foreground);
    font-family: var(--vscode-font-family);
    outline: none;
    min-width: 0;
  }
  .tag-mgr-input:hover { border-color: var(--vscode-panel-border); }
  .tag-mgr-input:focus {
    border-color: var(--vscode-focusBorder, var(--vscode-panel-border));
    background: var(--vscode-input-background);
  }

  .tag-mgr-del {
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 11px;
    padding: 2px 5px;
    border-radius: 3px;
    opacity: .45;
    flex-shrink: 0;
  }
  .tag-mgr-del:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

  .tag-mgr-count {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    opacity: .55;
    flex-shrink: 0;
    min-width: 20px;
    text-align: right;
  }
  .tag-mgr-confirm {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 0;
    font-size: 11px;
    color: var(--vscode-foreground);
    flex: 1;
  }
  .tag-mgr-confirm-msg { flex: 1; opacity: .8; }
  .tag-mgr-confirm-yes {
    background: #EF6C57;
    color: #fff;
    border: none;
    border-radius: 3px;
    padding: 2px 8px;
    font-size: 11px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .tag-mgr-confirm-yes:hover { opacity: .85; }
  .tag-mgr-confirm-no {
    background: none;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    padding: 2px 8px;
    font-size: 11px;
    cursor: pointer;
    flex-shrink: 0;
    color: var(--vscode-foreground);
  }
  .tag-mgr-confirm-no:hover { background: var(--vscode-toolbar-hoverBackground); }

  .tag-mgr-ro-label {
    flex: 1;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
    opacity: .6;
  }

  .tag-mgr-ro-hint {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    opacity: .5;
    font-style: italic;
  }

  .tag-mgr-empty {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    padding: 4px 0;
    opacity: .7;
  }

  /* Color picker popover inside the manager */
  .tag-mgr-color-pop {
    position: absolute;
    left: 22px;
    top: 22px;
    background: var(--vscode-editorWidget-background, #fff);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 8px;
    display: none;
    gap: 6px;
    flex-wrap: wrap;
    width: 128px;
    z-index: 100;
    box-shadow: 0 4px 16px rgba(0,0,0,.18);
  }
  .tag-mgr-color-pop.open { display: flex; }

  /* ── Simulation banner ───────────────────────────────── */
  .sim-banner {
    display: flex; align-items: center; justify-content: space-between;
    gap: 6px; padding: 5px 10px;
    background: rgba(255, 180, 0, .12);
    border-bottom: 1px solid rgba(255, 180, 0, .25);
    font-size: 10px;
  }
  .sim-label { opacity: .8; }
  .sim-exit {
    background: none; border: 1px solid rgba(255,180,0,.4); border-radius: 3px;
    color: inherit; font-size: 10px; padding: 1px 6px; cursor: pointer; opacity: .7;
  }
  .sim-exit:hover { opacity: 1; background: rgba(255,180,0,.15); }

  /* ── Card list ───────────────────────────────────────── */
  .card-list {
    flex: 1;
    overflow-y: auto;
    padding: var(--gap);
    display: flex;
    flex-direction: column;
    gap: var(--gap);
  }

  /* ── Card ────────────────────────────────────────────── */
  .card {
    border-radius: var(--radius);
    padding: 10px 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    border-left: 3px solid var(--card-accent, #FFD166);
    box-shadow: 0 1px 4px rgba(0,0,0,.1);
    transition: box-shadow .15s, transform .15s;
    color: var(--card-text);
    position: relative;
  }
  .card:hover { box-shadow: 0 4px 14px rgba(0,0,0,.15); transform: translateY(-1px); }
  .card:focus { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; box-shadow: 0 4px 14px rgba(0,0,0,.15); }
  .card.hidden { display: none; }
  .card.is-shared { border-left-color: rgba(6, 214, 214, 0.85); }

  /* ── Card rows ───────────────────────────────────────── */
  .card-row-1 {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 24px;
  }

  .card-overflow-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 15px;
    line-height: 1;
    padding: 0 2px;
    color: var(--card-text);
    opacity: 0;
    transition: opacity .12s;
    flex-shrink: 0;
    border-radius: 4px;
  }
  .card:hover .card-overflow-btn { opacity: .5; }
  .card-overflow-btn:hover { opacity: 1 !important; background: rgba(128,128,128,.15); }

  .card-color-btn {
    background: none; border: none; cursor: pointer;
    padding: 2px; line-height: 0;
    color: var(--card-text); opacity: 0;
    flex-shrink: 0;
    border-radius: 4px;
    transition: opacity .15s;
  }
  .card:hover .card-color-btn { opacity: .5; }
  .card-color-btn:hover { opacity: 1 !important; background: rgba(128,128,128,.15); }

  .star-btn {
    background: none; border: none; cursor: pointer;
    padding: 0; display: flex; align-items: center;
    color: var(--card-text); opacity: .4;
    flex-shrink: 0;
  }
  .star-btn.on { opacity: 1; }
  .star-btn.on svg { fill: currentColor; }
  .star-btn:hover { opacity: .8; }

  #card-color-pop {
    position: fixed;
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 8px;
    display: none;
    flex-direction: column;
    gap: 5px;
    z-index: 200;
    box-shadow: 0 4px 16px rgba(0,0,0,.28);
  }
  #card-color-pop.open { display: flex; }
  #card-color-pop .color-swatch { width: 20px; height: 20px; }

  .card-title {
    flex: 1;
    font-weight: 700;
    font-size: 13px;
    color: var(--card-text);
    outline: none;
    border: none;
    background: transparent;
    padding: 0;
    min-width: 0;
    cursor: text;
  }
  .card-title:focus {
    border-bottom: 1.5px solid var(--vscode-focusBorder);
  }

  .card-row-2 {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    min-height: 0;
  }
  .card-row-2:empty { display: none; }

  .card-row-3 {
    border-top: 1px solid rgba(128,128,128,.08);
    padding-top: 5px;
  }

  /* Color picker popover */
  .color-pop {
    position: absolute;
    top: 30px; right: 8px;
    background: var(--vscode-editorWidget-background, #fff);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 8px;
    display: none;
    gap: 6px;
    flex-wrap: wrap;
    width: 128px;
    z-index: 50;
    box-shadow: 0 4px 16px rgba(0,0,0,.18);
  }
  .color-pop.open { display: flex; }

  .color-swatch {
    width: 26px; height: 26px;
    border-radius: 50%;
    border: 2px solid rgba(255,255,255,.6);
    cursor: pointer;
    transition: transform .12s;
    box-shadow: 0 1px 4px rgba(0,0,0,.18);
  }
  .color-swatch:hover { transform: scale(1.15); }
  .color-swatch.selected { border-color: #1a1a2e; }

  /* Tag assignment popover */
  .tag-pop {
    position: absolute;
    top: 30px; right: 8px;
    background: var(--vscode-editorWidget-background, #fff);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 5px;
    display: none;
    flex-direction: column;
    gap: 2px;
    min-width: 140px;
    max-width: 200px;
    max-height: 220px;
    overflow-y: auto;
    z-index: 50;
    box-shadow: 0 4px 16px rgba(0,0,0,.18);
  }
  .tag-pop.open { display: flex; }
  .tag-pop-empty {
    font-size: 11px;
    padding: 6px 8px;
    opacity: .55;
    color: #1a1a2e;
  }
  .tag-pop-item {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 8px;
    border-radius: 5px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    color: #1a1a2e;
    transition: filter .1s;
  }
  .tag-pop-item:hover { filter: brightness(.93); }
  .tag-pop-check {
    font-size: 10px;
    margin-left: auto;
    opacity: 0;
    flex-shrink: 0;
  }
  .tag-pop-item.selected .tag-pop-check { opacity: 1; }

  /* Card content */
  .card-content {
    font-size: 12px;
    line-height: 1.55;
    color: var(--card-text);
    opacity: .85;
    cursor: text;
    width: 100%;
  }

  /* Rendered markdown preview */
  .card-preview { user-select: none; cursor: text; }
  .card-preview p { margin: 0 0 4px; }
  .card-preview ul, .card-preview ol { padding-left: 1.2em; margin: 0 0 4px; }
  .card-preview li { margin: 1px 0; }
  .card-preview code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: .85em;
    background: rgba(0,0,0,.1);
    padding: 0 3px;
    border-radius: 3px;
  }
  .card-preview strong { font-weight: 700; }
  .card-preview em { font-style: italic; }
  .card-preview.clamped {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* Preview in edit mode */
  .card-preview[contenteditable="true"] {
    user-select: text;
    outline: none;
    -webkit-line-clamp: unset;
    display: block;
    overflow: visible;
  }

  .show-more {
    font-size: 11px;
    cursor: pointer;
    opacity: .5;
    text-align: right;
    color: var(--card-text);
    display: none;
    user-select: none;
  }
  .show-more:hover { opacity: 1; }

  /* Card footer — aliased to row 4 */
  .card-row-4 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 4px;
    border-top: 1px solid rgba(128,128,128,.08);
    padding-top: 5px;
    margin-top: 1px;
  }

  /* Footer slot — crossfade between primary and secondary */
  .card-foot-slot {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .card-foot-slot-left  { justify-content: flex-start; text-align: left; }
  .card-foot-slot-right { justify-content: flex-end;   text-align: right; }
  .card-foot-primary {
    transition: opacity .18s ease, transform .18s ease;
    white-space: nowrap;
  }
  /* Two-class selector beats single-class element styles (.card-date, .card-reminder, etc.) */
  .card-foot-slot .card-foot-secondary {
    position: absolute;
    white-space: nowrap;
    opacity: 0 !important;
    transform: translateY(4px);
    pointer-events: none;
    transition: opacity .18s ease, transform .18s ease;
  }
  .card-foot-slot-left  .card-foot-secondary { left: 0; }
  .card-foot-slot-right .card-foot-secondary { right: 0; }
  .card-foot-slot.card-foot-flipped .card-foot-primary {
    opacity: 0;
    transform: translateY(-4px);
  }
  .card-foot-slot.card-foot-flipped .card-foot-secondary {
    opacity: 1 !important;
    transform: translateY(0);
    pointer-events: auto;
  }

  .card-reminder {
    font-size: 10px;
    white-space: nowrap;
    color: #d4900a;
    opacity: .9;
  }
  .card-reminder.overdue { color: #c0392b; opacity: 1; }

  /* ── Format bar (replaces row 4 while editing) ───────── */
  .card-fmtbar {
    display: none;
    align-items: center;
    gap: 2px;
    border-top: 1px solid rgba(128,128,128,.08);
    padding-top: 5px;
    margin-top: 1px;
  }
  .card-fmt-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 12px;
    padding: 1px 5px;
    border-radius: 3px;
    color: var(--card-text);
    opacity: .55;
    line-height: 1.4;
    transition: opacity .1s, background .1s;
  }
  .card-fmt-btn:hover { opacity: 1; background: rgba(128,128,128,.12); }
  .card-fmt-sep { flex: 1; }
  .card-fmt-done {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 3px;
    color: var(--card-text);
    opacity: .5;
    transition: opacity .1s, background .1s;
  }
  .card-fmt-done:hover { opacity: 1; background: rgba(128,128,128,.12); }

  /* Task / checklist items */
  .task-list { list-style: none; padding-left: 4px; margin: 2px 0; }
  .task-item { display: flex; align-items: center; gap: 5px; }
  .task-item input[type="checkbox"] {
    cursor: pointer; width: 13px; height: 13px; flex-shrink: 0;
    accent-color: var(--card-accent, #FFD166);
  }
  .task-item.done > span { opacity: .5; text-decoration: line-through; }

  /* Rich block content inside preview */
  .card-preview h2 { font-size: 1em; font-weight: 700; margin: 2px 0; }
  .card-preview h3 { font-size: .9em; font-weight: 600; margin: 2px 0; opacity: .85; }
  .card-preview pre {
    background: rgba(128,128,128,.1); border-radius: 3px;
    padding: 4px 6px; font-family: monospace; font-size: .85em;
    margin: 2px 0; white-space: pre-wrap;
  }
  .card-preview ol  { padding-left: 18px; margin: 2px 0; }
  .card-preview ul:not(.task-list) { padding-left: 18px; margin: 2px 0; }

  /* Format bar separator between button groups */
  .card-fmt-sep-bar {
    width: 1px; height: 14px; background: rgba(128,128,128,.22);
    margin: 0 2px; flex-shrink: 0;
  }

  .card-tags { display: contents; } /* flattened into row2 */

  .tag-ghost {
    display: inline-flex;
    align-items: center;
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 10px;
    border: 1px dashed rgba(128,128,128,.35);
    background: none;
    color: var(--card-text);
    opacity: .35;
    cursor: pointer;
    transition: opacity .12s;
  }
  .tag-ghost:hover { opacity: .7; }
  .tag-pill {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 10px;
    font-weight: 600;
    color: #1a1a2e;
    cursor: pointer;
  }
  .tag-pill:hover { filter: brightness(.9); }

  .card-date {
    font-size: 10px;
    opacity: .55;
    color: var(--card-text);
    white-space: nowrap;
  }

  /* ── Note card overlay ──────────────────────────────── */
  .note-card-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,.38);
    z-index: 200;
    align-items: center;
    justify-content: center;
    padding: 16px 10px;
  }
  .note-card-overlay.open { display: flex; }

  .note-card {
    width: 100%;
    max-height: 65vh;
    border-radius: 12px;
    background: var(--nc-bg, #FFD166);
    box-shadow: 0 8px 32px rgba(0,0,0,.35), 0 2px 8px rgba(0,0,0,.18);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transform: scale(.92);
    opacity: 0;
    transition: transform .18s cubic-bezier(.34,1.3,.64,1), opacity .15s ease;
  }
  .note-card-overlay.open .note-card {
    transform: scale(1);
    opacity: 1;
  }

  .note-card-header {
    display: flex;
    align-items: center;
    padding: 8px 10px 6px;
    gap: 6px;
  }
  .note-card-header .color-strip { flex: 1; }

  .note-card-close {
    background: none;
    border: none;
    cursor: pointer;
    color: rgba(26,26,46,.5);
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background .12s, color .12s;
    padding: 0;
  }
  .note-card-close:hover { background: rgba(26,26,46,.12); color: #1a1a2e; }

  .note-card-title {
    background: transparent;
    border: none;
    outline: none;
    font-size: 14px;
    font-weight: 700;
    color: #1a1a2e;
    padding: 0 12px 6px;
    width: 100%;
    font-family: var(--vscode-font-family);
  }
  .note-card-title::placeholder { color: rgba(26,26,46,.4); }

  .note-card-body {
    cursor: text;
    overflow-y: auto;
    min-height: 88px;
    flex: 1;
    min-height: 0;
    word-break: break-word;
  }
  .note-card-body .ProseMirror {
    outline: none;
    min-height: 88px;
    padding: 0 12px 10px;
    font-size: 12.5px;
    color: #1a1a2e;
    font-family: var(--vscode-font-family);
    line-height: 1.55;
  }
  .note-card-body .ProseMirror p { margin: 0 0 3px; }
  .note-card-body .ProseMirror ul { padding-left: 18px; margin: 0 0 3px; }
  .note-card-body .ProseMirror li { margin: 0; }
  .note-card-body.is-empty .ProseMirror p:first-child::before {
    content: attr(data-placeholder);
    color: rgba(26,26,46,.38);
    pointer-events: none;
    float: left;
    height: 0;
  }

  .note-card-footer {
    background: rgba(0,0,0,.08);
    border-top: 1px solid rgba(26,26,46,.1);
    padding: 7px 10px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .note-card-fmtbar {
    display: flex;
    gap: 1px;
    align-items: center;
  }

  .fmt-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: rgba(26,26,46,.55);
    font-size: 12px;
    width: 24px;
    height: 22px;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--vscode-font-family);
    transition: background .1s, color .1s;
  }
  .fmt-btn:hover { background: rgba(26,26,46,.1); color: #1a1a2e; }
  .fmt-btn.active { background: rgba(26,26,46,.18); color: #1a1a2e; }

  .fmt-btn-sep {
    width: 1px;
    height: 14px;
    background: rgba(26,26,46,.18);
    margin: 0 3px;
    flex-shrink: 0;
  }

  .note-card-metabar {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
    min-height: 24px;
  }

  .note-card-confirm {
    background: rgba(26,26,46,.15);
    border: none;
    cursor: pointer;
    color: #1a1a2e;
    font-size: 14px;
    font-weight: 700;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background .12s;
    margin-left: auto;
  }
  .note-card-confirm:hover { background: rgba(26,26,46,.25); }

  .note-card-header .color-swatch { width: 18px; height: 18px; }

  .nc-select {
    background: rgba(26,26,46,.12);
    border: 1px solid rgba(26,26,46,.2);
    border-radius: 5px;
    color: #1a1a2e;
    font-size: 11px;
    padding: 2px 4px;
    cursor: pointer;
    font-family: var(--vscode-font-family);
    outline: none;
    max-width: 105px;
    flex-shrink: 0;
  }
  .nc-select:focus { border-color: rgba(26,26,46,.4); }

  .color-strip {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .new-note-tags {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
    min-height: 22px;
  }

  .btn {
    padding: 4px 12px;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    font-size: 12px;
    font-family: var(--vscode-font-family);
    font-weight: 600;
  }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-ghost   { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }

  /* ── Add tag form ────────────────────────────────────── */
  .add-tag-form {
    display: none;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border-top: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  .add-tag-form.open { display: flex; }
  .add-tag-form input {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 5px;
    padding: 3px 7px;
    color: var(--vscode-input-foreground);
    outline: none;
    font-size: 12px;
    width: 100%;
  }

  /* ── Selection mode ─────────────────────────────────── */
  .select-mode .card { cursor: pointer; user-select: none; }
  .select-mode .card:hover { box-shadow: 0 4px 14px rgba(0,0,0,.2); }

  .card-check {
    display: none;
    position: absolute;
    top: 7px; left: 7px;
    width: 17px; height: 17px;
    border-radius: 4px;
    border: 2px solid rgba(26,26,46,.3);
    background: rgba(255,255,255,.88);
    z-index: 5;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    color: transparent;
    transition: background .1s, border-color .1s;
    flex-shrink: 0;
  }
  .select-mode .card-check { display: flex; }
  .card.selected .card-check {
    background: var(--vscode-button-background);
    border-color: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .card.selected .card-check::after { content: '✓'; }
  .card.selected { outline: 2px solid var(--vscode-button-background); outline-offset: 1px; }

  /* ── Export bar ──────────────────────────────────────── */
  .export-bar {
    padding: 8px 10px;
    border-top: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    background: var(--vscode-sideBar-background);
    display: none;
    align-items: center;
    gap: 8px;
  }
  .export-bar.visible { display: flex; }
  .export-bar .btn { font-size: 11px; padding: 3px 7px; }
  .export-count {
    flex: 1;
    font-size: 12px;
    color: var(--vscode-foreground);
    opacity: .85;
  }
  .btn-danger {
    color: var(--vscode-errorForeground) !important;
    border-color: var(--vscode-errorForeground) !important;
    opacity: .75;
  }
  .btn-danger:hover { opacity: 1; }
  .btn-sel-all { opacity: .7; }
  .btn-sel-all.all-selected { opacity: 1; font-weight: 700; }

  /* ── Branch indicator & filter ──────────────────────── */
  .branch-pill {
    font-size: 10px;
    padding: 1px 6px 1px 5px;
    border-radius: 10px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    min-width: 0;
    flex-shrink: 1;
    display: none;
    align-items: center;
    position: relative;
    overflow: hidden;
    height: 18px;
  }
  .branch-pill.visible { display: flex; }

  .branch-pill.can-switch { cursor: pointer; }
  .branch-pill.can-switch:hover {
    background: var(--vscode-button-secondaryBackground, rgba(255,255,255,.12));
    color: var(--vscode-button-secondaryForeground, var(--vscode-badge-foreground));
  }
  .branch-pill.can-switch:hover .pill-primary { opacity: 0; transform: translateY(-5px); }
  .branch-pill.can-switch:hover .pill-action  { opacity: 1; transform: translateY(0); }
  .branch-pill .pill-action { padding: 1px 6px 1px 5px; }


  .branch-filter-btn.active { color: var(--vscode-button-background) !important; opacity: 1; }
  .github-connect-btn.connected { color: #06d6a0 !important; opacity: 1; }
  .archive-view-btn.active { color: var(--vscode-button-background) !important; opacity: 1; }
  .card.is-archived { opacity: .7; filter: grayscale(.25); }
  .card.conflict { border-left-color: #EF6C57; background: rgba(239,108,87,.06); }
  .archived-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(0,0,0,.1);
    border: 1px solid rgba(0,0,0,.15);
    color: var(--card-text);
    opacity: .65;
  }

  /* Off-branch card — dimmed but still accessible */
  .card.off-branch { opacity: .42; }
  .card.off-branch:hover { opacity: .75; }

  /* Branch badge in card footer */
  .branch-badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 10px;
    background: rgba(0,0,0,.1);
    color: var(--card-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100px;
    opacity: .7;
  }

  /* Branch scope toggle in new-note form */
  .branch-scope-label {
    display: none;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--vscode-foreground);
    opacity: .8;
    cursor: pointer;
    user-select: none;
  }
  .branch-scope-label.visible { display: flex; }
  .branch-scope-label input { cursor: pointer; }
  .branch-scope-label code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px;
    background: rgba(128,128,128,.15);
    padding: 1px 4px;
    border-radius: 3px;
  }

  /* ── Owner badge ────────────────────────────────────── */
  .owner-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--card-text);
    opacity: .7;
    max-width: 100px;
    overflow: hidden;
  }
  .owner-initials {
    width: 16px; height: 16px;
    border-radius: 50%;
    background: var(--card-accent, #FFD166);
    opacity: .75;
    font-size: 8px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    letter-spacing: -.5px;
    color: #1a1a2e;
  }
  .owner-name {
    font-size: 10px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 56px;
  }
  .mine-filter-btn.active { color: var(--vscode-button-background) !important; opacity: 1; }
  .stale-filter-btn.active { color: #EF6C57 !important; opacity: 1; }

  /* ── Conflict indicator ─────────────────────────────── */
  .conflict-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 4px;
    background: rgba(239,108,87,.18);
    border: 1px solid rgba(239,108,87,.4);
    color: var(--card-text);
    cursor: pointer;
    transition: background .1s;
  }
  .conflict-badge:hover { background: rgba(239,108,87,.3); }

  /* ── Reminder badge ─────────────────────────────────── */
  .reminder-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 4px;
    background: rgba(0,0,0,.1);
    border: 1px solid rgba(0,0,0,.1);
    color: var(--card-text);
    opacity: .75;
    white-space: nowrap;
  }
  .reminder-badge.overdue {
    background: rgba(239,108,87,.22);
    border-color: rgba(239,108,87,.35);
    opacity: 1;
  }

  /* ── GitHub status badge ────────────────────────────── */
  .github-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 4px;
    color: var(--card-text);
    white-space: nowrap;
    cursor: pointer;
    transition: filter .1s;
    text-decoration: none;
  }
  .github-badge:hover { filter: brightness(.9); }
  .github-badge.gh-open {
    background: rgba(6,214,160,.18);
    border: 1px solid rgba(6,214,160,.45);
  }
  .github-badge.gh-closed {
    background: rgba(0,0,0,.1);
    border: 1px solid rgba(0,0,0,.18);
    opacity: .7;
  }
  .github-badge.gh-merged {
    background: rgba(130,80,255,.18);
    border: 1px solid rgba(130,80,255,.4);
  }
  .github-badge-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .gh-open  .github-badge-dot { background: #06d6a0; }
  .gh-closed .github-badge-dot { background: #888; }
  .gh-merged .github-badge-dot { background: #8250df; }

  /* ── Empty state ─────────────────────────────────────── */
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
  .empty-icon { font-size: 2.4em; }
  .empty p { font-size: 12px; line-height: 1.5; }

  /* ── Code link chip ──────────────────────────────────── */
  .code-link-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 4px;
    background: rgba(0,0,0,.12);
    border: 1px solid rgba(0,0,0,.18);
    color: var(--card-text);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
    flex-shrink: 0;
    opacity: .75;
    transition: opacity .12s, background .12s;
  }
  .code-link-chip::before {
    content: '{}';
    font-size: 9px;
    opacity: .55;
    flex-shrink: 0;
  }
  .code-link-chip:hover {
    opacity: 1;
    background: rgba(0,0,0,.2);
  }
  .code-link-chip.stale {
    opacity: .5;
    text-decoration: line-through;
    cursor: default;
    pointer-events: none;
    border-color: rgba(239,108,87,.4);
    color: #EF6C57;
  }
  .code-link-remove {
    opacity: 0;
    font-size: 8px;
    padding: 0 1px;
    border-radius: 2px;
    line-height: 1;
    flex-shrink: 0;
    transition: opacity .1s;
  }
  .code-link-chip:hover .code-link-remove { opacity: .55; }
  .code-link-remove:hover { opacity: 1 !important; }

  .note-links-row { display: contents; } /* flattened into row2 */
  .note-link-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 4px;
    background: rgba(0,0,0,.1);
    border: 1px solid rgba(0,0,0,.15);
    color: var(--card-text);
    cursor: pointer;
    white-space: nowrap;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: .8;
    transition: opacity .12s, background .12s;
  }
  .note-link-chip::before {
    content: '↗';
    font-size: 9px;
    opacity: .6;
    flex-shrink: 0;
  }
  .note-link-chip:hover { opacity: 1; background: rgba(0,0,0,.18); }
  .note-link-unlink {
    opacity: 0;
    font-size: 8px;
    flex-shrink: 0;
    padding: 0 1px;
    border-radius: 2px;
    line-height: 1;
    transition: opacity .1s;
  }
  .note-link-chip:hover .note-link-unlink { opacity: .55; }
  .note-link-unlink:hover { opacity: 1 !important; }

  .sort-btn.active { color: var(--vscode-button-background); opacity: 1; }

  /* ── New-note highlight flash ────────────────────────── */
  @keyframes highlight-new {
    0%   { outline: 3px solid rgba(255,255,255,.85); outline-offset: 0px; }
    100% { outline: 3px solid rgba(255,255,255,0);   outline-offset: 5px; }
  }
  .card.highlight-new { animation: highlight-new 1.2s ease-out forwards; }

  /* ── Keyboard hint in format bar ─────────────────────── */
  .nc-hint {
    margin-left: auto;
    font-size: 10px;
    color: rgba(26,26,46,.38);
    white-space: nowrap;
    pointer-events: none;
    user-select: none;
  }

</style>
</head>
<body>

<!-- ── Top bar ── -->
<div class="topbar">
  <div class="topbar-row">
    <span class="project-pill" id="project-name"><span class="pill-primary">${svgIcon(FolderGit, 13, 'flex-shrink:0')}<span class="pill-label">Loading…</span></span><span class="pill-action">${svgIcon(FolderOpen, 13, 'flex-shrink:0')}<span class="pill-label">Open recent folder</span></span></span>
    <span class="branch-pill" id="branch-pill"></span>
    <div style="flex:1"></div>
    <button class="new-note-pill" id="btn-new" title="New Note">
      ${svgIcon(Plus, 11)}
      New
    </button>
  </div>

  <div class="topbar-row">
    <div class="search-row">
      ${svgIcon(Search, 12, 'opacity:.5;flex-shrink:0')}
      <input id="search" type="text" placeholder="Search notes…" autocomplete="off">
      <button class="search-clear" id="search-clear" title="Clear search" style="display:none">${svgIcon(X, 11)}</button>
    </div>
    <button class="icon-btn branch-filter-btn" id="btn-branch-filter" title="Show current branch only" style="display:none">${svgIcon(GitBranch, 13)}</button>
    <button class="icon-btn sort-btn" id="btn-sort" title="Sort: last updated">${svgIcon(ClockArrowDown, 13)}</button>
    <button class="icon-btn overflow-btn" id="btn-overflow" title="More options">
      ${svgIcon(Ellipsis, 14)}
    </button>
  </div>
</div>

<!-- ── Note card overlay ── -->
<div class="note-card-overlay" id="note-card-overlay">
  <div class="note-card" id="note-card">
    <div class="note-card-header">
      <div class="color-strip" id="new-colors"></div>
      <button class="note-card-close" id="btn-cancel-new" title="Cancel">${svgIcon(X, 12)}</button>
    </div>
    <input class="note-card-title" id="new-title" type="text" placeholder="Note title…" maxlength="120" autocomplete="off">
    <div class="note-card-body is-empty" id="new-body" data-placeholder="Start writing…"></div>
    <div class="note-card-footer">
      <div class="note-card-fmtbar">
        <button class="fmt-btn" data-cmd="bold"       title="Bold (Ctrl+B)"><b>B</b></button>
        <button class="fmt-btn" data-cmd="italic"     title="Italic (Ctrl+I)"><i>I</i></button>
        <button class="fmt-btn" data-cmd="strike"     title="Strikethrough"><s>S</s></button>
        <div class="fmt-btn-sep"></div>
        <button class="fmt-btn" data-cmd="bulletList" title="Bullet list">&#8801;</button>
        <span class="nc-hint">Ctrl+Enter to create</span>
      </div>
      <div class="note-card-metabar">
        <label class="branch-scope-label" id="branch-scope-label">
          <input type="checkbox" id="new-branch-scope">
          <span>&#8903; <code id="branch-scope-name"></code></span>
        </label>
        <div class="new-note-tags" id="new-tags"></div>
        <select class="nc-select" id="new-template-select"></select>
        <button class="note-card-confirm" id="btn-confirm-new" title="Create note">&#10003;</button>
      </div>
    </div>
  </div>
</div>

<!-- ── Tag filter bar ── -->
<div class="tag-bar" id="tag-bar"></div>

<!-- ── GitHub status filter bar ── -->
<div class="github-filter-bar" id="github-filter-bar" style="display:none"></div>

<!-- ── Tag manager panel ── -->
<div class="tag-manager" id="tag-manager" style="display:none"></div>

<!-- ── Simulation banner (hidden unless sim mode active) ── -->
<div class="sim-banner" id="sim-banner" style="display:none">
  <span class="sim-label">⚗ Phase 7 simulation</span>
  <button class="sim-exit" id="sim-exit">× Exit</button>
</div>

<!-- ── Card list ── -->
<div class="card-list" id="card-list" role="list" aria-label="Notes"></div>

<!-- ── Card-level overflow menu ── -->
<div class="overflow-menu" id="card-ovf-menu"></div>

<!-- ── Card color picker popup ── -->
<div id="card-color-pop"></div>

<!-- ── Overflow menu (⋯ button) ── -->
<div class="overflow-menu" id="overflow-menu">
  <button class="ovf-item mine-filter-btn" id="btn-mine-filter" style="display:none">
    <span class="ovf-icon">${svgIcon(User, 14)}</span>
    <span class="ovf-label">My notes only</span>
    <span class="ovf-check">✓</span>
  </button>
  <button class="ovf-item" id="btn-archive-view">
    <span class="ovf-icon">${svgIcon(Archive, 14)}</span>
    <span class="ovf-label">Archived notes</span>
    <span class="ovf-check">✓</span>
  </button>
  <button class="ovf-item stale-filter-btn" id="btn-stale-filter">
    <span class="ovf-icon">${svgIcon(Clock, 14)}</span>
    <span class="ovf-label">Stale notes</span>
    <span class="ovf-check">✓</span>
  </button>
  <button class="ovf-item" id="btn-select">
    <span class="ovf-icon">${svgIcon(LayoutList, 14)}</span>
    <span class="ovf-label">Selection mode</span>
    <span class="ovf-check">✓</span>
  </button>
  <hr class="ovf-divider"/>
  <button class="ovf-item github-connect-btn" id="btn-github-connect">
    <span class="ovf-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.34-3.369-1.34-.454-1.154-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.202 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"/></svg></span>
    <span class="ovf-label" id="ovf-github-label">Connect GitHub</span>
    <span class="ovf-check">✓</span>
  </button>
  <button class="ovf-item" id="btn-register-mcp">
    <span class="ovf-icon">${svgIcon(Bot, 14)}</span>
    <span class="ovf-label">Register MCP</span>
  </button>
</div>

<!-- ── Export bar (selection mode) ── -->
<div class="export-bar" id="export-bar">
  <span class="export-count" id="export-count">0 notes selected</span>
  <button class="btn btn-ghost btn-sel-all" id="btn-sel-all" title="Select all visible notes">All</button>
  <button class="btn btn-ghost" id="btn-archive-sel" title="Archive selected">${svgIcon(Archive, 13)}</button>
  <button class="btn btn-ghost" id="btn-tag-sel" title="Assign tag to selected">${svgIcon(TagIcon, 13)}</button>
  <button class="btn btn-ghost" id="btn-export-sel" title="Export selected">${svgIcon(Download, 13)}</button>
  <button class="btn btn-ghost btn-danger" id="btn-delete-sel" title="Delete selected">${svgIcon(X, 13)}</button>
  <button class="btn btn-ghost" id="btn-cancel-sel">Cancel</button>
</div>

<!-- ── Add tag form ── -->
<div class="add-tag-form" id="add-tag-form">
  <input id="tag-label" type="text" placeholder="Tag name…" maxlength="24">
  <div class="color-strip" id="tag-colors"></div>
  <div class="form-actions">
    <button class="btn btn-ghost" id="btn-cancel-tag">Cancel</button>
    <button class="btn btn-primary" id="btn-confirm-tag">Add Tag</button>
  </div>
</div>

<script nonce="${nonce}" src="${sidebarEditorUri}"></script>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const COLORS  = ${colorsJson};
  const COLOR_KEYS = Object.keys(COLORS);

  let notes             = [];
  let tags              = [];
  let templates         = [];
  let defaultTagIds     = [];
  let activeTagIds      = [];
  let searchQuery       = '';
  let newColor          = COLOR_KEYS[0];
  let newTags           = [];
  let newTemplateId     = null;
  let tagColor          = '#74B9FF';
  let currentBranch      = null;
  let currentUser        = null;
  let availableBranches  = [];
  let branchFilterActive  = false;
  let mineFilterActive    = false;
  let githubConnected     = false;
  let showArchived           = false;
  let sortMode               = 'updated'; // 'updated' | 'created' | 'alpha'
  let githubStatusFilter     = null; // null | 'open' | 'closed' | 'merged'
  let staleFilterActive      = false;
  let selectMode         = false;
  let selectedIds        = [];
  let knownNoteIds       = null; // null on first load — skip highlight; Set afterwards
  let openColorPop    = null;
  let openTagPop      = null;
  let isManagingTags  = false;
  let openMgrColorPop = null;

  // ── DOM refs ────────────────────────────────────────────────────────────
  const simBanner      = document.getElementById('sim-banner');
  const simExit        = document.getElementById('sim-exit');
  const projectName    = document.getElementById('project-name');
  projectName.addEventListener('click', () => vscode.postMessage({ type: 'openFolder' }));
  const cardList       = document.getElementById('card-list');
  const tagBar         = document.getElementById('tag-bar');
  const searchEl       = document.getElementById('search');
  const searchClearEl  = document.getElementById('search-clear');
  const noteCardOverlay = document.getElementById('note-card-overlay');
  const noteCardEl      = document.getElementById('note-card');
  const newTitleEl      = document.getElementById('new-title');
  const newBodyEl       = document.getElementById('new-body');
  const newColorsEl     = document.getElementById('new-colors');
  const newTagsEl       = document.getElementById('new-tags');
  const newTemplateSelectEl = document.getElementById('new-template-select');
  const btnMineFilter     = document.getElementById('btn-mine-filter');
  const btnStaleFilter    = document.getElementById('btn-stale-filter');
  const btnSelect         = document.getElementById('btn-select');
  const exportBar         = document.getElementById('export-bar');
  const branchPillEl         = document.getElementById('branch-pill');
  const githubFilterBar      = document.getElementById('github-filter-bar');
  const btnSort              = document.getElementById('btn-sort');
  const branchFilterBtn   = document.getElementById('btn-branch-filter');
  const branchScopeLabel  = document.getElementById('branch-scope-label');
  const branchScopeNameEl = document.getElementById('branch-scope-name');
  const addTagForm     = document.getElementById('add-tag-form');
  const tagLabelEl     = document.getElementById('tag-label');
  const tagColorsEl    = document.getElementById('tag-colors');

  // ── Tiptap ──────────────────────────────────────────────────────────────
  window.SidebarEditor?.init(newBodyEl);

  // ── Overflow menu ────────────────────────────────────────────────────────
  const btnOverflow  = document.getElementById('btn-overflow');
  const overflowMenu = document.getElementById('overflow-menu');
  const ovfGithubLabel = document.getElementById('ovf-github-label');

  btnOverflow.addEventListener('click', e => {
    e.stopPropagation();
    const rect   = btnOverflow.getBoundingClientRect();
    const isOpen = overflowMenu.classList.contains('open');
    closeAllPops();
    if (!isOpen) {
      overflowMenu.style.top   = (rect.bottom + 4) + 'px';
      overflowMenu.style.right = (window.innerWidth - rect.right) + 'px';
      overflowMenu.classList.add('open');
      btnOverflow.classList.add('active');
    }
  });

  // Clicks inside the overflow propagate to document → closeAllPops closes it.
  // Clicks on each item run their handler first, then the menu closes naturally.

  // ── Branch filter toggle ─────────────────────────────────────────────────
  branchFilterBtn.addEventListener('click', () => {
    branchFilterActive = !branchFilterActive;
    branchFilterBtn.classList.toggle('active', branchFilterActive);
    branchFilterBtn.title = branchFilterActive ? 'Show all branches' : 'Show current branch only';
    vscode.postMessage({ type: 'branchFilterChanged', active: branchFilterActive });
    renderCards();
  });

  // ── Mine filter ──────────────────────────────────────────────────────────
  btnMineFilter.addEventListener('click', () => {
    mineFilterActive = !mineFilterActive;
    btnMineFilter.classList.toggle('active', mineFilterActive);
    btnMineFilter.title = mineFilterActive ? 'Show all notes' : 'Show only my notes';
    renderCards();
  });

  // ── Sort mode cycle ──────────────────────────────────────────────────────
  const SORT_MODES = [
    { key: 'updated', icon: ${jsSvg.sortUpdated}, title: 'Sort: last updated' },
    { key: 'alpha',   icon: ${jsSvg.sortAlpha},   title: 'Sort: alphabetical' },
  ];
  btnSort.addEventListener('click', () => {
    const idx = SORT_MODES.findIndex(m => m.key === sortMode);
    const next = SORT_MODES[(idx + 1) % SORT_MODES.length];
    sortMode = next.key;
    btnSort.innerHTML = next.icon;
    btnSort.title = next.title;
    btnSort.classList.toggle('active', sortMode !== 'updated');
    renderCards();
  });

  // ── Archive view toggle ──────────────────────────────────────────────────
  const btnArchiveView = document.getElementById('btn-archive-view');
  btnArchiveView.classList.add('archive-view-btn');
  btnArchiveView.addEventListener('click', () => {
    showArchived = !showArchived;
    btnArchiveView.classList.toggle('active', showArchived);
    btnArchiveView.title = showArchived ? 'Back to notes' : 'Show archived notes';
    githubStatusFilter = null;
    renderCards();
  });

  // ── Stale filter ─────────────────────────────────────────────────────────
  btnStaleFilter.addEventListener('click', () => {
    staleFilterActive = !staleFilterActive;
    btnStaleFilter.classList.toggle('active', staleFilterActive);
    btnStaleFilter.title = staleFilterActive ? 'Show all notes' : 'Show stale notes (14+ days old with overdue reminder, open todos, or broken file link)';
    if (staleFilterActive && showArchived) {
      showArchived = false;
      btnArchiveView.classList.remove('active');
      btnArchiveView.title = 'Show archived notes';
    }
    renderCards();
  });

  // ── GitHub connect ───────────────────────────────────────────────────────
  const btnGithub = document.getElementById('btn-github-connect');
  btnGithub.addEventListener('click', () => {
    vscode.postMessage({ type: 'connectGitHub' });
  });

  // ── Register MCP ─────────────────────────────────────────────────────────
  document.getElementById('btn-register-mcp').addEventListener('click', () => {
    vscode.postMessage({ type: 'registerMcp' });
  });

  // ── Selection mode ───────────────────────────────────────────────────────
  const exportCountEl  = document.getElementById('export-count');
  const btnSelAll      = document.getElementById('btn-sel-all');

  function exitSelectMode() {
    selectMode  = false;
    selectedIds = [];
    btnSelect.classList.remove('active');
    btnSelect.title = 'Select notes';
    cardList.classList.remove('select-mode');
    exportBar.classList.remove('visible');
    btnSelAll.classList.remove('all-selected');
    cardList.querySelectorAll('.card.selected').forEach(c => c.classList.remove('selected'));
  }

  function updateExportBar() {
    const n = selectedIds.length;
    exportCountEl.textContent = n + ' note' + (n !== 1 ? 's' : '') + ' selected';
    exportBar.classList.toggle('visible', n > 0);
    const visibleCount = cardList.querySelectorAll('.card[tabindex="0"]').length;
    btnSelAll.classList.toggle('all-selected', n > 0 && n === visibleCount);
    btnSelAll.title = (n > 0 && n === visibleCount) ? 'Deselect all' : 'Select all visible notes';
  }

  btnSelect.addEventListener('click', () => {
    if (selectMode) { exitSelectMode(); return; }
    selectMode = true;
    btnSelect.classList.add('active');
    btnSelect.title = 'Exit selection mode';
    cardList.classList.add('select-mode');
  });

  // Select / deselect all visible
  btnSelAll.addEventListener('click', () => {
    const allCards = [...cardList.querySelectorAll('.card[tabindex="0"]')];
    const allSelected = allCards.length > 0 && allCards.every(c => selectedIds.includes(c.dataset.id));
    if (allSelected) {
      selectedIds = [];
      allCards.forEach(c => c.classList.remove('selected'));
    } else {
      selectedIds = allCards.map(c => c.dataset.id);
      allCards.forEach(c => c.classList.add('selected'));
    }
    updateExportBar();
  });

  document.getElementById('btn-export-sel').addEventListener('click', () => {
    if (selectedIds.length === 0) return;
    vscode.postMessage({ type: 'exportNotes', noteIds: [...selectedIds] });
    exitSelectMode();
  });

  document.getElementById('btn-archive-sel').addEventListener('click', () => {
    if (selectedIds.length === 0) return;
    vscode.postMessage({ type: 'bulkArchive', noteIds: [...selectedIds] });
    exitSelectMode();
  });

  document.getElementById('btn-tag-sel').addEventListener('click', () => {
    if (selectedIds.length === 0) return;
    vscode.postMessage({ type: 'bulkTag', noteIds: [...selectedIds] });
    exitSelectMode();
  });

  document.getElementById('btn-delete-sel').addEventListener('click', () => {
    if (selectedIds.length === 0) return;
    vscode.postMessage({ type: 'bulkDelete', noteIds: [...selectedIds] });
    exitSelectMode();
  });

  document.getElementById('btn-cancel-sel').addEventListener('click', exitSelectMode);

  // ── Init ────────────────────────────────────────────────────────────────
  vscode.postMessage({ type: 'ready' });

  window.addEventListener('message', ({ data: msg }) => {
    if (msg.type === 'init') {
      const incomingIds = new Set((msg.notes ?? []).map(n => n.id));
      const addedId     = knownNoteIds !== null
        ? [...incomingIds].find(id => !knownNoteIds.has(id)) ?? null
        : null;
      knownNoteIds = incomingIds;

      notes         = msg.notes         ?? [];
      tags          = msg.tags          ?? [];
      templates     = msg.templates     ?? [];
      defaultTagIds = msg.defaultTagIds ?? [];
      currentBranch     = msg.currentBranch     ?? null;
      currentUser       = msg.currentUser       ?? null;
      availableBranches = msg.availableBranches ?? [];
      githubConnected   = msg.githubConnected   ?? false;
      if (msg.projectName) projectName.innerHTML = '<span class="pill-primary">' + ${jsSvg.folderGit} + '<span class="pill-label">' + esc(msg.projectName) + '</span></span><span class="pill-action">' + ${jsSvg.folderOpen} + '<span class="pill-label">Open recent folder</span></span>';
      // Show mine-filter button only when another user's note exists in this repo
      const hasOtherOwners = currentUser && notes.some(n => n.owner && n.owner !== currentUser);
      btnMineFilter.style.display = hasOtherOwners ? '' : 'none';
      // Show stale filter only when at least one stale note exists
      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const hasStale = notes.some(n => !n.archived && n.updatedAt <= cutoff &&
        (n.remindAt && n.remindAt < Date.now() || /- \[ \]/.test(n.content ?? '') || n.codeLinkStale));
      btnStaleFilter.style.display = hasStale ? '' : 'none';
      // Reflect GitHub connection status on the overflow item
      btnGithub.classList.toggle('connected', githubConnected);
      btnGithub.classList.toggle('active', githubConnected);
      btnGithub.title = githubConnected ? 'GitHub connected' : 'Connect to GitHub';
      if (ovfGithubLabel) ovfGithubLabel.textContent = githubConnected ? 'GitHub connected' : 'Connect GitHub';
      // Drop filter state for tags that no longer exist
      activeTagIds = activeTagIds.filter(id => tags.some(t => t.id === id));
      renderBranchIndicator();
      renderTagBar();
      if (isManagingTags) renderTagManager();
      renderCards();
      if (addedId) {
        requestAnimationFrame(() => {
          const newCard = cardList.querySelector('[data-id="' + addedId + '"]');
          if (newCard) {
            newCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            newCard.classList.add('highlight-new');
            setTimeout(() => newCard.classList.remove('highlight-new'), 1200);
          }
        });
      }
      renderNewNoteTags();
      renderCardTemplatePicker();
      buildColorStrip(newColorsEl,  c => { newColor = c; highlightSwatch(newColorsEl, c); noteCardEl.style.setProperty('--nc-bg', COLORS[c]); });
      buildColorStrip(tagColorsEl, c => { tagColor = c; highlightSwatch(tagColorsEl, c); });
      highlightSwatch(newColorsEl, newColor);
      highlightSwatch(tagColorsEl, tagColor);
    }

    if (msg.type === 'sim') {
      notes = msg.notes ?? [];
      simBanner.style.display = '';
      renderCards();
    }
  });

  simExit.addEventListener('click', () => {
    simBanner.style.display = 'none';
    vscode.postMessage({ type: 'ready' }); // triggers a full push() with real data
  });

  // ── Search ──────────────────────────────────────────────────────────────
  searchEl.addEventListener('input', () => {
    searchQuery = searchEl.value.toLowerCase();
    searchClearEl.style.display = searchQuery ? 'block' : 'none';
    renderCards();
  });
  searchClearEl.addEventListener('click', () => {
    searchQuery = '';
    searchEl.value = '';
    searchClearEl.style.display = 'none';
    searchEl.focus();
    renderCards();
  });
  searchEl.addEventListener('keydown', e => {
    if (e.key === 'Escape' && searchQuery) {
      searchQuery = '';
      searchEl.value = '';
      searchClearEl.style.display = 'none';
      renderCards();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const first = cardList.querySelector('.card[tabindex="0"]');
      if (first) first.focus();
    }
  });

  // ── New note ────────────────────────────────────────────────────────────
  document.getElementById('btn-new').addEventListener('click', () => {
    newTags = [];
    renderNewNoteTags();
    // If the branch filter is active, pre-check the scope toggle so the new
    // note defaults to the current branch — consistent with the user's focus mode.
    const scopeCheckbox = document.getElementById('new-branch-scope');
    if (scopeCheckbox) scopeCheckbox.checked = branchFilterActive && !!currentBranch;
    noteCardEl.style.setProperty('--nc-bg', COLORS[newColor]);
    noteCardOverlay.classList.add('open');
    newTitleEl.focus();
  });
  noteCardOverlay.addEventListener('click', e => {
    if (e.target === noteCardOverlay) closeNewForm();
  });
  document.getElementById('btn-cancel-new').addEventListener('click', closeNewForm);
  document.getElementById('btn-confirm-new').addEventListener('click', confirmNewNote);
  newTitleEl.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); newBodyEl.focus(); }
    if (e.key === 'Escape') closeNewForm();
  });
  newBodyEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeNewForm();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirmNewNote(); }
  });

  document.querySelectorAll('.fmt-btn[data-cmd]').forEach(btn => {
    btn.addEventListener('mousedown', e => {
      e.preventDefault(); // keep Tiptap selection intact
      window.SidebarEditor?.toggleFormat(btn.dataset.cmd);
      updateFmtBar();
    });
  });

  document.addEventListener('selectionchange', () => {
    if (newBodyEl.contains(document.getSelection()?.anchorNode)) updateFmtBar();
  });

  function updateFmtBar() {
    document.querySelectorAll('.fmt-btn[data-cmd]').forEach(btn => {
      btn.classList.toggle('active', window.SidebarEditor?.isActive(btn.dataset.cmd) ?? false);
    });
  }

  function closeNewForm() {
    noteCardOverlay.classList.remove('open');
    newTitleEl.value = '';
    window.SidebarEditor?.clear();
    newTags       = [];
    newTemplateId = null;
    newColor      = COLOR_KEYS[0];
    noteCardEl.style.setProperty('--nc-bg', COLORS[newColor]);
    const scopeCheckbox = document.getElementById('new-branch-scope');
    if (scopeCheckbox) scopeCheckbox.checked = false;
    renderCardTemplatePicker();
    highlightSwatch(newColorsEl, newColor);
    renderNewNoteTags();
  }

  function renderCardTemplatePicker() {
    if (!newTemplateSelectEl) return;
    newTemplateSelectEl.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Blank';
    newTemplateSelectEl.appendChild(blank);
    templates.forEach(tpl => {
      const opt = document.createElement('option');
      opt.value = tpl.id;
      opt.textContent = tpl.name;
      newTemplateSelectEl.appendChild(opt);
    });
    newTemplateSelectEl.value = newTemplateId ?? '';
  }

  newTemplateSelectEl.addEventListener('change', () => {
    const id = newTemplateSelectEl.value || null;
    newTemplateId = id;
    if (!id) {
      newColor = COLOR_KEYS[0];
      newTags  = [];
    } else {
      const tpl = templates.find(t => t.id === id);
      if (tpl) {
        if (tpl.color) newColor = tpl.color;
        if (tpl.tags?.length) newTags = [...tpl.tags];
      }
    }
    noteCardEl.style.setProperty('--nc-bg', COLORS[newColor]);
    highlightSwatch(newColorsEl, newColor);
    renderNewNoteTags();
  });
  function confirmNewNote() {
    const title = newTitleEl.value.trim();
    if (!title) { newTitleEl.focus(); return; }
    const scopeCheckbox = document.getElementById('new-branch-scope');
    const branch = scopeCheckbox?.checked && currentBranch ? currentBranch : undefined;
    const body = window.SidebarEditor?.getMarkdown().trim() || undefined;
    vscode.postMessage({ type: 'createNote', title, color: newColor, tags: [...newTags], templateId: newTemplateId, branch, body });
    closeNewForm();
  }

  function renderNewNoteTags() {
    newTagsEl.innerHTML = '';
    if (tags.length === 0) return;
    tags.forEach(tag => {
      const chip = mkEl('button', 'tag-chip' + (newTags.includes(tag.id) ? ' active' : ''));
      chip.type = 'button';
      chip.textContent = tag.label;
      chip.style.background = tag.color;
      chip.addEventListener('click', () => {
        newTags = newTags.includes(tag.id)
          ? newTags.filter(id => id !== tag.id)
          : [...newTags, tag.id];
        renderNewNoteTags();
      });
      newTagsEl.appendChild(chip);
    });
  }

  function renderBranchIndicator() {
    if (currentBranch) {
      branchPillEl.innerHTML = '<span class="pill-primary">' + ${jsSvg.branch} + '<span class="pill-label">' + esc(currentBranch) + '</span></span><span class="pill-action">' + ${jsSvg.branchSwitch} + '<span class="pill-label">Switch branch</span></span>';
      branchPillEl.classList.add('visible');
      branchFilterBtn.style.display = availableBranches.length > 1 ? '' : 'none';
      branchScopeLabel.classList.add('visible');
      branchScopeNameEl.textContent = currentBranch;
    } else {
      branchPillEl.classList.remove('visible');
      branchFilterBtn.style.display = 'none';
      branchScopeLabel.classList.remove('visible');
    }
    const otherBranches = availableBranches.filter(b => b !== currentBranch);
    branchPillEl.classList.toggle('can-switch', otherBranches.length > 0);
  }

  branchPillEl.addEventListener('click', () => {
    if (branchPillEl.classList.contains('can-switch')) {
      vscode.postMessage({ type: 'switchBranch' });
    }
  });

  // ── Tag bar ─────────────────────────────────────────────────────────────
  function renderTagBar() {
    tagBar.innerHTML = '';

    const all = mkEl('button', 'tag-chip all' + (activeTagIds.length === 0 ? ' active' : ''), 'All');
    all.addEventListener('click', () => { activeTagIds = []; renderTagBar(); renderCards(); });
    tagBar.appendChild(all);

    tags.forEach(tag => {
      const isDefault = defaultTagIds.includes(tag.id);

      const chip = mkEl('button', 'tag-chip' + (activeTagIds.includes(tag.id) ? ' active' : ''));
      chip.style.background = tag.color;
      chip.appendChild(mkEl('span', '', tag.label));

      if (!isDefault) {
        const delBtn = mkEl('span', 'tag-chip-delete', '✕');
        delBtn.title = 'Delete tag';
        let confirmTimer = null;
        delBtn.addEventListener('click', e => {
          e.stopPropagation();
          if (chip.classList.contains('confirming')) {
            clearTimeout(confirmTimer);
            vscode.postMessage({ type: 'deleteTag', id: tag.id });
          } else {
            chip.classList.add('confirming');
            delBtn.textContent = '✓';
            delBtn.title = 'Click to confirm deletion';
            confirmTimer = setTimeout(() => {
              chip.classList.remove('confirming');
              delBtn.textContent = '✕';
              delBtn.title = 'Delete tag';
            }, 3000);
          }
        });
        chip.appendChild(delBtn);
      }

      chip.addEventListener('click', () => {
        activeTagIds = activeTagIds.includes(tag.id)
          ? activeTagIds.filter(id => id !== tag.id)
          : [...activeTagIds, tag.id];
        renderTagBar();
        renderCards();
      });
      tagBar.appendChild(chip);
    });

    const addBtn = mkEl('button', 'add-tag-btn', '+ tag');
    addBtn.addEventListener('click', () => {
      addTagForm.classList.add('open');
      tagLabelEl.focus();
    });
    tagBar.appendChild(addBtn);

    const mgrBtn = mkEl('button', 'manage-tags-btn' + (isManagingTags ? ' active' : ''), '⚙');
    mgrBtn.title = isManagingTags ? 'Close tag manager' : 'Manage tags (rename, recolor)';
    mgrBtn.addEventListener('click', () => {
      isManagingTags = !isManagingTags;
      const mgr = document.getElementById('tag-manager');
      mgr.style.display = isManagingTags ? '' : 'none';
      if (isManagingTags) renderTagManager();
      renderTagBar();
    });
    tagBar.appendChild(mgrBtn);
  }

  // ── Tag manager ─────────────────────────────────────────────────────────
  function renderTagManager() {
    const mgr = document.getElementById('tag-manager');
    mgr.innerHTML = '';

    const customTags  = tags.filter(t => !defaultTagIds.includes(t.id));
    const builtinTags = tags.filter(t =>  defaultTagIds.includes(t.id));

    if (customTags.length > 0) {
      mgr.appendChild(mkEl('div', 'tag-mgr-section', 'Custom tags'));
      customTags.forEach(tag => {
        const row = mkEl('div', 'tag-mgr-row');
        const noteCount = notes.filter(n => n.tags.includes(tag.id)).length;

        const swatch = mkEl('div', 'tag-mgr-swatch');
        swatch.style.background = tag.color;
        swatch.title = 'Change color';

        const colorPop = mkEl('div', 'tag-mgr-color-pop');
        COLOR_KEYS.forEach(key => {
          const sw = mkEl('div', 'color-swatch' + (COLORS[key] === tag.color ? ' selected' : ''));
          sw.style.background = COLORS[key];
          sw.title = key;
          sw.addEventListener('click', e => {
            e.stopPropagation();
            colorPop.classList.remove('open');
            openMgrColorPop = null;
            vscode.postMessage({ type: 'updateTag', id: tag.id, changes: { color: COLORS[key] } });
          });
          colorPop.appendChild(sw);
        });

        swatch.addEventListener('click', e => {
          e.stopPropagation();
          const wasOpen = colorPop.classList.contains('open');
          document.querySelectorAll('.tag-mgr-color-pop.open').forEach(p => p.classList.remove('open'));
          openMgrColorPop = null;
          if (!wasOpen) { colorPop.classList.add('open'); openMgrColorPop = tag.id; }
        });

        const input = mkEl('input', 'tag-mgr-input');
        input.type = 'text';
        input.value = tag.label;
        input.maxLength = 24;
        input.title = 'Rename tag — press Enter to save';
        let pendingLabel = tag.label;
        input.addEventListener('input', e => { pendingLabel = e.target.value; });
        input.addEventListener('blur', () => {
          const newLabel = pendingLabel.trim();
          if (newLabel && newLabel !== tag.label) {
            vscode.postMessage({ type: 'updateTag', id: tag.id, changes: { label: newLabel } });
          }
        });
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
          if (e.key === 'Escape') { input.value = tag.label; pendingLabel = tag.label; input.blur(); }
        });

        const countEl = mkEl('span', 'tag-mgr-count', noteCount > 0 ? String(noteCount) : '');
        countEl.title = noteCount === 1 ? '1 note' : (noteCount + ' notes');

        const delBtn = mkEl('button', 'tag-mgr-del', '✕');
        delBtn.title = 'Delete tag';
        delBtn.addEventListener('click', () => {
          row.innerHTML = '';
          const confirmRow = mkEl('div', 'tag-mgr-confirm');
          const suffix = noteCount !== 1 ? 's' : '';
          const msgText = noteCount > 0
            ? 'Delete "' + tag.label + '"? Removes it from ' + noteCount + ' note' + suffix + '.'
            : 'Delete "' + tag.label + '"?';
          const msg = mkEl('span', 'tag-mgr-confirm-msg', msgText);
          const yes = mkEl('button', 'tag-mgr-confirm-yes', 'Delete');
          const no  = mkEl('button', 'tag-mgr-confirm-no', 'Cancel');
          yes.addEventListener('click', () => vscode.postMessage({ type: 'deleteTag', id: tag.id }));
          no.addEventListener('click', () => renderTagManager());
          confirmRow.append(msg, yes, no);
          row.appendChild(confirmRow);
        });

        row.append(swatch, colorPop, input, countEl, delBtn);
        mgr.appendChild(row);
      });
    }

    if (builtinTags.length > 0) {
      mgr.appendChild(mkEl('div', 'tag-mgr-section', 'Built-in tags'));
      builtinTags.forEach(tag => {
        const noteCount = notes.filter(n => n.tags.includes(tag.id)).length;
        const row  = mkEl('div', 'tag-mgr-row');
        const dot  = mkEl('div', 'tag-mgr-swatch tag-mgr-swatch-ro');
        dot.style.background = tag.color;
        const lbl  = mkEl('span', 'tag-mgr-ro-label', tag.label);
        const countEl = mkEl('span', 'tag-mgr-count', noteCount > 0 ? String(noteCount) : '');
        countEl.title = noteCount === 1 ? '1 note' : (noteCount + ' notes');
        const hint = mkEl('span', 'tag-mgr-ro-hint', 'built-in');
        row.append(dot, lbl, countEl, hint);
        mgr.appendChild(row);
      });
    }

    if (customTags.length === 0 && builtinTags.length === 0) {
      mgr.appendChild(mkEl('div', 'tag-mgr-empty', 'No tags yet — click "+ tag" to create one.'));
    }
  }

  // ── Add tag ─────────────────────────────────────────────────────────────
  document.getElementById('btn-cancel-tag').addEventListener('click', closeTagForm);
  document.getElementById('btn-confirm-tag').addEventListener('click', confirmTag);
  tagLabelEl.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); confirmTag(); }
    if (e.key === 'Escape') closeTagForm();
  });

  function closeTagForm() { addTagForm.classList.remove('open'); tagLabelEl.value = ''; }
  function confirmTag() {
    const label = tagLabelEl.value.trim();
    if (!label) { tagLabelEl.focus(); return; }
    vscode.postMessage({ type: 'addTag', label, color: tagColor });
    closeTagForm();
  }

  // ── Cards ────────────────────────────────────────────────────────────────
  function visibleNotes() {
    return notes.filter(n => {
      if (showArchived ? !n.archived : n.archived) return false;
      if (mineFilterActive && currentUser && n.owner && n.owner !== currentUser) return false;
      if (branchFilterActive && currentBranch && n.branch && n.branch !== currentBranch) return false;
      if (githubStatusFilter) {
        if (!n.github || n.github.status !== githubStatusFilter) return false;
      }
      if (searchQuery) {
        const tagText = n.tags.map(tid => { const t = tags.find(t => t.id === tid); return t ? t.label : ''; }).join(' ').toLowerCase();
        if (!n.title.toLowerCase().includes(searchQuery) &&
            !n.content.toLowerCase().includes(searchQuery) &&
            !tagText.includes(searchQuery)) return false;
      }
      if (activeTagIds.length > 0 && !activeTagIds.some(id => n.tags.includes(id))) return false;
      if (staleFilterActive) {
        const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
        if (n.updatedAt > cutoff) return false;
        const hasOverdueReminder = n.remindAt && n.remindAt < Date.now();
        const hasOpenTodos       = /- \[ \]/.test(n.content ?? '');
        const hasBrokenLink      = n.codeLinkStale;
        if (!hasOverdueReminder && !hasOpenTodos && !hasBrokenLink) return false;
      }
      return true;
    });
  }

  function renderGitHubFilterBar() {
    const linkedNotes = notes.filter(n => !n.archived && n.github);
    githubFilterBar.style.display = linkedNotes.length > 0 ? '' : 'none';
    if (linkedNotes.length === 0) return;

    githubFilterBar.innerHTML = '';
    const label = mkEl('span', 'gh-filter-label', 'GitHub:');
    githubFilterBar.appendChild(label);

    const statuses = [
      { key: null,     text: 'All' },
      { key: 'open',   text: 'Open',   cls: 'open-chip'   },
      { key: 'closed', text: 'Closed', cls: 'closed-chip' },
      { key: 'merged', text: 'Merged', cls: 'merged-chip' },
    ];

    statuses.forEach(({ key, text, cls }) => {
      // Only show status chips that have at least one matching note
      if (key !== null && !linkedNotes.some(n => n.github.status === key)) return;

      const chip = mkEl('button', 'gh-chip' + (cls ? ' ' + cls : '') + (githubStatusFilter === key ? ' active' : ''));
      if (cls) {
        const dot = mkEl('span', 'gh-dot');
        chip.appendChild(dot);
      }
      chip.appendChild(mkEl('span', '', text));
      chip.addEventListener('click', () => {
        githubStatusFilter = key;
        renderGitHubFilterBar();
        renderCards();
      });
      githubFilterBar.appendChild(chip);
    });
  }

  function renderCards() {
    renderGitHubFilterBar();
    cardList.innerHTML = '';
    const visible = visibleNotes();
    if (visible.length === 0) {
      const empty = mkEl('div', 'empty');
      if (showArchived) {
        empty.innerHTML = '<div class="empty-icon">📦</div><p>No archived notes.</p>';
      } else if (staleFilterActive) {
        empty.innerHTML = '<div class="empty-icon">✅</div><p>No stale notes.<br>Everything looks up to date.</p>';
      } else if (notes.length === 0) {
        empty.innerHTML = '<div class="empty-icon">📋</div><p>No notes yet.<br>Click <strong>+</strong> to create one.</p>';
      } else {
        empty.innerHTML = '<div class="empty-icon">🔍</div><p>No notes match<br><strong>' + esc(searchQuery || 'the selected filter') + '</strong>.</p>';
      }
      cardList.appendChild(empty);
      return;
    }
    [...visible]
      .sort((a, b) => {
        const starDiff = (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
        if (starDiff !== 0) return starDiff;
        if (sortMode === 'alpha') return a.title.localeCompare(b.title);
        return b.updatedAt - a.updatedAt;
      })
      .forEach(note => cardList.appendChild(buildCard(note)));
  }

  function buildCard(note) {
    const bg          = COLORS[note.color] || COLORS.yellow;
    const isOffBranch = currentBranch && note.branch && note.branch !== currentBranch;
    const card = mkEl('div', 'card'
      + (note.shared     ? ' is-shared'   : '')
      + (isOffBranch     ? ' off-branch'  : '')
      + (note.conflicted ? ' conflict'    : '')
      + (note.archived   ? ' is-archived' : '')
    );
    card.dataset.id = note.id;
    card.style.setProperty('--card-accent', bg);
    card.setAttribute('role', 'listitem');
    card.setAttribute('aria-label', note.title
      + (note.conflicted ? ' — conflict' : '')
      + (note.archived   ? ' — archived' : '')
    );

    // ── Select checkbox (visible only in selection mode) ──
    const checkEl = mkEl('div', 'card-check');
    card.appendChild(checkEl);

    card.addEventListener('click', e => {
      if (!selectMode) return;
      if (e.target.closest('button, input, textarea')) return;
      const idx = selectedIds.indexOf(note.id);
      if (idx === -1) { selectedIds.push(note.id); card.classList.add('selected'); }
      else            { selectedIds.splice(idx, 1); card.classList.remove('selected'); }
      updateExportBar();
    });

    // ── Row 1: Title + Star ──
    const row1 = mkEl('div', 'card-row-1');

    const title = mkEl('input', 'card-title');
    title.type  = 'text';
    title.value = note.title;
    title.setAttribute('aria-label', 'Note title');
    title.addEventListener('blur', () => {
      if (title.value.trim() !== note.title) {
        vscode.postMessage({ type: 'updateNote', id: note.id, changes: { title: title.value.trim() || note.title } });
      }
    });
    title.addEventListener('keydown', e => { if (e.key === 'Enter') title.blur(); });

    const overflowBtn = mkEl('button', 'card-overflow-btn');
    overflowBtn.innerHTML = ${jsSvg.overflow};
    overflowBtn.title = 'More actions';
    overflowBtn.setAttribute('aria-label', 'More actions');
    overflowBtn.setAttribute('aria-expanded', 'false');
    overflowBtn.setAttribute('aria-haspopup', 'menu');
    overflowBtn.addEventListener('click', e => {
      e.stopPropagation();
      openCardMenu(note, overflowBtn);
    });

    const cardColorBtn = mkEl('button', 'card-color-btn');
    cardColorBtn.innerHTML = ${jsSvg.colorPicker};
    cardColorBtn.title = 'Change color';
    cardColorBtn.setAttribute('aria-label', 'Change note color');
    cardColorBtn.setAttribute('aria-expanded', 'false');
    cardColorBtn.setAttribute('aria-haspopup', 'listbox');
    cardColorBtn.addEventListener('click', e => {
      e.stopPropagation();
      openCardColorPop(note, cardColorBtn);
    });

    const starBtn = mkEl('button', 'star-btn' + (note.starred ? ' on' : ''));
    starBtn.innerHTML = ${jsSvg.star};
    starBtn.title = note.starred ? 'Unstar' : 'Star';
    starBtn.setAttribute('aria-pressed', note.starred ? 'true' : 'false');
    starBtn.setAttribute('aria-label', note.starred ? 'Unstar note' : 'Star note');
    starBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'updateNote', id: note.id, changes: { starred: !note.starred } });
    });

    row1.append(title, overflowBtn, cardColorBtn, starBtn);
    card.append(row1);

    // ── Row 2: Metadata chips ──
    const row2 = mkEl('div', 'card-row-2');

    note.tags.forEach(tid => {
      const tag = tags.find(t => t.id === tid);
      if (!tag) return;
      const pill = mkEl('span', 'tag-pill', tag.label);
      pill.style.background = tag.color;
      pill.title = 'Filter by ' + tag.label;
      pill.addEventListener('click', () => {
        if (!activeTagIds.includes(tid)) {
          activeTagIds = [...activeTagIds, tid];
          renderTagBar();
          renderCards();
        }
      });
      row2.appendChild(pill);
    });

    if (note.linkedNoteIds && note.linkedNoteIds.length > 0) {
      note.linkedNoteIds.forEach(targetId => {
        const target = notes.find(n => n.id === targetId);
        if (!target) return;
        const chip = mkEl('button', 'note-link-chip');
        const label = mkEl('span', '', target.title);
        const unlinkBtn = mkEl('span', 'note-link-unlink');
        unlinkBtn.innerHTML = ${jsSvg.unlinkSmall};
        unlinkBtn.title = 'Remove link';
        chip.title = target.title;
        chip.append(label, unlinkBtn);
        chip.addEventListener('click', e => {
          if (e.target === unlinkBtn || unlinkBtn.contains(e.target)) {
            e.stopPropagation();
            vscode.postMessage({ type: 'unlinkNote', noteId: note.id, targetId });
          } else {
            vscode.postMessage({ type: 'openLinkedNote', noteId: targetId });
          }
        });
        row2.appendChild(chip);
      });
    }

    if (note.conflicted) {
      const badge = mkEl('button', 'conflict-badge', '⚠ Conflict — click to resolve');
      badge.setAttribute('aria-label', 'Merge conflict — click to open conflict resolution');
      badge.addEventListener('click', e => {
        e.stopPropagation();
        vscode.postMessage({ type: 'openConflict', noteId: note.id });
      });
      row2.appendChild(badge);
    }

    if (note.archived) {
      const ab = mkEl('span', 'archived-badge', '📦 Archived');
      ab.setAttribute('aria-label', 'This note is archived');
      row2.appendChild(ab);
    }

    if (note.remindAt) {
      const isOverdue = note.remindAt <= Date.now();
      const badge = mkEl('span', 'reminder-badge' + (isOverdue ? ' overdue' : ''));
      badge.textContent = '🔔 ' + formatReminder(note.remindAt);
      badge.title = isOverdue ? 'Overdue — click 🔔 to reschedule' : new Date(note.remindAt).toLocaleString();
      row2.appendChild(badge);
    }

    if (note.github) {
      const gh     = note.github;
      const status = gh.status ?? 'open';
      const badge  = mkEl('button', \`github-badge gh-\${status}\`);
      const dot    = mkEl('span', 'github-badge-dot');
      const typeLabel = gh.type === 'pr' ? 'PR' : '#';
      const label  = mkEl('span', '', \`\${typeLabel}\${gh.number} \${status}\`);
      badge.title  = gh.title ? gh.title : gh.url;
      badge.append(dot, label);
      badge.addEventListener('click', e => {
        e.stopPropagation();
        vscode.postMessage({ type: 'openGitHubLink', url: gh.url });
      });
      row2.appendChild(badge);
    }

    if (note.codeLink) {
      const chip = mkEl('button', 'code-link-chip' + (note.codeLinkStale ? ' stale' : ''));
      const shortName = note.codeLink.file.split('/').pop() || note.codeLink.file;
      const staleTitle = note.codeLink.file + ':' + note.codeLink.line + ' — file not found';
      chip.title = note.codeLinkStale
        ? staleTitle
        : note.codeLink.file + ':' + note.codeLink.line + ' — click to jump';
      chip.setAttribute('aria-label', note.codeLinkStale
        ? 'Broken link: ' + staleTitle
        : 'Jump to ' + note.codeLink.file + ' line ' + note.codeLink.line
      );
      const chipLabel = mkEl('span', '', (note.codeLinkStale ? '⚠ ' : '') + shortName + ':' + note.codeLink.line);
      chip.appendChild(chipLabel);
      if (!note.codeLinkStale) {
        chip.addEventListener('click', e => {
          e.stopPropagation();
          vscode.postMessage({ type: 'jumpToLink', file: note.codeLink.file, line: note.codeLink.line });
        });
        const removeBtn = mkEl('span', 'code-link-remove');
        removeBtn.innerHTML = ${jsSvg.unlinkSmall};
        removeBtn.title = 'Remove code link';
        removeBtn.addEventListener('click', e => {
          e.stopPropagation();
          vscode.postMessage({ type: 'removeCodeLink', noteId: note.id });
        });
        chip.appendChild(removeBtn);
      }
      row2.appendChild(chip);
    }

    const hasChips = note.tags.length > 0
      || (note.linkedNoteIds && note.linkedNoteIds.length > 0)
      || note.codeLink || note.github || note.remindAt || note.conflicted || note.archived;
    if (!hasChips) {
      const ghost = mkEl('button', 'tag-ghost', '+ tag');
      ghost.title = 'Assign tags via the overflow menu';
      row2.appendChild(ghost);
    }

    card.appendChild(row2);

    // ── Row 3: Content ──
    const row3 = mkEl('div', 'card-row-3');
    const contentWrap = mkEl('div', 'card-content');

    const preview  = mkEl('div', 'card-preview clamped');
    preview.innerHTML = searchQuery ? matchSnippet(note.content, searchQuery) : simpleMarkdown(note.content);

    const showMore = mkEl('div', 'show-more', '▾ more');
    const isLong   = note.content.split('\\n').length > 3 || note.content.length > 180;
    if (isLong) showMore.style.display = 'block';

    let expanded = false;
    showMore.addEventListener('click', () => {
      expanded = !expanded;
      preview.classList.toggle('clamped', !expanded);
      showMore.textContent = expanded ? '▴ less' : '▾ more';
    });

    // Intercept checkbox mousedown to prevent focus-steal (which triggers blur = "done" effect)
    preview.addEventListener('mousedown', e => {
      if (e.target.type !== 'checkbox') return;
      e.preventDefault(); // block focus change in both view and edit mode
      const newChecked = !e.target.checked;
      e.target.checked = newChecked;
      // Sync the HTML attribute so preview.innerHTML reflects the new state
      if (newChecked) e.target.setAttribute('checked', '');
      else            e.target.removeAttribute('checked');
      const li = e.target.closest('.task-item');
      if (li) li.classList.toggle('done', e.target.checked);
      if (preview.contentEditable !== 'true') {
        const newContent = htmlToMarkdown(preview.innerHTML);
        if (newContent !== note.content) {
          note.content = newContent;
          vscode.postMessage({ type: 'updateNote', id: note.id, changes: { content: newContent } });
        }
      }
    });

    preview.addEventListener('click', e => {
      if (e.target.type === 'checkbox') { e.preventDefault(); return; } // prevent browser re-toggle; handled by mousedown
      if (preview.contentEditable === 'true') return;
      const { clientX: x, clientY: y } = e;
      preview.classList.remove('clamped');
      showMore.style.display = 'none';
      preview.contentEditable = 'true';
      requestAnimationFrame(() => {
        preview.focus();
        if (document.caretPositionFromPoint) {
          const pos = document.caretPositionFromPoint(x, y);
          if (pos) window.getSelection().collapse(pos.offsetNode, pos.offset);
        } else if (document.caretRangeFromPoint) {
          const range = document.caretRangeFromPoint(x, y);
          if (range) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); }
        }
      });
    });

    preview.addEventListener('blur', () => {
      preview.contentEditable = 'false';
      fmtBar.style.display = 'none';
      footer.style.display = '';
      const newContent = htmlToMarkdown(preview.innerHTML);
      if (newContent !== note.content) {
        note.content = newContent;
        vscode.postMessage({ type: 'updateNote', id: note.id, changes: { content: newContent } });
      }
      preview.innerHTML = simpleMarkdown(note.content);
      if (!expanded) preview.classList.add('clamped');
      const stillLong = note.content.split('\\n').length > 3 || note.content.length > 180;
      showMore.style.display = (stillLong && !expanded) ? 'block' : 'none';
    });

    preview.addEventListener('keydown', e => {
      if (e.key === 'Escape') preview.blur();
    });

    contentWrap.append(preview, showMore);
    row3.appendChild(contentWrap);
    card.appendChild(row3);

    // ── Row 4: Footer ──
    const footer = mkEl('div', 'card-row-4');

    // ── Left slot: owner ↔ branch ──
    const leftSlot = mkEl('span', 'card-foot-slot card-foot-slot-left');
    const INVALID_OWNERS = ['undefined', 'null', 'unknown', ''];
    const hasOwner = note.owner && typeof note.owner === 'string'
      && !INVALID_OWNERS.includes(note.owner.trim());

    const buildOwnerEl = cls => {
      const owner   = note.owner.trim();
      const el      = mkEl('span', 'owner-badge ' + cls);
      el.title      = owner;
      const circle  = mkEl('span', 'owner-initials', initials(owner));
      const nameEl  = mkEl('span', 'owner-name', owner.split(/\s+/)[0] || owner);
      el.append(circle, nameEl);
      return el;
    };

    if (hasOwner && note.branch) {
      // Both present — hover to reveal branch, no auto-rotation
      leftSlot.appendChild(buildOwnerEl('card-foot-primary'));
      const branchEl = mkEl('span', 'branch-badge card-foot-secondary', '⎇ ' + note.branch);
      leftSlot.appendChild(branchEl);
      leftSlot.addEventListener('mouseenter', () => leftSlot.classList.add('card-foot-flipped'));
      leftSlot.addEventListener('mouseleave', () => leftSlot.classList.remove('card-foot-flipped'));
    } else if (hasOwner) {
      leftSlot.appendChild(buildOwnerEl(''));
    } else if (note.branch) {
      leftSlot.appendChild(mkEl('span', 'branch-badge', '⎇ ' + note.branch));
    }
    footer.appendChild(leftSlot);

    // ── Right slot ──
    // Reminder is shown by default when overdue or due within 24 h;
    // otherwise date is default and reminder peeks on hover.
    const rightSlot = mkEl('span', 'card-foot-slot card-foot-slot-right');
    const wasEdited = note.updatedAt - note.createdAt > 5000;
    const dateLabel = formatDate(wasEdited ? note.updatedAt : note.createdAt);
    const dateTitle = wasEdited
      ? 'Updated ' + new Date(note.updatedAt).toLocaleString()
      : 'Created '  + new Date(note.createdAt).toLocaleString();

    if (note.remindAt) {
      const isOverdue  = note.remindAt <= Date.now();
      const isImminent = note.remindAt - Date.now() <= 86400000; // within 24 h
      const reminderUrgent = isOverdue || isImminent;

      const reminderEl = mkEl('span', 'card-reminder' + (isOverdue ? ' overdue' : ''));
      reminderEl.textContent = '🔔 ' + formatReminder(note.remindAt);
      reminderEl.title = isOverdue
        ? 'Overdue — open overflow menu to reschedule'
        : new Date(note.remindAt).toLocaleString();

      const dateEl = mkEl('span', 'card-date');
      dateEl.textContent = dateLabel;
      dateEl.title = dateTitle;

      if (reminderUrgent) {
        // Reminder is primary; date peeks on hover
        reminderEl.classList.add('card-foot-primary');
        dateEl.classList.add('card-foot-secondary');
      } else {
        // Date is primary; reminder peeks on hover
        dateEl.classList.add('card-foot-primary');
        reminderEl.classList.add('card-foot-secondary');
      }
      rightSlot.append(reminderEl, dateEl);
      rightSlot.addEventListener('mouseenter', () => rightSlot.classList.add('card-foot-flipped'));
      rightSlot.addEventListener('mouseleave', () => rightSlot.classList.remove('card-foot-flipped'));
    } else {
      const dateEl = mkEl('span', 'card-date');
      dateEl.textContent = dateLabel;
      dateEl.title = dateTitle;
      rightSlot.appendChild(dateEl);
    }
    footer.appendChild(rightSlot);
    card.appendChild(footer);

    // ── Format bar (swaps with footer while editing) ──
    const fmtBar = mkEl('div', 'card-fmtbar');

    const addFmt = (label, title, cmd, arg) => {
      const btn = mkEl('button', 'card-fmt-btn');
      btn.innerHTML = label;
      btn.title = title;
      btn.addEventListener('mousedown', e => { e.preventDefault(); document.execCommand(cmd, false, arg || null); });
      fmtBar.appendChild(btn);
    };
    const addCustom = (label, title, fn) => {
      const btn = mkEl('button', 'card-fmt-btn');
      btn.innerHTML = label;
      btn.title = title;
      btn.addEventListener('mousedown', e => { e.preventDefault(); fn(); });
      fmtBar.appendChild(btn);
    };
    const addSepBar = () => fmtBar.appendChild(mkEl('span', 'card-fmt-sep-bar'));

    // Inline formatting
    addFmt('<b>B</b>',  'Bold',          'bold');
    addFmt('<i>I</i>',  'Italic',        'italic');
    addFmt('<u>U</u>',  'Underline',     'underline');
    addFmt('<s>S</s>',  'Strikethrough', 'strikeThrough');
    addSepBar();
    // Block formatting
    addCustom('H',   'Heading (toggle H2)',  () => {
      const cur = document.queryCommandValue('formatBlock');
      document.execCommand('formatBlock', false, cur === 'h2' ? 'p' : 'h2');
    });
    addFmt('≡',   'Bullet list',    'insertUnorderedList');
    addFmt('1.',  'Numbered list',  'insertOrderedList');
    addCustom('☑', 'Checklist item', () =>
      document.execCommand('insertHTML', false,
        '<ul class="task-list"><li class="task-item"><input type="checkbox" class="task-check"> <span>​</span></li></ul>'));
    addFmt('&lt;/&gt;', 'Code block', 'formatBlock', 'pre');
    addSepBar();
    // Indent / outdent / clear
    addFmt('→',  'Indent',  'indent');
    addFmt('←',  'Outdent', 'outdent');
    addCustom('✕', 'Clear formatting', () => document.execCommand('removeFormat', false, null));

    const fmtDone = mkEl('button', 'card-fmt-done', '✓');
    fmtDone.title = 'Done editing';
    fmtDone.addEventListener('mousedown', e => { e.preventDefault(); preview.blur(); });
    fmtBar.append(mkEl('span', 'card-fmt-sep'), fmtDone);
    card.appendChild(fmtBar);

    preview.addEventListener('focus', () => {
      footer.style.display = 'none';
      fmtBar.style.display = 'flex';
    });

    // ── Keyboard shortcuts ──
    card.tabIndex = 0;
    card.addEventListener('keydown', e => {
      if (e.target !== card) return; // let child inputs handle their own keys
      switch (e.key) {
        case 'Enter':
          e.preventDefault();
          vscode.postMessage({ type: 'openEditor', noteId: note.id });
          break;
        case 's': case 'S':
          e.preventDefault();
          vscode.postMessage({ type: 'updateNote', id: note.id, changes: { starred: !note.starred } });
          break;
        case 'a': case 'A':
          e.preventDefault();
          vscode.postMessage({ type: note.archived ? 'unarchiveNote' : 'archiveNote', id: note.id });
          break;
        case 'r': case 'R':
          e.preventDefault();
          title.focus();
          title.select();
          break;
        case 'Delete':
          e.preventDefault();
          vscode.postMessage({ type: 'deleteNote', id: note.id });
          break;
        case 'ArrowDown': {
          e.preventDefault();
          const cards = [...cardList.querySelectorAll('.card[tabindex="0"]')];
          const idx = cards.indexOf(card);
          if (idx < cards.length - 1) cards[idx + 1].focus();
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          const cards = [...cardList.querySelectorAll('.card[tabindex="0"]')];
          const idx = cards.indexOf(card);
          if (idx > 0) cards[idx - 1].focus();
          else searchEl.focus();
          break;
        }
        case 'Escape':
          card.blur();
          break;
      }
    });

    return card;
  }

  // ── Card-level overflow menu ────────────────────────────────────────────
  const cardOvfMenu = document.getElementById('card-ovf-menu');
  let cardOvfTarget = null; // note currently shown in the menu

  function openCardMenu(note, btn) {
    const isOpen = cardOvfMenu.classList.contains('open') && cardOvfTarget?.id === note.id;
    closeAllPops();
    if (isOpen) return; // toggle off

    // ── Position ──
    const rect = btn.getBoundingClientRect();
    cardOvfMenu.style.top   = (rect.bottom + 4) + 'px';
    cardOvfMenu.style.right = (window.innerWidth - rect.right) + 'px';
    cardOvfMenu.style.left  = 'auto';

    // ── Populate ──
    cardOvfMenu.innerHTML = '';
    cardOvfTarget = note;

    function item(icon, label, cls, handler) {
      const btn = mkEl('button', 'ovf-item' + (cls ? ' ' + cls : ''));
      btn.innerHTML = \`<span class="ovf-icon">\${icon}</span><span class="ovf-label">\${label}</span>\`;
      btn.addEventListener('click', e => { e.stopPropagation(); handler(btn); });
      cardOvfMenu.appendChild(btn);
      return btn;
    }
    function divider() { cardOvfMenu.appendChild(mkEl('hr', 'ovf-divider')); }

    const SVG = {
      edit:    ${jsSvg.edit},
      remind:  ${jsSvg.remind},
      dup:     ${jsSvg.dup},
      link:    ${jsSvg.link},
      unlink:  ${jsSvg.unlink},
      archive: ${jsSvg.archive},
      share:   ${jsSvg.share},
      export:  ${jsSvg.export},
      trash:   ${jsSvg.trash},
    };

    // ── Group 1: Actions ──
    item(SVG.edit,   'Edit in editor', '',
      () => { vscode.postMessage({ type: 'openEditor', noteId: note.id }); closeAllPops(); });

    item(SVG.remind, note.remindAt ? 'Change reminder' : 'Set reminder', '',
      () => { vscode.postMessage({ type: 'setReminder', noteId: note.id }); closeAllPops(); });

    item(SVG.dup, 'Duplicate', '',
      () => { vscode.postMessage({ type: 'duplicateNote', noteId: note.id }); closeAllPops(); });

    if (note.codeLink) {
      item(SVG.unlink, 'Remove file link', '',
        () => { vscode.postMessage({ type: 'removeCodeLink', noteId: note.id }); closeAllPops(); });
    } else {
      item(SVG.link, 'Link to current file', '',
        () => { vscode.postMessage({ type: 'linkToEditor', noteId: note.id }); closeAllPops(); });
    }

    divider();

    // ── Group 2: Visibility ──
    item(SVG.archive, note.archived ? 'Unarchive' : 'Archive', '',
      () => { vscode.postMessage({ type: note.archived ? 'unarchiveNote' : 'archiveNote', id: note.id }); closeAllPops(); });

    item(SVG.share, note.shared ? 'Unshare' : 'Share', '',
      () => { vscode.postMessage({ type: 'updateNote', id: note.id, changes: { shared: !note.shared } }); closeAllPops(); });

    divider();

    // ── Group 4: Danger ──
    item(SVG.export, 'Export', '',
      () => { vscode.postMessage({ type: 'exportNotes', noteIds: [note.id] }); closeAllPops(); });

    item(SVG.trash, 'Delete', 'danger', deleteBtn => {
      if (!deleteBtn.classList.contains('confirm')) {
        deleteBtn.classList.add('confirm');
        deleteBtn.querySelector('.ovf-label').textContent = 'Confirm delete?';
      } else {
        vscode.postMessage({ type: 'deleteNote', id: note.id });
        closeAllPops();
      }
    });

    cardOvfMenu.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
  }

  // ── Card color picker ───────────────────────────────────────────────────
  const cardColorPop = document.getElementById('card-color-pop');
  let cardColorTarget = null;

  function openCardColorPop(note, btn) {
    const isOpen = cardColorPop.classList.contains('open') && cardColorTarget?.id === note.id;
    closeAllPops();
    if (isOpen) return;

    const rect = btn.getBoundingClientRect();
    cardColorPop.style.top   = (rect.bottom + 4) + 'px';
    cardColorPop.style.left  = Math.max(4, rect.left - 4) + 'px';

    cardColorPop.innerHTML = '';
    cardColorTarget = note;

    Object.entries(COLORS).forEach(([key, hex]) => {
      const sw = mkEl('button', 'color-swatch' + (note.color === key ? ' selected' : ''));
      sw.style.background = hex;
      sw.title = key.charAt(0).toUpperCase() + key.slice(1);
      sw.addEventListener('click', e => {
        e.stopPropagation();
        vscode.postMessage({ type: 'updateNote', id: note.id, changes: { color: key } });
        closeAllPops();
      });
      cardColorPop.appendChild(sw);
    });

    cardColorPop.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
  }

  // ── Close all popover on outside click ─────────────────────────────────
  document.addEventListener('click', () => {
    closeAllPops();
  });

  function closeAllPops() {
    document.querySelectorAll('.color-pop.open, .tag-pop.open, .tag-mgr-color-pop.open').forEach(el => el.classList.remove('open'));
    openColorPop    = null;
    openTagPop      = null;
    openMgrColorPop = null;
    overflowMenu.classList.remove('open');
    btnOverflow.classList.remove('active');
    // Reset aria-expanded on any card overflow/color opener
    document.querySelectorAll('[aria-expanded="true"]').forEach(el => el.setAttribute('aria-expanded', 'false'));
    cardOvfMenu.classList.remove('open');
    cardOvfTarget = null;
    cardColorPop.classList.remove('open');
    cardColorTarget = null;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function matchSnippet(content, query) {
    if (!content) return '';
    const lower = content.toLowerCase();
    const idx   = lower.indexOf(query);
    if (idx === -1) return simpleMarkdown(content);
    const start  = Math.max(0, idx - 40);
    const end    = Math.min(content.length, idx + query.length + 80);
    const text   = (start > 0 ? '\\u2026' : '') + content.slice(start, end) + (end < content.length ? '\\u2026' : '');
    const li     = text.toLowerCase().indexOf(query);
    return '<p>' + esc(text.slice(0, li)) + '<mark class="match-highlight">' + esc(text.slice(li, li + query.length)) + '</mark>' + esc(text.slice(li + query.length)) + '</p>';
  }

  function mkEl(tag, cls = '', text = '') {
    const el = document.createElement(tag);
    if (cls)  el.className = cls;
    if (text) el.textContent = text;
    return el;
  }

  function buildColorStrip(container, onSelect) {
    container.innerHTML = '';
    COLOR_KEYS.forEach(key => {
      const sw = mkEl('div', 'color-swatch');
      sw.style.background = COLORS[key];
      sw.title = key;
      sw.dataset.colorKey = key;
      sw.addEventListener('click', () => onSelect(key));
      container.appendChild(sw);
    });
  }

  function highlightSwatch(container, key) {
    container.querySelectorAll('.color-swatch').forEach(sw => {
      sw.classList.toggle('selected', sw.dataset.colorKey === key);
    });
  }

  function initials(name) {
    if (typeof name !== 'string' || !name.trim()) return '?';
    const parts = name.trim().split(/\s+/).filter(p => p.length > 0);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return (parts[0][0] || '?').toUpperCase();
    const first = parts[0][0] || '';
    const last  = parts[parts.length - 1][0] || '';
    return (first + last).toUpperCase() || '?';
  }

  function formatReminder(ts) {
    const now  = new Date();
    const d    = new Date(ts);
    if (ts <= Date.now()) return 'Overdue';
    if (d.toDateString() === now.toDateString()) return 'Today';
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function formatDate(ts) {
    const d   = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function htmlToMarkdown(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    function walk(node) {
      if (node.nodeType === 3) return node.textContent.replace(/ /g, ' ');
      if (node.nodeType !== 1) return '';
      const tag = node.tagName.toLowerCase();
      const inner = Array.from(node.childNodes).map(walk).join('');
      switch (tag) {
        case 'strong': case 'b':               return \`**\${inner}**\`;
        case 'em':     case 'i':               return \`*\${inner}*\`;
        case 'code':                           return \`\\\`\${inner}\\\`\`;
        case 'del':    case 's': case 'strike': return \`~~\${inner}~~\`;
        case 'u':                              return \`++\${inner}++\`;
        case 'h1':                             return \`# \${inner}\\n\`;
        case 'h2':                             return \`## \${inner}\\n\`;
        case 'h3':                             return \`### \${inner}\\n\`;
        case 'pre':                            return \`\\\`\\\`\\\`\\n\${node.textContent.trim()}\\n\\\`\\\`\\\`\\n\`;
        case 'br':                             return '\\n';
        case 'li': {
          const cb = node.querySelector('input[type="checkbox"]');
          if (cb) {
            const txt = Array.from(node.childNodes)
              .filter(n => !(n.nodeType === 1 && n.tagName.toLowerCase() === 'input'))
              .map(walk).join('').trim();
            return \`- [\${cb.checked ? 'x' : ' '}] \${txt}\\n\`;
          }
          return \`- \${inner}\\n\`;
        }
        case 'ul':     case 'ol':              return inner;
        case 'p':      case 'div':             return inner ? inner + '\\n' : '\\n';
        default:                               return inner;
      }
    }
    return Array.from(tmp.childNodes).map(walk).join('').replace(/\\n$/, '');
  }

    function simpleMarkdown(md) {
    if (!md) return '';
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const inline = raw => {
      let l = esc(raw)
        .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\*(.+?)\\*/g,        '<em>$1</em>')
        .replace(/\`(.+?)\`/g,          '<code>$1</code>')
        .replace(/~~(.+?)~~/g,          '<del>$1</del>')
        .replace(/\\+\\+(.+?)\\+\\+/g,  '<u>$1</u>');
      if (/^(#{1,3})\\s/.test(raw)) {
        const lvl = raw.match(/^(#+)/)[1].length;
        l = \`<h\${lvl}>\${l.replace(/^#+\\s/, '')}</h\${lvl}>\`;
      }
      return l;
    };
    const lines = md.split('\\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].startsWith('\`\`\`')) {
        const codeLines = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('\`\`\`')) { codeLines.push(esc(lines[i])); i++; }
        if (i < lines.length) i++; // skip closing fence line
        out.push(\`<pre>\${codeLines.join('\\n')}</pre>\`);
        continue;
      }
      if (/^[-*]\\s/.test(lines[i])) {
        const items = [];
        while (i < lines.length && /^[-*]\\s/.test(lines[i])) {
          const tm = lines[i].match(/^[-*]\\s\\[([ x])\\]\\s(.*)/);
          if (tm) {
            const chk = tm[1] === 'x';
            items.push(\`<li class="task-item\${chk ? ' done' : ''}"><input type="checkbox" class="task-check"\${chk ? ' checked' : ''}> <span>\${inline(tm[2])}</span></li>\`);
          } else {
            items.push(\`<li>\${inline(lines[i].slice(2))}</li>\`);
          }
          i++;
        }
        out.push(\`<ul class="task-list">\${items.join('')}</ul>\`);
      } else {
        const l = inline(lines[i]);
        out.push(\`<p>\${l || '&nbsp;'}</p>\`);
        i++;
      }
    }
    return out.join('');
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

function parseGitHubOwnerRepo(remoteUrl: string): { owner: string; repo: string } | undefined {
  const cleaned = remoteUrl.replace(/\.git$/, '');
  const sshMatch   = cleaned.match(/github\.com[:/]([^/]+)\/([^/]+)$/);
  if (sshMatch)   return { owner: sshMatch[1],   repo: sshMatch[2] };
  const httpsMatch = cleaned.match(/github\.com\/([^/]+)\/([^/]+)$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  return undefined;
}

function githubCreateIssue(
  token: string,
  owner: string,
  repo : string,
  title: string,
  body : string,
): Promise<{ html_url: string; number: number; title: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ title, body });
    const req = https.request(
      {
        hostname: 'api.github.com',
        path    : `/repos/${owner}/${repo}/issues`,
        method  : 'POST',
        headers : {
          'Authorization'        : `Bearer ${token}`,
          'Accept'               : 'application/vnd.github+json',
          'Content-Type'         : 'application/json',
          'Content-Length'       : Buffer.byteLength(payload),
          'User-Agent'           : 'DevNotes-VSCode',
          'X-GitHub-Api-Version' : '2022-11-28',
        },
      },
      res => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 201) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`GitHub API returned ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
