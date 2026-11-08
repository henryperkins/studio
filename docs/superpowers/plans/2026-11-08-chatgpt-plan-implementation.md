# Direct ChatGPT-plan provider implementation plan

> **For agentic workers:** Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. The checkboxes below are requirements, not observed results.

**Goal:** Add direct ChatGPT-plan OAuth to the fork's existing Pi workflow without changing its paid API providers.

**Architecture:** Introduce provider-qualified connection/model identity; keep OAuth credentials in a backend broker; add a dedicated public Responses transport. Reuse the settings queue and existing WordPress agent loop.

**Tech Stack:** Existing TypeScript/npm workspaces, Pi 1.5.0 at the inspected base, React, Electron, Node HTTP/crypto, an audited OIDC/JWT verification library, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-08-subscription-connections-design.md`

## Global constraints

Use a feature branch in Henry's fork, not Automattic. Recheck the base and repository instructions. No real credentials in tests/logs/commits. No automatic billing fallback. No implementation outcome is assumed. Keep new features disabled until their acceptance checks pass.

## Review focus

1. A legacy API conversation must not become a subscription conversation because model names overlap (Task 1).
2. Logout and refresh racing across two processes must not restore a revoked session (Task 2).
3. Native Windows token storage must preserve a complete multi-kilobyte credential record or fail explicitly (Task 2).
4. A late streaming error must not mark partial text as a completed turn or repeat tool effects (Task 3).
5. A stale refetch or settings write must not change a sent turn's connection or reasoning (Task 4).

## Task 1: Connection identity and legacy migration

**Create:** `packages/agent/protocol/connections.ts`; `packages/agent/protocol/tests/connections.test.ts`.
**Modify:** `packages/agent/protocol/providers.ts`, `models.ts`, `sessions/entry-types.ts`; `apps/cli/ai/providers.ts`; `apps/cli/commands/ai/index.ts`.

**Interfaces:** `ProviderModelRef { providerId: AiProviderId; modelId: string }`; `ConnectionSelection { connectionId: string; model: ProviderModelRef; revision: number }`. `resolveConnectionSelection(entries, connectionRegistry)` returns a validated selection or a typed disconnected/unsupported error. Define registry entries with provider ID, backend (`pi` or `claude-code`), non-secret identity and authentication status. Do not encode token values in these types.

- [ ] Write regressions for the same model slug under API and OAuth connections; an unknown legacy model; removal of the selected connection; and an old unpinned reply. Assert unchanged API routing and no implicit OAuth selection.
- [ ] Run `npx vitest run packages/agent/protocol/tests/connections.test.ts`; confirm the intended failures before implementation.
- [ ] Add `chatgpt-oauth`, explicit Pi provider identity and separate model-availability namespace. Keep legacy provider IDs and Pi provider IDs stable. Do not infer new connections from model families.
- [ ] Pass the new tests plus existing provider and session-selection tests. Commit this independently reviewable change.

## Task 2: OAuth registration and credential broker

**Create:** `packages/agent/node/chatgpt/oauth.ts`, `credential-broker.ts`, `account-store.ts`, `tests/oauth.test.ts`, `tests/credential-broker.test.ts`.
**Reuse:** OS credential storage and the repository's cross-process lock/atomic-write conventions; do not weaken the existing string-secret validation.

**Interfaces:** `beginChatGptSignIn(registrationId?: string)` returns an attempt ID and the official authorization URL only; `cancelChatGptSignIn(attemptId)` invalidates the attempt; `getChatGptAccessToken(connectionId)` resolves a current token inside backend code; `signOutChatGpt(connectionId)` ends every active turn on that connection before it returns (its stream is aborted and no pending tool call executes afterwards), then returns `{ localCleared, remoteRevocationConfirmed }`. No renderer method returns tokens. Define pending-attempt and registration schemas with versioning and validated identity.

- [ ] First write tests for invalid/replayed state, nonce/signature/audience failure, denial, wrong returning client/subject, missing inference permission, callback-port collision, cancellation and bounded timeout. No failure may replace the active account.
- [ ] Run `npx vitest run packages/agent/node/chatgpt/tests/oauth.test.ts` and retain the expected failing baseline.
- [ ] Implement the current official public-client flow, with a stable host ID, system-browser navigation, loopback listener, issued-client handling, PKCE and verified ID token. Use discovery for trusted metadata, never callback-supplied remote endpoints.
- [ ] Test rotating refresh using two real local processes and a mocked token service: one refresh wins; both consumers use the committed record. Test logout generation against a delayed refresh and app termination during a vault write. Test sign-out during a streaming turn and while a tool call is pending: nothing more is streamed or executed on that connection after sign-out.
- [ ] Implement a protected record vault and serialized refresh/revocation. Keep application secrets out of child process environments; use scoped IPC when a forked turn needs access. Test Windows token sizes and secure-storage unavailability. Explicit session-only storage must not resurrect or silently select another stored identity.
- [ ] Run both test files and type checks, verify there is no credential material in renderer responses/diagnostics, then commit.

## Task 3: ChatGPT model discovery and transport

**Create:** `packages/agent/node/chatgpt/models.ts`, `runtime/chatgpt-transport.ts`, `chatgpt/tests/models.test.ts`, `runtime/tests/chatgpt-transport.test.ts`, `runtime/tests/chatgpt-session.test.ts`.
**Modify:** `packages/agent/node/runtime/index.ts` at provider registration only; keep `openai-transport.ts` API behavior intact.

**Interfaces:** `fetchChatGptModels(connectionId, signal?)` returns provider-qualified catalog entries or a typed failure; `createChatGptProviderConfig(model, connectionId, turnSnapshot)` returns the Pi registration configuration. Turn snapshots carry no refresh token. Implement an explicit typed request serializer, not a cast of the paid API request.

- [ ] Write parser tests for the route-specific models envelope, invisible models, unknown capabilities, genuine empty list, malformed JSON, broken stream and account switching. Preserve the last good list only for the same registration.
- [ ] Write request-capture tests asserting the public endpoint, selected identity and exact model/effort, stateless streaming, supported instructions/history/tools, and absence of forbidden fields. Assert `max_output_tokens` is absent and API-provider requests still retain their configured cap.
- [ ] Implement the serializer and tool representation using the current SIWC limitations. Prefer a developer `additional_tools` input item for the first implementation to retain flat Studio tool names; validate against the current schema. Preserve IDs and replay order. Do not enable Responses tool_search or hosted MCP.
- [ ] Add failure fixtures for HTTP detail-only errors, authorization failure, policy denial, transient unavailability, partial text followed by failure/incomplete, missing completion and cancellation. Never silently downgrade effort or switch billing.
- [ ] Drive the actual Pi loop with a file-backed session, real bounded tool execution and mocked HTTP: tool continuation, restart, compaction and changed effort. Keep image-generation behavior separate.
- [ ] Run targeted tests and existing OpenAI API runtime regressions; commit only after passing. Live acceptance remains a separate gate.

## Task 4: UI, application connectors and qualification

**Modify:** `apps/ui/src/data/core/types.ts`, both `connectors/ipc/` and `connectors/local/`, settings and composer components, `apps/local/src/index.ts`, `apps/studio/src/modules/user-settings/lib/ipc-handlers.ts`, `apps/studio/src/preload.ts`, CLI auth/slash-command handling, and `apps/ui/src/data/session-setting-changes.ts` only where necessary.

- [ ] First add UI tests for sign-in pending/cancelled/denied, an identity-only grant, account picker, reauthentication, sign-out and unsupported controls. Test connection changes with delayed writes, mixed failure/success saves and stale refetches.
- [ ] Changing an existing conversation's connection (to or from a ChatGPT connection, or between ChatGPT accounts) starts a new conversation in the UI and the CLI instead of re-pinning the current one; per the spec, only an explicit, user-reviewed summary may carry over. Test that switching accounts or providers never sends the previous conversation's history to the new connection. Switching among WordPress.com and the API-key providers keeps today's behavior.
- [ ] Implement named settings actions: Start sign-in, Cancel, Refresh models, Sign out and Select saved account. Keep the existing system-browser opener, origin checks and IPC sender validation. For `studio ui`, refuse to advertise local OAuth support when the browser is not on the callback host.
- [ ] Hide the server output-cap field for this provider; show the selected registration and billing route. Keep unsupported modes unavailable. Do not relabel it Codex.
- [ ] Run `npm run typecheck`, targeted lint, relevant Vitest suites and `npm run cli:build:ui`; then qualify Electron on Windows. Compare unrelated full-suite failures against the unchanged base.
- [ ] With the maintainer's approval and the account owner's explicit local consent (on this fork, the same person), sign in and run a disposable-site smoke: read site details, create a draft, read it back, change effort, restart and resume, sign out, and verify blocked subsequent use. Do not create an API key or publish content.
- [ ] Report base/head, exact test commands and outcomes, mocked/live/native-platform boundaries and remaining limitations. Open a draft PR against Henry's fork; no automatic merge or release.
