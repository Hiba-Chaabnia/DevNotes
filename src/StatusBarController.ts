import * as vscode from 'vscode';
import { NoteStorage } from './NoteStorage';

/**
 * Manages two persistent status bar items:
 *
 *  1. Overdue reminders  — $(bell) N overdue
 *     Shown whenever one or more non-archived notes have a remindAt in the past.
 *     Clicking opens the DevNotes sidebar.
 *
 *  2. Linked notes       — $(notebook) N note(s) here
 *     Shown when the active editor file has notes linked to it.
 *     Clicking opens the DevNotes sidebar.
 */
export class StatusBarController implements vscode.Disposable {
  private readonly reminderItem : vscode.StatusBarItem;
  private readonly linkedItem   : vscode.StatusBarItem;
  private readonly disposables  : vscode.Disposable[] = [];

  constructor(private readonly storage: NoteStorage) {
    this.reminderItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right, 100
    );
    this.reminderItem.command = 'devnotes.focusSidebar';
    this.disposables.push(this.reminderItem);

    this.linkedItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right, 99
    );
    this.linkedItem.command = 'devnotes.focusSidebar';
    this.disposables.push(this.linkedItem);

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh())
    );
  }

  /** Call after any notes mutation or on external change. */
  refresh(): void {
    this.updateReminderItem();
    this.updateLinkedItem();
  }

  private updateReminderItem(): void {
    const now     = Date.now();
    const overdue = this.storage.getNotes().filter(
      n => !n.archived && n.remindAt && n.remindAt <= now
    );

    if (overdue.length === 0) {
      this.reminderItem.hide();
      return;
    }

    const count = overdue.length;
    this.reminderItem.text    = `$(bell) ${count} overdue`;
    this.reminderItem.tooltip = count === 1
      ? `1 overdue reminder: "${overdue[0].title}" — click to open DevNotes`
      : `${count} overdue reminders — click to open DevNotes`;
    this.reminderItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.reminderItem.show();
  }

  private updateLinkedItem(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.linkedItem.hide();
      return;
    }

    const filePath = vscode.workspace.asRelativePath(editor.document.uri, false);
    // asRelativePath returns the fsPath unchanged when the file is outside the workspace
    if (filePath === editor.document.uri.fsPath) {
      this.linkedItem.hide();
      return;
    }

    const linked = this.storage.getNotes().filter(
      n => !n.archived && n.codeLink?.file === filePath
    );

    if (linked.length === 0) {
      this.linkedItem.hide();
      return;
    }

    const count = linked.length;
    this.linkedItem.text    = `$(notebook) ${count} note${count !== 1 ? 's' : ''} here`;
    this.linkedItem.tooltip = linked.map(n => `• ${n.title}`).join('\n') + '\n\nClick to open DevNotes';
    this.linkedItem.backgroundColor = undefined;
    this.linkedItem.show();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
