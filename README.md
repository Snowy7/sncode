<p align="center">
  <strong><span>Sn</span>Code</strong>
</p>

<p align="center">
  A desktop AI coding agent. Open a project, chat with the agent, and let it read, write, and run code for you.
</p>

<p align="center">
  <a href="https://github.com/Snowy7/sncode/releases"><img alt="Release" src="https://img.shields.io/github/v/release/Snowy7/sncode?style=flat-square&color=222" /></a>
  <a href="https://github.com/Snowy7/sncode/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/Snowy7/sncode?style=flat-square&color=222" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-333?style=flat-square" />
  <img alt="Electron" src="https://img.shields.io/badge/electron-37-333?style=flat-square" />
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-5.9-333?style=flat-square" />
</p>

---

## What is SnCode?

SnCode is a local-first desktop application that gives you an AI coding agent with full access to your project files and terminal. It works like Claude Code or Cursor's agent mode, but as a standalone Electron app.

You open a folder, start a conversation, and the agent uses built-in tools to explore, read, edit, and run commands in your codebase — all streamed in real-time.

## Features

**Agent & Tools**
- 9 built-in tools: `list_files`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `run_command`, `load_skill`, `spawn_task`
- Native streaming with Anthropic (Claude) and OpenAI (Codex) providers
- Sub-agent system — delegate to `general` (full access) or `explore` (read-only) sub-agents
- Parallel sub-agent execution with configurable concurrency
- Extended thinking / reasoning effort control (Anthropic up to High, Codex up to X-High)

**Workspace**
- Multi-project workspace with multiple threads per project
- AI-generated thread titles using the smallest available model
- File tree panel in the sidebar with click-to-preview
- Git integration: branch switching, commit, pull, push, stash, diff viewer
- Git repo initialization when no repo is detected
- Keyboard shortcuts (Ctrl+N, Ctrl+W, Ctrl+F, Ctrl+B, Ctrl+,)

**UI**
- Dark and light themes with CSS custom properties
- Syntax-highlighted code blocks (highlight.js, 16+ languages)
- Inline search with match highlighting and navigation
- Right sidebar for file preview, git diffs, and sub-agent details
- IDE-style diff viewer with line numbers, hunk headers, and status badges
- Image support (paste, drag-and-drop, file upload)
- Markdown rendering with GFM support
- Token usage display per response
- Todo/task checklist above the input area

**Skills System**
- Discover, load, and enable SKILL.md files from multiple sources
- Agent can dynamically load skills via the `load_skill` tool
- Per-project skill configuration

**Security**
- Credentials stored in OS keychain via `keytar`
- OAuth flows for Anthropic and OpenAI
- Sandboxed renderer with context isolation
- Tool operations scoped to project root
- Path traversal protection on file reads

## Installation

### From Source

```bash
git clone https://github.com/Snowy7/sncode.git
cd sncode
npm install
npm run dev
```

### Build & Package

```bash
# Production build
npm run build

# Package for distribution (Windows / macOS / Linux)
npm run package
```

Installers and portables are output to `release/`.

## Requirements

- **Node.js** 20+
- **Git** (for git integration features)
- An API key or OAuth token for **Anthropic** and/or **OpenAI**

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron 37 |
| Frontend | React 19, TypeScript 5.9 |
| Styling | Tailwind CSS v4 |
| AI SDKs | `@anthropic-ai/sdk`, `openai` |
| Credentials | `keytar` (OS keychain) |
| Validation | Zod |
| Code Highlighting | highlight.js |
| Markdown | react-markdown + remark-gfm |
| Bundler | Vite 7 |
| Testing | Vitest |
| Packaging | electron-builder |

## Project Structure

```
src/
  main/           # Electron main process
    main.ts        - Window, IPC handlers, agent orchestration
    agent.ts       - AI agent loop with streaming & tool calling
    store.ts       - JSON persistence
    project-tools.ts - File/command tools
    mcp.ts         - MCP client (in progress)
    skills.ts      - Skills discovery & loading
    oauth.ts       - OAuth flows
    credentials.ts - Keychain access
    preload.ts     - Context bridge
  renderer/       # React frontend
    App.tsx        - Main UI
    SettingsModal.tsx - Settings panel
    styles.css     - Theme variables & base styles
  shared/         # Shared between main & renderer
    types.ts       - All interfaces & types
    schema.ts      - Zod validation schemas
    models.ts      - Model catalog & helpers
```

## Verification

```bash
npm run lint        # ESLint
npm run typecheck   # TypeScript (both configs)
npm run test        # Vitest (33 tests)
npm run build       # Vite + tsc production build
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
