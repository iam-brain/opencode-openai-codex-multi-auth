# Multi-Account Setup

This plugin supports multiple ChatGPT Plus/Pro accounts so you can distribute requests across accounts when rate limits are reached.

## Quick Start

Add accounts by running:

```bash
opencode auth login
```

When accounts already exist, you'll be prompted:

```
(a)dd new account(s) or (f)resh start? [a/f]:
```

## Account Selection (How Rotation Works)

This plugin intentionally defaults to **sticky** selection to preserve Codex/ChatGPT-side prompt caching.

- `sticky` (default): Stay on the same account until it is rate-limited, then switch.
- `round-robin` (opt-in): Rotate accounts on every request (maximum throughput, less caching).

### Parallel Agents (PID Offset)

When you run multiple OpenCode sessions (or parallel agents) at once, they can otherwise all start on Account 1.
To avoid that, the plugin supports PID-based offset.

When enabled and you have 2+ accounts, each process will pick a different **starting** account:

- Process A starts on Account 1
- Process B starts on Account 2
- ...

Each process still behaves "sticky" after choosing its initial account.

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

Security note: this file contains OAuth refresh tokens. Treat it like a password file.

## Resetting Accounts

If tokens are revoked or you want to start over:

```bash
rm ~/.opencode/openai-codex-accounts.json
opencode auth login
```
