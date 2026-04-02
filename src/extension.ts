import * as vscode from 'vscode';
import { NoteStorage } from './NoteStorage';
import { SidebarView } from './SidebarView';
import { CanvasPanel } from './CanvasPanel';
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

  const sidebar = new SidebarView(
    context,
    storage,
    (noteId) => CanvasPanel.show(context, storage, noteId, () => sidebar.push())
  );

  // Sync both panels when notes change due to external file edits (e.g. git pull)
  storage.onExternalChange = () => {
    sidebar.push();
    CanvasPanel.current?.push();
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
    vscode.commands.registerCommand('devnotes.openCanvas', () => {
      CanvasPanel.show(context, storage, undefined, () => sidebar.push());
    }),

    vscode.commands.registerCommand('devnotes.refresh', () => {
      sidebar.push();
    }),

    vscode.commands.registerCommand('devnotes.search', async () => {
      const notes = storage.getNotes();
      const tags  = storage.getTags();

      type NoteItem = vscode.QuickPickItem & { noteId: string };
      const items: NoteItem[] = notes.map(n => ({
        label      : n.title,
        description: n.tags.map(tid => tags.find(t => t.id === tid)?.label).filter(Boolean).join(', ') || undefined,
        detail     : n.content.slice(0, 120).replace(/\n/g, ' ') || undefined,
        noteId     : n.id,
      }));

      const pick = await vscode.window.showQuickPick<NoteItem>(items, {
        matchOnDescription: true,
        matchOnDetail     : true,
        placeHolder       : 'Search notes by title, content, or tag…',
      });

      if (pick) {
        CanvasPanel.show(context, storage, pick.noteId, () => sidebar.push());
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
