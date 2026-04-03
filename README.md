# DevNotes

A VS Code extension that gives you a **project-scoped note panel** — rich text notes that live alongside your code, organized in a sidebar view.

## Features

- **Sidebar panel** — quick access to all notes from the activity bar, with inline search and tag filtering
- **Rich text editor** — click ✏ on any note to open a full Tiptap editor with a formatting toolbar (bold, italic, headings, lists, task lists, code blocks, and more)
- **Tags** — assign tags to notes for filtering; create custom tags with any color; delete tags you no longer need
- **Color-coded notes** — eight color options per note, changeable at any time from the card
- **Starred notes** — star important notes to pin them to the top of the list
- **Project-scoped storage** — notes are tied to the workspace, not a global account
- **Git-aware** — detects the current repo so notes stay relevant to the project
- **Opt-in sharing** — share individual notes with teammates through git, with nothing exposed by default

## Getting Started

1. Install the extension (or run it via **F5** in the repo)
2. Click the **DevNotes** icon in the activity bar
3. Hit **+** to create a note — pick a title, color, and any tags upfront
4. Click the note content to edit inline, or press **✏** to open the full rich text editor

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
createdAt: 1712345678
updatedAt: 1712349000
---

## Steps to reproduce
1. Log in, wait 1 hour
2. Make any API call → 401
```

Notes are readable and editable in any text editor, even without the extension installed.

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
