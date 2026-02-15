# SNCode

SNCode is a desktop AI coding agent built with Electron + React + Tailwind CSS.

## Production-ready baseline included

- Multi-project workspace (each project is a local folder).
- Multiple threads under every project.
- Provider management for Anthropic and Codex/OpenAI.
- Credentials stored in OS keychain via `keytar` (not in app state JSON).
- Typed and validated IPC contracts (`zod`).
- Agent execution status events, cancellation support, and tool activity updates.
- Built-in project tools the model can use:
  - list files
  - read files
  - write files
  - run shell commands (scoped to selected project folder)
- Renderer error boundary and hardened Electron navigation policy.
- Tailwind-based desktop UI.
- Linting, typechecking, and tests.
- Packaging config via `electron-builder`.

## Development

```bash
npm install
npm run dev
```

## Verification

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

## Packaging

```bash
npm run package
```

Artifacts are generated under `release/`.

## Notes

- State file path is `app.getPath("userData")/sncode-state.json`.
- Credentials are stored in the OS keychain by provider ID.
- Tool operations are restricted to the selected project root path.
