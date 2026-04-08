# DevNotes

A VS Code extension that gives you a **project-scoped note panel** — rich text notes that live alongside your code, organized in a sidebar view.

## Features

- **Sidebar panel** — quick access to all notes from the activity bar, with inline search and tag filtering
- **Rich text editor** — click ✏ on any note to open a full Tiptap editor with a formatting toolbar (bold, italic, headings, lists, task lists, code blocks, and more)
- **Quick Capture** — press `Ctrl+Alt+Q` from anywhere to create a note instantly; auto-links to the current file and line when an editor is focused
- **Branch-scoped notes** — scope any note to a git branch; the sidebar detects your current branch live and lets you filter to branch-relevant notes instantly
- **Reminders** — set a reminder on any note; VS Code fires a notification when it's due with options to open, snooze, or dismiss
- **Export** — export a single note, a hand-picked selection, or all notes as Markdown, HTML, or clipboard copy
- **Image paste** — paste screenshots and images directly into the rich editor; images are saved to `.devnotes/assets/` and embedded inline
- **Note templates** — six built-in templates for common developer workflows (Bug Report, ADR, Meeting Notes, Standup, Feature Spec, Code Review); save any note as a custom template
- **Code-linked notes** — attach a note to any file and line number; a gutter icon marks the line and hovering it shows the note title with a clickable link back to the note
- **Tags** — assign tags to notes for filtering; create custom tags with any color; delete tags you no longer need
- **Color-coded notes** — eight color options per note, changeable at any time from the card
- **Starred notes** — star important notes to pin them to the top of the list
- **Project-scoped storage** — notes are tied to the workspace, not a global account
- **Git-aware** — detects the current repo so notes stay relevant to the project
- **Opt-in sharing** — share individual notes with teammates through git, with nothing exposed by default
- **Activity feed** — a live panel showing recent changes to shared notes, grouped by day with owner avatars and clickable titles
- **Conflict resolution UI** — when a shared note has a git merge conflict, a visual two-column panel lets you keep yours, keep theirs, or merge both versions
- **Note ownership** — notes are automatically attributed to the git user who created them; filter to your own notes instantly with the "Mine" button
- **Claude Code integration** — an MCP server lets Claude Code create notes, read them, append solutions, query todos, and generate standups or PR handoffs — all talking to the same `.devnotes/` files the extension uses

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

## Branch-Scoped Notes

Notes are global by default — visible regardless of which branch you're on. You can optionally scope any note to a specific branch so it surfaces only in that context and recedes everywhere else.

### Branch indicator

When you're inside a git repository, a `⎇ branch-name` pill appears in the sidebar top bar next to the project name. It updates live whenever you switch branches — no restart needed.

### Filtering to the current branch

Click the `⎇` button in the top bar to toggle **branch filter mode**. When active:

- Notes scoped to the **current branch** show normally
- Notes scoped to **other branches** are hidden
- **Global notes** (no branch set) always remain visible

Click the button again to return to the full list.

### Scoping a note to a branch

**From the card** — hover any note card to reveal the action buttons. Click the `⎇` branch button to scope that note to your current branch. The button highlights when the note is scoped. Click it again to make the note global.

**At creation (sidebar form)** — the new-note form shows a "Scope to current branch" checkbox when a branch is detected. If the branch filter is active when you open the form, the checkbox is pre-checked automatically.

**Via Quick Capture** (`Ctrl+Alt+Q`) — after the template step, a branch scope picker appears:

```
○ Global — visible on all branches      ← pre-selected by default
○ Scope to feature/auth                 ← pre-selected if filter is active
```

Press `Enter` to accept the default, or arrow to change it.

### Visual treatment of off-branch notes

When the branch filter is **inactive**, notes scoped to other branches remain visible but are dimmed to 42% opacity so they don't compete for attention. A small `⎇ branch-name` badge in the card footer shows which branch they belong to.

### How branch detection works

The current branch is read directly from `.git/HEAD` — no git commands or shell processes are involved. A file watcher on `.git/HEAD` detects branch switches instantly so the sidebar always reflects your current context.

Detached HEAD state (e.g. during a rebase or when checking out a commit directly) is handled gracefully — the branch indicator is hidden and no scoping options are offered.

### Note format with a branch scope

```markdown
---
id: lp9k3fab
title: Auth refactor plan
color: purple
tags: idea
branch: feature/auth-v2
createdAt: 1712345678
updatedAt: 1712349000
---

Notes specific to this feature branch.
```

## Reminders

Set a reminder on any note so it surfaces at the right time — useful for follow-ups, deferred bugs, or anything you want to revisit later.

### Setting a reminder

Hover any note card to reveal its action buttons, then click **🔔**. A picker appears with preset options:

| Option | When it fires |
|---|---|
| Tomorrow morning | Next day at 9:00 AM |
| In 2 days | Two days from now at 9:00 AM |
| Next week | Seven days from now at 9:00 AM |
| Next month | Thirty days from now at 9:00 AM |
| Custom date… | Any date you enter (YYYY-MM-DD), fires at 9:00 AM |

If the note already has a reminder, a **Remove reminder** option appears at the top of the picker.

### Reminder badge

Once set, a `🔔 Tomorrow`, `🔔 Apr 28`, or similar badge appears on the card — always visible, not just on hover. Overdue reminders display in a distinct reddish style so they stand out.

### Notification

When a reminder comes due, VS Code fires a notification:

```
🔔 DevNote: "Fix auth token expiry"
[Open]  [Snooze 1h]  [Snooze tomorrow]  [Dismiss]
```

| Action | What happens |
|---|---|
| **Open** | Opens the note in the rich editor; reminder stays set |
| **Snooze 1h** | Pushes the reminder forward by one hour |
| **Snooze tomorrow** | Reschedules to 9:00 AM the next day |
| **Dismiss** | Clears the reminder entirely |
| *(close popup)* | Auto-snoozed 1 hour to prevent re-firing immediately |

Reminders are checked every 60 seconds. If multiple notes are due simultaneously, notifications are shown concurrently — one per note.

### Note format with a reminder

```markdown
---
id: lp9k3fab
title: Fix auth token expiry
color: orange
tags: bug
remindAt: 1745226000000
createdAt: 1712345678
updatedAt: 1712349000
---

Token TTL is 1 hour — needs refresh token flow.
```

`remindAt` is a Unix timestamp in milliseconds. It is omitted from the frontmatter when no reminder is set.

## Note Templates

Templates let you scaffold a new note with a pre-defined structure, color, and tags in one click. Six templates are built in and ready to use — no setup required.

| Template | Pre-fills | Default color | Default tags |
|---|---|---|---|
| **Bug Report** | Steps to Reproduce, Expected, Actual, Environment | Orange | Bug |
| **ADR** | Context, Decision, Consequences | Purple | Reference |
| **Meeting Notes** | Attendees, Decisions, Action Items | Blue | Meeting |
| **Standup** | Done, Doing, Blocked | Green | Todo |
| **Feature Spec** | Goal, Acceptance Criteria, Notes, Open Questions | Cyan | Idea |
| **Code Review** | What to Check, Findings, Decision | Yellow | Reference |

### Using a template

**In the sidebar** — when creating a note, template chips appear between the title field and the color strip. Click one to pre-select it; the color and tags update automatically. Click **Blank** to deselect.

**In Quick Capture** (`Ctrl+Alt+Q`) — after typing the note title and pressing `Enter`, a template picker appears. **Blank** is pre-selected so pressing `Enter` again creates a plain note instantly. Arrow down to pick a template.

**In the rich editor** — the toolbar has two new buttons on the right:
- **`Tpl↓`** — applies a template to the current note (replaces the body; prompts to choose which template)
- **`Tpl↑`** — saves the current note's content as a new custom template (prompts for a name)

### Custom templates

Any note can become a template via `Tpl↑` in the editor toolbar. Custom templates are stored in `.devnotes/templates.json` and appear alongside the built-ins everywhere — sidebar picker, Quick Capture, and the editor.

To delete a custom template, remove its entry from `.devnotes/templates.json` directly.

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

## Image Paste

Paste any image directly into the rich editor — screenshots, diagrams, browser captures — and it appears inline in the note body, right where your cursor is.

### How to paste an image

1. Copy an image to your clipboard (`Print Screen`, `Ctrl+Shift+S`, snipping tool, or copy from a browser)
2. Open a note in the rich editor (click ✏ on a card)
3. Place your cursor where you want the image
4. Press `Ctrl+V`

The image appears immediately. The note auto-saves after one second, as usual.

### Where images are stored

Images are written to `.devnotes/assets/<note-id>-<timestamp>.png` on paste. The markdown stores a workspace-relative path:

```markdown
## Bug reproduction

Here is the error state I am seeing:

![image](.devnotes/assets/lp9k3fab-1712345678.png)

The modal appears before the data loads.
```

The `.devnotes/assets/` folder is gitignored by default — the same privacy model as notes. To share images alongside a shared note, add `!assets/` to `.devnotes/.gitignore`:

```
*
!.gitignore
!tags.json
!assets/
!<note-id>.md
```

### Supported formats

Any image format the clipboard provides — PNG, JPEG, GIF, WebP. The file extension is detected from the clipboard MIME type.

## Exporting Notes

Notes can be exported as Markdown files, HTML files, or copied to the clipboard — individually, in bulk, or as a hand-picked selection.

### Export a single note

Open a note in the rich editor (click ✏ on the card), then click the **Export** button in the toolbar. A format picker appears and the file is saved to a location of your choice.

### Export all notes

Open the **Command Palette** (`Ctrl+Shift+P`) and run **DevNotes: Export All Notes**.

### Export selected notes

1. Click the **checklist icon** (☰) in the sidebar top bar to enter selection mode
2. Click any note cards you want to include — a checkmark appears and the card is highlighted
3. Click **Export** in the bar that appears at the bottom of the sidebar
4. Pick a format and save

Click **Cancel** or the toggle button again to exit selection mode without exporting.

### Export formats

| Format | Output | Best for |
|---|---|---|
| **Markdown file** | `.md` with frontmatter-style metadata footer | Wikis, GitHub, other editors |
| **HTML file** | Styled `.html` with note colors preserved | Sharing with non-developers |
| **Copy to clipboard** | Markdown — ready to paste | Slack, Notion, GitHub issues |

Multiple notes exported to a single file are separated by `---` dividers with a header and timestamp.

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

## Activity Feed

The Activity panel gives your team a live view of what's been changing in the shared knowledge base — without opening a terminal or running `git log`.

### Where to find it

The **Activity** panel lives directly below the **Notes** panel in the DevNotes sidebar. Click it to expand. It refreshes automatically whenever notes change (e.g. after a `git pull`), and a ↺ button in the panel title bar lets you refresh manually.

### What it shows

All shared notes and notes created by Claude Code, sorted by most recently updated and grouped by day:

```
TODAY
  SM  Sara Morales  updated
      Onboarding flow ADR · 2h ago

  AT  Alex Turner  created
      DB migration notes · 5h ago

YESTERDAY
  ML  Marcus Lee  updated
      Perf regression in prod · yesterday
```

Each entry shows:
- **Owner avatar** — a color-coded initials circle. Each person always gets the same color for easy recognition across sessions. Claude Code entries show a purple **CC** avatar.
- **Owner name** — the git user who created the note. Your own entries are labelled with a small `you` badge. Claude Code entries show an **AI** badge.
- **Action** — `created` when the note was just added, `updated` when it has been edited since creation.
- **Note title** — click it to open the note directly in the rich editor.
- **Relative timestamp** — "just now", "2h ago", "yesterday", or a short date.

### Empty state

When no notes have been shared yet, the panel shows a prompt explaining how to share notes to start populating the feed.

### When it updates

The feed refreshes automatically on every external file change — this includes notes arriving after a `git pull`, shared by a teammate, or modified outside the extension. It reflects the current state of all shared notes in the workspace.

## Note Ownership

Every note is automatically attributed to the git user who created it, read from the local `.git/config` (with `~/.gitconfig` as a fallback). Ownership makes shared notes more useful — teammates can see at a glance who to ask about a given note.

### Owner badge

Each note with an owner shows a small circular initials badge and first name in the card footer. Hovering the badge shows the full name.

For example, a note created by **Jane Smith** shows `JS Jane` in the footer.

### Mine filter

Click the **person icon** (👤) in the sidebar top bar to activate the Mine filter. When active:

- Notes owned by **you** are shown normally
- Notes owned by **teammates** are hidden
- Notes with **no owner** (created before this feature) are always shown

Click the button again to return to the full list.

### How ownership is detected

On activation, DevNotes reads the `name` field from the `[user]` section in your `.git/config`. If not found there, it falls back to `~/.gitconfig`, then to the `email` field. If neither is set, the feature is silently disabled — the Mine filter button is hidden and no owner is assigned to new notes.

You can verify your git identity by running:

```bash
git config user.name
git config user.email
```

### Note format with ownership

```markdown
---
id: lp9k3fab
title: Auth token expiry bug
color: orange
tags: bug
owner: Jane Smith
createdAt: 1712345678
updatedAt: 1712349000
---
```

Ownership is stored as a plain string — the name or email, exactly as set in git config.

## Conflict Resolution

When two teammates edit the same shared note and one pulls after the other has pushed, git writes conflict markers into the `.devnotes/<id>.md` file. DevNotes detects this automatically and handles it without requiring any raw file editing.

### How it works

1. **Detection** — the file watcher fires after a `git pull`. DevNotes checks for conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) before parsing. If found, the note is flagged as conflicted and a ⚠ notification fires:

   ```
   ⚠ Conflict in shared note: "Auth token bug"   [Resolve]  [Dismiss]
   ```

2. **Sidebar indicator** — the note card shows a persistent `⚠ Conflict — click to resolve` badge with a red left-border stripe so it can't be missed.

3. **Resolution panel** — clicking **Resolve** (in the notification or on the badge) opens a two-column panel:

   ```
   ┌─────────────────────────┬────────────────────────────────┐
   │  YOUR VERSION  (HEAD)   │  INCOMING  (feature/auth-v2)   │
   │  ─────────────────────  │  ──────────────────────────    │
   │  color: orange          │  color: blue          (★ diff) │
   │  tags: bug, important   │  tags: bug            (★ diff) │
   │                         │                                │
   │  ## My approach…        │  ## Teammate's approach…       │
   │                         │                                │
   │  [✓ Keep mine]          │             [✓ Keep theirs]    │
   └─────────────────────────┴────────────────────────────────┘
              [⊕ Keep both]   [Edit raw file manually]
   ```

   Fields that differ between the two versions are highlighted.

### Resolution options

| Option | What it does |
|---|---|
| **Keep mine** | Keeps the HEAD version entirely; discards the incoming changes |
| **Keep theirs** | Keeps the incoming version entirely; discards your local changes |
| **Keep both** | Merges the two versions: tags are unioned, content is concatenated with a `---` divider, single-value fields (color, title) come from your version |
| **Edit raw file** | Opens the `.md` file in VS Code for manual conflict editing |

### When to use "Keep both"

"Keep both" is most useful when both versions contain independent, non-overlapping information — for example, two people added different action items to a Meeting Notes, or two separate bug findings to a Code Review note. The merged result includes everything and can be cleaned up afterward.

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
  .gitignore      — ignores everything by default; updated when notes are shared
  tags.json       — custom tag definitions for this workspace
  templates.json  — custom note templates (built-ins are hardcoded, not stored here)
  assets/         — images pasted into notes (gitignored by default)
  <id>.md         — one file per note
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

`codeLink_file`, `codeLink_line`, `branch`, `owner`, and `remindAt` are all optional — notes without these fields simply omit them. Notes are readable and editable in any text editor, even without the extension installed.

### Personal vs. shared data

| File | Default | Committed when |
|---|---|---|
| `<id>.md` | Gitignored | Note marked as Shared |
| `tags.json` | Gitignored | Added manually by user |
| `templates.json` | Gitignored | Added manually by user |
| `.gitignore` | Gitignored | First note is shared |

## Why the canvas view was removed

An earlier version included a freeform canvas — a separate VS Code panel where notes could be arranged and resized spatially. It was removed for the following reasons:

- **Complexity for little gain.** The canvas required a dedicated webview, a separate esbuild bundle, and a `canvas-layout.json` file to persist card positions. This was a significant slice of the codebase serving a feature that duplicated what the sidebar already does.
- **State fragmentation.** The extension had to keep two panels in sync — any note mutation in the sidebar had to be pushed to the canvas and vice versa. This introduced subtle race conditions and made the message-passing logic harder to follow.
- **Personal layout, no sharing value.** Canvas positions were intentionally never committed to git, making the spatial arrangement purely personal. Given that notes themselves are the shareable artifact, the canvas added friction without adding collaboration value.
- **The sidebar covers the same need more simply.** The sidebar has inline search, tag filtering, starred sorting, and per-card editing — the same information the canvas displayed, without the overhead of a free-form layout engine.

## Claude Code Integration (MCP Server)

DevNotes ships a companion MCP (Model Context Protocol) server that connects Claude Code directly to your notes. Once registered, Claude can create notes mid-conversation, read them back, append solutions, query your open todos, and generate standups or PR handoffs — all reading and writing the same `.devnotes/` files the VS Code extension uses. Notes you create via Claude appear instantly in the sidebar, and notes you write in the editor are immediately visible to Claude.

### Setup

**1. Build the server**

```bash
cd mcp-server
npm install
npm run build
```

**2. Register it with Claude Code**

Click the **bot icon** (🤖) in the DevNotes sidebar top bar. The button detects your extension path and runs `claude mcp add --scope user` to register the server, then confirms with a notification. If Claude Code is not installed it tells you so and links to the download page.

Alternatively, register it from the terminal using the Claude Code CLI:

```bash
claude mcp add --scope user devnotes node /absolute/path/to/DevNotes/mcp-server/dist/index.js
```

The `--scope user` flag registers the server globally across all projects. Claude Code stores the config in its own location per platform — the CLI handles this automatically.

**3. Restart Claude Code** — the `devnotes` server will be available in every session from that point on.

### Workspace detection

The server finds your `.devnotes/` folder automatically — it walks up from the current working directory looking for one. You can override this with an environment variable if needed:

```json
{
  "mcpServers": {
    "devnotes": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/index.js"],
      "env": { "DEVNOTES_WORKSPACE": "/path/to/your/project" }
    }
  }
}
```

### Tools

Claude can call these tools at any point in a conversation:

| Tool | What it does |
|---|---|
| `create_note` | Creates a new note with title, content, tags, color, optional code link, and optional reminder (`remindAt`) |
| `get_note` | Retrieves a note by ID or title (fuzzy match). Returns the full content and metadata |
| `list_notes` | Lists notes with optional filters: tag, search text, branch, or starred status |
| `append_to_note` | Appends a new section to an existing note — preserves the original body |
| `update_note` | Updates metadata: title, tags, color, starred, shared, owner, or reminder (`remindAt`) |
| `complete_todo` | Marks matching `- [ ]` items as done (`- [x]`) inside a note — matched by substring |
| `delete_note` | Permanently deletes a note. Requires `confirm: true` as a safety guard |
| `get_todos` | Extracts every unchecked `- [ ]` item across all notes into a unified list |
| `get_stale_notes` | Finds notes not updated in N days that still have open todos or a bug tag |
| `note_history` | Shows the git commit history for a note file. Requires the workspace to be a git repo and the note to be tracked by git. |
| `log_session` | Appends a timestamped Done / In-progress / Blocked entry to a persistent session log. Called automatically at the end of every work session. |

### Resources

Resources are data Claude can read passively — without you asking — as background context:

| Resource URI | What it contains |
|---|---|
| `devnotes://todos` | All unchecked `- [ ]` items across every note |
| `devnotes://recent` | Notes created or updated in the last 72 hours |
| `devnotes://session-log` | The last 5 session log entries (what was worked on in previous Claude Code sessions) |
| `devnotes://branch` | All notes scoped to the current git branch |

### Prompts

Prompts are pre-built workflows. Invoke them with `/mcp__devnotes__<name>` in Claude Code, or ask Claude to run them by name:

| Prompt | What it does |
|---|---|
| `solve` | Loads a note and its linked source file into context, then asks Claude to diagnose and fix the problem. Saves the solution back as an appended `## Solution` section. |
| `standup` | Reads notes updated in the last 24 hours and writes a Done / Doing / Blocked standup update |

### Example conversations

```
"I found a null pointer in parseConfig when the input is empty — make a bug note"
→ Claude calls create_note with the title, tags: ["bug"], color: "orange",
  and links it to the current file if one is open.

"What are my open todos?"
→ Claude calls get_todos and returns a grouped list across all notes.

"Mark 'write tests' as done in my Auth bug note"
→ Claude calls complete_todo, ticking off the matching - [ ] item in place.

"Delete the scratch note from yesterday"
→ Claude calls delete_note with confirm: true after locating the note by title.

"Look at my 'Auth bug' note and suggest a fix"
→ Claude calls get_note, reads the content and linked code file,
  reasons about it, and calls append_to_note to save the solution.

"Generate my standup for today"
→ Claude runs the standup prompt against notes updated in the last 24 hours.

```

### Session log

The `log_session` tool writes timestamped entries to a special `session-log` note (`session-log.md` in `.devnotes/`). Over time this becomes a searchable engineering diary — and since the last 5 entries are included as a resource in every session, Claude always starts with context about what you were working on previously.

```
"We're done for today — log what we did"
→ Claude calls log_session with a summary of the session's work,
  what's still in progress, and any blockers.
```

### Claude Code activity in the feed

Every note the MCP server creates is automatically attributed to **Claude Code** (`owner: 'Claude Code'`). The Activity feed panel surfaces these notes alongside shared teammate notes — Claude's entries appear with a purple **CC** avatar and an **AI** badge so they're immediately distinguishable.

The footer of the activity feed shows a split count: `3 shared notes · 2 from Claude`.

### Sync with the VS Code extension

The MCP server reads and writes `.devnotes/*.md` files directly. Notes created by Claude appear in the sidebar within a second (the extension's file watcher picks them up automatically). If you want to see them immediately, click the **↻ Refresh** button in the DevNotes sidebar.

---

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
