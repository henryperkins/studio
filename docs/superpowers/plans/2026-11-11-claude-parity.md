# Claude Full Studio Parity Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. C1 establishes shared contracts; review those before enabling C2's broader execution surface.

**Goal:** Replace the narrow Claude proof of concept with complete Studio workflow, rich UI, session recovery and platform parity while retaining the official runtime and vendor-owned sign-in.

**Architecture:** Claude continues to own its agent loop and native history. Studio owns a capability-filtered canonical tool bridge, target/permission policy, user interaction and display projection. Shared tool execution semantics must work for Pi and Claude without forcing Claude events into Pi-private history.

**Tech Stack:** Existing TypeScript, official Claude Agent SDK, TypeBox/Zod, React, Vitest, Playwright and Studio CLI/host contracts.

**Spec:** [Full parity scope](../specs/2026-11-11-subscription-provider-parity.md). Coordination: [merge-readiness plan](2026-11-11-subscription-merge-readiness.md). Execute in the Claude worktree.

## Global constraints

All coordinator constraints apply. Preserve the official preset and native authentication methods. Never parse `.credentials.json`, inject Studio inference API keys, enable blanket permission bypass, silently rebind native history or implement duplicate site operations. Image/WordPress.com service credentials stay in the host that owns those operations.

## Review focus

1. Native shell/file tools and MCP allow rules cannot bypass required execution guards (C1/C2).
2. Global/local/live target changes cannot redirect a queued or already-approved operation (C1).
3. Images, artifacts, pending work and questions must survive both transport and rendering (C2/C3).
4. Native history, a display journal and a stale lock are different things; recovery must preserve their ownership (C4).
5. A Claude-labelled model in a Pi eval cannot count as Claude-runtime acceptance (C5).

### C1: Define target and execution-policy contracts

**Modify:** `packages/agent/protocol/backend-events.ts`, `backend-sessions.ts`, `claude-code.ts`; `node/claude-code/studio-surface.ts`, `runtime.ts`, `tool-bridge.ts`; `node/sessions/manage.ts`, `node/host.ts`, CLI `commands/ai/index.ts` and `ai/claude-approval.ts`.

**Create:** `packages/agent/node/claude-code/execution-policy.ts` and `tests/execution-policy.test.ts`.

**Interfaces:** Extend `ClaudeBackendTurnSnapshot` and `ClaudeBackendSessionBinding` to distinguish native workspace/config/history identity from the selected Studio target. Reuse site-selection fields from `protocol/sessions/entry-types.ts` (`siteId`, `wpcomSiteId`, environment) instead of inventing another site registry. Global conversations use a dedicated stable workspace; target changes are explicit next-turn selections, never hidden cwd/history reassignment.

Generalize `ClaudeApprovalRequest` beyond a draft: immutable operation/tool arguments, affected local paths/site/remote target, run/turn/connection and policy revisions, and a unique request ID. An approval is scoped to that exact operation. Shared policy must authorize immediately before the native execution or CLI spawn, not only when the model proposes it.

- [ ] Write failing tests for global chat/site creation, explicit local/live target changes, changed target after Send, changed arguments after approval, denied/expired approval, reconnect and stale approval replies.
- [ ] Establish operation classes from canonical tools and native equivalents. Preserve ordinary authorized local edits; require the existing user-facing confirmations for destructive/overwrite, remote/publish and external-message operations. Tool annotations are hints, not enforcement.
- [ ] Apply the same guards to SDK hooks, native tool permission requests and host MCP execution. A runtime allow rule cannot waive a required Studio guard. Unstructured shell commands must receive appropriate bounded approval and workspace restrictions; no regex-only safety claim.
- [ ] Extend signal/before-execution fencing to all cancellable host operations through their existing CLI commands. Cancelling, disconnecting or changing a connection invalidates pending approvals.
- [ ] Implement global and explicit target transitions while preserving native session identity. Refuse unsafe rebinding; explain when an intentional new conversation is required. Cover existing session migration without destroying journals/history.
- [ ] Run protocol/session/runtime/approval regressions, ESLint and typecheck; independently review the policy before C2 enables more tools.

**Exit:** Broader tools have an enforceable permission/target boundary and all supported conversation placements have defined behavior.

### C2: Bridge the canonical tools and native equivalents

**Modify:** `node/tools/define-tool.ts`, `node/tools/index.ts`, `node/claude-code/tool-bridge.ts`, `runtime.ts`, `node/runtime/tool-safety.ts`, `file-tool-prompts.ts`, `pending-work.ts`, `node/chat-artifacts.ts`, `result-notes.ts`; corresponding tests.

**Create:** `packages/agent/node/tools/execution.ts`, `tools/tests/execution.test.ts`, `node/claude-code/tests/tool-parity.test.ts`.

**Interfaces:** Build the Claude SDK MCP tool list from the existing capability-filtered Studio registry and canonical schemas. Extract shared execution semantics into `tools/execution.ts` using existing `StudioToolDefinition`, `ToolContext`, `ToolResult`, `AnyStudioAgentTool` and `StudioAgentHost` types. Runtime adapters consume the same validation, progress, artifacts, pending work and safe errors; they remain responsible for their transport representation. Do not call a raw handler around those semantics.

- [ ] Generate a contract test from the production registry (currently 29 definitions), including capability-dependent factories for questions, design choices and skills. Every registered tool must be bridged, mapped to a qualified native equivalent, or absent for the same host-capability reason as Pi.
- [ ] Add failing result-contract cases for optional/schema-invalid arguments, text and image blocks, `_meta` excluded from model context, artifacts, progress, safe failures, cancelled execution and `settlesPendingWork`. Pin Pi behavior before extracting shared code.
- [ ] Replace the single restricted `wp_cli` bridge with the canonical registry. Retain CLI-owned site operations and normal confirmation/host checks for creation, deletion, start/stop, previews, push/pull, import/export, WordPress requests, design/block checks, screenshots and feedback.
- [ ] Enable qualified native equivalents for Read/Write/Edit/Bash/Grep/Glob/Ls. Explicitly adapt native argument names and write paths to Studio safety rules; test symlink/workspace escape, secrets in child environments, alternate shell mutation paths and DESIGN.md preview effects.
- [ ] Add question/design-choice/Skill support and standing user instructions. Append capability-aware Studio guidance to the official preset; derive tool names and skill references from actual registration. Preserve UI capability gating in both tools and prompt mentions.
- [ ] Pass tool, safety, pending-work and existing Pi/MCP regressions; run the full applicable agent eval suite after system-guidance changes. Commit independently reviewable execution and guidance changes.

**Exit:** Tool parity is demonstrated by contracts and actual outcomes, not a matching list of names. Required work is settled before successful completion.

### C3: Complete rich conversation and surface integration

**Modify:** `node/claude-code/event-adapter.ts`, `protocol/backend-events.ts`, `node/run-manager.ts`, `apps/ui/src/data/agent-runs/provider.tsx`; Claude chat/settings/new-chat components and shared conversation presentation/composer hooks; `protocol/chat-images.ts`, `chat-files.ts`, `visual-annotations.ts`; CLI `commands/ai/index.ts`; both connectors, local routes and Desktop IPC/preload where contracts change.

**Interfaces:** Extend the existing `BackendTurnEvent` discriminated union with complete payloads for tool results, attachments, questions and answer resolution while preserving `chat.artifact`, `preview.reload` and exactly one terminal event. Native history remains separate; shared React presentation components consume Studio's projection.

- [ ] Add failing UI/contract cases for image/file attachments, visual annotations, questions with free text/multiple/image choices, artifacts, preview refresh, pending work and generalized approvals. Include missed events, duplicate final blocks, out-of-order snapshots and reconnect.
- [ ] Replace the standalone Claude textarea limitations with the real composer capabilities. Remove CLI attachment/annotation rejection only after native materialization/access validation, model-capability gating and restart/replay tests pass.
- [ ] Render and reconcile rich events in the shared transcript; merely appending them to a journal is insufficient. Keep questions distinct from mutation approvals and clear resolved requests by run/request identity.
- [ ] Expand discovered model capabilities for vision/tool-image compatibility and supported controls. Hold Send when capability checks fail; do not silently downgrade a selected model/effort or discard an attachment.
- [ ] Wire the same operations through Desktop, browser and CLI. Translate user-facing errors and use theme tokens; explain native sign-out versus Studio detach and the independent image-service dependency.
- [ ] Run real-provider-component tests plus connector contracts; verify Desktop and `studio ui` in light/dark at normal/narrow widths and with keyboard navigation. Complete live interaction coverage in C5.

**Exit:** All spec interactions and rich outputs work on each appropriate surface and survive restart/reconnect without duplication or stale actions.

### C4: Implement safe same-conversation crash recovery

**Modify:** `node/claude-code/sessions.ts`, `runtime.ts`, `studio-surface.ts`, protocol `claude-code.ts`/`backend-sessions.ts`, CLI `commands/ai/claude.ts`, both connectors and Claude session UI; session/run-manager/native lifecycle tests.

**Interfaces:** Version the existing lock record to store lock token, run/turn identity, owner/native process identity including start time, connection revision and native session/config/workspace binding. Expose `recoverClaudeSession(sessionId)` through the shared surface and CLI `code claude recover --session <id>`; return a discriminated recovered/blocked result with a safe reason. The platform process-identity adapter is supplied by P2.

- [ ] Write failing tests for owner death, still-live descendants, PID reuse, ambiguous process identity, replacement-lock races, missing native history, stale approvals and an uncertain completed mutation.
- [ ] Recover only after proving the recorded owner and owned descendants are gone, atomically rechecking lock ownership, and independently verifying the exact native session/config/workspace. Never unlock by age alone.
- [ ] Record one interrupted/unknown terminal outcome, preserve partial output and clear obsolete approvals. Resume the same native conversation; inspect observable state before any retry of a mutation whose outcome is uncertain.
- [ ] Migrate legacy UUID-only locks conservatively: explain why automatic recovery cannot establish ownership, preserve evidence, and provide a reviewed manual procedure. Do not guess a PID or delete another lock.
- [ ] Test stop, EOF, native/owner death, restart and recovery on all six native platforms after P2. Assert no owned descendants survive and unrelated Claude sessions remain running.

**Exit:** A recoverable crash can safely resume the same conversation; ambiguous ownership fails explicitly without data loss or automatic replay.

### C5: Qualify authenticated full workflows

**Create:** `apps/cli/ai/claude-acceptance-entry.ts`, `claude-acceptance.ts`, `apps/cli/ai/tests/claude-acceptance.test.ts`, `scripts/claude-acceptance/README.md`. Add a development-only Vite entry, using G3's evidence format without creating a general testing framework.

**Interfaces:** Proposed command after `npm run cli:build`: `node apps/cli/dist/cli/claude-acceptance.mjs --live --run-dir <new-directory> --executable <qualified-native-path> --config-directory <explicit-test-profile>`. Use production `code claude` session/selection operations and `code sessions resume`. IPC approval replies already use `{ type: 'answer', answers: { [requestId]: 'allow' | 'deny' } }`; validate run/turn/request and the predeclared test operation before answering. Plain JSON mode must not silently grant writes.

- [ ] Add offline harness tests for invalid prerequisites, wrong billing route, unexpected approval/target, cleanup and evidence redaction. Check terminal outcomes as well as exit codes.
- [ ] Complete real native sign-in and verify the same executable/user/config/workspace for inspection and execution. No credentials are read by Studio or the harness.
- [ ] Run read, denied draft with independent no-write proof, allowed draft/readback, effort change, fresh-owner native resume, pending-approval cancellation and stale late reply. Then run C2/C3 parity cases: global site creation, site transitions, file/theme editing, skills, questions/design choices, images/documents/annotations, artifacts, preview/screenshots, import/export and designated staging operations.
- [ ] Trigger bounded compaction, crash and same-conversation recovery; verify continuity, no duplicate effects/text and no orphan descendants. Exercise Desktop and browser approvals with the actual provider, not only scripted SDK/connected-data fixtures.
- [ ] Run provider-qualified outcome evals via M2 on the actual Claude backend. Selecting `claude-*` in the existing Pi eval runner is not this test.
- [ ] Repeat native/platform-sensitive gates through P4; update all evidence and behavior documentation. Close the vendor distribution/branding decision before M4 readiness.

**Exit:** Claude completes the same Studio workflows as the existing providers, under equivalent optional-service configuration, on the full target matrix.
