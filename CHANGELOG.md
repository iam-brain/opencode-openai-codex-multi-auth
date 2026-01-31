# Changelog

All notable changes to this project are documented here. Dates use the ISO format (YYYY-MM-DD).

## [4.5.21] - 2026-01-31

**Parallel Rotation Resilience release**: atomic sync across multiple machine sessions.

### Fixed
- **Unauthorized Recovery**: main request loop now recovers from `401 Unauthorized` by re-syncing with disk and retrying, matching the official Codex CLI's robustness.
- **Ghost Rotations**: `codex-status` tool now persists rotated tokens to disk immediately, preventing drift that previously invalidated other active sessions.
- **Token Overwrite Race**: implemented **Timestamp Arbitration** in storage merges; the most recently active session (`lastUsed`) now always wins, preventing stale sessions from corrupting the authoritative machine state.

### Changed
- **Strict Identity Uniqueness**: all account matching now strictly uses the `accountId + email + plan` composite key to ensure global uniqueness across different workspaces and subscriptions.

## [4.5.20] - 2026-01-31

**Reliability & Identity Hardening release**: codex-status stability, memory safety, and identity-based tracking.

### Changed
- **codex-status Read-Only**: tool no longer forces token refresh; uses existing valid tokens and falls back to cached snapshots on failure.
- **Identity-Based Trackers**: `HealthScoreTracker` and `TokenBucketTracker` now key on `accountId|email|plan` instead of array index for stability across account changes.
- **Periodic Cleanup**: both trackers now auto-prune stale entries (24h for health, 1h for tokens) to prevent memory growth.
- **Console Logging**: migrated `console.error` calls to `logWarn` to respect debug settings and avoid TUI corruption.
- **Command Templates**: updated slash commands to output results exactly as returned by tools.

### Added
- **logCritical()**: new always-enabled logger for critical issues that bypass debug flags.
- **Toast Notifications**: integrated debounced toast when switching accounts due to rate limits (respects `quietMode` config).
- **Debug Logging**: added status fetch failure logging when `OPENCODE_OPENAI_AUTH_DEBUG=1`.

### Fixed
- **Memory Leak**: `RateLimitTracker` now cleans up stale entries periodically (every 60s).

## [4.5.19] - 2026-01-31

**Slash Commands release**: register codex tools as TUI slash commands.

### Added
- **Slash Commands**: `/codex-status`, `/codex-switch-accounts`, `/codex-toggle-account` now available via config hook.

## [4.5.18] - 2026-01-31

**Tool Consolidation release**: finalized renaming of status and account management tools to match the `codex-*` namespace.

### Changed
- **Tool Consolidation**: renamed `openai-accounts` and `status-codex` to a single authoritative `codex-status` tool.
- **Account Management**: renamed `openai-accounts-switch` to `codex-switch-accounts` and `openai-accounts-toggle` to `codex-toggle-account`.
- **Lazy Refresh**: tool calls now only refresh tokens if they are within the `tokenRefreshSkewMs` window (default 60s), reducing unnecessary network roundtrips.
- **Code Hardening**: implemented SSE stream memory guards (1MB buffer limit) and removed redundant imports and logic in `index.ts`.

## [4.5.17] - 2026-01-31

**Authoritative Status release**: active fetching from official OpenAI `/wham/usage` endpoints and perfect protocol alignment.

### Added
- **Active Usage Fetching**: tools now actively fetch real-time rate limit data from `https://chatgpt.com/backend-api/wham/usage` (ChatGPT plans) and `https://api.openai.com/api/codex/usage` (API plans).
- **Protocol Alignment**: refactored `CodexStatusManager` to match the official `codex-rs v0.92.0` data structures and TUI formatting.
- **Detailed Reset Dates**: long-term resets (>24h) now display the full date and time (e.g., `resets 18:10 on 5 Feb`).

### Changed
- **Inverted Usage Display**: status bars now show **"% left"** instead of "% used", correctly representing remaining quota.
- **Standardized Labels**: updated window labels to "5 hour limit:" and "Weekly limit:".
- **Proactive Tool Hydration**: tool calls now force a token refresh and identity repair to ensure the authoritative `/usage` endpoint receives a valid Bearer token.
- **Enhanced UI Alignment**: applied strict padding and "Always Render Both" logic to ensure vertical and horizontal table stability even with missing or "unknown" data.

### Fixed
- **Memory Safety**: added length guards to the SSE stream buffer to prevent memory exhaustion from malformed backend responses.
- **Stale Data Capture**: replaced fragile SSE/Header capture fallbacks with reliable direct polling of the official usage API.

## [4.5.16] - 2026-01-31



## [4.5.15] - 2026-01-31

**Cache Retention release**: automatic pruning of stale snapshot data.

### Added
- **Snapshot Retention**: implemented automatic pruning for snapshots older than 7 days to prevent accumulation of stale or contaminated data.
- **Diagnostic Logging**: added `OPENCODE_OPENAI_AUTH_DEBUG=1` support for troubleshooting identity key generation and header parsing.

## [4.5.14] - 2026-01-30

**Global Cache path release**: ensure cross-process visibility.

### Fixed
- **Global Snapshot Path**: corrected `getCachePath` to always use the system configuration directory (`~/.config/opencode/cache`), ensuring that rate limit data captured by the proxy is visible to CLI tools regardless of project scope.
- **Table Alignment**: refactored `openai-accounts` and `status-codex` into a strict ASCII table format to prevent horizontal shifting.

## [4.5.13] - 2026-01-30

**Storage Hardening release**: restrictive permissions for account files.

### Changed
- **Security Hardening**: primary account storage now uses restrictive `0600` permissions on creation/update, matching the hardening applied to snapshots.

## [4.5.12] - 2026-01-30

**Final Hardening & Concurrency Safety release**: async status manager, promise-based initialization, and cross-process safety.

### Added
- **Detailed Inline Errors**: 429 rate-limit responses now return structured inline account status summaries showing which accounts are exhausted and their reset times.

### Changed
- **Async Status Hardening**: refactored `CodexStatusManager` to use non-blocking async I/O (`fs.promises`) and promise-based initialization gates to prevent concurrency races.
- **Cross-Process Hydration**: ensured status snapshots are stored globally even when using per-project account storage, allowing all projects to share real-time rate limit visibility.
- **Tool UI Refinement**: refactored `openai-accounts` and `status-codex` output into a strictly aligned ASCII table format for better readability.
- **Lost Updates Prevention**: implemented timestamp-based (`updatedAt`) merge arbitration under lock (`proper-lockfile`) to ensure newest state wins across concurrent processes.
- **Security Hardening**: primary accounts and snapshots cache files now use restrictive `0600` permissions.

### Fixed
- **Initialization Race**: resolved a race condition where concurrent calls to the status manager could result in stale or partial data during the initial disk load.

### Tests
- **Test Fixture Alignment**: refactored all unit tests to strictly use repository fixtures for identities and snapshots, removing all hardcoded mocks.

## [4.5.11] - 2026-01-30

**Persistence fix release**: cross-process snapshot visibility.

### Changed
- **Persistent Snapshots**: rate limit data is now persisted to `~/.config/opencode/cache/codex-snapshots.json` for cross-process visibility between the proxy and CLI tools.

### Tests
- **Status Fixtures**: added `codex-status-snapshots.json` and `codex-headers.json` for deterministic testing of rate limit parsing and rendering.

## [4.5.10] - 2026-01-30

**Per-project storage & Codex status release**: isolated account storage and real-time rate limit monitoring.

### Added
- **Codex Status Tool**: added `status-codex` and `openai-accounts` tools to display real-time ASCII status bars for rate limits and credits.
- **Per-Project Storage**: added `perProjectAccounts` config flag to isolate OpenAI accounts within `.opencode/` for specific projects.

### Changed
- **Identity Matching**: standardized plan casing (e.g., "plus" -> "Plus") at the storage level to ensure reliable matching.

### Fixed
- **Concurrent Session Safety**: implemented `originalRefreshToken` tracking and disk-fallback lazy loading to prevent token drift and rollbacks in multi-process environments.

## [4.5.9] - 2026-01-30

**CI publish fix**: use Node.js 24+ (npm 11.5.1+) so npm Trusted Publishing (OIDC) is supported in GitHub Actions.

### Fixed
- **Release workflow**: publish now uses npm Trusted Publishing (OIDC) instead of legacy tokens.

## [4.5.8] - 2026-01-30

**CI publish attempt**: `v4.5.8` tag publish failed because the GitHub runner npm CLI did not support Trusted Publishing.

## [4.5.7] - 2026-01-30

**Hardening release**: account repair/quarantine UX, safer locking, and better production ergonomics.

### Added
- **Repair + quarantine UX**: detect corrupt storage / legacy identity records and prompt to repair during login; auto-repair once on first send when no eligible accounts.
- **Wrap-safe messaging**: toast/status formatting helpers to keep TUI output readable.
- **Account controls**: `openai-accounts-toggle` tool to enable/disable an account by index.

### Changed
- **Storage locking**: lock paths ensure the storage file exists before acquiring `proper-lockfile` (antigravity-style).
- **Migration safety**: legacy migration runs under the storage lock to avoid cross-process races.
- **Quarantine safety**: quarantine copies attempt `0600` and older quarantine files may be pruned to avoid unbounded buildup.
- **Write robustness**: `.tmp` files are cleaned up on save failures.
- **Manual OAuth security**: validate OAuth `state` when provided; recommend pasting the full redirect URL.
- **Release pipeline**: GitHub Actions publishes to npm via OIDC provenance.

### Fixed
- **Disabled account safety**: disabled accounts are excluded from refresh/hydration and proactive refresh.

### Documentation
- **Multi-account docs**: document repair/quarantine behavior, account toggle, and retention notes.

## [4.5.6] - 2026-01-29

**Multi-account parity release**: strict identity, account management, and refresh/hydration reliability.

### Added
- **Account management**: `opencode auth login` now offers manage mode to enable/disable accounts; storage persists `enabled`.
- **Background refresh**: proactive refresh queue/scheduler can refresh tokens ahead of expiry (config-flagged).
- **Multi-account stability**: locking/rotation hardening under load.

### Changed
- **Strict identity matching**: accounts match on `accountId` + `email` + `plan`.
- **Legacy hydration**: refresh-based hydration fills missing email/accountId/plan, throttled and skips disabled accounts.
- **Wait-time calculation**: hydrates legacy identities before wait-time checks and ignores disabled accounts.
- **Rate-limit backoff**: exponential backoff replaces linear retry scaling.

### Fixed
- **Refresh token safety**: lock refresh usage and retry when disk updates occur.
- **Active index remap**: active indices remap after refresh token dedupe.
- **Legacy identity hydration**: plan-only records hydrate via refresh tokens; access-token claims used when id token lacks claims.
- **Disabled account safety**: disabled accounts are excluded from hydration and wait-time calculations.

### Tests
- **Fixtures/JWTs**: align account fixtures and JWT payloads; add hydration fallback coverage.
- **Config defaults**: sync plugin config default tests.

### Documentation
- **Multi-account docs**: updated manage flow, identity rules, and storage fields.

## [4.5.5] - 2026-01-28

**Release metadata**: version bump only (no functional changes).

### Changed
- Release/tag metadata only.

## [4.5.4] - 2026-01-28

**Bugfix release**: avoid plan collision during auth fallback hydration.

### Fixed
- **Hydration fallback**: avoid plan collisions when hydrating auth fallback.

### Changed
- **Repo hygiene**: removed AGENTS doc from repo.

## [4.5.3] - 2026-01-28

**Bugfix + tooling release**: migrate plugin paths and protect account saves.

### Added
- **Release automation**: auto-tag release workflow.

### Fixed
- **Plugin path migration**: migrate plugin paths and protect account saves.

## [4.5.2] - 2026-01-27

**Bugfix release**: match accounts by plan and render OAuth version.

### Fixed
- **Account matching**: include plan to prevent overwrites.
- **OAuth success banner**: render OAuth version on success page.

## [4.5.1] - 2026-01-27

**Bugfix release**: atomic account saves and rate-limit key dedupe.

### Fixed
- **Storage**: account saves are atomic.
- **Rate-limit keys**: dedupe per-family/model keys.

## [4.5.0] - 2026-01-27

**Feature release**: align login UX and capture plan info.

### Added
- **Plan capture**: store ChatGPT plan from OAuth JWT.

### Changed
- **Login UX**: align OpenAI login flow with antigravity UX.

## [4.4.9] - 2026-01-27

**Bugfix release**: safer installer plugin removal.

### Fixed
- **Installer plugin removal**: avoid substring collisions when removing plugin entries.

## [4.4.8] - 2026-01-27

**Bugfix release**: installer consistency improvements.

### Fixed
- **Installer pinning**: keep plugin at `@latest` during install/updates.

### Changed
- **Repo hygiene**: ignore local `BUG_FIXES` notes.

## [4.4.7] - 2026-01-25

**Security release**: patch JWT middleware vulnerability.

### Fixed
- **Security**: `hono` JWT middleware vulnerability resolved (audit fix).

### Changed
- **Repo hygiene**: ignore local third-account test script.

## [4.4.6] - 2026-01-25

**Bugfix release**: make TUI login non-interactive; improve account migration reliability.

### Fixed
- **CLI vs TUI auth mismatch**: `opencode auth login` keeps the full multi-account workflow (add/fresh + add-another prompts), while TUI-based login no longer overlays terminal prompts on the UI.
- **TUI login flow**: provider selection in the TUI now performs a single login and returns to the provider list (antigravity-style behavior).

### Changed
- **Migration behavior**: when both legacy (`~/.opencode/`) and new (`~/.config/opencode/`) account files exist, the plugin merges and deduplicates accounts instead of ignoring the legacy file.
- **Debug gating**: auth/storage debug output stays behind `OPENCODE_OPENAI_AUTH_DEBUG=1`.

## [4.4.3] - 2026-01-23

**Compliance release**: third-party notices for MIT-derived code.

### Added
- `THIRD_PARTY_NOTICES.md` with the MIT license text for `NoeFabris/opencode-antigravity-auth`.

## [4.4.4] - 2026-01-23

**Bugfix release**: fixes broken terminal input after OAuth login.

### Fixed
- Restores terminal raw mode/mouse tracking after interactive auth prompts to prevent mouse movements being interpreted as typed input.

## [4.4.5] - 2026-01-23

**Bugfix release**: align account/config storage with OpenCode's config directory.

### Changed
- Store `openai-codex-accounts.json` and `openai-codex-auth-config.json` under `~/.config/opencode/`.
- Automatically migrate legacy files from `~/.opencode/` on startup.

### Installer
- `--uninstall --all` removes both the new and legacy locations.

## [4.4.2] - 2026-01-23

**Multi-account strategy release**: hybrid selection and expanded docs.

### Added
- **Hybrid selection strategy**: `accountSelectionStrategy: "hybrid"` (health score + token bucket + LRU bias).

### Documentation
- **Multi-account docs**: Expanded to include strategy descriptions and manual configuration examples (antigravity-inspired).

## [4.4.1] - 2026-01-22

**Fork maintenance release**: publish-ready metadata + installer alignment.

### Changed
- **npm publish compatibility**: Fixes `bin` paths so `npx -y opencode-openai-codex-multi-auth@latest` runs the installer.
- **Fork docs/installer**: Uses the fork package name by default and migrates legacy identifiers.
- **OAuth success page**: Updates banner to the fork package name and version.

## [4.4.0] - 2026-01-09

**Maintenance release**: OAuth success page version sync.

### Changed
- **OAuth success banner**: Updates the success page header to display the current release version.

## [4.3.1] - 2026-01-08

**Installer safety release**: JSONC support, safe uninstall, and minimal reasoning clamp.

### Added
- **JSONC-aware installer**: preserves comments/formatting and prioritizes `opencode.jsonc` over `opencode.json`.
- **Safe uninstall**: `--uninstall` removes only plugin entries + our model presets; `--all` removes tokens/logs/cache.
- **Installer tests**: coverage for JSONC parsing, precedence, uninstall safety, and artifact cleanup.

### Changed
- **Default config path**: installer creates `~/.config/opencode/opencode.jsonc` when no config exists.
- **Dependency**: `jsonc-parser` added to keep JSONC updates robust and comment-safe.

### Fixed
- **Minimal reasoning clamp**: `minimal` is now normalized to `low` for GPT‑5.x requests to avoid backend rejection.

## [4.3.0] - 2026-01-04

**Feature + reliability release**: variants support, one-command installer, and auth/error handling fixes.

### Added
- **One-command installer/update**: `npx -y opencode-openai-codex-auth@latest` (global config, backup, cache clear) with `--legacy` for OpenCode v1.0.209 and below.
- **Modern variants config**: `config/opencode-modern.json` for OpenCode v1.0.210+; legacy presets remain in `config/opencode-legacy.json`.
- **Installer CLI** bundled as package bin for cross-platform use (Windows/macOS/Linux).

### Changed
- **Variants-aware request config**: respects host-supplied `body.reasoning` / `providerOptions.openai` before falling back to defaults.
- **OpenCode prompt source**: updates to the current upstream repository (`anomalyco/opencode`).
- **Docs/README**: install-first layout with leaner guidance and explicit legacy path.

### Fixed
- **Headless login fallback**: missing `xdg-open` no longer fails the OAuth flow; manual URL paste stays available.
- **Error handling alignment**: refresh failures throw; usage-limit 404s map to retryable 429s where appropriate.
- **AGENTS.md preservation**: protected instruction markers stop accidental filtering of user instructions.
- **Tool-call integrity**: orphan outputs now match `local_shell_call` and `custom_tool_call` (Codex CLI parity); unmatched outputs preserved as assistant messages.
- **Logging noise**: debug logging gated behind flags to prevent stdout bleed.

## [4.2.0] - 2025-12-19

**Feature release**: GPT 5.2 Codex support and prompt alignment with latest Codex CLI.

### Added
- **GPT 5.2 Codex model family**: Full support for `gpt-5.2-codex` with presets:
  - `gpt-5.2-codex-low` - Fast GPT 5.2 Codex responses
  - `gpt-5.2-codex-medium` - Balanced GPT 5.2 Codex tasks
  - `gpt-5.2-codex-high` - Complex GPT 5.2 Codex reasoning & tools
  - `gpt-5.2-codex-xhigh` - Deep GPT 5.2 Codex long-horizon work
- **New model family prompt**: `gpt-5.2-codex_prompt.md` fetched from the latest Codex CLI release with its own cache file.
- **Test coverage**: Added unit tests for GPT 5.2 Codex normalization, family selection, and reasoning behavior.

### Changed
- **Prompt selection alignment**: GPT 5.2 general now uses `gpt_5_2_prompt.md` (Codex CLI parity).
- **Reasoning configuration**: GPT 5.2 Codex supports `xhigh` but does **not** support `"none"`; `"none"` auto-upgrades to `"low"` and `"minimal"` normalizes to `"low"`.
- **Config presets**: `config/opencode-legacy.json` includes the 22 pre-configured presets (adds GPT 5.2 Codex); `config/opencode-modern.json` provides the variant-based setup.
- **Docs**: Updated README/AGENTS/config docs to include GPT 5.2 Codex and new model family behavior.

## [4.1.1] - 2025-12-17

**Minor release**: "none" reasoning effort support, orphaned function_call_output fix, and HTML version update.

### Added
- **"none" reasoning effort support**: GPT-5.1 and GPT-5.2 support `reasoning_effort: "none"` which disables the reasoning phase entirely. This can result in faster responses when reasoning is not needed.
  - `gpt-5.2-none` - GPT-5.2 with reasoning disabled
  - `gpt-5.1-none` - GPT-5.1 with reasoning disabled
- **4 new unit tests** for "none" reasoning behavior (now 197 total unit tests).

### Fixed
- **Orphaned function_call_output 400 errors**: Fixed API errors when conversation history contains `item_reference` pointing to stored function calls. Previously, orphaned `function_call_output` items were only filtered when `!body.tools`. Now always handles orphans regardless of tools presence, and converts them to assistant messages to preserve context while avoiding API errors.
- **OAuth HTML version display**: Updated version in oauth-success.html from 1.0.4 to 4.1.0.

### Technical Details
- `getReasoningConfig()` now detects GPT-5.1 general purpose models (not Codex variants) and allows "none" to pass through.
- GPT-5.2 inherits "none" support as it's newer than GPT-5.1.
- Codex variants (gpt-5.1-codex, gpt-5.1-codex-max, gpt-5.1-codex-mini) do NOT support "none":
  - Codex and Codex Max: "none" auto-converts to "low"
  - Codex Mini: "none" auto-converts to "medium" (as before)
- Documentation updated with complete reasoning effort support matrix per model family.

### References
- **OpenAI API docs** (`platform.openai.com/docs/api-reference/chat/create`): "gpt-5.1 defaults to none, which does not perform reasoning. The supported reasoning values for gpt-5.1 are none, low, medium, and high."
- **Codex CLI** (`codex-rs/protocol/src/openai_models.rs`): `ReasoningEffort` enum includes `None` variant with `#[serde(rename_all = "lowercase")]` serialization to `"none"`.
- **Codex CLI** (`codex-rs/core/src/client.rs`): Request builder passes `ReasoningEffort::None` through to API without validation/rejection.
- **Codex CLI** (`docs/config.md`): Documents `model_reasoning_effort = "none"` as valid config option.

### Notes
- This plugin defaults to "medium" for better coding assistance; users must explicitly set "none" if desired.

## [4.1.0] - 2025-12-11

**Feature release**: GPT 5.2 model support and image input capabilities.

### Added
- **GPT 5.2 model family support**: Full support for OpenAI's latest GPT 5.2 model with 4 reasoning level presets:
  - `gpt-5.2-low` - Fast responses with light reasoning
  - `gpt-5.2-medium` - Balanced reasoning for general tasks
  - `gpt-5.2-high` - Complex reasoning and analysis
  - `gpt-5.2-xhigh` - Deep multi-hour analysis (same as Codex Max)
- **Full image input support**: All 16 model variants now include `modalities.input: ["text", "image"]` enabling full multimodal capabilities - read screenshots, diagrams, UI mockups, and any image directly in OpenCode.
- **GPT 5.2 model family** added to `codex.ts` with dedicated prompt handling.
- **Test coverage**: Updated integration tests to verify all 16 models (was 13), now 193 unit tests + 16 integration tests.

### Changed
- **Model ordering**: Config now ordered by model family priority: GPT 5.2 → Codex Max → Codex → Codex Mini → GPT 5.1.
- **Removed default presets**: Removed `gpt-5.1-codex-max` and `gpt-5.2` (without reasoning suffix) to enforce explicit reasoning level selection.
- **Test script**: `scripts/test-all-models.sh` now uses local dist for testing and includes GPT 5.2 tests.
- **Documentation**: Updated README with GPT 5.2 models, image support, and condensed config example.

### Technical Details
- GPT 5.2 maps to `gpt-5.2` API model with same reasoning options as Codex Max (`low/medium/high/xhigh`).
- `getModelFamily()` now returns `"gpt-5.2"` for GPT 5.2 models, using Codex Max prompts.
- `getReasoningConfig()` treats GPT 5.2 like Codex Max for `xhigh` reasoning support.
- Model normalization pattern matching updated to recognize GPT 5.2 before other patterns.

## [4.0.2] - 2025-11-27

**Bugfix release**: Fixes compaction context loss, agent creation, and SSE/JSON response handling.

### Fixed
- **Compaction losing context**: v4.0.1 was too aggressive in filtering tool calls - it removed ALL `function_call`/`function_call_output` items when tools weren't present. Now only **orphaned** outputs (without matching calls) are filtered, preserving matched pairs for compaction context.
- **Agent creation failing**: The `/agent create` command was failing with "Invalid JSON response" because we were returning SSE streams instead of JSON for `generateText()` requests.
- **SSE/JSON response handling**: Properly detect original request intent - `streamText()` requests get SSE passthrough, `generateText()` requests get SSE→JSON conversion.

### Added
- **`gpt-5.1-chat-latest` model support**: Added to model map, normalizes to `gpt-5.1`.

### Technical Details
- Root cause of compaction issue: OpenCode sends `item_reference` with `fc_*` IDs for function calls. We filter these for stateless mode, but v4.0.1 then removed ALL tool items. Now we only remove orphaned `function_call_output` items (where no matching `function_call` exists).
- Root cause of agent creation issue: We were forcing `stream: true` for all requests and returning SSE for all responses. Now we capture original `stream` value before transformation and convert SSE→JSON only when original request wasn't streaming.
- The Codex API always receives `stream: true` (required), but response handling is based on original intent.

## [4.0.1] - 2025-11-27

**Bugfix release**: Fixes API errors during summary/compaction and GitHub rate limiting.

### Fixed
- **Orphaned `function_call_output` errors**: Fixed 400 errors during summary/compaction requests when OpenCode sends `item_reference` pointers to server-stored function calls. The plugin now filters out `function_call` and `function_call_output` items when no tools are present in the request.
- **GitHub API rate limiting**: Added fallback mechanism when fetching Codex instructions from GitHub. If the API returns 403 (rate limit), the plugin now falls back to parsing the HTML releases page.

### Technical Details
- Root cause: OpenCode's secondary model (gpt-5-nano) uses `item_reference` with `fc_*` IDs to reference stored function calls. Our plugin filters `item_reference` for stateless mode (`store: false`), leaving `function_call_output` orphaned. The Codex API rejects requests with orphaned outputs.
- Fix: When `hasTools === false`, filter out all `function_call` and `function_call_output` items from the input array.
- GitHub fallback chain: API endpoint → HTML page → redirect URL parsing → HTML regex parsing.

## [4.0.0] - 2025-11-25

**Major release**: Complete prompt engineering overhaul matching official Codex CLI behavior, with full **GPT-5.1 Codex Max** support.

### Highlights
- **Full Codex Max support** with dedicated prompt including frontend design guidelines
- **Model-specific prompts** matching Codex CLI's prompt selection logic
- **GPT-5.0 → GPT-5.1 migration** as legacy models are phased out

### Added
- **Model-specific system prompts**: Plugin now fetches the correct Codex prompt based on model family, matching Codex CLI's `model_family.rs` logic:
  - `gpt-5.1-codex-max*` → `gpt-5.1-codex-max_prompt.md` (117 lines, includes frontend design guidelines)
  - `gpt-5.1-codex*`, `gpt-5.1-codex-mini*` → `gpt_5_codex_prompt.md` (105 lines, focused coding prompt)
  - `gpt-5.1*` → `gpt_5_1_prompt.md` (368 lines, full behavioral guidance)
- New `ModelFamily` type (`"codex-max" | "codex" | "gpt-5.1"`) for prompt selection.
- New `getModelFamily()` function to determine prompt selection based on normalized model name.
- Model family now logged in request logs for debugging (`modelFamily` field in after-transform logs).
- 16 new unit tests for model family detection (now **191 total unit tests**).
- Integration tests now verify correct model family selection (13 integration tests with family verification).

### Changed
- **Legacy GPT-5.0 models now map to GPT-5.1**: All legacy `gpt-5` model variants automatically normalize to their `gpt-5.1` equivalents as GPT-5.0 is being phased out by OpenAI:
  - `gpt-5-codex` → `gpt-5.1-codex`
  - `gpt-5` → `gpt-5.1`
  - `gpt-5-mini`, `gpt-5-nano` → `gpt-5.1`
  - `codex-mini-latest` → `gpt-5.1-codex-mini`
- **Lazy instruction loading**: Instructions are now fetched per-request based on model family (not pre-loaded at initialization).
- **Separate caching per model family**: Each model family has its own cached prompt file:
  - `codex-max-instructions.md` + `codex-max-instructions-meta.json`
  - `codex-instructions.md` + `codex-instructions-meta.json`
  - `gpt-5.1-instructions.md` + `gpt-5.1-instructions-meta.json`

### Fixed
- Fixed OpenCode prompt cache URL to fetch from `dev` branch instead of non-existent `main` branch.
- Fixed model configuration test script to correctly identify model logs in multi-model sessions (opencode uses a small model like `gpt-5-nano` for title generation alongside the user's selected model).

### Technical Details
This release brings full parity with Codex CLI's prompt engineering:
- **Codex family** (105 lines): Concise, tool-focused prompt for coding tasks
- **Codex Max family** (117 lines): Adds frontend design guidelines for UI work
- **GPT-5.1 general** (368 lines): Comprehensive behavioral guidance, personality, planning

## [3.3.0] - 2025-11-19
### Added
- GPT 5.1 Codex Max support: normalization, per-model defaults, and new presets (`gpt-5.1-codex-max`, `gpt-5.1-codex-max-xhigh`) with extended reasoning options (including `none`/`xhigh`) while keeping the 272k context / 128k output limits.
- Typing and config support for new reasoning options (`none`/`xhigh`, summary `off`/`on`) plus updated test matrix entries.

### Changed
- Codex Mini clamping now downgrades unsupported `xhigh` to `high` and guards against `none`/`minimal` inputs.
- Documentation, config guides, and validation scripts now reflect 13 verified GPT 5.1 variants (3 codex, 5 codex-max, 2 codex-mini, 3 general), including Codex Max. See README for details on pre-configured variants.

## [3.2.0] - 2025-11-14
### Added
- GPT 5.1 model family support: normalization for `gpt-5.1`, `gpt-5.1-codex`, and `gpt-5.1-codex-mini` plus new GPT 5.1-only presets in the canonical `config/opencode-legacy.json`.
- Documentation updates (README, docs, AGENTS) describing the 5.1 families, their reasoning defaults, and how they map to ChatGPT slugs and token limits.

### Changed
- Model normalization docs and tests now explicitly cover both 5.0 and 5.1 Codex/general families and the two Codex Mini tiers.
- The legacy GPT 5.0 full configuration is now published separately; new installs should prefer the 5.1 presets in `config/opencode-legacy.json`.

## [3.1.0] - 2025-11-11
### Added
- Codex Mini support end-to-end: normalization to the `codex-mini-latest` slug, proper reasoning defaults, and two new presets (`gpt-5-codex-mini-medium` / `gpt-5-codex-mini-high`).
- Documentation & configuration updates describing the Codex Mini tier (200k input / 100k output tokens) plus refreshed totals (11 presets, 160+ unit tests).

### Fixed
- Prevented Codex Mini from inheriting the lightweight (`minimal`) reasoning profile used by `gpt-5-mini`/`nano`, ensuring the API always receives supported effort levels.

## [3.0.0] - 2025-11-04
### Added
- Codex-style usage-limit messaging that mirrors the 5-hour and weekly windows reported by the Codex CLI.
- Documentation guidance noting that OpenCode's context auto-compaction and usage sidebar require the canonical `config/opencode-legacy.json`.

### Changed
- Prompt caching now relies solely on the host-supplied `prompt_cache_key`; conversation/session headers are forwarded only when OpenCode provides one.
- CODEX_MODE bridge prompt refreshed to the newest Codex CLI release so tool awareness stays in sync.

### Fixed
- Clarified README, docs, and configuration references so the canonical config matches shipped behaviour.
- Pinned `hono` (4.10.4) and `vite` (7.1.12) to resolve upstream security advisories.

## [2.1.2] - 2025-10-12
### Added
- Comprehensive compliance documentation (ToS guidance, security, privacy) and a full user/developer doc set.

### Fixed
- Per-model configuration lookup, stateless multi-turn conversations, case-insensitive model normalization, and GitHub instruction caching.

## [2.1.1] - 2025-10-04
### Fixed
- README cache-clearing snippet now runs in a subshell from the home directory to avoid path issues while removing cached plugin files.

## [2.1.0] - 2025-10-04
### Added
- Enhanced CODEX_MODE bridge prompt with Task tool and MCP awareness plus ETag-backed verification of OpenCode system prompts.

### Changed
- Request transformation made async to support prompt verification caching; AGENTS.md renamed to provide cross-agent guidance.

## [2.0.0] - 2025-10-03
### Added
- Full TypeScript rewrite with strict typing, 123 automated tests, and nine pre-configured model variants matching the Codex CLI.
- CODEX_MODE introduced (enabled by default) with a lightweight bridge prompt and configurability via config file or `CODEX_MODE` env var.

### Changed
- Library reorganized into semantic folders (auth, prompts, request, etc.) and OAuth flow polished with the new success page.

## [1.0.3] - 2025-10-02
### Changed
- Major internal refactor splitting the runtime into focused modules (logger, request/response handlers) and removing legacy debug output.

## [1.0.2] - 2025-10-02
### Added
- ETag-based GitHub caching for Codex instructions and release-tag tracking for more stable prompt updates.

### Fixed
- Default model fallback, text verbosity initialization, and standardized error logging prefixes.

## [1.0.1] - 2025-10-01
### Added
- README clarifications: opencode auto-installs plugins, config locations, and streamlined quick-start instructions.

## [1.0.0] - 2025-10-01
### Added
- Initial production release with ChatGPT Plus/Pro OAuth support, tool remapping, auto-updating Codex instructions, and zero runtime dependencies.
