# AGENTS.md

This file provides coding guidance for AI agents (Claude, Codex, Antigravity) working in this repository.

## Overview

This is an **opencode plugin** for OpenAI ChatGPT OAuth authentication. It intercepts OpenAI SDK requests and transforms them for the ChatGPT backend API (`/backend-api/codex/responses`).

## Build & Test Commands

```bash
# Full build (TypeScript + assets)
npm run build

# Type checking only
npm run typecheck

# Run all tests
npm test

# Run a single test file (vitest)
npx vitest run test/auth.test.ts

# Run tests in watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

**Important**: `npm run build` is required before deployment as it copies critical assets (like `oauth-success.html`) to `dist/`.

## Code Style & Architecture

### General Guidelines
- **Language**: TypeScript with ES2022 features.
- **Modularity**: Small, focused modules in `lib/`. Logic is separated into `auth/`, `request/`, `prompts/`, and `config/`.
- **Naming**: Use camelCase for variables/functions, PascalCase for classes/interfaces, and UPPER_SENSE for constants.
- **Error Handling**: Use `try/catch` blocks. Wrap external API calls and file I/O. Use descriptive error messages.
- **Comments**: Focus on "why", not "what". Avoid redundant comments.

### Imports
- **Local Imports**: MUST use explicit `.js` extensions (e.g., `import { foo } from "./bar.js"`).
- **Node Built-ins**: MUST use the `node:` prefix (e.g., `import { join } from "node:path"`).
- **Order**: Node built-ins -> External packages -> Local modules.

### Types
- Always define interfaces for configuration and API payloads in `lib/types.ts`.
- Prefer `import type` for type-only imports.
- Maintain strict typing; avoid `any` unless absolutely necessary for low-level SDK interop.

## Architecture Principles

### 1. 7-Step Fetch Flow (`index.ts`)
1. Token management (refresh if needed).
2. URL rewriting (OpenAI -> ChatGPT backend).
3. Request transformation (model normalization, prompt injection).
4. Headers (OAuth token + Account ID).
5. Execution.
6. Optional logging.
7. Response handling (SSE to JSON conversion).

### 2. Request Transformation
- **Model Normalization**: Maps various `gpt-5` versions to standard internal names.
- **CODEX_MODE**: Enabled by default. Injects a bridge prompt for CLI parity.
- **Statelessness**: Uses `store: false` and reasoning persistence.

## Release Workflow

When asked to "bump version and push & release", follow this exact sequence:

0.  **Test**: Run `npm test` to ensure all tests pass.
1.  **Version Bump**: Use `npm version <patch|minor|major> -m "release: v%s"` (replace `<patch|minor|major>` based on the scope of changes).
2.  **Build**: Run `npm run build` to ensure static files in `dist/` are up to date for the new version.
3.  **Push**: Run `git push origin main --tags` to push the commit and tags to GitHub.
4.  **GitHub Release**: Auto-created via tag workflow (`.github/workflows/release.yml`).
5.  **Publish**: Run `npm publish` manually.

## File Locations

- **Plugin Config**: `~/.config/opencode/openai-codex-auth-config.json`
- **Cache**: `~/.config/opencode/cache/` (ETag-cached instructions and system prompts).
- **Logs**: `~/.config/opencode/logs/codex-plugin/` (if `ENABLE_PLUGIN_REQUEST_LOGGING=1`).
