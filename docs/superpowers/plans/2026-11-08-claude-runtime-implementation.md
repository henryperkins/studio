# Official Claude runtime connection implementation plan

> **For agentic workers:** Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Checkboxes are acceptance requirements, not completed work.

**Goal:** Run the official, unmodified Claude Code runtime from Studio, using sign-in owned by that runtime and Studio's WordPress tool host.

**Architecture:** Add a backend adapter, not a Pi model transport. Keep native Claude history separate from Studio's projected display journal. Use the official Agent SDK as the process/control bridge and an SDK MCP server for host-specific WordPress tools.

**Tech Stack:** Existing TypeScript/npm workspaces, official Claude Agent SDK pinned in the lockfile, native Windows Claude Code, React/Electron/local HTTP, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-08-subscription-connections-design.md`. Reuse the provider-qualified connection types introduced in the ChatGPT plan; do not reimplement them.

## Observed completion — November 10, 2026

Draft [PR #3](https://github.com/henryperkins/studio/pull/3), stacked on PR #2, implements Tasks 1–2 and Task 3's scoped proof of concept. Merge `11e0a5810` brings forward PR #2 through `4ae1e38da`, including global ChatGPT default rejection and unconfirmed-revocation coverage. This follow-up completes the Claude renderer hardening, offline native lifecycle qualification, fresh Windows x64 packaging and packaged Desktop checks.

- Creation and sending require successful, settled connection and catalog checks. Failed refreshes and removed or blocked connections hold prompts. Pickers retain explicit model/effort choices when options close or change, rather than saving an automatic fallback to the initial value.
- Pending draft approvals come from the current run, with run-ID and snapshot-revision fencing. Reconnect recovers missed requests; resolved, interrupted and completed requests stay cleared even when the display journal or a delayed snapshot is stale.
- The final four-suite renderer matrix passes **63/63 tests**, covering Settings, new chats, model/effort persistence, failed saves, active-turn setting changes, unavailable connections and approval recovery. The broader final Claude/backend/UI run passes **178 tests across 27 files**, with six opt-in native cases skipped. The merged ChatGPT/credential-race/transport/selection/settings/connector/CLI/dependency regressions pass **514/514 tests across 19 files**.
- The signed native Windows x64 `2.1.319` executable with SDK `0.3.319` passes **5/5 isolated lifecycle cases**: SDK close, abort, stdin EOF, native termination and owner termination. The real SDK and Studio launcher use an empty profile with the user-prompt gate closed. No descendant processes survive. A killed owner retains the conservative session lock; the four recoverable cases write one non-success terminal outcome. The installed executable has advanced to `2.1.322`, so qualification uses a retained, signature-verified `2.1.319` copy.
- Final `studio ui` and fresh packaged Desktop verification pass in **light and dark**, each with 20 screenshots and no renderer page errors: both provider groups and composers, ChatGPT effort/account-switch controls, Claude creation, unsupported efforts, keyboard selection, unavailable catalogs and allow/deny replies. Real HTTP/IPC checks confirm signed-out metadata projection and rejection of a ChatGPT global default (HTTP 400); connected data and Claude create/send/approval operations are synthetic.
- The packaged ASAR main-process runtime and bundled CLI runtime each load SDK `0.3.319`, initialize one signed native `2.1.319` process, send zero user messages and close it cleanly. The empty-profile probe returns `native-runtime-unqualified`. The CLI probe also passes under the shipped Node `v24.22.1` executable. The SDK core is bundled into runtime chunks rather than installed as a separate package in the shipped CLI.
- Packaged Desktop regressions report **7 passed and 1 flaky pass on retry** across app, IPC bridge, settings and chat flows; the retry was the first-launch welcome-dialog timing check. A separate isolated run with one worker and no retries passes **2/2**: first launch and site creation/preview/persistence across relaunches.
- Modified-file ESLint, repository typecheck, Knip, browser UI/CLI builds and `git diff --check` pass. Local evidence is retained under `%LOCALAPPDATA%\Temp\opencode\studio-offline-20261110\`: `qualify-surfaces.mjs`, `packaged-sdk-probe.cjs`, `visual/local-final-evidence.json`, `visual/electron-final-evidence.json`, `visual/packaged-cli-evidence.json`, screenshots, and final build/test logs including `desktop-e2e-final.log` and `desktop-lifecycle-final.log`. The initial package run was stopped after the browser found the picker fallback; the final package includes that fix.
- The fresh Windows x64 installer (`STUDIO_PACKAGE_FRESH=1`, `scripts/package-in-isolation.ts make:windows-x64`) is `apps/studio/out/make/squirrel.windows/x64/studio-setup.exe`: unsigned, 387,885,056 bytes, SHA-256 `befcca9e359b047d90e16efe4e9853e4236a714e3e3ed447332fc0a8a20cbd49`.

Qlty's GitHub status at the preceding remote head `95853473e` is `success`, but its description reports **41 blocking issues**. PR #2 at `4ae1e38da` similarly reports 28. The issue details require Qlty login; neither status establishes that the findings are resolved.

The bridge supports allowlisted `wp_cli` text reads and approved draft creation. Image results, artifacts and preview/annotations remain outside this proof of concept. Authenticated disposable-site acceptance and the public-distribution/branding gate remain open. Windows ARM64, macOS and Linux are unqualified for this runtime path. Keep `STUDIO_EXPERIMENTAL_CLAUDE_CODE` default-off. The original checkboxes below remain acceptance requirements.

## Global constraints

No Claude OAuth implementation or token-file parsing in Studio. Do not modify vendor binaries or remove their authentication methods. No Studio-owned API credentials passed into subscription runtime sessions. No blanket permission bypass. No cloud execution, WSL fallback, production-site edits or automatic publishing. Keep existing Pi behavior and files readable.

## Review focus

1. Authentication discovery and execution must resolve the same binary/configuration/user (Task 2).
2. Missing native history must not silently start a fresh session or resume an unrelated session in the same directory (Task 1).
3. An approval deny or disconnect must prevent host mutations and late execution (Task 3).
4. Streaming deltas plus final messages must not duplicate text or falsely close a turn (Task 4).
5. SDK bundling or a native runtime update must not silently change the qualified Windows path (Tasks 2 and 4).

## Task 1: Backend event and session contracts

**Create:** `packages/agent/protocol/backend-events.ts`, `backend-sessions.ts`; `packages/agent/node/backends/pi.ts`, `dispatch.ts`; corresponding protocol/backend tests.
**Modify:** `packages/agent/node/agent.ts`; `protocol/json-events.ts`; session summary/load plumbing; CLI turn dispatch; UI event ingestion.

**Interfaces:** `BackendSessionRef` is a discriminated union of Pi session path and Claude native session ID/cwd/connection ID. `runBackendTurn(snapshot, handlers)` returns a run handle with `interrupt()` and a terminal result. The snapshot includes selected connection, backend, model, effort, configuration revision and active local site. It is not a Pi SessionManager.

- [ ] First write compatibility tests replaying existing Pi fixture sessions through the adapter with identical visible transcript, tool progress, errors and terminal status.
- [ ] Define a Studio-owned event union for text delta, tool start/result, user question, permission request, artifact, preview refresh and terminal status. Require stable event/run identifiers and exactly one terminal transition. Existing Pi event readers need an explicit compatibility mapping.
- [ ] Add backend session references and explicit native-state-missing errors. Do not pass a Claude session to Pi's compactor or use `continue: true` as a substitute for an explicit session ID.
- [ ] Run existing-provider UI/session/runtime regressions, then commit this neutral boundary separately.

## Task 2: Runtime discovery and vendor-owned sign-in

**Create:** `packages/agent/node/claude-code/discovery.ts`, `auth-status.ts`, `connection.ts`, `tests/discovery.test.ts`, `tests/auth-status.test.ts`.
**Modify:** `packages/agent/package.json`, lockfile and CLI/desktop build dependency handling.

**Interfaces:** `inspectClaudeConnection(executablePath, configDirectory)` returns validated runtime/version/platform/authentication metadata without secrets. `openClaudeNativeSignIn(connectionId)` opens the official interactive command in a real terminal. `disconnectClaudeConnection(connectionId)` detaches Studio without logging the user out of other clients.

- [ ] Use a fake executable first to test missing binaries, unexpected output, unsupported versions, spaces/Unicode in paths, timeout, cancellation and nonzero exit. No executable path is concatenated with untrusted shell input.
- [ ] Install and lock the official SDK version selected for the implementation. Select a user-installed unmodified binary for phase one; pass its absolute path explicitly. Check the installed SDK types and binary capabilities, rather than assuming every current documentation field exists in that version.
- [ ] Implement native `auth status` and sign-in commands. Query and execution must have the same cwd/config reference and relevant environment. Treat API-key, helper, cloud-provider and unknown authentication as visible states, not as confirmed subscription usage.
- [ ] Do not edit the user's global environment or vendor settings. Strip Studio-owned secrets from child environments case-insensitively on Windows. Detect user configuration that selects another billing route; explain the mismatch before starting a subscription-labeled turn.
- [ ] Test disconnect separately from explicitly requested native logout. Do not delete credential files or claim remote logout merely because Studio detached. Commit after targeted tests pass.

## Task 3: SDK runtime and guarded WordPress bridge

**Create:** `packages/agent/node/claude-code/runtime.ts`, `tool-bridge.ts`, `event-adapter.ts`, `sessions.ts`, and associated unit/integration tests.
**Reuse:** `StudioAgentHost`, tool definitions and validated host operations; native runtime tools for file/shell work.

**Interfaces:** `runClaudeTurn(snapshot, host, handlers)` implements the generic run contract. `createStudioClaudeToolBridge(host, policy, onEvent)` returns the SDK MCP server and a disposal function. `nativeSessionStore` maps Studio conversation IDs to vendor session IDs and configuration references; no Claude tokens are stored.

- [ ] First write tool contract tests for optional arguments, schema rejection, errors, progress, image results, artifacts, pending work and cancellation. A direct call to `rawHandler` without the shared validation/policy layer must fail a test.
- [ ] Implement the bridge with SDK-supported schema conversion. Prefer importing canonical schemas or a verified conversion over hand-maintained duplicate schemas. The bridge uses the current run's host with UI support, not a random globally installed `studio mcp`.
- [ ] Add runtime tests using a scripted SDK process/control double: model discovery, supported effort validation, authentication mismatch, native session capture, explicit resume, rate limit, restart and interruption. Pin credentials to the runtime connection, not an email inferred from arbitrary text.
- [ ] Implement `query()` with an explicit executable, cwd, resume ID, model/effort, partial streaming, SDK MCP bridge, official Claude Code preset plus Studio-specific guidance, and explicit permission handling. Use a streaming input queue where required by the pinned SDK; stop or close only this run's process.
- [ ] Hook native tool permission decisions into Studio's approval UI. Test precedence: an allow rule must not accidentally bypass a required mutation approval. Retain host-side execution guards even when the model/runtime requests approval. On UI disconnect, cancel unresolved approvals rather than granting them.
- [ ] Keep skill/tool-name mappings explicit. Do not advertise preview/annotation capabilities until their bridge tests pass. Commit after targeted tests and legacy tool regressions pass.

## Task 4: All surfaces and Windows qualification

**Modify:** Both UI connectors, local server, Electron IPC/preload, settings, composer, runtime metadata display, session-loading and run-manager code as required by the new backend.

- [ ] Add UI tests for missing runtime, unauthenticated runtime, wrong billing method, account change, supported efforts, unsupported controls, permission wait/deny and native-state loss.
- [ ] Add event-adapter tests that combine streamed deltas with final blocks and duplicate/replayed messages. Assert no duplicate transcript text, no synthetic successful completion on process EOF, and exactly one terminal event.
- [ ] Start a real Windows child process with mocked provider interactions where the runtime supports that safely. Separately run an explicitly authorized authenticated disposable-site smoke. Do not claim a mocked SDK object exercises actual process startup, IPC, permissions or credentials.
- [ ] Test process death, app restart and explicit native resume; settings chosen during a turn; denied writes; a successful draft creation and readback; artifact/preview delivery; shutdown with no orphan process. No production sites or publishing.
- [ ] Qualify SDK/runtime version pair, native executable signing/provenance, x64/ARM64 as applicable, dependency bundling and ASAR/resource handling. Preserve a known-good runtime option instead of auto-updating user software during Studio startup.
- [ ] Run type checks, modified-file lint, relevant and full tests, CLI/UI build, Electron launch and Windows package checks. Report any platform not run. Open a separate draft PR in Henry's fork; do not merge automatically.

## Subscription sign-in gate

Decide this before Task 1 starts. The Agent SDK docs say that, unless Anthropic has approved it beforehand, third-party products built on the SDK must not offer Claude.ai login or plan usage limits to their users and should use API keys. The legal and compliance page forbids third-party developers from offering Claude.ai login or routing requests through plan credentials, while an end user may still sign in to the unmodified Claude Code binary themselves. Anthropic's Help Center describes using the SDK with your own Claude plan.

- The maintainer decides whether this connection is limited to the maintainer's own use of their own Claude Code sign-in, or offered to other Studio users.
- Offering Claude.ai sign-in to other users (a default-on setting, release notes, or a published build that advertises it) requires Anthropic's prior approval, unless Anthropic confirms the integration is exempt. Until then the connection stays off by default and is not advertised.
- This plan is native end-user sign-in to an unmodified runtime. It is not authorization to proxy Claude subscription credentials through Studio or provide shared usage. Preserve vendor authentication choices and branding requirements (no "Claude Code" in a product name).
