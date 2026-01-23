# Multi-Account Setup

This plugin supports multiple ChatGPT Plus/Pro accounts so you can distribute requests across accounts when rate limits are reached.

Multi-account behavior and the overall UX are heavily inspired by `NoeFabris/opencode-antigravity-auth` (adapted for OpenAI Codex OAuth).

## Quick Start

Add accounts by running:

```bash
opencode auth login
```

When accounts already exist, you'll be prompted:

```
(a)dd new account(s) or (f)resh start? [a/f]:
```

## Load Balancing Behavior

- **Sticky by default**: The plugin stays on the same account until rate-limited (best for caching).
- **Per-model-family limits**: Rate limits are tracked per Codex model family.
- **Smart retry threshold**: Short rate limits (<= 5s) are retried on the same account.
- **Hybrid strategy (optional)**: Health score + token bucket + LRU bias for better overall distribution.

## Parallel Sessions (PID Offset)

When you run multiple OpenCode sessions (or parallel agents) at once, they can otherwise all start on Account 1.
To avoid that, the plugin supports PID-based offset.

When enabled and you have 2+ accounts, each process will pick a different **starting** account:

- Process A starts on Account 1
- Process B starts on Account 2
- ...

Each process still behaves "sticky" after choosing its initial account.

Enable it in `~/.opencode/openai-codex-auth-config.json`:

```json
{
  "pidOffsetEnabled": true
}
```

## Toast Notifications

When OpenCode is running with the TUI available, the plugin shows toasts for:

- Which account is being used (debounced)
- Rate limits and automatic switching
- Optional waiting when all accounts are rate-limited

You can disable most toasts with `quietMode: true`.

## Account Management Tools

The plugin exposes a few OpenCode tools to inspect or switch accounts:

- `openai-accounts` - list accounts and status
- `openai-accounts-switch` - switch active account by index (1-based)

These are primarily useful in the OpenCode TUI.

## Storage

Accounts are stored on disk so you don't have to re-auth every run.

- Accounts file: `~/.opencode/openai-codex-accounts.json`
- Plugin config: `~/.opencode/openai-codex-auth-config.json`

Example accounts file:

```json
{
  "version": 3,
  "accounts": [
    {
      "email": "you@example.com",
      "accountId": "acct_...",
      "refreshToken": "...",
      "addedAt": 1700000000000,
      "lastUsed": 1700000000000
    }
  ],
  "activeIndex": 0,
  "activeIndexByFamily": {
    "codex": 0,
    "gpt-5.2-codex": 0,
    "codex-max": 0,
    "gpt-5.2": 0,
    "gpt-5.1": 0
  }
}
```

`version` is the **accounts file format version**. The plugin currently reads/writes version `3`.
It's not related to the npm package version; it exists so the file format can evolve safely over time.

### Fields

| Field | Description |
|-------|-------------|
| `email` | Best-effort email extracted from the OAuth JWT (may be missing) |
| `accountId` | ChatGPT account ID extracted from the OAuth JWT (may be missing) |
| `refreshToken` | OAuth refresh token (auto-managed) |
| `addedAt` | Timestamp when the account was first stored |
| `lastUsed` | Timestamp when the account was last selected |
| `activeIndex` | Active account index (used by the account switch tool) |
| `activeIndexByFamily` | Per-model-family active index |
| `rateLimitResetTimes` | Optional per-family/model rate limit reset times |
| `coolingDownUntil` | Optional cooldown timestamp for failing accounts |

Security note: this file contains OAuth refresh tokens. Treat it like a password file.

## Account Selection Strategies

Configure in `~/.opencode/openai-codex-auth-config.json`:

```json
{
  "accountSelectionStrategy": "sticky"
}
```

| Strategy | Behavior | Best For |
|----------|----------|----------|
| `sticky` | Same account until rate-limited | Prompt cache preservation |
| `round-robin` | Rotate to next account on every request | Maximum throughput |
| `hybrid` | Deterministic selection using health score + token bucket + LRU bias | Best overall distribution |

### Set Strategy via Environment Variable

```bash
CODEX_AUTH_ACCOUNT_SELECTION_STRATEGY=hybrid
```

## Resetting Accounts

If tokens are revoked or you want to start over:

```bash
rm ~/.opencode/openai-codex-accounts.json
opencode auth login
```
