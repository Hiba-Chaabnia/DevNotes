# DevNotes

A VS Code extension that gives you a **project-scoped sticky-note canvas** — rich text notes that live alongside your code, organized visually on a free-form canvas.

## Features

- **Sidebar panel** — quick access to all notes from the activity bar
- **Canvas view** — arrange notes spatially, resize and reposition freely
- **Rich text editor** — powered by [Tiptap](https://tiptap.dev/), with support for bold, italic, task lists, and Markdown input
- **Project-scoped storage** — notes are tied to the workspace, not a global account
- **Git-aware** — detects the current repo so notes stay relevant to the project

## Getting Started

1. Install the extension (or run it via **F5** in the repo)
2. Click the **DevNotes** icon in the activity bar
3. Use the **Open Canvas** button to arrange notes visually, or create notes directly in the sidebar panel

## Development

```bash
npm install
npm run compile
```

Press **F5** in VS Code to launch the Extension Development Host.

| Script | Description |
|---|---|
| `npm run compile` | Full build (TypeScript + webviews) |
| `npm run watch` | Watch TypeScript files |
| `npm run watch:canvas` | Watch canvas webview only |
| `npm run lint` | Lint source files |

## Tech Stack

- TypeScript + VS Code Extension API
- [Tiptap](https://tiptap.dev/) (rich text editor)
- [esbuild](https://esbuild.github.io/) (webview bundler)
