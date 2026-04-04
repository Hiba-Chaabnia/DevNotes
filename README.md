# DevNotes

A VS Code extension that gives you a **project-scoped note panel** — rich text notes that live alongside your code, organized in a sidebar view.

## Features

- **Sidebar panel** — quick access to all notes from the activity bar, with inline search and tag filtering
- **Rich text editor** — click ✏ on any note to open a full Tiptap editor with a formatting toolbar (bold, italic, headings, lists, task lists, code blocks, and more)
- **Quick Capture** — press `Ctrl+Alt+Q` from anywhere to create a note instantly; auto-links to the current file and line when an editor is focused
- **Code-linked notes** — attach a note to any file and line number; a gutter icon marks the line and hovering it shows the note title with a clickable link back to the note
- **Tags** — assign tags to notes for filtering; create custom tags with any color; delete tags you no longer need
- **Color-coded notes** — eight color options per note, changeable at any time from the card
- **Starred notes** — star important notes to pin them to the top of the list
- **Project-scoped storage** — notes are tied to the workspace, not a global account
- **Git-aware** — detects the current repo so notes stay relevant to the project
- **Opt-in sharing** — share individual notes with teammates through git, with nothing exposed by default

## Quick Capture

Press **`Ctrl+Alt+Q`** (Mac: **`Cmd+Alt+Q`**) from anywhere in VS Code to capture a note instantly without touching the mouse.

- **Editor open** — the note is automatically linked to your current file and cursor line. No extra steps needed.
- **No editor open** — a plain unlinked note is created.

In both cases a single input box appears, you type a title, and press `Enter`. The note lands in the sidebar immediately.

### Changing the keybinding

Every VS Code keybinding is user-overridable:

1. Open **Keyboard Shortcuts** with `Ctrl+K Ctrl+S`
2. Search for **DevNotes: Quick Capture Note**
3. Click the pencil icon and press your preferred combination

Or add it directly to `keybindings.json`:

```json
{
  "key": "ctrl+shift+`",
  "command": "devnotes.quickCapture"
}
```

## Getting Started

1. Install the extension (or run it via **F5** in the repo)
2. Click the **DevNotes** icon in the activity bar
3. Hit **+** to create a note — pick a title, color, and any tags upfront
4. Click the note content to edit inline, or press **✏** to open the full rich text editor

## Code-Linked Notes

Code-linked notes let you attach a note to a specific file and line number. The link is stored in the note's frontmatter and persists across sessions.

### Creating a link

There are two ways to link a note to a line:

**From the editor (new note):** right-click any line → **Add DevNote Here**, or press `Ctrl+Alt+Q`. An input box pre-labelled with the file and line appears; enter a title and the note is created already linked.

**From the sidebar (existing note):** click the chain-link icon (🔗) on any note card. The note is linked to wherever your cursor currently sits in the active editor. Clicking 🔗 on an already-linked note updates the link to the new position.

### Navigating from a note

Each linked note card shows a `{} filename:line` chip below its tags. Click the chip to open that file and jump directly to the linked line.

To remove a link, hover the chip and click the **✕** that appears on the right.

### Navigating from the editor

When you open a file that has notes linked to it, a small sticky-note icon appears in the left gutter on each linked line. Hovering the line text shows a tooltip with the note title as a clickable link — clicking it opens the note in the rich editor.

### Automatic link maintenance

When you rename or move a file using VS Code's Explorer or refactoring tools, all notes linked to the old path are updated automatically. Links to files moved outside of VS Code (e.g. via a terminal `mv` or `git mv`) are not updated automatically — the chip will appear greyed out with strikethrough to indicate the link is stale.

### Note format with a code link

```markdown
---
id: lp9k3fab
title: Null check missing
color: orange
tags: bug
starred: false
codeLink_file: src/auth/tokenService.ts
codeLink_line: 42
createdAt: 1712345678
updatedAt: 1712349000
---

Token is never validated before use here.
```

## Working with Tags

Tags are shown in the filter bar at the top of the sidebar. Click any tag to filter the list to matching notes; click multiple tags to broaden the selection.

- **Create a tag** — click **+ tag** at the right end of the tag bar, enter a name, and pick a color
- **Assign tags to a note** — click the **#** button on a card to open the tag picker; click any tag to toggle it on or off
- **Assign tags at creation** — tags can also be selected in the new-note form before the note is created
- **Delete a tag** — hover over a tag chip in the filter bar and click the **✕** that appears (built-in tags cannot be deleted)

## Sharing Notes with Teammates

Notes are private by default — the `.devnotes/` folder is fully gitignored and nothing appears in `git status` until you choose to share.

To share a note:

1. Click the **share icon** (⇄) on a note card — it highlights teal when sharing is active
2. A notification appears with the exact git commands to commit; click **Copy git commands** to copy them
3. Run the commands and push — teammates pull and the note appears automatically in their DevNotes panel

To un-share, click the share icon again to toggle it off, then commit the updated `.devnotes/.gitignore`.

## Storage Design

### Why file-based storage?

Previous versions stored notes in VS Code's internal `workspaceState` — a SQLite database inside the VS Code installation. While simple to implement, this had three fundamental problems:

1. **No git tracking.** Notes couldn't be versioned or recovered via `git log`.
2. **No sharing.** There was no way to share notes with teammates short of copying text manually.
3. **No portability.** Notes were locked to a single VS Code installation and inaccessible from any other tool.

Storing notes as files in the workspace solves all three: git handles versioning and sharing for free, and the files are readable without the extension.

### File layout

```
.devnotes/
  .gitignore  — ignores everything by default; updated when notes are shared
  tags.json   — custom tag definitions for this workspace
  <id>.md     — one file per note
```

### Note format

Each note is a plain Markdown file with a YAML frontmatter header:

```markdown
---
id: lp9k3fab
title: Auth token expiry bug
color: orange
tags: bug,important
starred: true
codeLink_file: src/auth/tokenService.ts
codeLink_line: 42
createdAt: 1712345678
updatedAt: 1712349000
---

## Steps to reproduce
1. Log in, wait 1 hour
2. Make any API call → 401
```

`codeLink_file` and `codeLink_line` are optional — notes without a code link simply omit them. Notes are readable and editable in any text editor, even without the extension installed.

### Personal vs. shared data

| File | Default | Committed when |
|---|---|---|
| `<id>.md` | Gitignored | Note marked as Shared |
| `tags.json` | Gitignored | Added manually by user |
| `.gitignore` | Gitignored | First note is shared |

## Why the canvas view was removed

An earlier version included a freeform canvas — a separate VS Code panel where notes could be arranged and resized spatially. It was removed for the following reasons:

- **Complexity for little gain.** The canvas required a dedicated webview, a separate esbuild bundle, and a `canvas-layout.json` file to persist card positions. This was a significant slice of the codebase serving a feature that duplicated what the sidebar already does.
- **State fragmentation.** The extension had to keep two panels in sync — any note mutation in the sidebar had to be pushed to the canvas and vice versa. This introduced subtle race conditions and made the message-passing logic harder to follow.
- **Personal layout, no sharing value.** Canvas positions were intentionally never committed to git, making the spatial arrangement purely personal. Given that notes themselves are the shareable artifact, the canvas added friction without adding collaboration value.
- **The sidebar covers the same need more simply.** The sidebar has inline search, tag filtering, starred sorting, and per-card editing — the same information the canvas displayed, without the overhead of a free-form layout engine.

## Development

```bash
npm install
npm run compile
```

Press **F5** in VS Code to launch the Extension Development Host.

| Script | Description |
|---|---|
| `npm run compile` | Full build (TypeScript + webview) |
| `npm run watch` | Watch TypeScript files |
| `npm run lint` | Lint source files |

## Tech Stack

- TypeScript + VS Code Extension API
- [Tiptap](https://tiptap.dev/) (rich text editor)
- [esbuild](https://esbuild.github.io/) (webview bundler)
