# Agent Audit Log

Chronological record of all agent audit findings (spec + quality + general audits) for this workstream.

## 2026-02-06 – General Audit (per-message fetches)

- Source: `@general` audit (task_id: `ses_3ceb927fbffeYA4lkFQC6HM0jL`).
- Per-request path: `lib/fetch-orchestrator.ts:263` → `lib/request/fetch-helpers.ts:102` → `getCodexInstructions` + `getCodexModelRuntimeDefaults`.
- Per-request network fetches:
  - `/backend-api/codex/models` called every request via `getCodexModelRuntimeDefaults` (`lib/prompts/codex-models.ts:287` → `fetchModelsFromServer`).
  - GitHub instructions fetch on cache miss/stale (`lib/prompts/codex.ts:136`, `lib/prompts/codex.ts:87`, `lib/prompts/codex.ts:175`).
- Per-request disk/CPU:
  - Reads instruction cache/meta each request (`lib/prompts/codex.ts:148`).
  - Reads models cache + static defaults each request (`lib/prompts/codex-models.ts:93`, `lib/prompts/codex-models.ts:227`).
  - Codex status snapshots write per response + per SSE token_count (`lib/codex-status.ts:156`, `lib/codex-status.ts:330`).
- Existing caching:
  - Instructions: ETag + 15-min TTL, on-disk cache (`lib/prompts/codex.ts`).
  - Models: on-disk cache exists but server fetch happens before cache (`lib/prompts/codex-models.ts`).
- Suggested caching points:
  - In-memory cache for instructions/model catalog; ETag for `/codex/models`.
  - Memoize static template defaults to avoid repeated disk reads.
  - Debounce codex-status disk writes.

## 2026-02-06 – General Audit (second pass)

- Source: `@general` audit (task_id: `ses_3cea77097ffeYwaUz9TG86fpXl`).
- Reconfirmed per-request call chain and caching behavior:
  - `getCodexInstructions` called every request via `transformRequestForCodex`.
  - `/codex/models` server fetch happens every request before cache.
- Noted per-request disk writes:
  - `codexStatus.updateFromHeaders` and `updateFromSnapshot` persist every response/SSE event.
- Safe warm points:
  - On plugin init / when `FetchOrchestrator` created in `index.ts`.
  - Add in-memory cache in `lib/prompts/codex.ts` and `lib/prompts/codex-models.ts`.

## 2026-02-06 – Task 1 Spec Review (initial)

- Source: `@general` spec review (task_id: `ses_3ce991efcffe3p9hBelEPU7nD3`).
- Medium: Startup warm skipped cold start when cache/meta missing; first request still fetches.
- Low: In-memory cache expires after 15 minutes; may re-read disk mid-session.
- Low: Warm iterates all `MODEL_FAMILIES`, may refresh multiple caches at startup.
- Question: Should warm fetch on cold start when no cache/meta exists?

## 2026-02-06 – Task 1 Spec Review (incorrect worktree)

- Source: `@general` spec review (task_id: `ses_3ce94f9a1ffevVD7A1bjqN00gC`).
- Note: This review was later determined to inspect the wrong worktree; findings are retained for completeness.
- High: No session-long in-memory cache; per-request cache reads remain.
- High: No startup warm path; instructions fetched per request only.
- High: Cold-start still fetches from network when cache/meta missing.
- Medium: Cache writes not concurrency-safe.
- Low: Debug log gating respected.

## 2026-02-06 – Task 1 Spec Review (correct worktree)

- Source: `@general` spec review (task_id: `ses_3ce91db67ffepck4eOhtVmmT4h`).
- Finding: No true gaps vs requirements.
- Residual risk: In-memory cache short-circuits TTL refresh for long-lived processes.

## 2026-02-06 – Task 1 Code Quality Review

- Source: `@general` code quality review (task_id: `ses_3ce8f6bcaffepHzpmXYbwRVgF3`).
- High: 304 response with missing cache file falls back to bundled instructions instead of re-fetch.
- Medium: `getModelFamily` checks `gpt-5.2-codex` before `codex-max`, misclassifying `gpt-5.2-codex-max`.
- Medium: In-memory cache bypasses TTL/ETag refresh for long-running sessions.
- Medium: `normalizeProviderModelMetadata` deletes non-codex model entries from provider config.

## 2026-02-06 – Task 2 Spec Review

- Source: `@general` spec review (task_id: `ses_3ce820fb4ffesGzQL6caaaHYgO`).
- Low: Lock/atomic cache write path not covered by tests.
- Assumption: Startup warm uses cache only; no revalidation without credentials at startup.

## 2026-02-06 – Task 2 Code Quality Review

- Source: `@general` code quality review (task_id: `ses_3ce7f3e35ffebVxNm2PiyGh2qE`).
- Medium: `normalizeProviderModelMetadata` deletes non-codex entries (potential regression).
- Medium: In-memory models cache never re-reads disk; multi-process freshness risk.
- Low: No in-flight request dedup; parallel calls can fetch/write concurrently.
- Low: `readModelsCache` doesn’t validate entries; malformed cache could cause issues.

## 2026-02-06 – Task 2 Spec Review (post-fix)

- Source: `@general` spec review (task_id: `ses_3cd0851dfffeUkfUWkqdVClBZN`).
- Pass: Requirements 1–5 met (startup warm, in-session cache, ETag + atomic write, memoized defaults, auth-scoped backoff guard).
- Gap: No explicit test asserting warm avoids network when cache is stale and no auth is provided.
- Gap: Atomic/lockfile write behavior not directly tested.

## 2026-02-06 – Task 2 Code Quality Review (post-fix)

- Source: `@general` code quality review (task_id: `ses_3cd06b172ffeaGzskiuHOg46TU`).
- High: Backoff guard only applied when cache exists; cold start with auth + server outage would hit `/codex/models` on every call. Suggested: apply guard regardless of cache presence and allow GitHub/static fallback.
- Medium: Catalog cache is global (single memory + disk file) and not scoped to account identity; model availability could differ by account/plan.

## 2026-02-06 – Task 2 Spec Review (incorrect path)

- Source: `@general` spec review (task_id: `ses_3cd02a971ffet5Z3MKOBI5tSrr`).
- Note: Reviewer appears to have inspected repo root instead of worktree; findings below are retained for completeness but superseded by the correct-path review.
- Critical: Claimed missing warm hook, in-memory cache, backoff, ETag handling, lockfile writes, and memoization.
- Important: Claimed missing tests for new behaviors.

## 2026-02-06 – Task 2 Spec Review (correct path)

- Source: `@general` spec review (task_id: `ses_3cd0057c7ffefNFj9mPQkFBrfb`).
- Pass: Requirements 1–5 met, including auth-scoped backoff and short retry window.
- Gap: No explicit test for warm avoiding network when cache is stale and no auth is provided.
- Gap: Atomic/lockfile write behavior not directly tested.

## 2026-02-06 – Task 2 Code Quality Review (correct path)

- Source: `@general` code quality review (task_id: `ses_3ccff1174ffez2ih78Nnx8737K`).
- High: Backoff guard did not apply when cache was missing; repeated `/codex/models` attempts possible on cold start with auth + server outage. Suggested applying guard regardless of cache presence.
- Medium: Catalog cache is global (single memory + disk file) and not scoped to account identity.

## 2026-02-06 – Task 2 Code Quality Review (final)

- Source: `@general` code quality review (task_id: `ses_3cced71beffeOAC5oWWtfRMsoH`).
- Low: Backoff key uses `accountId ?? "auth"` when accessToken present; access-token-only calls share a single bucket, so fresh tokens may still be throttled for up to 60s.
- Low: When server backoff is active and there is no cache, GitHub fallback is retried on each call; offline scenarios may cause repeated GitHub attempts/log spam.

## 2026-02-06 – Task 3 Spec Review

- Source: `@general` spec review (task_id: `ses_3ccafe7f6ffeI0Q9b6r4omMgxe`).
- Pass: Internal defaults read from cached catalog + static templates.
- Pass: User config overrides defaults; no config writes.
- Pass: Only base models are added; variants remain internal.
- Pass: Defaults populate when config lacks models.
- Pass: Display names derived deterministically.
- Gap: Tests do not directly cover config hook or variant cleanup behavior.

## 2026-02-06 – Task 3 Code Quality Review

- Source: `@general` code quality review (task_id: `ses_3ccae4250ffeRN0D9Hh437MTRF`).
- Medium: Shallow merge of model overrides would drop default limit/variants/options; suggested deep merge per model.
- Medium: Fallback applied `gpt-5.1` defaults to any `gpt-*` slug; should limit to `gpt-5.*`.
- Low: Test did not restore `XDG_CONFIG_HOME` or cleanup temp dir on failure.

## 2026-02-06 – Task 4 Code Quality Review (normalizeModel false-positive reduction)

- Source: `@general` audit (task_id: `ses_3cbe3808bffeYlvKjJRr6zpOyj`, re-verified after corrections).
- Medium: `docs/development/TESTING.md:18-32` still asserts `gpt-5-mini`/`gpt-5-nano` normalize to `gpt-5`; current behavior preserves `gpt-5-mini`/`gpt-5-nano` (lowercased) in `lib/request/request-transformer.ts`.
- Medium: `docs/development/TESTING.md:66-112` still shows `gpt-5-codex-low`/verbose names normalizing to `gpt-5-codex`; current behavior preserves legacy identifiers instead of coercing.
- Medium: `docs/development/CONFIG_FIELDS.md:167-170` and `docs/development/CONFIG_FIELDS.md:535-586` describe normalizeModel mapping `gpt-5-codex-low` or any "codex" key to `gpt-5-codex`; current implementation no longer performs substring-based coercion.

## 2026-02-06 – Task 5 Code Quality Review (gpt-5.3-codex first-class)

- Source: `@general` audit (task_id: `ses_3cbd48399ffe7bBI3iN9CxbtCx`, verified against worktree).
- Pass: Model family list and instruction cache mapping now include `gpt-5.3-codex` (`lib/constants.ts`, `lib/prompts/codex.ts`).
- Low: `gpt-5.3-codex` reuses the `gpt-5.2-codex_prompt.md` upstream prompt file until a dedicated 5.3 prompt exists; if upstream adds one, update `PROMPT_FILES`.

## 2026-02-06 – Task 6 Documentation Review (normalization + personalities)

- Source: `@general` audit (task_id: `ses_3cbc43d63ffeOxSxqwDG4eY8dm`, verified against worktree).
- Fixes applied: Updated normalization examples and debug output in `docs/development/TESTING.md`, corrected API normalization notes in `docs/development/CONFIG_FIELDS.md`, and aligned `test/README.md` summary with current normalizeModel behavior.
- Status: No remaining doc mismatches found after updates.

## 2026-02-06 – Task 4 Spec Review (gpt-5.3-codex first-class)

- Source: `@general` spec review (task_id: `ses_3cb193c03ffeDw3Go9yCI9BHfH`).
- High: Docs changed despite scope excluding docs (e.g., `README.md`, `docs/configuration.md`, `docs/getting-started.md`, `docs/development/ARCHITECTURE.md`, `docs/development/TESTING.md`).
- Medium: `config/minimal-opencode.json` still uses `openai/gpt-5-codex` (not 5.3).
- Low: Possible scope creep in new personality/catalog/caching additions (`lib/personalities.ts`, `lib/catalog-defaults.ts`, related tests).

## 2026-02-06 – Task 4 Code Quality Review (gpt-5.3-codex first-class)

- Source: `@general` code quality review (task_id: `ses_3cb14e2b6ffemzgHx57X8C0cJS`).
- High: Legacy model normalization removed; legacy/verbose IDs now pass through unchanged (potential invalid model IDs).
- Medium: Personality resolution defaults to pragmatic unless `custom_settings` is set, ignoring user config/runtime defaults.
- Medium: `buildInternalModelDefaults` applies gpt-5.3-codex defaults to any `gpt-5.*` slug (including non-codex).
- Medium: Variant filtering uses cached supported reasoning levels without TTL validation; stale cache may delete variants.
- Low: Server `base_instructions` + `apply_patch_tool_type` fetched but unused in request instruction building.
- Low: New test may bypass required fixture seeding (`test/models-gpt-5.3-codex.test.ts`).

## 2026-02-06 – Task 4 Spec Review (re-check)

- Source: `@general` spec review (task_id: `ses_3cb0a3449ffeDsmXG6zohLAzUr`).
- Pass: `config/minimal-opencode.json` updated to `openai/gpt-5.3-codex`.
- Remaining gap: Doc edits still present even though docs are a separate task (`README.md`, `docs/getting-started.md`, `docs/development/TESTING.md`, `docs/development/ARCHITECTURE.md`, `docs/configuration.md`).
- Note: Possible scope creep remains (`lib/personalities.ts`, `lib/catalog-defaults.ts`).

## 2026-02-06 – Task 6 Spec Review (docs update, initial)

- Source: `@general` spec review (task_id: `ses_3cacdf02ffferw61yrheL5qS96`).
- High: Worktree includes non-doc edits; doc-only scope flagged (code/config/test files present).
- Medium: “Best Practice” example still referenced GPT‑5.2 presets (`docs/development/CONFIG_FIELDS.md`).
- Low: Cache examples still centered on GPT‑5.2 (`docs/privacy.md`).

## 2026-02-06 – Task 6 Spec Review (docs update, final)

- Source: `@general` spec review (task_id: `ses_3cabf347cffeFXV5oqyuqeALZV`).
- Pass: GPT‑5.3 Codex primary examples and personality guidance aligned across docs.

## 2026-02-06 – Task 6 Code Quality Review (docs update, re-check)

- Source: `@general` code quality review (task_id: `ses_3cab0848effec95r4cpQRrkhl4`).
- Pass: All doc quality issues (xhigh casing, normalization examples, variant counts, legacy aliases, and personality default naming) have been corrected and aligned with plugin behavior.

## 2026-02-06 – End-to-End Verification

- Results: `npm run build` and `npm test` passed in worktree.
- Fixed: 2 regression tests in `test/plugin-config-hook.test.ts` related to `gpt-5.3-codex` first-class synthesis and metadata folding precedence.
- Status: All 457 tests passing.
