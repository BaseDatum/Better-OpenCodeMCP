# Agent Instructions — Better-OpenCodeMCP

## What This Is

MCP server (stdio transport) that bridges Claude Code to OpenCode CLI.
Fork of frap129/opencode-mcp-tool with async task execution, process pooling, and concurrency fixes.
Package: `opencode-mcp-tool` v2.0.0 | License: MIT | Node >=16

## Build & Dev

```bash
npm install          # install deps
npm run build        # tsc → dist/
npm run dev          # build + run
npm start            # run from dist/
npm test             # vitest run (293 tests)
npm run test:watch   # vitest in watch mode
npm run lint         # tsc --noEmit (type check only)
```

Package manager: **npm** (lockfile is package-lock.json).

## Local Testing

```bash
npm run build
node dist/index.js                          # auto-detects model from OpenCode state
node dist/index.js --model google/gemini-2.5-pro  # explicit model
node dist/index.js --setup                  # interactive config wizard
node dist/index.js --log-level debug        # verbose logging
```

To test as an MCP server in Claude Code:
```bash
claude mcp add opencode -- node /absolute/path/to/dist/index.js
```

Config file written by `--setup`: `~/.config/opencode-mcp/config.json`

## Testing

Framework: **Vitest** (v4, vitest.config.ts). Tests in two locations:
- `src/__tests__/` — integration, JSON parser, sessions, task persistence
- `src/tests/` — concurrency, process pool, tool registry

30-second test timeout configured globally.

## Source Layout

```
src/
  index.ts              # entrypoint — CLI arg parsing, MCP server setup (StdioServerTransport)
  config.ts             # runtime config singleton
  constants.ts          # protocol version, process limits
  config/               # config loading, model auto-detection
  commands/setup.ts     # interactive setup wizard
  tools/                # MCP tool definitions (opencode, sessions, respond, cancel, health)
    registry.ts         # tool registration system
  tasks/                # async task manager
  persistence/          # task state persistence to disk
  utils/                # logger, helpers
```

## Conventions

- ESM (`"type": "module"` in package.json), all imports use `.js` extensions
- Zod schemas for all tool input validation
- `prepare` hook runs build on `npm install` (matters for npm link)
- CI tests on Node 16/18/20 (GitHub Actions, ubuntu-latest)
- Windows: process spawning uses `shell: true`; termination uses `taskkill /T /F`

---

Session completion and beads workflow are in the global CLAUDE.md.
