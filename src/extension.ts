import * as vscode from 'vscode';
import { NoteStorage } from './NoteStorage';
import { SidebarView } from './SidebarView';
import { EditorPanel } from './EditorPanel';
import { GutterController } from './GutterController';
import { ReminderController } from './ReminderController';
import { ConflictPanel } from './ConflictPanel';
import { runExport } from './ExportController';
import { detectProjectIdentity, getCurrentBranch } from './GitDetector';

// ─── Activation ──────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    await _activate(context);
  } catch (err) {
    vscode.window.showErrorMessage(`DevNotes failed to activate: ${err}`);
    console.error('[DevNotes] activation error:', err);
  }
}

async function _activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;

  if (!workspaceRoot) {
    // No folder open — register a minimal provider so the sidebar panel shows
    // a helpful message instead of a blank/broken view.
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('devnotesView', {
        resolveWebviewView(view: vscode.WebviewView) {
          view.webview.options = { enableScripts: false };
          view.webview.html = `<!DOCTYPE html>
<html lang="en"><body style="
  font-family:var(--vscode-font-family);
  font-size:13px;
  color:var(--vscode-descriptionForeground);
  padding:24px 16px;
  text-align:center;
  line-height:1.5;
">
  <p>DevNotes requires an open workspace folder.</p>
  <p style="margin-top:8px;font-size:12px;">
    Open a folder or workspace to start taking notes.
  </p>
</body></html>`;
        },
      })
    );
    return;
  }

  const storage = new NoteStorage(workspaceRoot, context.workspaceState, context.globalState);
  const watcher = await storage.init();
  context.subscriptions.push(watcher);

  // Declared before sidebar so the callback closure can reference it safely.
  // Assigned immediately after — the callback only fires on user interaction,
  // which is always after activation completes.
  let gutterController!: GutterController;

  const sidebar = new SidebarView(
    context,
    storage,
    (noteId) => EditorPanel.show(context, storage, noteId, () => sidebar.push()),
    () => gutterController.refresh(),
  );

  // Gutter decorations — shows sticky-note icon on lines with linked notes
  gutterController = new GutterController(context, storage);
  context.subscriptions.push(gutterController);

  // Reminder system — checks due remindAt timestamps every minute
  const reminderController = new ReminderController(storage, () => sidebar.push());
  context.subscriptions.push(reminderController);

  // Track which note IDs have already shown a conflict notification this session
  // so we don't re-notify on every subsequent onExternalChange fire.
  const notifiedConflicts = new Set<string>();

  // Sync all surfaces when notes change due to external file edits (e.g. git pull)
  storage.onExternalChange = () => {
    sidebar.push();
    EditorPanel.current?.push();
    gutterController.refresh();
    reminderController.refresh();

    // Detect newly conflicted notes and show a notification
    const conflicted = storage.getNotes().filter(n => n.conflicted);

    // Clear IDs of notes that are no longer conflicted
    for (const id of notifiedConflicts) {
      if (!conflicted.some(n => n.id === id)) notifiedConflicts.delete(id);
    }

    for (const note of conflicted) {
      if (notifiedConflicts.has(note.id)) continue;
      notifiedConflicts.add(note.id);
      notifyConflict(note.id, note.title, context, storage, sidebar);
    }
  };

  // Register the WebviewView in the sidebar
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('devnotesView', sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Detect Git project identity and current branch
  refreshProjectIdentity(sidebar);
  refreshBranch(sidebar, workspaceRoot.fsPath);

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshProjectIdentity(sidebar);
      refreshBranch(sidebar, workspaceRoot.fsPath);
    })
  );

  // Watch .git/HEAD for branch switches (checkout, rebase, merge)
  const headWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, '.git/HEAD')
  );
  headWatcher.onDidChange(() => refreshBranch(sidebar, workspaceRoot.fsPath));
  context.subscriptions.push(headWatcher);

  // ── Commands ─────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('devnotes.refresh', () => {
      sidebar.push();
    })
  );

  // Quick Capture — Ctrl+Alt+Q (Cmd+Alt+Q on Mac)
  // Works from anywhere: auto-links to current file:line when an editor is
  // focused, falls back to a plain note when no editor is open.
  context.subscriptions.push(
    vscode.commands.registerCommand('devnotes.quickCapture', async () => {
      const editor = vscode.window.activeTextEditor;

      let prompt    = 'New note';
      let codeLink: import('./NoteStorage').CodeLink | undefined;

      if (editor) {
        const filePath = vscode.workspace.asRelativePath(editor.document.uri, false);
        if (filePath !== editor.document.uri.fsPath) {
          const line = editor.selection.active.line + 1;
          codeLink = { file: filePath, line };
          prompt = `Note linked to ${filePath}:${line}`;
        }
      }

      const title = await vscode.window.showInputBox({
        prompt,
        placeHolder: 'Note title…',
      });
      if (!title) return;

      // Template picker — "Blank" is pre-selected so Enter still creates a note instantly
      type TplItem = vscode.QuickPickItem & { template?: import('./NoteStorage').Template };
      const tplItems: TplItem[] = [
        { label: '$(file) Blank', description: 'No template', picked: true },
        ...storage.getTemplates().map(t => ({
          label      : `$(note) ${t.name}`,
          description: t.content.replace(/#+\s/g, '').replace(/\n/g, ' ').slice(0, 72),
          template   : t,
        })),
      ];
      const picked = await vscode.window.showQuickPick(tplItems, {
        placeHolder    : 'Choose a template — Enter to accept Blank',
        matchOnDescription: true,
      });
      if (picked === undefined) return; // Escape cancels

      const tpl = (picked as TplItem).template;

      // Branch scope step — only shown when on a named git branch
      let branch: string | undefined;
      const detectedBranch = getCurrentBranch(workspaceRoot.fsPath);
      if (detectedBranch) {
        type ScopeItem = vscode.QuickPickItem & { branch?: string };
        // Pre-select "Scope to branch" when the sidebar branch filter is active —
        // the user is already in branch-focused mode so scoping is the likely intent.
        const filterIsActive = sidebar.isBranchFilterActive();
        const scopeItems: ScopeItem[] = [
          { label: '$(globe) Global', description: 'Visible on all branches', picked: !filterIsActive },
          { label: `$(git-branch) Scope to ${detectedBranch}`, description: 'Only surfaces on this branch', branch: detectedBranch, picked: filterIsActive },
        ];
        const scopePicked = await vscode.window.showQuickPick(scopeItems, {
          placeHolder: 'Branch scope — Enter to keep global',
        });
        if (scopePicked === undefined) return; // Escape cancels
        branch = (scopePicked as ScopeItem).branch;
      }

      await storage.createNote({
        title,
        codeLink,
        content: tpl?.content,
        color  : tpl?.color,
        tags   : tpl?.tags,
        branch,
      });
      sidebar.push();
      gutterController.refresh();
    })
  );

  // Open a note in the rich editor (used by hover tooltip links)
  context.subscriptions.push(
    vscode.commands.registerCommand('devnotes.focusNote', (noteId: string) => {
      EditorPanel.show(context, storage, noteId, () => sidebar.push());
    })
  );

  // Jump to the file:line stored in a note's codeLink
  context.subscriptions.push(
    vscode.commands.registerCommand('devnotes.jumpToLink', async (file: string, line: number) => {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!wsRoot) return;
      const uri = vscode.Uri.joinPath(wsRoot, file);
      try {
        const doc    = await vscode.workspace.openTextDocument(uri);
        const opened = await vscode.window.showTextDocument(doc, { preview: false });
        const pos    = new vscode.Position(line - 1, 0);
        opened.selection = new vscode.Selection(pos, pos);
        opened.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      } catch {
        vscode.window.showWarningMessage(`DevNotes: could not open ${file}:${line}`);
      }
    })
  );

  // ── Debug: simulate a conflicted shared note ─────────────────────────────
  // Writes a fake .devnotes/<id>.md file containing git conflict markers.
  // The file watcher detects it within seconds, triggers the conflict UI,
  // and shows the notification — exactly as a real `git pull` conflict would.
  context.subscriptions.push(
    vscode.commands.registerCommand('devnotes.simulateConflict', async () => {
      const id  = 'sim-conflict-' + Date.now().toString(36);
      const now = Date.now();
      const uri = vscode.Uri.joinPath(workspaceRoot, '.devnotes', `${id}.md`);

      const content = [
        '---',
        `id: ${id}`,
        `title: Auth token expiry fix`,
        '<<<<<<< HEAD',
        'color: orange',
        'tags: bug,important',
        '=======',
        'color: blue',
        'tags: bug',
        '>>>>>>> feature/auth-v2',
        'starred: false',
        'shared: true',
        `createdAt: ${now}`,
        `updatedAt: ${now}`,
        '---',
        '',
        '<<<<<<< HEAD',
        '## My approach',
        '',
        'Use a refresh token with a 24h TTL.',
        '',
        '- Implement token rotation',
        '- Add `/auth/refresh` endpoint',
        '- Update client to handle 401 → retry',
        '=======',
        '## Teammate\'s approach',
        '',
        'Extend the access token TTL to 24 hours.',
        '',
        '- Update JWT expiry setting in config',
        '- Simpler — no refresh token needed',
        '>>>>>>> feature/auth-v2',
      ].join('\n');

      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
      vscode.window.showInformationMessage(
        'DevNotes: simulated conflict written — watch for the ⚠ notification.'
      );
    })
  );

  // Open the conflict resolution panel for a specific note
  context.subscriptions.push(
    vscode.commands.registerCommand('devnotes.openConflict', (noteId: string) => {
      ConflictPanel.show(context, storage, noteId, () => sidebar.push());
    })
  );

  // Export all notes
  context.subscriptions.push(
    vscode.commands.registerCommand('devnotes.exportAll', () =>
      runExport(storage.getNotes(), storage.getTags())
    )
  );

  // Export a single note by ID (called from editor toolbar and sidebar)
  context.subscriptions.push(
    vscode.commands.registerCommand('devnotes.exportNote', (noteId: string) => {
      const note = storage.getNote(noteId);
      if (!note) return;
      return runExport([note], storage.getTags());
    })
  );

  // Export a specific set of notes by IDs (called from sidebar selection mode)
  context.subscriptions.push(
    vscode.commands.registerCommand('devnotes.exportSelected', (noteIds: string[]) => {
      const notes = noteIds.map(id => storage.getNote(id)).filter((n): n is import('./NoteStorage').Note => !!n);
      return runExport(notes, storage.getTags());
    })
  );

  // Auto-update codeLinks when files are renamed inside VS Code
  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles(async (event) => {
      let anyChanged = false;
      for (const { oldUri, newUri } of event.files) {
        const oldRel = vscode.workspace.asRelativePath(oldUri, false);
        const newRel = vscode.workspace.asRelativePath(newUri, false);
        const affected = storage.getNotes().filter(n => n.codeLink?.file === oldRel);
        for (const note of affected) {
          await storage.updateNote(note.id, { codeLink: { file: newRel, line: note.codeLink!.line } });
          anyChanged = true;
        }
      }
      if (anyChanged) {
        sidebar.push();
        gutterController.refresh();
      }
    })
  );
}

// ─── Deactivation ────────────────────────────────────────────────────────────

export function deactivate(): void {
  // VS Code disposes subscriptions automatically
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function refreshProjectIdentity(sidebar: SidebarView): void {
  try {
    const identity = detectProjectIdentity();
    if (identity) sidebar.setProjectName(identity.displayName);
  } catch (err) {
    console.error('[DevNotes] refreshProjectIdentity error:', err);
  }
}

async function notifyConflict(
  noteId : string,
  title  : string,
  context: vscode.ExtensionContext,
  storage: NoteStorage,
  sidebar: SidebarView,
): Promise<void> {
  const action = await vscode.window.showWarningMessage(
    `⚠ Conflict in shared note: "${title}"`,
    'Resolve',
    'Dismiss',
  );
  if (action === 'Resolve') {
    ConflictPanel.show(context, storage, noteId, () => sidebar.push());
  }
}

function refreshBranch(sidebar: SidebarView, rootPath: string): void {
  try {
    sidebar.setCurrentBranch(getCurrentBranch(rootPath));
  } catch (err) {
    console.error('[DevNotes] refreshBranch error:', err);
  }
}
