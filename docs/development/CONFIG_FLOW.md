# OpenCode Config Flow: Complete Guide

This document explains how OpenCode configuration flows from user files through the plugin system to the Codex API.

> Note: Some examples use legacy model aliases for compatibility demonstrations. Runtime normalization maps known gpt-5.x variants (like `gpt-5.3-codex-low`) to base slugs (`gpt-5.3-codex`) before API submission; unknown/legacy IDs are lowercased and preserved without substring coercion.

## Table of Contents

- [Config Loading Order](#config-loading-order)
- [Provider Options Flow](#provider-options-flow)
- [Model Selection & Persistence](#model-selection--persistence)
- [Plugin Configuration](#plugin-configuration)
- [Examples](#examples)
- [Best Practices](#best-practices)

---

## Config Loading Order

OpenCode loads and merges configuration from multiple sources in this order (**last wins**):

### 1. Global Config

```
~/.config/opencode/opencode.jsonc
~/.config/opencode/opencode.json
```

### 2. Project Configs (traversed upward from cwd)

```
<project>/.opencode/opencode.jsonc
<project>/.opencode/opencode.json
<parent>/.opencode/opencode.jsonc
<parent>/.opencode/opencode.json
... (up to worktree root)
```

### 3. Custom Config (via flags)

```bash
OPENCODE_CONFIG=/path/to/config.json opencode
# or
OPENCODE_CONFIG_CONTENT='{"model":"openai/gpt-5"}' opencode
```

### 4. Auth Configs

```
# From .well-known/opencode endpoints (for OAuth providers)
https://auth.example.com/.well-known/opencode
```

**Source**: `tmp/opencode/packages/opencode/src/config/config.ts:26-51`

---

## Provider Options Flow

Options are merged at multiple stages before reaching the plugin:

### Stage 1: Database Defaults

Models.dev provides baseline capabilities for each provider/model.

### Stage 2: Environment Variables

```bash
export OPENAI_API_KEY="sk-..."
```

### Stage 3: Custom Loaders

Plugins can inject options via the `loader()` function.

### Stage 4: User Config (HIGHEST PRIORITY)

```json
{
  "provider": {
    "openai": {
      "options": {
        "reasoningEffort": "medium",
        "textVerbosity": "low"
      }
    }
  }
}
```

**Result**: User config overrides everything else.

**Source**: `tmp/opencode/packages/opencode/src/provider/provider.ts:236-339`

---

## Model Selection & Persistence

### Display Names vs Internal IDs

**Your Config** (`config/opencode-legacy.json`):

```json
{
  "provider": {
    "openai": {
      "models": {
        "gpt-5.3-codex-medium": {
          "name": "GPT 5.3 Codex Medium (OAuth)",
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

**What OpenCode Uses**:

- **UI Display**: "GPT 5.3 Codex Medium (OAuth)" ✅
- **Persistence**: `provider_id: "openai"` + `model_id: "gpt-5.3-codex-medium"` ✅
- **Plugin lookup**: `models["gpt-5.3-codex-medium"]` → used to build Codex request ✅

### TUI Persistence

The TUI stores recently used models in `~/.config/opencode/tui`:

```toml
[[recently_used_models]]
provider_id = "openai"
model_id = "gpt-5.3-codex"
last_used = 2025-10-12T10:30:00Z
```

**Key Point**: Custom display names are **UI-only**. The underlying config key (persisted as model_id) is used for selection, while normalization determines the slug sent to APIs.

**Source**: `tmp/opencode/packages/tui/internal/app/state.go:54-79`

---

## Plugin Configuration

### How This Plugin Receives Config

**Plugin Entry Point** (`index.ts:64-86`):

```typescript
async loader(getAuth: () => Promise<Auth>, provider: unknown) {
  const providerConfig = provider as {
    options?: Record<string, unknown>;
    models?: UserConfig["models"]
  };

  const userConfig: UserConfig = {
    global: providerConfig?.options || {},  // Global options
    models: providerConfig?.models || {},   // Per-model options
  };

  // ... use userConfig in custom fetch()
}
```

Plugin settings are loaded from `~/.config/opencode/openai-codex-auth-config.json` and include:

- Account selection + scheduling: `accountSelectionStrategy`, `schedulingMode`, `maxCacheFirstWaitSeconds`, `switchOnFirstRateLimit`
- Rate-limit tuning: `rateLimitDedupWindowMs`, `rateLimitStateResetMs`, `defaultRetryAfterMs`, `maxBackoffMs`, `requestJitterMaxMs`
- Hard-stop safety: `hardStopMaxWaitMs`, `hardStopOnUnknownModel`, `hardStopOnAllAuthFailed`, `hardStopMaxConsecutiveFailures`
- Token refresh + logging: `tokenRefreshSkewMs`, `proactiveTokenRefresh`, `authDebug`
- Storage + UX: `perProjectAccounts`, `pidOffsetEnabled`, `quietMode`

See `docs/configuration.md` for the full field table and environment variable mapping.

### Config Structure

```typescript
type UserConfig = {
  global: {
    // Applied to ALL models
    reasoningEffort?: "minimal" | "low" | "medium" | "high";
    textVerbosity?: "low" | "medium" | "high";
    include?: string[];
  };
  models: {
    [modelName: string]: {
      options?: {
        // Override global for specific model
        reasoningEffort?: "minimal" | "low" | "medium" | "high";
        textVerbosity?: "low" | "medium" | "high";
      };
    };
  };
};
```

### Option Precedence

For a given model, options are merged:

1. **Global options** (`provider.openai.options`)
2. **Model-specific options** (`provider.openai.models[modelName].options`) ← WINS

**Implementation**: `lib/request/request-transformer.ts:getModelConfig()`

---

## Examples

### Example 1: Global Options Only

```json
{
  "plugin": ["opencode-openai-codex-multi-auth"],
  "provider": {
    "openai": {
      "options": {
        "reasoningEffort": "medium",
        "textVerbosity": "medium",
        "include": ["reasoning.encrypted_content"]
      }
    }
  }
}
```

**Result**: All OpenAI models use these options.

### Example 2: Per-Model Override

```json
{
  "plugin": ["opencode-openai-codex-multi-auth"],
  "provider": {
    "openai": {
      "options": {
        "reasoningEffort": "medium",
        "textVerbosity": "medium"
      },
      "models": {
        "gpt-5.3-codex-high": {
          "name": "GPT 5.3 Codex High (OAuth)",
          "options": {
            "reasoningEffort": "high",
            "reasoningSummary": "detailed"
          }
        },
        "gpt-5-nano": {
          "name": "GPT 5 Nano (OAuth)",
          "options": {
            "reasoningEffort": "minimal",
            "textVerbosity": "low"
          }
        }
      }
    }
  }
}
```

**Result**:

- `gpt-5.3-codex-high` uses `reasoningEffort: "high"` (overridden) + `textVerbosity: "medium"` (from global)
- `gpt-5-nano` uses `reasoningEffort: "minimal"` + `textVerbosity: "low"` (both overridden)

### Example 3: Full Configuration

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-openai-codex-multi-auth"],
  "model": "openai/gpt-5.3-codex-medium",
  "provider": {
    "openai": {
      "options": {
        "reasoningEffort": "medium",
        "reasoningSummary": "auto",
        "textVerbosity": "medium",
        "include": ["reasoning.encrypted_content"]
      },
      "models": {
        "gpt-5.3-codex-low": {
          "name": "GPT 5.3 Codex Low (OAuth)",
          "options": {
            "reasoningEffort": "low"
          }
        },
        "gpt-5.3-codex-high": {
          "name": "GPT 5.3 Codex High (OAuth)",
          "options": {
            "reasoningEffort": "high",
            "reasoningSummary": "detailed"
          }
        }
      }
    }
  }
}
```

---

## Best Practices

### 1. Use Per-Model Options for Variants

Instead of duplicating global options, override only what's different:

❌ **Bad**:

```json
{
  "models": {
    "gpt-5-low": {
      "id": "gpt-5",
      "options": {
        "reasoningEffort": "low",
        "textVerbosity": "low",
        "include": ["reasoning.encrypted_content"]
      }
    },
    "gpt-5-high": {
      "id": "gpt-5",
      "options": {
        "reasoningEffort": "high",
        "textVerbosity": "high",
        "include": ["reasoning.encrypted_content"]
      }
    }
  }
}
```

✅ **Good**:

```json
{
  "options": {
    "include": ["reasoning.encrypted_content"]
  },
  "models": {
    "gpt-5-low": {
      "id": "gpt-5",
      "options": {
        "reasoningEffort": "low",
        "textVerbosity": "low"
      }
    },
    "gpt-5-high": {
      "id": "gpt-5",
      "options": {
        "reasoningEffort": "high",
        "textVerbosity": "high"
      }
    }
  }
}
```

### 2. Keep Display Names Meaningful

Custom model names help you remember what each variant does:

```json
{
  "models": {
    "GPT 5 Codex - Fast & Cheap": {
      "id": "gpt-5.3-codex",
      "options": { "reasoningEffort": "low" }
    },
    "GPT 5 Codex - Balanced": {
      "id": "gpt-5.3-codex",
      "options": { "reasoningEffort": "medium" }
    },
    "GPT 5 Codex - Max Quality": {
      "id": "gpt-5.3-codex",
      "options": { "reasoningEffort": "high" }
    }
  }
}
```

### 3. Set Defaults at Global Level

Most common settings should be global:

```json
{
  "options": {
    "reasoningEffort": "medium",
    "reasoningSummary": "auto",
    "textVerbosity": "medium",
    "include": ["reasoning.encrypted_content"]
  }
}
```

### 4. Prefer Config Files for Plugin Settings

Use plugin config files for persistent behavior.

---

## Troubleshooting

### Config Not Being Applied

1. Check config file syntax with `jq . < config.json`
2. Verify config file location (use absolute paths)
3. Check OpenCode logs for config load errors
4. Use `OPENCODE_CONFIG_CONTENT` to test minimal configs

### Model Not Persisting

1. TUI remembers the `id` field, not the display name
2. Check `~/.config/opencode/tui` for recently used models
3. Verify your config has the correct `id` field

### Options Not Taking Effect

1. Model-specific options override global options
2. Plugin receives merged config from OpenCode
3. Add debug logging to verify what plugin receives

---

## See Also

- [ARCHITECTURE.md](./ARCHITECTURE.md) - Plugin architecture and design decisions
- [OpenCode Config Schema](https://opencode.ai/config.json) - Official schema
- [Models.dev](https://models.dev) - Model capability database
