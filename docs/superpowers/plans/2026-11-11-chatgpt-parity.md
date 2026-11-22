# ChatGPT Completion and Parity Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Complete each task's regression, implementation, verification and scoped commit before its downstream qualification.

**Goal:** Complete ChatGPT account lifecycle and prove full Studio workflow parity on the subscription route.

**Architecture:** Keep the existing Pi loop, canonical Studio tools and dedicated Responses transport. Repair demonstrated defects, qualify route-specific capabilities and add a reproducible development-only acceptance path.

**Tech Stack:** TypeScript, Pi, Node HTTP/crypto, existing OAuth/credential broker, React, Vitest and repository CLI build tooling.

**Spec:** [Full parity scope](../specs/2026-11-11-subscription-provider-parity.md). Coordination and final gates: [merge-readiness plan](2026-11-11-subscription-merge-readiness.md).

## Global constraints

All coordinator constraints apply. Preserve registration identity, cross-process locks, logout generations, session-only owner isolation and backend-only token handling. Do not add another agent loop, inspect Codex credentials or silently switch to API billing. No output-cap or unsupported hosted-tool controls on this route.

## Review focus

1. A failed returning session-only sign-in must retain its safe failure code without logging a URL/token (G1).
2. A late refresh must not restore a signed-out account or leave the rotated grant usable (G1/G3).
3. Image/tool-result replay and compaction must retain the pinned account/model/effort without repeating mutations (G2/G4).
4. API-catalog changes must not silently enable unqualified ChatGPT capabilities (G2).
5. An optional image-service credential must not be mistaken for subscription inference authorization (G2/G4).

### G1: Reproduce the session-only failure and close lifecycle defects

**Files:** `packages/agent/node/chatgpt/oauth.ts`, `credential-broker.ts`, `account-store.ts` only where reproduction requires; corresponding `tests/oauth.test.ts`, `credential-broker.test.ts`, `fixtures/broker-process.ts`; `node/tests/run-manager-chatgpt.test.ts`.

**Interfaces:** Existing `createChatGptSignInFlow(options)` exposes `begin(registrationId?, options)`, `wait(attemptId)` and `cancel(attemptId)`. Its failure outcome already contains `code`; no new OAuth diagnostic API is necessary. Existing broker `beginTurn`, `invalidateAccessToken`, `signOut` and session-IPC methods remain the lifecycle contract.

- [ ] Preserve the previous failed acceptance record. Capture only `outcome.ok` and the typed `outcome.code` before the harness assertion; do not print the authorization URL, callback, tokens or account record.
- [ ] Reproduce saved-account sign-out followed by returning sign-in with `storage: 'session'`. Distinguish denial, cancellation, timeout, provider rejection, test prerequisite failure and code defect before selecting a fix.
- [ ] Add the minimal failing regression for the demonstrated defect. If only the harness lost diagnostics, fix the harness and record the external failure; do not weaken OAuth validation to make the test pass.
- [ ] Exercise two-process refresh, stale-token invalidation, delayed refresh after logout, owner exit, vault-write interruption and pending-tool/stream cancellation. Assert no credential resurrection, later request, late tool mutation or fallback.
- [ ] Run `npm test -- packages/agent/node/chatgpt/tests packages/agent/node/tests/run-manager-chatgpt.test.ts --maxWorkers=2`, modified-file ESLint and typecheck. Commit the bounded fix with its regression.

**Exit:** The failure is diagnosed; both storage modes have deterministic lifecycle regressions. Live session-only completion remains G3's separate gate.

### G2: Qualify model capabilities and rich Studio workflows

**Files:** `packages/agent/protocol/chatgpt-models.ts`, `node/chatgpt/models.ts`, `node/runtime/chatgpt-transport.ts`, `node/runtime/index.ts`, `node/image-generation.ts`, relevant tests; `apps/cli/commands/ai/index.ts`; `apps/ui/src/features/chats/session-view/chatgpt-chat.test.tsx`, composer/settings and both connectors only as needed.

**Interfaces:** Preserve `fetchChatGptModels`, `resolveChatGptReasoning`, the `ChatGptSessionSelection` contract and the canonical tool registry. Make route-qualified capabilities authoritative rather than deriving new behavior automatically from `OPENAI_MODEL_CAPABILITIES`.

- [ ] Record supported models, efforts, vision input, tool-image results, replay semantics and local context budgets against current route documentation and captured requests. Unknown capabilities remain unavailable with an explicit explanation.
- [ ] Add tests proving API-model table updates cannot silently change this route's supported controls; test account catalog refresh/removal and no automatic model/effort replacement.
- [ ] Add composer-to-request tests for image attachments; file-tool attachment tests for documents, missing files and access boundaries; real-Pi tests for screenshot/image tool results, artifacts, annotations, questions and pending-work settlement. Reuse existing tools rather than rebuilding them.
- [ ] Extend compaction/restart regressions to image-heavy history, interrupted compaction, token invalidation and partial tool failure. Assert every summary and resumed request keeps the selected connection/model/effort and no uncertain side effect replays.
- [ ] Expose the existing image service as a separate capability/account in Settings/composer and execution metadata. Its absence must remove unsupported image-generation guidance and show a useful setup explanation; its presence must not change the ChatGPT inference route. Apply the same contract to Claude through C2/C3.
- [ ] Run protocol/model/transport/session and changed UI/connector tests, ESLint and typecheck. Update affected eval assertions; run shared prompt evals when guidance changes.

**Exit:** Every applicable spec workflow has an explicit test; capability and optional-service behavior is accurate. Supported models each receive a live smoke in G4; a single model does not qualify the entire list.

### G3: Check in reproducible authenticated acceptance

**Create:** `apps/cli/ai/chatgpt-acceptance-entry.ts`, `chatgpt-acceptance.ts`, `chatgpt-acceptance-observer.ts`, `apps/cli/ai/tests/chatgpt-acceptance.test.ts`, `scripts/chatgpt-acceptance/README.md`.

**Modify:** `apps/cli/vite.config.dev.ts` to add development-only entries, following `eval-runner-entry.ts`. Do not bundle the harness into production.

**Proposed runner contract:**

```text
npm run cli:build
node apps/cli/dist/cli/chatgpt-acceptance.mjs --live --scenario saved --run-dir <absolute-new-directory> [--model <qualified-model>]
node apps/cli/dist/cli/chatgpt-acceptance.mjs --live --scenario session --run-dir <same-directory>
```

`saved` creates an isolated test profile/site. `session` requires that exact run's compatible non-secret manifest and registration; it never searches other temporary folders or uses the normal Studio profile. Set `DEV_CONFIG_DIR` and `STUDIO_PROCESS_MANAGER_HOME` before importing application modules.

- [ ] Add offline tests for safe failure-code retention, missing/incompatible prerequisites, evidence redaction and cleanup after each failed stage; then implement the runner using existing broker/session/CLI APIs.
- [ ] Emit versioned `manifest.json` and append-only `evidence.ndjson`: source SHA/dirty state, OS/architecture, Node/npm, build identity, model/effort, stage, `passed|failed|blocked`, safe failure code and bounded observation counts/booleans. Keep test identifiers in local `state.json`; never include credentials or raw requests.
- [ ] Run the saved scenario: browser sign-in/re-sign-in; model discovery; site read; exactly one draft; independent WP-CLI title/content/status verification; effort change; fresh-process resume and continuity; sign-out and blocked later use. Confirm remote revocation separately from local clear.
- [ ] Run the session scenario: returning sign-in succeeds without a persisted credential record; an offered fork completes live read-only inference via existing token IPC; an unoffered process fails before inference with no alternate-account/API fallback.
- [ ] Hold a successful real refresh result in memory through the existing injectable token-client seam, sign out, release it and prove the retired refresh is rejected and the rotated grant revoked. Retain only booleans/counters. Also observe an active real application run stopping on sign-out; distinguish that evidence from a broker-handle race and record bounded watcher timing.
- [ ] On every exit cancel pending sign-in, settle held refresh work, stop only owned children/site processes and sign out only the test registration. Preserve the original failure if cleanup also fails. Never delete the shared vault wrapping key or other users' registrations.

**Exit:** Both scenarios succeed reproducibly with sanitized evidence; the prior session-only failure remains in the history rather than being overwritten.

### G4: Run the full parity outcomes and hand off platform qualification

**Files:** `scripts/eval/subscription-parity.config.yaml`, outcome assertions and acceptance runner extensions owned jointly with M2; ChatGPT behavior docs and readiness ledger.

- [ ] Add explicit ChatGPT connection selection to the provider acceptance/eval path. The ordinary eval runner currently resolves a global legacy provider; setting a model name is insufficient.
- [ ] Run site creation, theme/file editing, skills/instructions, design choice, image/file input, screenshot interpretation, annotations, artifacts, preview refresh, import/export and user-question cases. Test remote operations through fixture/staging targets under the normal consent rules.
- [ ] Run image-generation outcomes with the separately configured existing image service, and prove clear unavailable behavior without it. Verify the inference observer still identifies ChatGPT.
- [ ] Qualify long-conversation compaction/resume and each advertised model/capability combination with bounded live scenarios. Use deterministic fixtures for pathological limits; label those separately.
- [ ] Repeat account lifecycle, draft/readback/resume and platform-sensitive workflows through P1-P4. Exercise both Desktop and `studio ui`, including actual sign-in/selection/send/sign-out, not synthetic connected data alone.
- [ ] Update observed completion and the PR's testing instructions with exact commands, SHAs, model/runtime/platform results and remaining failures. Proceed to M3/M4 only when all ChatGPT cells pass.

**Exit:** ChatGPT meets the full spec independently; Claude's unfinished work does not redefine or block its own readiness gate.
