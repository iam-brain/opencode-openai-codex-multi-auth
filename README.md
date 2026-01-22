![Image 1: opencode-openai-codex-auth](assets/readme-hero.svg)
  
  
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
opencode run "write hello world to test.txt" --model=openai/gpt-5.2 --variant=medium
```
Legacy OpenCode (v1.0.209 and below):
```bash
npx -y opencode-openai-codex-multi-auth@latest --legacy
opencode run "write hello world to test.txt" --model=openai/gpt-5.2-medium
```
Uninstall:
```bash
npx -y opencode-openai-codex-multi-auth@latest --uninstall
npx -y opencode-openai-codex-multi-auth@latest --uninstall --all
```

Note: if you previously installed the GitHub-spec version (`github:iam-brain/opencode-openai-codex-multi-auth`), re-running the installer will migrate you to the npm package.
---
## 📦 Models
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

Minimal configs are not supported for GPT‑5.x; use the full configs above.
---
## ✅ Features
- ChatGPT Plus/Pro OAuth authentication (official flow)
- 22 model presets across GPT‑5.2 / GPT‑5.2 Codex / GPT‑5.1 families
- Variant system support (v1.0.210+) + legacy presets
- Multimodal input enabled for all models
- Usage‑aware errors + automatic token refresh
- Multi-account support with sticky selection + PID offset (great for parallel agents)
- Optional round-robin account rotation (maximum throughput)
- OpenCode TUI toasts + `openai-accounts` / `openai-accounts-switch` tools
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
- This fork: multi-account pool, sticky-by-default rotation with PID offset, round-robin option, and account tools/toasts

**Built for developers who value simplicity.**
