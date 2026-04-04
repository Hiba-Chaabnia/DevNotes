import * as vscode from 'vscode';
import { NoteStorage } from './NoteStorage';
import { SidebarView } from './SidebarView';
import { EditorPanel } from './EditorPanel';
import { GutterController } from './GutterController';
import { detectProjectIdentity } from './GitDetector';

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

  // Sync all surfaces when notes change due to external file edits (e.g. git pull)
  storage.onExternalChange = () => {
    sidebar.push();
    EditorPanel.current?.push();
    gutterController.refresh();
  };

  // Register the WebviewView in the sidebar
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('devnotesView', sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Detect Git project and label the sidebar / canvas
  refreshProjectIdentity(sidebar);

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => refreshProjectIdentity(sidebar))
  );

  // ── Commands ─────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('devnotes.refresh', () => {
      sidebar.push();
    })
  );

  // Add a DevNote linked to the current cursor position
  context.subscriptions.push(
    vscode.commands.registerCommand('devnotes.addNoteHere', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const filePath = vscode.workspace.asRelativePath(editor.document.uri, false);
      // If asRelativePath returns the fsPath unchanged, the file is outside the workspace
      if (filePath === editor.document.uri.fsPath) {
        vscode.window.showWarningMessage('DevNotes: file is outside the current workspace.');
        return;
      }

      const line = editor.selection.active.line + 1; // store as 1-based
      const title = await vscode.window.showInputBox({
        prompt: `New DevNote linked to ${filePath}:${line}`,
        placeHolder: 'Note title…',
      });
      if (!title) return;

      await storage.createNote({ title, codeLink: { file: filePath, line } });
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
    if (identity) {
      sidebar.setProjectName(identity.displayName);
    }
  } catch (err) {
    console.error('[DevNotes] refreshProjectIdentity error:', err);
  }
}
