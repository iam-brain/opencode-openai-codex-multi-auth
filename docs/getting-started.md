# Getting Started

Complete installation and setup guide for the OpenCode OpenAI Codex Auth Plugin.

## ⚠️ Before You Begin

**This plugin is for personal development use only.** It uses OpenAI's official OAuth authentication for individual coding assistance with your ChatGPT Plus/Pro subscription.

**Not intended for:** Commercial services, API resale, multi-user applications, or any use that violates [OpenAI's Terms of Use](https://openai.com/policies/terms-of-use/).

For production applications, use the [OpenAI Platform API](https://platform.openai.com/).

---

## Prerequisites

- **OpenCode** installed ([installation guide](https://opencode.ai))
- **ChatGPT Plus or Pro subscription** (required for Codex access)
- **Node.js** 20+ (for OpenCode)

## Installation

### One-Command Install/Update (Recommended)

Works on **Windows, macOS, and Linux**:

```bash
npx -y opencode-openai-codex-multi-auth@latest
```

This writes the **global** config at `~/.config/opencode/opencode.jsonc` (falls back to `.json` if needed), backs it up, and clears the OpenCode plugin cache so the latest version installs.
It seeds templates **online-first** (latest release, then `main`) and falls back to bundled static templates if network sources are unavailable.

Need legacy config (OpenCode v1.0.209 and below)?

```bash
npx -y opencode-openai-codex-multi-auth@latest --legacy
```

---

### Step 1: Add Plugin to Config

OpenCode automatically installs plugins - no `npm install` needed!

**Choose your configuration style:**

#### ⚠️ REQUIRED: Full Configuration (Only Supported Setup)

**IMPORTANT**: You MUST use the full configuration. This is the ONLY officially supported setup for GPT 5.x models.

**Why the full config is required:**
- GPT 5 models can be temperamental and need proper configuration
- Minimal configs are NOT supported and will fail unpredictably
- OpenCode features require proper model metadata
- This configuration has been tested and verified to work

Add this to `~/.config/opencode/opencode.jsonc` (or `.json`):

**Tip**: The snippet below is a truncated excerpt. For the complete legacy list, copy `config/opencode-legacy.json`. For the modern variants config (OpenCode v1.0.210+), use `config/opencode-modern.json`.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-openai-codex-multi-auth"],
  "provider": {
    "openai": {
      "options": {
        "reasoningEffort": "medium",
        "reasoningSummary": "auto",
        "textVerbosity": "medium",
        "include": ["reasoning.encrypted_content"],
        "store": false
      },
      "models": {
        "gpt-5.3-codex": {
          "name": "GPT 5.3 Codex (OAuth)",
          "limit": {
            "context": 272000,
            "output": 128000
          },
          "options": {
            "reasoningEffort": "medium",
            "reasoningSummary": "auto",
            "textVerbosity": "medium",
            "include": ["reasoning.encrypted_content"],
            "store": false
          }
        },
        "gpt-5.3-codex-low": {
          "name": "GPT 5.3 Codex Low (OAuth)",
          "limit": {
            "context": 272000,
            "output": 128000
          },
          "options": {
            "reasoningEffort": "low",
            "reasoningSummary": "auto",
            "textVerbosity": "medium",
            "include": ["reasoning.encrypted_content"],
            "store": false
          }
        },
        "gpt-5.3-codex-high": {
          "name": "GPT 5.3 Codex High (OAuth)",
          "limit": {
            "context": 272000,
            "output": 128000
          },
          "options": {
            "reasoningEffort": "high",
            "reasoningSummary": "detailed",
            "textVerbosity": "medium",
            "include": ["reasoning.encrypted_content"],
            "store": false
          }
        },
        "gpt-5.2-codex": {
          "name": "GPT 5.2 Codex (OAuth)",
          "limit": {
            "context": 272000,
            "output": 128000
          },
          "options": {
            "reasoningEffort": "medium",
            "reasoningSummary": "auto",
            "textVerbosity": "medium",
            "include": ["reasoning.encrypted_content"],
            "store": false
          }
        },
        "gpt-5.2": {
          "name": "GPT 5.2 (OAuth)",
          "limit": {
            "context": 272000,
            "output": 128000
          },
          "options": {
            "reasoningEffort": "medium",
            "reasoningSummary": "auto",
            "textVerbosity": "medium",
            "include": ["reasoning.encrypted_content"],
            "store": false
          }
        }
      }
    }
  }
}
```

  **What you get:**
  - ✅ GPT 5.3 Codex (low/medium/high/xhigh reasoning)
  - ✅ GPT 5.2 (none/low/medium/high/xhigh reasoning)
  - ✅ GPT 5.2 Codex (low/medium/high/xhigh reasoning)
  - ✅ GPT 5.1 Codex Max (low/medium/high/xhigh reasoning presets)
  - ✅ GPT 5.1 Codex (low/medium/high reasoning)
  - ✅ GPT 5.1 Codex Mini (medium/high reasoning)
  - ✅ GPT 5.1 (none/low/medium/high reasoning)
  - ✅ 272k context + 128k output window for all GPT 5.x presets.
  - ✅ All visible in OpenCode model selector
  - ✅ Optimal settings for each reasoning level

**Optional: Personality configuration**

Personality settings live in the plugin config file: `~/.config/opencode/openai-codex-auth-config.json` under `custom_settings`.

```json
{
  "custom_settings": {
    "options": {
      "personality": "friendly"
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

Personality descriptions are loaded from:
- Project-local `.opencode/Personalities/*.md`
- Global `~/.config/opencode/Personalities/*.md`

The filename (case-insensitive) is the personality key; the file contents are used verbatim.

Built-ins: `none`, `default` (uses model runtime defaults), `friendly`, `pragmatic` (fallback if unset). Any other key requires a matching file.

> **Note**: All `gpt-5.*` presets use 272k context / 128k output limits.
>
> **Note**: Codex Max presets map to the `gpt-5.1-codex-max` slug with 272k context and 128k output. Use `gpt-5.1-codex-max-low/medium/high/xhigh` to pick the reasoning level (only `-xhigh` uses `xhigh` reasoning).
>
> **Note**: GPT-5.3-Codex, GPT-5.2, and GPT-5.2 Codex support `xhigh` reasoning. Use explicit reasoning levels (e.g., `gpt-5.3-codex-xhigh`, `gpt-5.2-xhigh`) for precise control.

Prompt caching is enabled out of the box: when OpenCode sends its session identifier as `prompt_cache_key`, the plugin forwards it untouched so multi-turn runs reuse prior work. If you hit your ChatGPT subscription limits, the plugin returns a friendly Codex-style message with the 5-hour and weekly usage windows so you know when capacity resets.

> **⚠️ CRITICAL:** This full configuration is REQUIRED. OpenCode's context auto-compaction and usage sidebar only work with this full configuration. GPT 5 models are temperamental and need proper setup - minimal configurations are NOT supported.

#### ❌ Minimal Configuration (NOT SUPPORTED - DO NOT USE)

**DO NOT use minimal configurations** - they will NOT work reliably with GPT 5:

```json
// ❌ DO NOT USE THIS
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-openai-codex-multi-auth"],
  "model": "openai/gpt-5.3-codex"
}
```

**Why this doesn't work:**
- GPT 5 models need proper configuration to work reliably
- Missing model metadata breaks OpenCode features
- Cannot guarantee stable operation

### Step 2: Authenticate

```bash
opencode auth login
```

1. Select **"OpenAI"**
2. Choose **"ChatGPT Pro/Plus (Codex Multi Auth)"**

   If you see other OpenAI auth options, they are OpenCode's built-in methods. This plugin's flow is the one labeled **"(Codex Multi Auth)"**.
3. Browser opens automatically for OAuth flow
4. Log in with your ChatGPT account
5. Done! Accounts saved to `~/.config/opencode/openai-codex-accounts.json`

**Multi-account:** Run `opencode auth login` again to add more ChatGPT accounts (you'll be prompted to add, fresh start, or manage accounts to enable/disable). Accounts are stored in `~/.config/opencode/openai-codex-accounts.json`. See [Multi-Account](multi-account.md).

**⚠️ Important**: If you have the official Codex CLI running, stop it first (both use port 1455 for OAuth callback).

**Manual fallback**: On SSH/WSL/remote environments, pick **"ChatGPT Plus/Pro (Manual URL Paste)"** and paste the full redirect URL after login.

### Step 3: Test It

```bash
# Quick test
opencode run "write hello world to test.txt" --model=openai/gpt-5.3-codex --variant=medium

# Or start interactive session
opencode
```

You'll see all GPT 5.x variants (GPT 5.3 Codex, GPT 5.2, GPT 5.2 Codex, Codex Max, Codex, Codex Mini, and GPT 5.1 presets) in the model selector!

---

## Configuration Locations

OpenCode checks multiple config files in order:

1. **Project config**: `./.opencode.json` (current directory)
2. **Parent configs**: Walks up directory tree
3. **Global config**: `~/.config/opencode/opencode.jsonc` (or `~/.config/opencode/opencode.json`)

**Recommendation**: Use global config for plugin, project config for model/agent overrides.

---

## ⚠️ Updating the Plugin (Important!)

OpenCode caches plugins. To install the latest version, just re-run the installer:

```bash
npx -y opencode-openai-codex-multi-auth@latest
```

Legacy OpenCode (v1.0.209 and below):

```bash
npx -y opencode-openai-codex-multi-auth@latest --legacy
```

## Uninstall

```bash
npx -y opencode-openai-codex-multi-auth@latest --uninstall
npx -y opencode-openai-codex-multi-auth@latest --uninstall --all
```

**When to update:**
- New features released
- Bug fixes available
- Security updates

**Check for updates**: [Releases Page](https://github.com/iam-brain/opencode-openai-codex-multi-auth/releases)

**Pro tip**: Subscribe to release notifications on GitHub to get notified of updates.

---

## Local Development Setup

For plugin development or testing unreleased changes:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-openai-codex-multi-auth/dist"]
}
```

**Note**: Must point to `dist/` folder (built output), not root.

**Build the plugin:**
```bash
cd opencode-openai-codex-multi-auth
npm install
npm run build
```

---

## Verifying Installation

### Check Plugin is Loaded

```bash
opencode --version
# Should not show any plugin errors
```

### Check Authentication

```bash
cat ~/.config/opencode/openai-codex-accounts.json
# Should show OAuth credentials (if authenticated)
```

### Test API Access

```bash
# Enable logging to verify requests
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "test" --model=openai/gpt-5.3-codex

# Check logs
ls ~/.config/opencode/logs/codex-plugin/
# Should show request logs
```

---

## Next Steps

- [Configuration Guide](configuration.md) - Advanced config options
- [Troubleshooting](troubleshooting.md) - Common issues and solutions
- [Developer Docs](development/ARCHITECTURE.md) - Technical deep dive

**Back to**: [Documentation Home](index.md)
