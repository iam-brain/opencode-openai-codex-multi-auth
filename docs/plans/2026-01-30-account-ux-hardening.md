# Account UX + Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add account repair/quarantine flows, safer auto-repair on first send, and UX-safe toast/status messaging.

**Architecture:** Introduce storage inspection/quarantine helpers, wire repair prompts in login flows, and add auto-repair with quarantine on request selection. Add message formatting helpers to keep toast/status copy short and wrap-friendly.

**Tech Stack:** TypeScript, Node fs, OpenCode plugin SDK, Vitest.

---

### Task 1: Add storage inspection + quarantine helpers

**Files:**
- Modify: `lib/storage.ts`
- Test: `test/storage.test.ts`

**Step 1: Write the failing tests**

```ts
it("inspectAccountsFile flags corrupt json", async () => {
  // write invalid JSON to storage path
  // expect status === "corrupt-file"
});

it("inspectAccountsFile reports corrupt + legacy entries", async () => {
  // write storage with: one valid, one missing refresh, one missing plan
  // expect corruptEntries.length === 1 and legacyEntries.length === 1
});

it("quarantineAccounts writes file and removes entries", async () => {
  // call quarantine helper with 2 records
  // expect quarantine path exists and payload includes records
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/storage.test.ts`
Expected: FAIL (helpers not defined / assertions fail)

**Step 3: Write minimal implementation**

- Add `inspectAccountsFile()` to parse raw JSON and classify entries into `valid`, `legacy`, and `corrupt`.
- Add `writeQuarantineFile()` to persist quarantined records with reason and timestamp.
- Add `quarantineAccounts()` to write quarantine file and return its path.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/storage.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add lib/storage.ts test/storage.test.ts
git commit -m "feat: add account inspection and quarantine helpers"
```

---

### Task 2: Repair flow for CLI/TUI login

**Files:**
- Modify: `lib/cli.ts`
- Modify: `index.ts`
- Modify: `lib/accounts.ts`
- Test: `test/accounts-manager.test.ts`

**Step 1: Write the failing tests**

```ts
it("repairLegacyAccounts quarantines failures", async () => {
  // stub refreshAccessToken to fail
  // expect quarantined list to include legacy account
});

it("repairLegacyAccounts fills missing identity", async () => {
  // stub refreshAccessToken success with id/access claims
  // expect account identity populated
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/accounts-manager.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

- Add `repairLegacyAccounts()` on `AccountManager` to attempt hydration and return `{ repaired, quarantined }`.
- Add `promptRepairAccounts()` to `lib/cli.ts` for CLI/TUI login prompts.
- In `authorize` flow (`index.ts`), call `inspectAccountsFile()` and prompt. If user accepts, run repair, quarantine failures, and show result.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/accounts-manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add lib/accounts.ts lib/cli.ts index.ts test/accounts-manager.test.ts
git commit -m "feat: prompt and repair legacy accounts"
```

---

### Task 3: Auto-repair + quarantine on first send

**Files:**
- Modify: `lib/accounts.ts`
- Modify: `index.ts`
- Test: `test/accounts-manager.test.ts`

**Step 1: Write the failing tests**

```ts
it("auto-repair skips disabled accounts", async () => {
  // mark legacy account disabled
  // expect repairLegacyAccounts to ignore it
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/accounts-manager.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

- Add helper to check for legacy accounts before selection.
- In request loop (`index.ts`), if no eligible accounts and legacy exist, attempt repair.
- On failure, quarantine accounts and show toast; retry with next eligible account.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/accounts-manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add lib/accounts.ts index.ts test/accounts-manager.test.ts
git commit -m "feat: auto-repair legacy accounts on first send"
```

---

### Task 4: Toast + status message formatting (wrap-safe)

**Files:**
- Modify: `index.ts`
- Test: `test/auth.test.ts` or `test/helpers` (new helper tests)

**Step 1: Write failing tests**

```ts
it("formatToastMessage truncates long paths", () => {
  // expect .../openai-codex-accounts.json
});

it("formatStatusMessage clamps length", () => {
  // expect <= 120 chars
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/auth.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

- Add message formatting helpers in `index.ts`.
- Use them in `showToast` and error-response message generation.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/auth.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add index.ts test/auth.test.ts
git commit -m "fix: wrap-safe toast and status messages"
```

---

### Task 5: Docs update

**Files:**
- Modify: `docs/multi-account.md`
- Modify: `docs/troubleshooting.md`

**Step 1: Update docs**

- Document repair prompts, quarantine behavior, and auto-repair on first send.
- Add troubleshooting entry for quarantine file paths.

**Step 2: Commit**

```bash
git add docs/multi-account.md docs/troubleshooting.md
git commit -m "docs: document account repair and quarantine"
```

---

### Task 6: Full verification

**Step 1: Run full tests**

Run: `npm test`
Expected: PASS

**Step 2: Run build**

Run: `npm run build`
Expected: PASS
