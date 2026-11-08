# Official Claude runtime connection implementation plan

> **For agentic workers:** Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Checkboxes are acceptance requirements, not completed work.

**Goal:** Run the official, unmodified Claude Code runtime from Studio, using sign-in owned by that runtime and Studio's WordPress tool host.

**Architecture:** Add a backend adapter, not a Pi model transport. Keep native Claude history separate from Studio's projected display journal. Use the official Agent SDK as the process/control bridge and an SDK MCP server for host-specific WordPress tools.

**Tech Stack:** Existing TypeScript/npm workspaces, official Claude Agent SDK pinned in the lockfile, native Windows Claude Code, React/Electron/local HTTP, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-08-subscription-connections-design.md`. Reuse the provider-qualified connection types introduced in the ChatGPT plan; do not reimplement them.

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

## Public distribution gate

Review the official runtime-hosting terms and the SDK quickstart's third-party-login warning before advertising a public subscription integration. This plan is native end-user sign-in to an unmodified runtime. It is not authorization to proxy Claude subscription credentials through Studio or provide shared usage. Preserve vendor authentication choices and branding requirements.
