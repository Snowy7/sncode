# Contributing to SnCode

Thanks for your interest in contributing.

## Getting Started

```bash
git clone https://github.com/Snowy7/sncode.git
cd sncode
npm install
npm run dev
```

This starts the Vite dev server on port 5188 and launches Electron with hot reload.

## Before Submitting

Run the full verification suite:

```bash
npm run lint        # ESLint
npm run typecheck   # TypeScript
npm run test        # Vitest
npm run build       # Production build
```

All four must pass before a PR will be reviewed.

## Code Guidelines

- **TypeScript** — No `any` types. Use explicit types for function parameters and return values.
- **Tailwind CSS v4** — Use `@import "tailwindcss"` and the Vite plugin. No `tailwind.config`.
- **CSS variables** — Use `var(--bg-base)`, `var(--text-primary)`, etc. for theme-aware colors. See `src/renderer/styles.css`.
- **Electron IPC** — All IPC channels are typed via `SncodeApi` in `src/shared/types.ts`. Add new channels there first, then implement in `main.ts` and `preload.ts`.
- **Validation** — Use Zod schemas in `src/shared/schema.ts` for all IPC input validation.
- **Tests** — Add tests for new shared logic. Test files live next to source files (`*.test.ts`).

## Architecture

| Layer | Path | Notes |
|-------|------|-------|
| Main process | `src/main/` | Node.js — IPC handlers, agent loop, file tools |
| Renderer | `src/renderer/` | React — UI components, state management |
| Shared | `src/shared/` | Types, schemas, model catalog — imported by both |

The main process runs the AI agent loop (`agent.ts`) with streaming and tool calling. The renderer communicates exclusively through typed IPC via the preload bridge.

## Pull Requests

- One feature or fix per PR.
- Write a clear description of what changed and why.
- Keep commits focused — don't bundle unrelated changes.
- If adding a new tool or IPC channel, update `types.ts`, `schema.ts`, `preload.ts`, and `main.ts` together.

## Issues

Use GitHub Issues for bug reports and feature requests. Include:
- Steps to reproduce (for bugs)
- Expected vs. actual behavior
- OS and Node.js version
