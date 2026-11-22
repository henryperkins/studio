# Subscription Native Platform Qualification Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Implement shared platform seams once; qualify each native platform separately and retain its evidence.

**Goal:** Support and qualify both subscription providers on all six existing Studio app/CLI platform targets.

**Architecture:** Keep provider logic portable and move executable inspection, terminal launch, environment/path identity and owned-process lifecycle behind small platform adapters. Reuse the existing credential-store and packaging boundaries.

**Tech Stack:** Node/TypeScript, native Windows/macOS/Linux services, Electron Forge, repository standalone-CLI bundling, Vitest and Playwright.

**Spec:** [Full parity and platform scope](../specs/2026-11-11-subscription-provider-parity.md). Dependencies: G3/C5 acceptance runners, C1 execution policy, C4 recovery and M2 CI.

## Global constraints

All coordinator constraints apply. No silent WSL fallback, global vendor configuration changes, token-file parsing, plaintext storage or automatic runtime downgrade/update. Use real native runners for qualification. Linux Desktop target is Debian/Ubuntu glibc with the existing DEB packaging; this plan does not claim Alpine/musl Desktop support.

## Review focus

1. A qualified executable must remain the same binary between inspection, sign-in and execution (P1).
2. Case-sensitive paths and platform environment requirements must not inherit Windows assumptions (P1).
3. Cancelling native shell work must terminate owned descendants without touching unrelated processes (P2).
4. Locked/missing credential services must fail clearly or use explicitly selected session-only storage (P3).
5. Cross-builds and synthetic UI fixtures cannot satisfy native authenticated package acceptance (P4).

### P1: Portable runtime discovery, sign-in and configuration

**Modify:** `packages/agent/node/claude-code/discovery.ts`, `studio-surface.ts`, `connection.ts`, `configuration.ts`, `auth-status.ts` and their tests; `packages/common/lib/user-settings/terminal.ts`, `open-linux-terminal.ts` only where a reusable terminal-launch primitive is needed.

**Create:** `packages/agent/node/claude-code/platform.ts`, `platforms/windows.ts`, `platforms/macos.ts`, `platforms/linux.ts`, `tests/platform.test.ts`.

**Interfaces:** `platform.ts` selects an adapter by actual OS/architecture and exposes executable inspection, canonical configuration identity, allowed child environment, managed-policy inspection and native sign-in launch. Existing `inspectClaudeConnection`/connection functions remain the public boundary. Inspection returns safe executable/version/architecture/provenance metadata; it never returns tokens.

- [ ] Replace both the discovery and UI-surface Windows/x64 gates with a qualified SDK/runtime/platform matrix. Start with the known SDK `0.3.319` / Windows x64 runtime `2.1.319` record; add a pair only after its native qualification passes.
- [ ] Add fixture tests for PE/architecture/Authenticode, Mach-O/architecture/vendor signing, and ELF/architecture/vendor signed-manifest checksum verification. Check changed binaries, symlinks, spaces/Unicode and unqualified versions. Path extension alone is insufficient.
- [ ] Fix unconditional path lowercasing in `connection.ts`. Canonical identity must respect the filesystem and preserve distinct paths on case-sensitive Linux/macOS volumes; test aliases and symlinks without collapsing distinct profiles.
- [ ] Define minimal per-platform child environment allowlists. Preserve required HOME/SHELL/XDG/session/display values on Unix and required Windows values; retain secret removal and explicit rejection of alternate billing routes. Test Windows case-insensitive environment names.
- [ ] Implement vendor managed-policy/configuration checks on each OS. The current non-Windows `false` result is not a compatibility decision. Inspect documented policy locations without reading credential contents.
- [ ] Launch vendor-owned login with argv-safe platform adapters in an actual interactive terminal. Handle no terminal/display/browser as an explicit user-action state. Inspection and execution must resolve the same executable, user, cwd and native configuration.
- [ ] Show detected/supported runtime versions and the selected executable in Settings. Runtime auto-updates must produce an actionable qualification error before releasing a prompt; Studio must not silently change binaries or alter the user's updater settings.
- [ ] Run discovery/environment/configuration/connection tests, changed-file ESLint and typecheck. Test real sign-in/inspection on each OS in P4.

**Exit:** All six targets have portable code paths and explicit compatibility records; unknown runtime versions remain visible and unqualified until tested.

### P2: Own and terminate complete native process trees

**Modify:** `packages/agent/node/claude-code/runtime.ts`, native lifecycle tests/fixtures; `packages/common/lib/cli-process.ts` only where the shared process abstraction changes.

**Create:** `packages/common/lib/owned-process.ts`, `packages/common/lib/tests/owned-process.test.ts` and platform-specific implementation files if required by the final adapter size.

**Interfaces:** Export `ProcessIdentity` containing PID plus verified process-start identity, and an owned-process handle that can inspect ownership, request graceful shutdown, wait with a bound and escalate only within the owned tree. C4 consumes the same identity check for recovery. An unknown identity is not treated as dead.

- [ ] Add meaningful fixtures that launch a child and shell grandchild, an unrelated sentinel process and a pending approval. Test close, abort, stdin EOF, native death and owner death.
- [ ] Implement native ownership mechanisms appropriate to each platform: Windows owned-tree/job behavior and POSIX process-group/session supervision as supported. Preserve enough identity to detect PID reuse; do not kill by executable name or a stale PID alone.
- [ ] Connect cancellation to C1's execution boundary and pending approvals before shutdown. Verify no later host operation runs after cancellation is acknowledged.
- [ ] Extend `native-lifecycle.test.ts` beyond Windows; remove platform skips only when their fixture actually exercises the OS. Assert bounded cleanup, no surviving owned descendants, preserved unrelated processes and one non-success terminal outcome for interrupted/failed runs.
- [ ] Exercise owner-crash recovery with C4, including replacement-lock races and uncertain mutation outcomes. Record any irrecoverable ambiguity as a blocked recovery rather than forcing an unlock.

**Exit:** Shell/tool parity does not leave uncontrolled descendants, and recovery can use real process identity on every platform.

### P3: Native ChatGPT secure-storage and browser qualification

**Modify:** `packages/common/lib/os-credential-store.ts` and its existing tests only for demonstrated defects; `packages/agent/node/chatgpt` lifecycle code as necessary; `apps/studio/forge.config.ts` for Linux dependency handling.

**Create:** `packages/common/lib/tests/os-credential-store-native.test.ts` and isolated fixtures; document opt-in native test configuration in `scripts/chatgpt-acceptance/README.md`.

**Interfaces:** Preserve `OsCredentialStore` and ChatGPT's encrypted-record/wrapping-key design. Native tests use a unique test credential identifier; production keys and unrelated registrations are never deleted. Native-store testing is opt-in and separate from credential-free CI.

- [ ] Exercise Windows PasswordVault, macOS Keychain and Linux Secret Service for write/read/delete, restart persistence, large records through the encrypted-record layer, corrupt ciphertext and lost wrapping keys.
- [ ] Test denied/locked/unavailable storage, missing `secret-tool`, unavailable session bus and headless sessions. Assert no plaintext fallback and no secret-bearing process argv, stdout or diagnostic artifacts.
- [ ] Declare the Secret Service command dependency for the Linux DEB where persistent storage is offered; document it for standalone CLI users. An installed command without an unlocked Secret Service session is not proof that storage works.
- [ ] Qualify system-browser callback, callback-port collision, cancel/timeout, returning identity and explicit session-only selection on each OS/architecture. Retain same-host browser limitations; do not advertise remote callback support that cannot work.
- [ ] Run G3's owner/fork IPC, unoffered-process failure, refresh/sign-out and restart behavior with each native store. GUI failures and headless session-only behavior require separate results.

**Exit:** Persistent and session-only modes are demonstrated natively and failure states preserve credentials and account isolation correctly.

### P4: Qualify shipped app and CLI artifacts on all six targets

**Inspect/modify as needed:** Root/app `package.json`, `apps/studio/forge.config.ts`, `apps/cli/vite.config.base.ts`, dependency manifests/lockfile, `scripts/package-in-isolation.ts`, `create-standalone-bundle.ts`, `download-php-binary.ts`, native dependency installation and package tests.

**Interfaces:** Every evidence record identifies provider, source SHA, OS/architecture/version, SDK/runtime pair and provenance, Node version, artifact hash, signing status, install/launch result and evidence level. The platform matrix is maintained in `docs/superpowers/evidence/subscription-readiness.md`.

| Native runner | App build command | Standalone CLI target |
| --- | --- | --- |
| Windows x64 | `npm run make:windows-x64` | `win32 x64` |
| Windows ARM64 | `npm run make:windows-arm64` | `win32 arm64` |
| macOS x64 | `npm run make:macos-x64` | `darwin x64` |
| macOS ARM64 | `npm run make:macos-arm64` | `darwin arm64` |
| Linux x64 | `npm run make:linux-x64` | `linux x64` |
| Linux ARM64 | `npm run make:linux-arm64` | `linux arm64` |

- [ ] Use `.nvmrc`, the repository npm version and `npm ci` on each native runner. Verify native SDK/CLI dependencies and dependency ranges. Windows ARM64's existing x64 PHP emulation must be recorded and exercised explicitly.
- [ ] Run credential-free full tests and builds through M2; run opt-in native process/storage tests separately. Provision controlled runners for platforms unavailable in ordinary hosted CI; missing runners leave gates open.
- [ ] Build browser UI and CLI: `npm run cli:build:ui`. On PowerShell, if the existing POSIX environment assignment fails, set `$env:STUDIO_TARGET='local'`, run `npm -w @studio/ui run build`, restore that variable, then `npm run cli:build`. Do not present plain `cli:build` as a UI rebuild.
- [ ] Build the app with `STUDIO_PACKAGE_FRESH=1` and the matching command above. Build the standalone CLI on that same architecture with `node --experimental-strip-types scripts/create-standalone-bundle.ts <platform> <arch>`. Foreign Node downloads do not qualify host-built native modules.
- [ ] Verify SDK loading and native runtime initialization from packaged main/ASAR and standalone CLI. Then complete real authenticated G3/C5 read/draft/readback/resume, cancellation and recovery with the installed artifacts; zero-prompt startup probes are a separate lower evidence level.
- [ ] Run Desktop app/IPC/settings/chat/site persistence e2e, plus the expanded provider UI cases, in light/dark. Run browser equivalents, keyboard interaction and narrow layouts. On Linux exercise supported X11/Wayland paths and no-keyring behavior.
- [ ] Verify clean install, relaunch, update from the prior compatible build, existing session migration and uninstall behavior without deleting user sites/history. Use disposable OS/test profiles. Record signing/notarization separately from functional merge readiness; do not claim an unsigned artifact is release-ready.
- [ ] Populate all twelve provider/platform cells and link rich workflow/eval evidence. Rebuild and rerun affected cells after platform/runtime/package changes. Hand final results to M3/M4.

**Exit:** Every required native target runs both providers and their application surfaces from actual artifacts, with no missing or substituted platform evidence.
