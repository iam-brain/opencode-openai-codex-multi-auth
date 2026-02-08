![Image 1: opencode-openai-codex-auth](assets/readme-hero.svg)


**Maintenance fork:** This project continues to receive hardening and compatibility updates while a full rewrite (based on OpenCode's native OAuth) is underway at [https://github.com/iam-brain/opencode-openai-multi](https://github.com/iam-brain/opencode-openai-multi).

  
Fork maintained by [iam-brain](https://github.com/iam-brain).

Upstream project (credit): [numman-ali/opencode-openai-codex-auth](https://github.com/numman-ali/opencode-openai-codex-auth)

[![CI](https://github.com/iam-brain/opencode-openai-codex-multi-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/iam-brain/opencode-openai-codex-multi-auth/actions)
[![npm version](https://img.shields.io/npm/v/opencode-openai-codex-multi-auth.svg)](https://www.npmjs.com/package/opencode-openai-codex-multi-auth)

**One install. Every Codex model. Multi-account aware.**
[Install](#-quick-start) · [Models](#-models) · [Configuration](#-configuration) · [Docs](#-docs)
---
## 💡 Philosophy
> **"One config. Every model."**
OpenCode should feel effortless. This plugin keeps the setup minimal while giving you full GPT‑5.x + Codex access via ChatGPT OAuth.
```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  ChatGPT OAuth → Codex backend → OpenCode               │
│  One command install, full model presets, done.         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```
---
## 🚀 Quick Start
```bash
npx -y opencode-openai-codex-multi-auth@latest
```
Then:
```bash
opencode auth login
opencode run "write hello world to test.txt" --model=openai/gpt-5.3-codex --variant=medium
```
Legacy OpenCode (v1.0.209 and below):
```bash
npx -y opencode-openai-codex-multi-auth@latest --legacy
opencode run "write hello world to test.txt" --model=openai/gpt-5.3-codex-medium
```
Uninstall:
```bash
npx -y opencode-openai-codex-multi-auth@latest --uninstall
npx -y opencode-openai-codex-multi-auth@latest --uninstall --all
```

## ⚠️ Migration Note (Multi-Plan Accounts)
If you used multiple plans or emails under the same ChatGPT accountId on older versions, the
previous matching logic could overwrite entries. To regenerate a clean layout:

```bash
rm ~/.config/opencode/openai-codex-accounts.json
opencode auth login
```

---
## 📦 Models
- **gpt-5.3-codex** (low/medium/high/xhigh)
- **gpt-5.2** (none/low/medium/high/xhigh)
- **gpt-5.2-codex** (low/medium/high/xhigh)
- **gpt-5.1-codex-max** (low/medium/high/xhigh)
- **gpt-5.1-codex** (low/medium/high)
- **gpt-5.1-codex-mini** (medium/high)
- **gpt-5.1** (none/low/medium/high)
---
## 🧩 Configuration
- Modern (OpenCode v1.0.210+): `config/opencode-modern.json`
- Legacy (OpenCode v1.0.209 and below): `config/opencode-legacy.json`
- Installer template source: latest GitHub release → GitHub `main` → bundled static template fallback
- Runtime model metadata source: Codex `/backend-api/codex/models` → per-account local cache (server-derived). Requests fail closed if the catalog is unavailable.

Minimal configs are not supported for GPT‑5.x; use the full configs above.

Personality is configured in `~/.config/opencode/openai-codex-auth-config.json` via `custom_settings`:

```json
{
  "custom_settings": {
    "options": {
      "personality": "Idiot"
    },
    "models": {
      "gpt-5.3-codex": {
        "options": {
          "personality": "pragmatic"
        }
      }
    }
  }
}
```

Personality descriptions come from:
- Project-local `.opencode/Personalities/*.md`
- Global `~/.config/opencode/Personalities/*.md`

The filename (case-insensitive) defines the key (e.g., `Idiot.md`), and the file contents are used verbatim.

Built-ins: `none`, `default` (uses model runtime defaults), `friendly`, `pragmatic` (fallback if unset). Any other key requires a matching personality file.
## ✅ Features
- ChatGPT Plus/Pro OAuth authentication (official flow)
- Model presets across GPT‑5.3 Codex / GPT‑5.2 / GPT‑5.2 Codex / GPT‑5.1 families
- Variant system support (v1.0.210+) + legacy presets
- Multimodal input enabled for all models
- Usage‑aware errors + automatic token refresh
- Authoritative model catalog validation (`/codex/models`) with per-account cache
- Multi-account support with sticky selection + PID offset (great for parallel agents)
- Account enable/disable management (via `opencode auth login` manage)
- Hard-stop safety loops for unavailable accounts and unsupported models
- Strict account identity matching (`accountId` + `email` + `plan`)
- Hybrid account selection strategy (health score + token bucket + LRU bias)
- Optional round-robin account rotation (maximum throughput)
- OpenCode TUI toasts for account switching and rate-limit events
- **Authoritative Status Tracking**: Real-time rate limit monitoring (5h/Weekly) with cached snapshots
---
## 🛡️ Safety & Reliability
- Hard-stop safety gate for all-accounts rate-limit/auth-failure loops
- Strict model allowlist from `/backend-api/codex/models` (per-account cached)
- Synthetic error responses that surface the exact failure reason
---
## 📚 Docs
- Getting Started: `docs/getting-started.md`
- Configuration: `docs/configuration.md`
- Multi-Account: `docs/multi-account.md`
- Troubleshooting: `docs/troubleshooting.md`
- Architecture: `docs/development/ARCHITECTURE.md`
---
## ⚠️ Usage Notice
This plugin is for **personal development use** with your own ChatGPT Plus/Pro subscription.
For production or multi‑user applications, use the OpenAI Platform API.

## Credits

- Original implementation and ongoing upstream work: Numman Ali and contributors (`numman-ali/opencode-openai-codex-auth`)
- Multi-account strategy + UX inspiration (rotation modes, PID offset approach, toasts): NoeFabris and contributors (`NoeFabris/opencode-antigravity-auth`)
- This fork: multi-account pool, sticky-by-default rotation with PID offset, round-robin option, and account tools/toasts

**Built for developers who value simplicity.**
