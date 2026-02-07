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
(a)dd, (f)resh start, or (m)anage accounts? [a/f/m]:
```

Use **manage** to toggle accounts enabled/disabled. Disabled accounts are skipped for
selection and rate-limit calculations, and are never re-enabled automatically.

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

Enable it in `~/.config/opencode/openai-codex-auth-config.json`:

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

- `codex-status` - list accounts and status
- `codex-switch-accounts` - switch active account by index (1-based)
- `codex-toggle-account` - enable/disable account by index (1-based)
- `codex-remove-account` - remove account by index (1-based)

These are primarily useful in the OpenCode TUI.
To enable or disable accounts, re-run `opencode auth login` and choose **manage**.

## Storage

Accounts are stored on disk so you don't have to re-auth every run.

- Accounts file: `~/.config/opencode/openai-codex-accounts.json`
- Plugin config: `~/.config/opencode/openai-codex-auth-config.json`

Example accounts file:

```json
{
  "version": 3,
  "accounts": [
    {
      "email": "you@example.com",
      "accountId": "acct_...",
      "plan": "Plus",
      "refreshToken": "...",
      "enabled": true,
      "addedAt": 1700000000000,
      "lastUsed": 1700000000000
    }
  ],
  "activeIndex": 0,
  "activeIndexByFamily": {
    "gpt-5.3-codex": 0,
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

Accounts are matched by `accountId` + `email` + `plan` (strict identity). This allows multiple
emails per account and multiple accounts per email without collisions.

### Fields

| Field | Description |
|-------|-------------|
| `email` | Best-effort email extracted from the OAuth JWT (may be missing) |
| `accountId` | ChatGPT account ID extracted from the OAuth JWT (may be missing) |
| `plan` | ChatGPT plan name extracted from the OAuth JWT (may be missing) |
| `refreshToken` | OAuth refresh token (auto-managed) |
| `enabled` | Whether the account can be selected (defaults to true) |
| `addedAt` | Timestamp when the account was first stored |
| `lastUsed` | Timestamp when the account was last selected |
| `activeIndex` | Active account index (used by the account switch tool) |
| `activeIndexByFamily` | Per-model-family active index |
| `rateLimitResetTimes` | Optional per-family/model rate limit reset times |
| `coolingDownUntil` | Optional cooldown timestamp for failing accounts |

Security note: this file contains OAuth refresh tokens. Treat it like a password file.

## Account Repair and Quarantine

On login, the plugin inspects the accounts file for corrupt JSON or corrupt entries. Legacy
entries missing identity fields are preserved for hydration (they are not auto-quarantined
at login).

- Corrupt JSON or corrupt entries trigger a quarantine snapshot and storage reset.
- If the file is parseable, valid entries are preserved; corrupt and legacy entries are dropped.
- Auto-repair runs once on the first request if legacy accounts exist; any records that still
  lack identity after hydration are quarantined and removed from storage.

Quarantine files live next to the accounts file with a `.quarantine-<timestamp>.json` suffix.
For parseable quarantines, they include the reason and records; for corrupt JSON they are raw
snapshots of the original file.

Quarantine files contain refresh tokens (treat them like passwords). The plugin writes them with
restrictive permissions when supported, and keeps only the most recent set (older quarantine files
may be pruned automatically after successful writes).

## Account Selection Strategies

Configure in `~/.config/opencode/openai-codex-auth-config.json`:

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

If you upgraded from a version that matched accounts by accountId only (or accountId + plan),
multiple emails/plans on the same account could have been overwritten. To rebuild clean storage:

```bash
rm ~/.config/opencode/openai-codex-accounts.json
opencode auth login
```

If tokens are revoked or you want to start over:

```bash
rm ~/.config/opencode/openai-codex-accounts.json
opencode auth login
```
