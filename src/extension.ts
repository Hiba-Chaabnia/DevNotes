import * as vscode from 'vscode';
import { NoteStorage } from './NoteStorage';
import { SidebarView } from './SidebarView';
import { CanvasPanel } from './CanvasPanel';
import { detectProjectIdentity } from './GitDetector';

// ─── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  try {
    _activate(context);
  } catch (err) {
    vscode.window.showErrorMessage(`DevNotes failed to activate: ${err}`);
    console.error('[DevNotes] activation error:', err);
  }
}

function _activate(context: vscode.ExtensionContext): void {
  const storage = new NoteStorage(context.workspaceState, context.globalState);

  const sidebar = new SidebarView(
    context,
    storage,
    (noteId) => CanvasPanel.show(context, storage, noteId, () => sidebar.push())
  );

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
