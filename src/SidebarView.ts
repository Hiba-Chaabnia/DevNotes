import * as vscode from 'vscode';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { NoteStorage, Note, Tag, Template, GitHubLink, NOTE_COLORS, DEFAULT_TAGS } from './NoteStorage';
import { detectProjectIdentity } from './GitDetector';

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
  | { type: 'openLinkedNote'; noteId: string };

// ─── Provider ────────────────────────────────────────────────────────────────

export class SidebarView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private projectName      = 'DevNotes';
  private currentBranch: string | undefined;
  private currentUser:   string | undefined;
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
      type            : 'init',
      notes,
      tags            : this.storage.getTags(),
      templates       : this.storage.getTemplates(),
      defaultTagIds   : DEFAULT_TAGS.map(t => t.id),
      projectName     : this.projectName,
      currentBranch   : this.currentBranch ?? null,
      currentUser     : this.currentUser   ?? null,
      githubConnected : this._githubConnected,
    });
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

      case 'registerMcp':
        vscode.commands.executeCommand('devnotes.registerMcp');
        break;
    }
  }

  // ── HTML ─────────────────────────────────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
    const nonce      = getNonce();
    const colorsJson = JSON.stringify(NOTE_COLORS);

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
    --card-text: #1a1a2e;
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

  .project-name {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .04em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

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
    font-size: 11px;
    line-height: 1;
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
    box-shadow: 0 1px 4px rgba(0,0,0,.1);
    transition: box-shadow .15s, transform .15s;
    color: var(--card-text);
    position: relative;
  }
  .card:hover { box-shadow: 0 4px 14px rgba(0,0,0,.15); transform: translateY(-1px); }
  .card:focus { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; box-shadow: 0 4px 14px rgba(0,0,0,.15); }
  .card.hidden { display: none; }

  /* Shared indicator — left-edge stripe */
  .card.is-shared::before {
    content: '';
    position: absolute;
    left: 0; top: 8px; bottom: 8px;
    width: 3px;
    background: rgba(6, 214, 214, 0.75);
    border-radius: 0 3px 3px 0;
  }

  /* Card header row */
  .card-header {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 22px;
  }

  .star-btn {
    background: none; border: none; cursor: pointer;
    font-size: 14px; padding: 0; line-height: 1;
    color: var(--card-text); opacity: .4;
    flex-shrink: 0;
  }
  .star-btn.on { opacity: 1; }
  .star-btn:hover { opacity: .8; }

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
    border-bottom: 1.5px solid rgba(26,26,46,.35);
  }

  .card-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    opacity: 0;
    transition: opacity .12s;
    flex-shrink: 0;
  }
  .card:hover .card-actions { opacity: 1; }

  .card-btn {
    background: rgba(0,0,0,.12);
    border: none;
    border-radius: 4px;
    width: 22px; height: 22px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    font-size: 12px;
    color: var(--card-text);
    transition: background .1s;
  }
  .card-btn:hover { background: rgba(0,0,0,.22); }
  .card-btn.is-active {
    background: rgba(6, 214, 214, 0.35);
  }
  .card-btn.is-active:hover { background: rgba(6, 214, 214, 0.5); }

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
  }

  /* Rendered markdown preview */
  .card-preview { pointer-events: none; }
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
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* Textarea for quick editing */
  .card-editor {
    display: none;
    width: 100%;
    background: rgba(0,0,0,.06);
    border: none;
    border-radius: 5px;
    padding: 6px 8px;
    font-size: 12px;
    font-family: var(--vscode-font-family);
    color: var(--card-text);
    resize: vertical;
    min-height: 60px;
    outline: none;
    line-height: 1.55;
  }

  .show-more {
    font-size: 11px;
    cursor: pointer;
    opacity: .6;
    text-align: right;
    color: var(--card-text);
    display: none;
  }
  .show-more:hover { opacity: 1; }

  /* Card footer */
  .card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 4px;
  }

  .card-tags { display: flex; gap: 3px; flex-wrap: wrap; }
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
    font-size: 13px;
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
    background: transparent;
    border: none;
    outline: none;
    font-size: 12.5px;
    color: #1a1a2e;
    padding: 0 12px 10px;
    width: 100%;
    min-height: 88px;
    font-family: var(--vscode-font-family);
    line-height: 1.55;
    cursor: text;
    overflow-y: auto;
    word-break: break-word;
  }
  .note-card-body:empty::before {
    content: attr(data-placeholder);
    color: rgba(26,26,46,.38);
    pointer-events: none;
    display: block;
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
    padding: 1px 6px;
    border-radius: 10px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 110px;
    flex-shrink: 1;
    display: none;
  }
  .branch-pill.visible { display: inline-block; }

  .branch-filter-btn.active { color: var(--vscode-button-background) !important; opacity: 1; }
  .github-connect-btn.connected { color: #06d6a0 !important; opacity: 1; }
  .archive-view-btn.active { color: var(--vscode-button-background) !important; opacity: 1; }
  .card.is-archived { opacity: .75; }
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
    align-self: flex-start;
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
    gap: 3px;
    color: var(--card-text);
    opacity: .6;
    max-width: 80px;
  }
  .owner-initials {
    width: 15px; height: 15px;
    border-radius: 50%;
    background: rgba(0,0,0,.2);
    font-size: 8px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    letter-spacing: -.5px;
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
  .card.conflict::after {
    content: '';
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 3px;
    background: #EF6C57;
    border-radius: var(--radius) 0 0 var(--radius);
  }
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
    align-self: flex-start;
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
    align-self: flex-start;
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
    align-self: flex-start;
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
    align-self: flex-start;
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
    opacity: .35;
    text-decoration: line-through;
    cursor: default;
    pointer-events: none;
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

  .note-links-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }
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

  .sort-btn {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: -.3px;
    min-width: 22px;
    padding: 0 3px;
  }
  .sort-btn.active { color: var(--vscode-button-background); opacity: 1; }

</style>
</head>
<body>

<!-- ── Top bar ── -->
<div class="topbar">
  <div class="topbar-row">
    <span class="project-name" id="project-name">Loading…</span>
    <span class="branch-pill" id="branch-pill"></span>
    <button class="icon-btn branch-filter-btn" id="btn-branch-filter" title="Show current branch only" style="display:none">⎇</button>
    <button class="icon-btn sort-btn" id="btn-sort" title="Sort: last updated">↓U</button>
    <button class="icon-btn" id="btn-new" title="New Note">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>
    <button class="icon-btn overflow-btn" id="btn-overflow" title="More options">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
      </svg>
    </button>
  </div>

  <div class="search-row">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" style="opacity:.5;flex-shrink:0">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
    <input id="search" type="text" placeholder="Search notes…" autocomplete="off">
    <button class="search-clear" id="search-clear" title="Clear search" style="display:none">✕</button>
  </div>
</div>

<!-- ── Note card overlay ── -->
<div class="note-card-overlay" id="note-card-overlay">
  <div class="note-card" id="note-card">
    <div class="note-card-header">
      <div class="color-strip" id="new-colors"></div>
      <button class="note-card-close" id="btn-cancel-new" title="Cancel">✕</button>
    </div>
    <input class="note-card-title" id="new-title" type="text" placeholder="Note title…" maxlength="120" autocomplete="off">
    <div class="note-card-body" id="new-body" contenteditable="true" spellcheck="true" data-placeholder="Start writing…" role="textbox" aria-multiline="true"></div>
    <div class="note-card-footer">
      <div class="note-card-fmtbar">
        <button class="fmt-btn" data-cmd="bold"                 title="Bold (Ctrl+B)"><b>B</b></button>
        <button class="fmt-btn" data-cmd="italic"               title="Italic (Ctrl+I)"><i>I</i></button>
        <button class="fmt-btn" data-cmd="underline"            title="Underline (Ctrl+U)"><u>U</u></button>
        <button class="fmt-btn" data-cmd="strikeThrough"        title="Strikethrough"><s>S</s></button>
        <div class="fmt-btn-sep"></div>
        <button class="fmt-btn" data-cmd="insertUnorderedList"  title="Bullet list">&#8801;</button>
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

<!-- ── Card list ── -->
<div class="card-list" id="card-list"></div>

<!-- ── Overflow menu (⋯ button) ── -->
<div class="overflow-menu" id="overflow-menu">
  <button class="ovf-item mine-filter-btn" id="btn-mine-filter" style="display:none">
    <span class="ovf-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>
    <span class="ovf-label">My notes only</span>
    <span class="ovf-check">✓</span>
  </button>
  <button class="ovf-item" id="btn-archive-view">
    <span class="ovf-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg></span>
    <span class="ovf-label">Archived notes</span>
    <span class="ovf-check">✓</span>
  </button>
  <button class="ovf-item stale-filter-btn" id="btn-stale-filter">
    <span class="ovf-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 6 12 12 16 14"/></svg></span>
    <span class="ovf-label">Stale notes</span>
    <span class="ovf-check">✓</span>
  </button>
  <button class="ovf-item" id="btn-select">
    <span class="ovf-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="5" width="5" height="5" rx="1"/><line x1="12" y1="7.5" x2="21" y2="7.5"/><rect x="3" y="14" width="5" height="5" rx="1"/><line x1="12" y1="16.5" x2="21" y2="16.5"/></svg></span>
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
    <span class="ovf-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="13" rx="2"/><circle cx="9" cy="14" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="14" r="1" fill="currentColor" stroke="none"/><line x1="9" y1="18" x2="15" y2="18"/><line x1="12" y1="8" x2="12" y2="4"/><circle cx="12" cy="3" r="1.5"/></svg></span>
    <span class="ovf-label">Register MCP</span>
  </button>
</div>

<!-- ── Export bar (selection mode) ── -->
<div class="export-bar" id="export-bar">
  <span class="export-count" id="export-count">0 notes selected</span>
  <button class="btn btn-ghost btn-sel-all" id="btn-sel-all" title="Select all visible notes">All</button>
  <button class="btn btn-ghost" id="btn-archive-sel" title="Archive selected">📦</button>
  <button class="btn btn-ghost" id="btn-tag-sel" title="Assign tag to selected">#</button>
  <button class="btn btn-ghost" id="btn-export-sel" title="Export selected">↓</button>
  <button class="btn btn-ghost btn-danger" id="btn-delete-sel" title="Delete selected">✕</button>
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
  let branchFilterActive  = false;
  let mineFilterActive    = false;
  let githubConnected     = false;
  let showArchived           = false;
  let sortMode               = 'updated'; // 'updated' | 'created' | 'alpha'
  let githubStatusFilter     = null; // null | 'open' | 'closed' | 'merged'
  let staleFilterActive      = false;
  let selectMode         = false;
  let selectedIds        = [];
  let openColorPop    = null;
  let openTagPop      = null;
  let isManagingTags  = false;
  let openMgrColorPop = null;

  // ── DOM refs ────────────────────────────────────────────────────────────
  const projectName    = document.getElementById('project-name');
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
    { key: 'updated', label: '↓U', title: 'Sort: last updated' },
    { key: 'created', label: '↓C', title: 'Sort: date created' },
    { key: 'alpha',   label: 'A–Z', title: 'Sort: alphabetical' },
  ];
  btnSort.addEventListener('click', () => {
    const idx = SORT_MODES.findIndex(m => m.key === sortMode);
    const next = SORT_MODES[(idx + 1) % SORT_MODES.length];
    sortMode = next.key;
    btnSort.textContent = next.label;
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
    btnStaleFilter.title = staleFilterActive ? 'Show all notes' : 'Show stale notes (14+ days old with open todos or bug tag)';
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
      notes         = msg.notes         ?? [];
      tags          = msg.tags          ?? [];
      templates     = msg.templates     ?? [];
      defaultTagIds = msg.defaultTagIds ?? [];
      currentBranch   = msg.currentBranch   ?? null;
      currentUser     = msg.currentUser     ?? null;
      githubConnected = msg.githubConnected ?? false;
      if (msg.projectName) projectName.textContent = msg.projectName;
      // Show mine-filter button only when a git user is detected
      btnMineFilter.style.display = currentUser ? '' : 'none';
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
      renderNewNoteTags();
      renderCardTemplatePicker();
      buildColorStrip(newColorsEl,  c => { newColor = c; highlightSwatch(newColorsEl, c); noteCardEl.style.setProperty('--nc-bg', COLORS[c]); });
      buildColorStrip(tagColorsEl, c => { tagColor = c; highlightSwatch(tagColorsEl, c); });
      highlightSwatch(newColorsEl, newColor);
      highlightSwatch(tagColorsEl, tagColor);
    }
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
      e.preventDefault(); // keep focus in contenteditable
      document.execCommand(btn.dataset.cmd);
      updateFmtBar();
    });
  });

  document.addEventListener('selectionchange', () => {
    if (newBodyEl.contains(document.getSelection()?.anchorNode)) updateFmtBar();
  });

  function updateFmtBar() {
    document.querySelectorAll('.fmt-btn[data-cmd]').forEach(btn => {
      try {
        btn.classList.toggle('active', document.queryCommandState(btn.dataset.cmd));
      } catch (_) {}
    });
  }

  function closeNewForm() {
    noteCardOverlay.classList.remove('open');
    newTitleEl.value    = '';
    newBodyEl.innerHTML = '';
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
    const body = newBodyEl.innerText.trim() || undefined;
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
      branchPillEl.textContent = '⎇ ' + currentBranch;
      branchPillEl.classList.add('visible');
      branchFilterBtn.style.display = '';
      branchScopeLabel.classList.add('visible');
      branchScopeNameEl.textContent = currentBranch;
    } else {
      branchPillEl.classList.remove('visible');
      branchFilterBtn.style.display = 'none';
      branchScopeLabel.classList.remove('visible');
    }
  }

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
        const hasBugTag    = n.tags.includes('bug');
        const hasOpenTodos = /- \[ \]/.test(n.content);
        if (!hasBugTag && !hasOpenTodos) return false;
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
        if (sortMode === 'alpha')   return a.title.localeCompare(b.title);
        if (sortMode === 'created') return b.createdAt - a.createdAt;
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
    card.style.background = bg;

    // ── Select checkbox (visible only in selection mode) ──
    const checkEl = mkEl('div', 'card-check');
    card.appendChild(checkEl);

    card.addEventListener('click', e => {
      if (!selectMode) return;
      if (e.target.closest('.card-actions')) return;
      const idx = selectedIds.indexOf(note.id);
      if (idx === -1) { selectedIds.push(note.id); card.classList.add('selected'); }
      else            { selectedIds.splice(idx, 1); card.classList.remove('selected'); }
      updateExportBar();
    });

    // ── Header ──
    const hdr = mkEl('div', 'card-header');

    const starBtn = mkEl('button', 'star-btn' + (note.starred ? ' on' : ''));
    starBtn.textContent = '★';
    starBtn.title = note.starred ? 'Unstar' : 'Star';
    starBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'updateNote', id: note.id, changes: { starred: !note.starred } });
    });

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

    const actions = mkEl('div', 'card-actions');

    // ── Tag assignment button ──
    const tagBtn = mkEl('button', 'card-btn', '#');
    tagBtn.title = 'Assign tags';
    const tagPop = mkEl('div', 'tag-pop');

    if (tags.length === 0) {
      tagPop.appendChild(mkEl('div', 'tag-pop-empty', 'No tags yet'));
    } else {
      tags.forEach(tag => {
        const item  = mkEl('div', 'tag-pop-item' + (note.tags.includes(tag.id) ? ' selected' : ''));
        item.style.background = tag.color;
        const lbl   = mkEl('span', '', tag.label);
        const check = mkEl('span', 'tag-pop-check', '✓');
        item.append(lbl, check);
        item.addEventListener('click', e => {
          e.stopPropagation();
          const newNoteTags = note.tags.includes(tag.id)
            ? note.tags.filter(t => t !== tag.id)
            : [...note.tags, tag.id];
          vscode.postMessage({ type: 'updateNote', id: note.id, changes: { tags: newNoteTags } });
          tagPop.classList.remove('open');
          openTagPop = null;
        });
        tagPop.appendChild(item);
      });
    }

    tagBtn.addEventListener('click', e => {
      e.stopPropagation();
      const wasOpen = tagPop.classList.contains('open');
      closeAllPops();
      if (!wasOpen) { tagPop.classList.add('open'); openTagPop = note.id; }
    });

    // ── Code link button ──
    const linkBtn = mkEl('button', 'card-btn' + (note.codeLink ? ' is-active' : ''));
    linkBtn.title = note.codeLink ? 'Update link to current cursor position' : 'Link to current cursor position';
    linkBtn.innerHTML = \`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
    </svg>\`;
    linkBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'linkToEditor', noteId: note.id });
    });

    // ── Branch scope button ──
    const branchBtn = mkEl('button', 'card-btn' + (note.branch ? ' is-active' : ''));
    branchBtn.textContent = '⎇';
    if (!currentBranch) {
      branchBtn.style.display = 'none';
    } else if (note.branch) {
      branchBtn.title = note.branch === currentBranch
        ? 'Scoped to this branch — click to make global'
        : 'Scoped to ' + note.branch + ' — click to make global';
    } else {
      branchBtn.title = 'Scope to current branch (' + currentBranch + ')';
    }
    branchBtn.addEventListener('click', () => {
      if (note.branch) {
        vscode.postMessage({ type: 'setBranchScope', noteId: note.id, branch: null });
      } else if (currentBranch) {
        vscode.postMessage({ type: 'setBranchScope', noteId: note.id, branch: currentBranch });
      }
    });

    // ── Reminder button ──
    const bellBtn = mkEl('button', 'card-btn' + (note.remindAt ? ' is-active' : ''));
    bellBtn.textContent = '🔔';
    bellBtn.title = note.remindAt ? 'Edit reminder' : 'Set a reminder';
    bellBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'setReminder', noteId: note.id });
    });

    // ── Share toggle button ──
    const shareBtn = mkEl('button', 'card-btn' + (note.shared ? ' is-active' : ''));
    shareBtn.title = note.shared ? 'Unshare note' : 'Share note (opt into git)';
    shareBtn.innerHTML = \`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
      <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
      <line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/>
    </svg>\`;
    shareBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'updateNote', id: note.id, changes: { shared: !note.shared } });
    });

    // ── Color picker button ──
    const colorBtn = mkEl('button', 'card-btn', '🎨');
    colorBtn.title = 'Change color';
    const colorPop = mkEl('div', 'color-pop');
    COLOR_KEYS.forEach(key => {
      const sw = mkEl('div', 'color-swatch' + (note.color === key ? ' selected' : ''));
      sw.style.background = COLORS[key];
      sw.title = key;
      sw.addEventListener('click', e => {
        e.stopPropagation();
        vscode.postMessage({ type: 'updateNote', id: note.id, changes: { color: key } });
        colorPop.classList.remove('open');
        openColorPop = null;
      });
      colorPop.appendChild(sw);
    });
    colorBtn.addEventListener('click', e => {
      e.stopPropagation();
      const wasOpen = colorPop.classList.contains('open');
      closeAllPops();
      if (!wasOpen) { colorPop.classList.add('open'); openColorPop = note.id; }
    });

    // ── Open in rich editor button ──
    const editBtn = mkEl('button', 'card-btn', '✏');
    editBtn.title = 'Open in rich editor';
    editBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'openEditor', noteId: note.id });
    });

    // ── Duplicate button ──
    const dupBtn = mkEl('button', 'card-btn');
    dupBtn.title = 'Duplicate note';
    dupBtn.innerHTML = \`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>\`;
    dupBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'duplicateNote', noteId: note.id });
    });

    // ── Link to another note button ──
    const noteLinkBtn = mkEl('button', 'card-btn');
    noteLinkBtn.title = 'Link to another note';
    noteLinkBtn.innerHTML = \`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
      <line x1="5" y1="5" x2="5" y2="1"/><line x1="1" y1="5" x2="5" y2="5"/>
    </svg>\`;
    noteLinkBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'linkNote', noteId: note.id });
    });

    // ── Create GitHub issue button (only when connected and not yet linked) ──
    const ghIssueBtn = mkEl('button', 'card-btn');
    ghIssueBtn.title = 'Create GitHub issue from this note';
    ghIssueBtn.innerHTML = \`<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/>
      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/>
    </svg>\`;
    ghIssueBtn.style.display = (githubConnected && !note.github) ? '' : 'none';
    ghIssueBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'createGitHubIssue', noteId: note.id });
    });

    // ── Archive / unarchive button ──
    const archiveBtn = mkEl('button', 'card-btn', note.archived ? '↩' : '📦');
    archiveBtn.title = note.archived ? 'Unarchive note' : 'Archive note';
    archiveBtn.addEventListener('click', () => {
      vscode.postMessage({ type: note.archived ? 'unarchiveNote' : 'archiveNote', id: note.id });
    });

    // ── Delete button ──
    const delBtn = mkEl('button', 'card-btn', '✕');
    delBtn.title = 'Delete note';
    delBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'deleteNote', id: note.id });
    });

    actions.append(tagBtn, linkBtn, branchBtn, bellBtn, shareBtn, colorBtn, editBtn, dupBtn, noteLinkBtn, ghIssueBtn, archiveBtn, delBtn);
    hdr.append(starBtn, title, actions);
    card.append(hdr, colorPop, tagPop);

    // ── Tags on card ──
    if (note.tags.length > 0) {
      const tagRow = mkEl('div', 'card-tags');
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
        tagRow.appendChild(pill);
      });
      card.appendChild(tagRow);
    }

    // ── Linked notes chips ──
    if (note.linkedNoteIds && note.linkedNoteIds.length > 0) {
      const linksRow = mkEl('div', 'note-links-row');
      note.linkedNoteIds.forEach(targetId => {
        const target = notes.find(n => n.id === targetId);
        if (!target) return; // note was deleted
        const chip = mkEl('button', 'note-link-chip');
        const label = mkEl('span', '', target.title);
        const unlinkBtn = mkEl('span', 'note-link-unlink', '✕');
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
        linksRow.appendChild(chip);
      });
      if (linksRow.children.length > 0) card.appendChild(linksRow);
    }

    // ── Conflict badge ──
    if (note.conflicted) {
      const badge = mkEl('button', 'conflict-badge', '⚠ Conflict — click to resolve');
      badge.addEventListener('click', e => {
        e.stopPropagation();
        vscode.postMessage({ type: 'openConflict', noteId: note.id });
      });
      card.appendChild(badge);
    }

    // ── Archived badge ──
    if (note.archived) {
      card.appendChild(mkEl('span', 'archived-badge', '📦 Archived'));
    }

    // ── Reminder badge ──
    if (note.remindAt) {
      const isOverdue = note.remindAt <= Date.now();
      const badge = mkEl('span', 'reminder-badge' + (isOverdue ? ' overdue' : ''));
      badge.textContent = '🔔 ' + formatReminder(note.remindAt);
      badge.title = isOverdue ? 'Overdue — click 🔔 to reschedule' : new Date(note.remindAt).toLocaleString();
      card.appendChild(badge);
    }

    // ── GitHub status badge ──
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
      card.appendChild(badge);
    }

    // ── Code link chip ──
    if (note.codeLink) {
      const chip = mkEl('button', 'code-link-chip' + (note.codeLinkStale ? ' stale' : ''));
      const shortName = note.codeLink.file.split('/').pop() || note.codeLink.file;
      chip.title = note.codeLinkStale
        ? note.codeLink.file + ':' + note.codeLink.line + ' (file not found)'
        : note.codeLink.file + ':' + note.codeLink.line + ' — click to jump';

      const chipLabel = mkEl('span', '', shortName + ':' + note.codeLink.line);
      chip.appendChild(chipLabel);

      if (!note.codeLinkStale) {
        chip.addEventListener('click', e => {
          e.stopPropagation();
          vscode.postMessage({ type: 'jumpToLink', file: note.codeLink.file, line: note.codeLink.line });
        });

        const removeBtn = mkEl('span', 'code-link-remove', '✕');
        removeBtn.title = 'Remove code link';
        removeBtn.addEventListener('click', e => {
          e.stopPropagation();
          vscode.postMessage({ type: 'removeCodeLink', noteId: note.id });
        });
        chip.appendChild(removeBtn);
      }

      card.appendChild(chip);
    }

    // ── Content ──
    const contentWrap = mkEl('div', 'card-content');

    const preview  = mkEl('div', 'card-preview clamped');
    preview.innerHTML = searchQuery ? matchSnippet(note.content, searchQuery) : simpleMarkdown(note.content);

    const showMore = mkEl('div', 'show-more', '▾ more');
    const isLong   = note.content.split('\\n').length > 4 || note.content.length > 200;
    if (isLong) showMore.style.display = 'block';

    let expanded = false;
    showMore.addEventListener('click', () => {
      expanded = !expanded;
      preview.classList.toggle('clamped', !expanded);
      showMore.textContent = expanded ? '▴ less' : '▾ more';
    });

    const editor = mkEl('textarea', 'card-editor');
    editor.value = note.content;
    editor.placeholder = 'Write something…';
    editor.rows = 4;

    preview.addEventListener('click', () => {
      preview.style.display = 'none';
      showMore.style.display = 'none';
      editor.style.display   = 'block';
      editor.focus();
    });

    editor.addEventListener('blur', () => {
      const newContent = editor.value;
      if (newContent !== note.content) {
        vscode.postMessage({ type: 'updateNote', id: note.id, changes: { content: newContent } });
        preview.innerHTML = simpleMarkdown(newContent);
        const stillLong = newContent.split('\\n').length > 4 || newContent.length > 200;
        showMore.style.display = stillLong ? 'block' : 'none';
      }
      preview.style.display = '';
      showMore.style.display = isLong ? 'block' : 'none';
      editor.style.display   = 'none';
    });

    editor.addEventListener('keydown', e => {
      if (e.key === 'Escape') editor.blur();
    });

    contentWrap.append(preview, showMore, editor);
    card.appendChild(contentWrap);

    // ── Footer ──
    const footer  = mkEl('div', 'card-footer');
    const leftEl  = mkEl('span', '');
    if (note.branch) {
      const badge = mkEl('span', 'branch-badge', '⎇ ' + note.branch);
      leftEl.appendChild(badge);
    }
    const INVALID_OWNERS = ['undefined', 'null', 'unknown', ''];
    if (note.owner && typeof note.owner === 'string' && !INVALID_OWNERS.includes(note.owner.trim())) {
      const owner    = note.owner.trim();
      const ownerEl  = mkEl('span', 'owner-badge');
      ownerEl.title  = owner;
      const circle   = mkEl('span', 'owner-initials', initials(owner));
      const firstName = owner.split(/\s+/)[0] || owner;
      const nameEl   = mkEl('span', 'owner-name', firstName);
      ownerEl.appendChild(circle);
      ownerEl.appendChild(nameEl);
      leftEl.appendChild(ownerEl);
    }
    footer.appendChild(leftEl);
    const dateEl = mkEl('span', 'card-date', formatDate(note.updatedAt));
    footer.appendChild(dateEl);
    card.appendChild(footer);

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

  function simpleMarkdown(md) {
    if (!md) return '';
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return md.split('\\n').map(line => {
      let l = esc(line)
        .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
        .replace(/\`(.+?)\`/g, '<code>$1</code>')
        .replace(/~~(.+?)~~/g, '<del>$1</del>');
      if (/^#{1,3}\\s/.test(line)) {
        l = \`<strong>\${l.replace(/^#+\\s/, '')}</strong>\`;
      }
      return \`<p>\${l || '&nbsp;'}</p>\`;
    }).join('');
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
