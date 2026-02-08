### v4.5.25 — Release Notes (since v4.5.24)

Bugfix release: toast debounce configuration and legacy account removal.

### Highlights

- Corrected toast notification debounce time.
- Hardened legacy account removal against token rotation race conditions.

### User-Facing Changes

**Reliability & Data Safety**

- **Toast Spam Fix**: Notifications for rate-limit account switching now respect the 60s debounce timer (`rateLimitToastDebounceMs`) instead of the 2s dedupe window, preventing UI spam during heavy load.
- **Account Removal Safety**: account removal now safely handles in-memory token rotations during the same session, preventing "zombie" accounts from persisting in storage.

**Full Changelog**: https://github.com/iam-brain/opencode-openai-codex-multi-auth/compare/v4.5.24...v4.5.25
