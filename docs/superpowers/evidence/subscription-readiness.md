# Subscription providers readiness ledger

Opened November 11, 2026 by task M1 of the [merge-readiness plan](../plans/2026-11-11-subscription-merge-readiness.md). The capability and platform rows come from the [parity spec](../specs/2026-11-11-subscription-provider-parity.md). Owner IDs (G1-G4, C1-C5, P1-P4, M2-M4) are the tasks in the [ChatGPT](../plans/2026-11-11-chatgpt-parity.md), [Claude](../plans/2026-11-11-claude-parity.md) and [platform](../plans/2026-11-11-subscription-platform-qualification.md) plans.

This file is a record, not a claim of completion. A row is only "done" when its evidence link points to a result bound to the candidate source SHA. At M1 no row is done. Later tasks update their own rows and add their evidence.

How to edit: the ChatGPT section (A), the Claude section (B) and the Platform section (C) are independent, so they can be edited on separate branches and merged. Sections D to H are shared; sections 1 and 2 are the baseline.

## Conventions

- **Status values:** `not started`, `partial`, `offline-tested` (automated tests with fakes or mocks exist), `live-passed` (real account run recorded), `failed` (recorded failure, kept), `blocked` (named gate), `not verified`.
- **Test/eval column:** an existing test file path, or `none yet`. Existing files were located by listing the repository at the stated SHA. M1 did not run them, so "offline-tested" means the tests exist, not that they passed on this candidate.
- **Evidence column:** `none yet` until a SHA-bound result exists.
- Statements taken from the baseline table of the merge-readiness plan and not re-checked by M1 are marked "per merge-readiness plan baseline, not re-verified".
- No credentials, tokens, account identifiers, authorization URLs or callback URLs appear in this file or may be added to it.

## 1. Source state (captured November 11, 2026)

| Item | ChatGPT (PR #2) | Claude (PR #3) |
| --- | --- | --- |
| Branch | `add-chatgpt-plan-provider` | `add-claude-code-runtime` |
| Remote head SHA (`git ls-remote origin`, `gh pr view`) | `4ae1e38da8af219f4289ab8710f6a756393a01a2` | `ce4eea5dc44de1be7f1cdf7abb81052909cabe2e` |
| Local checkout head | `4ae1e38da8af219f4289ab8710f6a756393a01a2` (primary checkout, matches remote) | `ce4eea5dc44de1be7f1cdf7abb81052909cabe2e` (worktree `C:/Users/htper/.codex/worktrees/add-claude-runtime/studio`, matches remote) |
| Base branch | `trunk` (`8672a64e7daf368051db0b35989dc9dd89523ff9` on origin) | `add-chatgpt-plan-provider` |
| Draft state | draft, open | draft, open |
| Relation | | Contains #2 head `4ae1e38da` as an ancestor (`git merge-base` returns it); 14 commits ahead |
| Experiment flag | `STUDIO_EXPERIMENTAL_CHATGPT` (`packages/agent/node/chatgpt/settings.ts`, off unless `=== '1'`) | `STUDIO_EXPERIMENTAL_CLAUDE_CODE` and additionally `process.platform === 'win32' && process.arch === 'x64'` (`packages/agent/node/claude-code/studio-surface.ts`) |

Dirty-work ownership at M1 start (not M1's, left untouched and unstaged):

- Primary checkout, modified: `docs/design-docs/chatgpt-provider.md`, `docs/superpowers/README.md`, `docs/superpowers/plans/2026-11-08-chatgpt-plan-implementation.md`.
- Primary checkout, untracked: the four `docs/superpowers/plans/2026-11-11-*.md` plans and `docs/superpowers/specs/2026-11-11-subscription-provider-parity.md`.
- Claude worktree, untracked: `.playwright-cli/` (predates the plan).

The plan notes that the primary checkout's Claude completion notes lag the Claude worktree. M1 therefore read Claude code only from the worktree at `ce4eea5dc`.

## 2. Existing evidence and provenance

What each statement rests on, and how far M1 could confirm it.

| Claim | Source | M1 verification |
| --- | --- | --- |
| ChatGPT saved-account live run at `4ae1e38da` on Windows x64: returning sign-in, model discovery, one draft created and read back, effort change, fresh-process resume, vault sign-out, later CLI use blocked | "Observed completion" in `docs/superpowers/plans/2026-11-08-chatgpt-plan-implementation.md` (uncommitted edit in the primary checkout) | Stage names and pass/fail flags confirmed in the retained local file `evidence.ndjson` under `%LOCALAPPDATA%\Temp\opencode\studio-chatgpt-acceptance-20261110\` (20 records read; only stage, pass flag and code fields were read). Request counts and the site-level readback were not re-derived. Not bound to a SHA inside the file. |
| ChatGPT session-only acceptance **failed** | Merge-readiness plan baseline, plus that same `evidence.ndjson` | The file ends with a record `session-only-acceptance`, `ok: false`, code `assertion-failed`. That is the harness assertion code. The underlying sign-in failure code was not retained, matching the plan's statement. Kept as a failure. Owner: G1 (diagnose), G3 (live rerun). |
| Earlier recorded failures in the same file | `evidence.ndjson` | A first `sign-in` record with `ok: false`, code `sign-in-failed`, and a `prepare` record with `ok: false`, code `assertion-failed`, appear before the passing run. The passing records follow in the same file. Both failures are kept here rather than dropped. Their causes are not established by M1. |
| Quota-limited turn handled as `subscription_sharing_usage_limit_exceeded` with no tools or retries | Same plan section | Not re-verified. |
| ChatGPT "Task 4 at `1feb4ba11`" passed Desktop and `studio ui` light/dark checks, Windows x64 packaging and nine Desktop end-to-end tests | Same plan section; PR #3 comment from the repository owner mentions a Windows installer and six packaged-app checks recorded on #2 | Not re-verified. The installer is for the earlier fix build and does not qualify `4ae1e38da` or the Claude merge (per the PR #3 comment). |
| 326 ChatGPT backend/CLI tests and a 50-test surface run passed; ChatGPT-branch typecheck passed; Claude 140 passed with 6 opt-in skipped | Merge-readiness plan baseline | Per merge-readiness plan baseline, not re-verified. The plan says the counts overlap and are not a total. |
| Claude native startup/lifecycle and packaging evidence exists; authenticated Studio workflow acceptance open | Merge-readiness plan baseline; `docs/superpowers/plans/2026-11-08-claude-runtime-implementation.md` | Test files `native-startup.test.ts` and `native-lifecycle.test.ts` exist in the worktree. Per merge-readiness plan baseline, not re-verified that they ran or that a package was executed. |
| Live-account checks deferred because quota is exhausted | PR #3 comment by the repository owner | Quoted from the PR, not independently verified. |
| One Windows cleanup failure (`EPERM` in `openai-runtime.test.ts`) on a 590-test run | PR #3 comment | Not re-verified. Recorded as a known Windows-only unresolved note; the comment says it reproduces on an older unchanged ChatGPT base. |
| Provider flags default-off | Code at both SHAs (see section 1) | Confirmed by reading code. |

Not available to M1: any run on this machine of the claimed tests, builds or packages.

## A. ChatGPT capability rows (PR #2, source SHA `4ae1e38da`)

Owners are plan tasks. Test files are under `packages/agent/` unless noted.

| # | Capability | Owner | Status | Existing test/eval | Evidence |
| --- | --- | --- | --- | --- | --- |
| A1 | Account lifecycle: sign-in, cancel, inspect, reconnect, sign-out, account-change detection, billing-route identity; persistent and session-only storage | G1, G3, P3 | partial. Saved-account sign-in and sign-out `live-passed` on Windows x64 per section 2. Session-only live `failed`. Refresh/sign-out race gates not started. | `node/chatgpt/tests/oauth.test.ts`, `credential-broker.test.ts`, `settings.test.ts`; `node/tests/run-manager-chatgpt.test.ts`; `protocol/tests/connections.test.ts` | Section 2 (local, not SHA-bound); session-only: none yet |
| A2 | Conversations: new/global/site, explicit target, model/effort change, queued sends, restart/resume, compaction, cancellation, crash recovery; fresh conversation on provider/account switch | G1, G2, G4 | partial. Effort change and fresh-process resume `live-passed` once on Windows x64 (section 2). Compaction, cancellation and crash recovery: not verified live. | `node/runtime/tests/chatgpt-session.test.ts`, `chatgpt-transport.test.ts`, `compaction.test.ts`; `node/sessions/tests/chatgpt-selection.test.ts`, `placement.test.ts`, `environment.test.ts` | Section 2 for resume; others none yet |
| A3 | File work: read, search, list, write, edit, shell within workspace boundaries | G4 | offline-tested (Pi file tools run in the shared runtime, `buildAgentTools` in `node/runtime/index.ts`) | `node/runtime/tests/tool-safety.test.ts`, `file-write-refusal.test.ts`, `file-tool-prompts.test.ts` | none yet |
| A4 | Studio operations: every host-applicable Studio tool, sites, WordPress, import/export, sync, preview | G2, G4 | partial. One live read plus draft via `wp_cli` is recorded. The other tools are not exercised against the ChatGPT route. See section D. | `node/tests/tools.test.ts`, `node/tools/tests/*.test.ts` (legacy-provider and unit scope) | Draft/readback in section 2; the rest none yet |
| A5 | User interaction: questions, choices, design alternatives, mutation approvals; reconnect restores only the current run's unresolved requests | G2, G4 | not verified | `node/tests/present-design-options.test.ts`, `apps/cli/ai/tests/option-picker.test.ts` (shared, not ChatGPT-specific) | none yet |
| A6 | Rich results: text, images/screenshots, attachments, artifacts, progress, background completion, preview refresh, annotations | G2, G4 | offline-tested on the route (G2 record). Not verified live. | `node/runtime/tests/chatgpt-session.test.ts`; `apps/ui/src/features/chats/session-view/chatgpt-chat.test.tsx`; shared: `node/tests/chat-artifacts.test.ts`, `screenshot-helpers.test.ts`, `strip-stale-images.test.ts`, `protocol/tests/chat-images.test.ts`, `composer-attachments.test.ts` | none yet |
| A7 | Guidance: identity, user instructions, skill routing | G4, M2 | not started for the ChatGPT route. The existing eval config uses the legacy provider path. | `node/tests/system-prompt.test.ts`, `global-instructions.test.ts`; `scripts/eval/promptfoo.config.yaml` cases (legacy-provider regression evidence only) | none yet |
| A8 | Models: discovery intersected with qualified capabilities; unsupported settings explained, never silently replaced | G2 | offline-tested. Route-qualified table and its sources in the G2 record (`gpt-6-luna` at `low` and `medium` only). One live discovery recorded (section 2). Per-model live smoke: G4. | `node/chatgpt/tests/models.test.ts`, `node/sessions/tests/chatgpt-selection.test.ts`, `apps/cli/commands/ai/tests/chatgpt.test.ts`, `apps/local/src/tests/chatgpt.test.ts`, `apps/ui/src/features/chats/session-view/chatgpt-chat.test.tsx` | Discovery: section 2; qualification sources: G2 record (not SHA-bound live evidence) |
| A9 | Failures: no false completion, duplicate side effects, paid-API fallback, account substitution, credential leak, orphan processes | G1, G3 | partial. Request observer rejected an API-key-shaped bearer in the recorded run (per the plan text). Race, interruption and orphan cases not exercised live. | `node/chatgpt/tests/credential-broker.test.ts`, `node/runtime/tests/usage-cap.test.ts`, `protocol/tests/chatgpt-errors.test.ts` | none yet |
| A10 | Surfaces: Desktop, `studio ui`, interactive CLI, noninteractive CLI; UI-only tools gated without a UI | G2, G4, P4 | partial. CLI live-passed once. Desktop and `studio ui` live selection/send/sign-out not recorded; Desktop light/dark and packaging claimed in section 2, not re-verified. UI-only tool gating confirmed in code (section D). | `apps/cli/commands/ai/tests/*`, `apps/local/src/tests/chatgpt.test.ts`, UI tests under `apps/ui/src/features/chats/session-view/` | none yet |
| A11 | Existing providers: WordPress.com, Anthropic API, OpenAI API routing, sessions and settings unchanged | M2, M3 | not verified. Provider and session-selection tests exist. | `protocol/tests/providers.test.ts`, `node/sessions/tests/openai-selection.test.ts`, `migration.test.ts` | none yet |

Image generation (spec boundary, recorded only): see section G.

### G1 record (November 11, 2026)

- **Session-only failure diagnosis: not reproduced offline; live diagnosis pending in G3.** The last two records of the retained `evidence.ndjson` are `session-only-browser-opened` and `session-only-acceptance` (`ok: false`, `assertion-failed`). The assertion that failed was the harness's own `outcome.ok` check, made before the outcome's code was recorded. The failure record follows the browser record by 599.5 s, against the attempt's 600 s bound, so the outcome was almost certainly `timed-out`: no callback with a valid state reached the loopback listener within 10 minutes. Denial, provider errors sent back to the callback, code/ID-token/identity/permission rejections and save failures would have ended the attempt when the callback arrived. Why the browser leg didn't finish (user, browser or provider page) can't be told offline. The earlier `sign-in-failed` and `prepare` records come from harness versions edited afterwards; their causes are not established.
- **Offline reproduction:** the same sequence (saved-account sign-in, sign-out, returning sign-in with `storage: 'session'`) succeeds against the local fake authorization server.
- **Regressions:** `node/chatgpt/tests/oauth.test.ts` (the reproduction, and a typed code with no URL or token for every failure ending of a returning session-only sign-in, `timed-out` included); `node/chatgpt/tests/credential-broker.test.ts` (refresh held across sign-out with a pending tool, vault and session; app killed during a refresh's vault write, two processes). Commit `449258a07`, with no product change.
- **Session-only sign-ins end with the app that holds them (fix, commit `242906a40`).** Before this fix, a turn forked by the app kept using the session access token it had cached after the app's end of the IPC channel closed, until that token neared expiry. Now, once the channel has closed (`process.connected` is false) or sending to the app fails:
  - the fork drops what it was handed, and `getAccessToken` fails with `session-unavailable`, with no refresh, revocation or fallback to a stored record;
  - its turn stops at its next model request or tool call, within the account-watch poll bound if idle, so an approved tool doesn't run;
  - the registry reports the account disconnected in that process.

  The account list, the vault and stored sign-ins are untouched. Pinned in `credential-broker.test.ts`: *ends a forked turn's session-only sign-in with the app that held it, so its pending tool never runs, leaving stored sign-ins running* (a real forked process whose channel the test closes, with a vault-stored control turn) and *…once sending to the app that held it fails, never falling back to a stored record*. A live-turn observation of this is G3's.
- Status `offline-tested`; no live gate is passed by this record.

### G2 record, first half (G2a, November 11, 2026)

Covers G2 checkboxes 1 to 4 (capabilities, model controls, rich workflows, compaction and restart). Checkbox 5 (the image service as its own capability in Settings and the composer) is G2b's.

**Sources.** Route documentation, re-read on November 11, 2026: [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) and [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), as rendered by a summarizing fetch tool (section E). Captured requests: the November 10 run at `4ae1e38da` (section 2), read from the retained `draft.requests.ndjson`, `resume.requests.ndjson` and `evidence.ndjson`, of which only model, effort, booleans and counts were read. Where the route defers to the model ("images … are supported when the selected model accepts them"), [the model's page](https://developers.openai.com/api/docs/models/gpt-6-luna), which lists text and image input.

What the captured run shows: the account's live model list included `gpt-6-luna`; seven requests on it completed, five at `low` and two at `medium`; each sent `stream: true`, `store: false`, no output cap, no top-level `tools` and an `additional_tools` item; the input grew 2 → 4 → 10 → 12 → 14 → 16 → 20 items as tool calls, their results (0 → 1 → 4 → 5 → 6 → 6 → 8) and one assistant message were replayed; reasoning tokens were 0 throughout; the largest input was 9,696 tokens; no request carried an image.

**Capabilities on this route.** A capability with no source is unavailable in code.

| Model | Offered on the route | Efforts | Image input (attachments) | Image tool results | Replay | Local context budget |
| --- | --- | --- | --- | --- | --- | --- |
| `gpt-6-luna` | Captured request (listed for the account; seven requests completed) | `low`, `medium`: captured request. `none`, `minimal`, `high`, `xhigh`, `max`: unknown → unavailable | Available: route documentation (images supported when the model accepts them) and the model's page. Not captured | Available, inferred: from the route's general statement about image inputs; not named by the route documentation and not observed in a captured request. Unqualified until the live check in gate T1 (section H) | Stateless, full history in `input`, `store: false`, `stream: true`, no `previous_response_id`: route documentation. Function calls, their outputs and assistant messages: captured request. `include: ["reasoning.encrypted_content"]`: captured request (pi asks for it at every effort it sends). Encrypted reasoning items: kept, under the route's "send the required history"; never captured, since no captured turn produced one | 200,000 tokens, Studio's own: the route documents no window. Captured inputs reached 9,696 tokens |
| `gpt-6.1-sol` | Route documentation (the example request's `model`) | None sourced: the documented example sends no `reasoning`, and Studio always sends an effort. Unknown → unavailable, so the model is unavailable | n/a | n/a | n/a | n/a |
| `gpt-6-astra`, `gpt-6.1-terra` | Neither documented nor captured: unknown → unavailable | n/a | n/a | n/a | n/a | n/a |

Not offered on any model, as before: reasoning modes other than standard, an output cap, and hosted tools (image generation, file search, Code Interpreter, computer use, hosted MCP, `tool_search`). Nothing found being sent that the route lists as unsupported.

**Authority (defect fixed, commit `ebc94a147`).** The route's table was seeded from the OpenAI API catalog: `seedFromApiCatalog` in `packages/agent/protocol/chatgpt-models.ts` copied `reasoningEfforts` (by reference) and `imageInput` from `OPENAI_MODEL_CAPABILITIES` for four slugs. Every ChatGPT control read that seeded table: the account model list filter (`fetchChatGptModels`), effort checks and defaults (`resolveChatGptReasoning`, `getDefaultChatGptReasoningEffort`, used by the runtime, CLI, local server, Settings, composer and queue), the pi model (`buildChatGptModel`: image input, effort map, and through them the screenshot tools' vision), the composer's image check and the CLI's `/model` and `/reasoning` choices. A regression test that edits the API catalog failed against it: the route gained `none` and `minimal` efforts and lost image input. Now `CHATGPT_MODEL_CAPABILITIES` is a frozen literal table and `CHATGPT_LOCAL_CONTEXT_BUDGET` the budget, both in that file, which no longer imports the API catalog. Left as they were, being enumerations or labels rather than capabilities: the effort list and labels, `toPiThinkingLevel`, and the composer's model label for a known slug.

A selection the route isn't qualified for is held with an explanation and never replaced: "Studio doesn’t support the ChatGPT model “gpt-6.1-sol” yet: it isn’t qualified for use with a ChatGPT plan. Choose another model to continue." and "Studio doesn’t support “High” reasoning for gpt-6-luna with ChatGPT yet: it isn’t qualified for use with a ChatGPT plan. Choose one of: Low, Medium." A model the account lists but Studio hasn't qualified is left out of the pickers without a message.

**Workflows pinned on the route** (test files under `packages/agent/` unless noted):

| Workflow | Test |
| --- | --- |
| API catalog edits can't change the route's controls | `node/chatgpt/tests/models.test.ts`: *the ChatGPT route’s controls, whatever the OpenAI API catalog says* (two tests), *offers only what the route is qualified for*, *is frozen* |
| Catalog refresh, removal, no replacement | `node/chatgpt/tests/models.test.ts` (listing, hiding, last good list per registration); `apps/ui/.../chatgpt-chat.test.tsx`: *holds queued messages once a refreshed catalog drops the chat’s model, never switching to another*, *explains and holds a recorded choice of a model / an effort the route isn’t qualified for*; `node/sessions/tests/chatgpt-selection.test.ts`: *refuses … and keeps the saved choice, never a nearby one*; `apps/local/src/tests/chatgpt.test.ts`: *refuses a model or effort the route isn’t qualified for, keeping the saved choice*; `apps/cli/commands/ai/tests/chatgpt.test.ts`: *offers only the listed models and efforts the route is qualified for*, *does not silently replace …* (three cases). Settings refresh was already pinned: `apps/ui/.../chatgpt-settings.test.tsx` *refreshes the selected account’s models and offers no output cap or unsupported mode* |
| Image attachments, composer to request | `apps/ui/.../chatgpt-chat.test.tsx` *sends attached images and documents with the turn on the pinned ChatGPT selection*; `node/tests/run-manager.test.ts` *hands attached images and files to the turn in the input payload*; `apps/cli/commands/ai/sessions/tests/resume.test.ts` *passes attached images and files from an input payload*; `apps/cli/commands/ai/tests/chatgpt.test.ts` *runs a turn with attached images and files on the chat’s pinned connection, model and effort*; `node/runtime/tests/chatgpt-session.test.ts` *sends the composer’s attached images to the model as image input with the prompt* |
| Documents, missing files, access boundaries | `chatgpt-session.test.ts` *reads an attached document, reports a missing one and refuses a core-file write to the model, without failing the turn*; `resume.test.ts` *refuses an attached file with a relative path / a control character*; `protocol/tests/chat-files.test.ts` (existing) |
| Screenshots, image tool results, artifacts, progress, preview refresh | `chatgpt-session.test.ts` *returns a screenshot to the model as image input, shows it as an artifact with progress, and refreshes the preview*; *sends an image tool result back as image input* (existing) |
| Annotations | `chatgpt-session.test.ts` *gives the model the user’s visual annotations and their images, from the composer and from the annotation browser* |
| Questions | `chatgpt-session.test.ts` *asks the user a question and gives the model their answer* |
| Pending work | `chatgpt-session.test.ts` *settles background image generation before a screenshot runs, and reports its failure to the model with that result*; *doesn’t end the turn before its background image generation settles* |
| Image-heavy history and compaction | `chatgpt-session.test.ts` *replays an image-heavy history statelessly and summarizes it without its images, on the pinned connection, model and effort*; *keeps reasoning, tool calls and effort straight across tool use, reopened sessions and compaction* (existing) |
| Interrupted compaction | *keeps the history whole when compaction’s summary breaks off, without sending it again or re-running a tool* |
| Token invalidation | *invalidates a token rejected during compaction, keeps the history whole, and goes on with the newer token*; *invalidates only the rejected request’s token …* (existing) |
| Partial tool failure | *reports a partly failed tool batch to the model and, after a mid-stream failure, resumes without running either tool again* |
| Uncertain tool outcome | *never runs a tool call again that an interruption cut into while its command runs / before its command starts* |

Every request in these tests is checked for the selected connection, its token, `gpt-6-luna`, the turn's effort and no output cap, summaries included.

**Observed, not changed:**

- On every provider, pi records an interruption that lands while it prepares the next model request as an error ("This operation was aborted") rather than as interrupted, because pi's `lazyStream` reports a failed request setup as an error. An interrupted tool is never re-run: if its command finished, the history keeps its real result; if it hadn't started, the history says "Operation aborted".
- Image generation (for G2b): a ChatGPT turn offers `generate_images` whenever Studio's WordPress.com image service is configured (`STUDIO_IMAGE_API_TOKEN` or a WordPress.com login), exactly as on other providers. It calls that service with that credential, never with the ChatGPT token, and ChatGPT requests never carry the service's credential. Nothing in Settings or the composer says the service is in use. Pinned in `chatgpt-session.test.ts`: *offers image generation with no image service / an image service token / a WordPress.com login, on its own credential*.

**Status.** `offline-tested`. No live gate is passed by this record; T1 and T2 (section H) stay open. G4 owes a live smoke of `gpt-6-luna` at `low` and `medium`, with an attached image, an image tool result and a reasoning-item replay. Any other model or effort becomes available only once a capture or the route's documentation supports it.

### G2 record, second half (G2b, November 11, 2026)

Covers G2 checkbox 5 (section G's acceptance condition) and the verification part of checkbox 6. Commits `ea3406eab`, `f31080d8b`, `ee7b779c4`, `d2264fa10`.

- **One capability, one account.** `resolveImageService` in `packages/agent/node/image-generation.ts` decides it: `STUDIO_IMAGE_API_TOKEN` first, else the WordPress.com login in `shared.json`, never a model provider's credential. The same lookup gates `generate_images` (`isImageGenerationAvailable`), signs its requests and feeds the apps: `readImageServiceState` behind the Desktop IPC handler `getImageServiceState` and `studio ui`'s `GET /api/image-service`, read through the connector method `getImageServiceState()` as `ImageServiceState` (`packages/agent/protocol/image-service.ts`). The state names the account only as Studio's account menu already does (display name, email): no token, no user ID.
- **In the product.** ChatGPT settings gain an "Image generation" row: Studio's WordPress.com image service, separate from the ChatGPT plan, the account it acts as, or "Log in to WordPress.com". A ChatGPT chat's composer says under its connection label which service and account make images, "not your ChatGPT plan", or that images are off, with a link to Settings › AI. Composers of WordPress.com, Anthropic API and OpenAI API chats are unchanged. The model picker and the Settings model row note when the account lists models Studio hasn't qualified, naming and offering none (closes G2a's "left out of the pickers without a message").
- **Guidance.** The system prompt's imagery routing is present only when `generate_images` is registered, or for an MCP client with an image tool of its own; otherwise one line says the conversation can't make images and how the user sets the service up. With the service, the prompt is byte-identical to before. This applies to every provider.
- **Execution record.** A `generate_images` result keeps `studioService` (service, credential kind, account) in its `details`, which the session stores and the chat's tool row shows. It is not in the model's content, in any ChatGPT request, or in what an MCP client receives.
- **Tests.** `node/tests/image-generation.test.ts` (*the image service*, four cases); `node/tests/tools.test.ts` *keeps the image service and account that made the images with the result, out of what the model reads*; `node/tests/system-prompt.test.ts` *imagery guidance* (three cases); `node/runtime/tests/chatgpt-session.test.ts` *offers image generation with … on its own credential* (G2a's three cases, extended: prompt gating, the stored record, nothing of it in ChatGPT requests); `node/runtime/tests/pi-runtime.test.ts` *image generation on WordPress.com / an Anthropic API key / an OpenAI API key* (both branches each); `node/chatgpt/tests/models.test.ts` *says only whether the account lists models Studio hasn't qualified, never which*; `apps/cli/ai/runtimes/mcp/tests/served-tool.test.ts`; `apps/local/src/tests/image-service.test.ts`; `apps/studio/.../image-service-ipc.test.ts`; `apps/ui/.../image-service-contracts.test.ts`, `chatgpt-settings.test.tsx`, `chatgpt-chat.test.tsx`, `composer.test.tsx`, `trace/tool.test.tsx`, `transcript-items.test.ts`.
- **Status.** `offline-tested`. No live gate is passed by this record. Light and dark visual verification of the new states is pending with the controller (playground page `image-service-preview.html`). Evals not run; see the G2b report for the commands. Claude (C2/C3) still owes the same contract on PR #3.

### G3 record (November 11, 2026)

- **What exists.** A development-only acceptance runner, `node apps/cli/dist/cli/chatgpt-acceptance.mjs --scenario saved|session --run-dir <absolute path> [--live]`, built by `npm run cli:build` (`apps/cli/vite.config.dev.ts`) and by no production, npm or standalone build (pinned in `apps/cli/ai/tests/chatgpt-acceptance-entry.test.ts`). Usage, stages, evidence format and cleanup: `scripts/chatgpt-acceptance/README.md`. It replaces the throwaway scripts of the November 10 run.
- **Evidence format.** `manifest.json` (schema version, source SHA and dirty flag, OS/architecture, Node/npm, build identity, model/effort, scenario; runs appended), append-only `evidence.ndjson` (stage, `passed|failed|blocked|skipped`, typed code, bounded counts/booleans/durations), and `state.json` for local identifiers only. The writer and its redaction guard are provider-neutral (`apps/cli/ai/acceptance-evidence.ts`) for C5 to reuse.
- **Record before judging.** Each stage records its status, typed code and observations before anything judges it. `apps/cli/ai/tests/chatgpt-acceptance.test.ts` reproduces the earlier harness's mistake against the real sign-in flow and a local authorization server: asserting the outcome first left no record, while the runner keeps `timed-out`. A sign-in prints when the browser opened and the time left each minute; a time-out says how many seconds after the browser opened Studio stopped waiting (the earlier `assertion-failed` record landed 599.5 s after its browser opened, against the 600 s bound).
- **Scenarios.** `saved`: sign-in, re-sign-in, model discovery, disposable site, one named draft with tool-policy enforcement, request audit, independent WP-CLI readback, effort change, fresh-process resume, an active forked run stopping on sign-out by itself, remote revocation probed separately from the local clear, later use blocked. `session`: returning session-only sign-in, no credential record on disk, an offered fork answered over IPC, an unoffered process failing before inference, and a real refresh held across a sign-out (no token for a fork started in the window; the offer gone once the refresh settles, not asserted earlier; the held refresh rejected as signed-out; retired and rotated refresh tokens refused). Optional gates T1 (image tool result used by the reply), T2 (reasoning item replayed and accepted) and T3 (`details.studioService` on the live tool row before persistence; `blocked`, never failed, without the image service) are stages skipped unless requested.
- **Offline tests.** Both scenarios end to end with the real credential broker and sign-in flow against the local authorization server, the remaining parts scripted; cleanup after a failure at each `saved` stage; cleanup failing too without hiding the original failure; an interrupt during sign-in; missing or incompatible prerequisites (run directory, real-profile isolation, unqualified model or effort, missing or incompatible saved manifest, changed source, missing registration); the redaction guard against token-, URL- and email-shaped strings; the request observer; the entry's import order.
- **Status.** Brief items 1, 2 and 6: implemented and offline-tested. Items 3, 4 and 5 (the live saved and session scenarios, the live refresh hold and the active run stopping on sign-out): implemented and offline-tested; live execution pending owner consent. No live gate is passed by this record, and T1, T2 and T3 stay open. The November 10 session-only failure stays recorded in section 2.

### G4a record (November 11, 2026)

Offline part of G4 with the ChatGPT side of M2. Commits `2b2e773b8`, `2bbf5ddbe`, `de130bd7c`, `8151becb5`, `c4d650e57`; review fix round 1: `bf059f24a`, `70a36e458`, `4352d9dab`, `746bd4d12`, `f05f5eca6`, `b9de808de` (and the documentation commit that updates this record).

- **Explicit provider selection for evals.** `STUDIO_EVAL_PROVIDER` (or a case's `provider` var), `STUDIO_EVAL_CHATGPT_PROFILE` and `STUDIO_EVAL_CONNECTION` (environment only), `STUDIO_EVAL_MODEL`, `STUDIO_EVAL_EFFORT`, and a case var `requireProvider` (`apps/cli/ai/eval-provider.ts`, wired in `eval-runner.ts`). Unselected runs take the default path unchanged (result fields and provider fallback pinned by test); a model name alone never selects a route. A ChatGPT selection runs on that connection or is refused, with a typed code, before any site, turn or model request (`experimental-flag-off`, `connection-required`, the `profile-*` codes, `connection-unknown`, `connection-signed-out`, `connection-unsupported`, `connection-state-unavailable`, `model-not-qualified`, `effort-not-qualified`, and the selection and legacy-provider codes listed in `scripts/eval/README.md`). Never a fallback to the global provider.
- **Dedicated test profile (fix round 1).** A ChatGPT eval takes its connection from a dedicated test profile the owner signs in to with the acceptance runner's new `provision` scenario and signs out with `retire`, never from the owner's normal profile (refused when it is `~/.studio`, inside it, resolves into it, or is the eval process's own config folder). The runner points the process's ChatGPT state at that profile through a development-only seam, `setChatGptStateDirectory` (`packages/agent/node/chatgpt/state-directory.ts`: absolute existing directories only, refuses a move once ChatGPT state was used, unchanged behaviour when unset; only `apps/cli/ai/eval-runner.ts` calls it, checked by a source scan). Every read and write of ChatGPT state happens in that profile under its own locks; the earlier links to credential state are gone. Setup to teardown is one try/finally that restores `fetch` and removes the case's temporary profile and registry on every way out.
- **Executed route.** Each selected run reports `providerRoute.requested` and `providerRoute.executed`. The executed kind, backend, model, effort and bearer shape come from the acceptance runner's request observer wrapped around the run's `fetch`; the reply providers from the runtime's own stamps; the connection fingerprint (`connectionRef`) from the conversation's ChatGPT record, which restates the selection. The evidence of the account is `connectionMatchesBearer` (fix round 1): the observer compares, in memory, each route bearer's `sub` claim with the selected registration's recorded subject and keeps only `true`, `false` or `unverified`. Studio's separate image service is counted apart from inference. `scripts/eval/outcome.mjs:ranOnRequestedRoute` fails a run with no selection ("regression evidence only"), a refused run, any mismatch, or a bearer comparison that is not `true` (`connection-mismatch`, `connection-unverified`).
- **What `remote: mock` guarantees (fix round 1).** Pushes, pulls and preview changes recorded by the mocked host; `wpcom_request` writes recorded and answered by a fixture; any other non-GET/HEAD request to a WordPress.com host from the eval process refused and failing the case (`noWordPressComWrites`, `wpcom-write-under-mock`), with the image service allowed only in cases labelled `imageService: "required"`. Reads still reach WordPress.com, and a command the agent runs in its shell is outside the guard. Every selected case without a `remote` var runs as `remote: mock`.
- **Staging (fix round 1).** `remoteCalls` only for mocked cases; `remoteOperationRan` judges by the declared mode. A staging case runs only on a site named for the run (`STUDIO_EVAL_STAGING_SITE_ID`, `STUDIO_EVAL_STAGING_SITE_URL`) that WordPress.com lists, at that address, as a staging site of the account (`staging-not-confirmed` otherwise).
- **Offline regressions.** `apps/cli/ai/tests/eval-provider.test.ts`: a ChatGPT-selected eval with `gpt-6-luna` (a slug the OpenAI API also serves) runs the real agent session with an API key planted in its environment and every request goes to the route with the connection's token; with `gpt-6.1-sol` it is refused, never run on the API key (a table the Claude side adds its row to); each refusal before any request; the executed route read from the requests, not the selection. `apps/cli/ai/tests/eval-runner.test.ts`: the default path unchanged, the selected path never resolving the global provider, a run that ends up on an API key reported as such, refusals before any site or turn.
- **Parity config.** `scripts/eval/subscription-parity.config.yaml`: 22 automatic cases (identity, instructions, skill routing, site creation, target selection, theme file, import and export, questions, design choice, desktop and mobile screenshots, screenshot interpretation, preview refresh, mocked preview creation, annotation, artifact, attachment replay, declined and approved push on a mocked remote, cancellation, resume, fixture-forced compaction, image generation off), two that need Studio's image service (generation, and pending work, which checks that generation came before the screenshot in the recorded tool sequence) and one staging case refused unless a disposable staging site is designated. Checked without running a case by `scripts/eval/subscription-parity.test.mjs`.
- **Acceptance runner.** WP-CLI's global config, cache and packages now point inside the run directory (`WP_CLI_CONFIG_PATH`, `WP_CLI_CACHE_DIR`, `WP_CLI_PACKAGES_DIR` in `acceptance-isolation.ts`). New optional gate **T4**: one read-only smoke stage per pair of the route's qualified table (`gate-t4-smoke-1` = `gpt-6-luna` at `low`, `gate-t4-smoke-2` = at `medium`), each its own record. New scenarios `provision` (`profile-sign-in`, left signed in) and `retire` (`profile-sign-out`, reporting `remoteRevocationConfirmed`), offline-tested.
- **Status.** `offline-tested`. **No live gate is passed by this record**; T1, T2 and T3 stay open, and T4 is added open. Live runs that remain, each needing the account owner's consent:
  1. Make the dedicated test profile: `node apps/cli/dist/cli/chatgpt-acceptance.mjs --scenario provision --run-dir <new absolute directory> --live`.
  2. The parity eval on it: `npm run eval:parity -- --filter-pattern "^parity"` with `STUDIO_EXPERIMENTAL_CHATGPT=1`, `STUDIO_EVAL_PROVIDER=chatgpt-oauth`, `STUDIO_EVAL_CHATGPT_PROFILE=<run directory>/profile`, `STUDIO_EVAL_CONNECTION=<registrationId from its state.json>`, `STUDIO_EVAL_MODEL=gpt-6-luna`, `STUDIO_EVAL_EFFORT=medium`, with Studio's image service configured (the two `[image service]` cases are refused otherwise).
  3. The acceptance runner with every gate, T4 being the per-model smoke: `node apps/cli/dist/cli/chatgpt-acceptance.mjs --scenario saved --run-dir <another new absolute directory> --gates T1,T2,T3,T4 --live`, then `--scenario session --run-dir <that directory> --live`.
  4. Retire the dedicated profile: `node apps/cli/dist/cli/chatgpt-acceptance.mjs --scenario retire --run-dir <the provisioned directory> --live`.
  5. The staging case, only on a disposable staging site named for that run: `npm run eval:parity -- --filter-pattern "^staging:"` with `STUDIO_EVAL_STAGING_SITE_ID` and `STUDIO_EVAL_STAGING_SITE_URL` (the same selection variables as 2).
  6. The original suite as regression evidence for the legacy provider only: `npm run eval`.
  7. Not G4a's: platform repeats (P1-P4), Desktop and `studio ui` runs, and the PR's testing instructions (G4 checkboxes 5 and 6).

## B. Claude capability rows (PR #3, source SHA `ce4eea5dc`)

Test files are under `packages/agent/node/claude-code/tests/` in the Claude worktree unless noted.

| # | Capability | Owner | Status | Existing test/eval | Evidence |
| --- | --- | --- | --- | --- | --- |
| B1 | Account lifecycle: native sign-in, inspect, reconnect, disconnect, identity change detection, billing-route identity. Credentials stay vendor-owned. | C5, P1 | partial. Sign-in launch, discovery and connection code exist (`connection.ts`, `auth-status.ts`). Authenticated live acceptance open. | `connection.test.ts`, `auth-status.test.ts`, `auth-route.test.ts`, `auth-comparison.test.ts`, `managed-auth.test.ts`, `identity.test.ts` | none yet |
| B2 | Conversations: new/global/site, target selection, model/effort, queued sends, resume, compaction, cancellation, crash recovery | C1, C4, C5 | partial. `createClaudeSession` is bound to one local site (`studio-surface.ts`). Global and explicit target transitions not implemented (C1). Crash recovery: C4, not started. | `sessions.test.ts`, `studio-surface.test.ts`, `environment.test.ts`, `routing.test.ts`, `native-lifecycle.test.ts` (opt-in) | none yet |
| B3 | File work: read, search, list, write, edit, shell | C1, C2 | partial. The runtime is configured with tools `['Read']` only (`runtime.ts`); `canUseTool` and init-frame checks allow only `Read` and `mcp__studio__wp_cli`. Write, Edit, Grep, Glob, Ls and Bash are not enabled. | `runtime.test.ts`, `tool-bridge.test.ts` | none yet |
| B4 | Studio operations: every host-applicable Studio tool | C2 | partial. One bridged tool, `wp_cli`, restricted to an allowlist (see section D). The other 28 registered Studio tools are not bridged. | `tool-bridge.test.ts` | none yet |
| B5 | User interaction: questions, choices, design alternatives, approvals; reconnect restores only the current run's unresolved requests | C1, C3 | partial. Approval for draft creation exists (`approval.requested` events in `tool-bridge.ts`). Questions and design choice not implemented. Reconnect behavior not verified. | `tool-bridge.test.ts`, `event-adapter.test.ts` | none yet |
| B6 | Rich results: images, attachments, artifacts, background completion, preview refresh, annotations | C3 | not started. The plan baseline says image results, artifacts and preview/annotations are outside the current proof of concept. | none yet | none yet |
| B7 | Guidance: identity, user instructions, skills, tool-name mapping for the native runtime | C2, C3 | not started (no `Skill` tool bridged). | none yet | none yet |
| B8 | Models: runtime discovery intersected with qualified capabilities | C5, P1 | partial. `discoverClaudeModels` and `requireSupportedSelection` exist (`studio-surface.ts`). | `runtime.test.ts`, `studio-surface.test.ts` | none yet |
| B9 | Failures: no false completion, duplicate side effects, API fallback, account substitution, leaks, orphan processes | C1, C4, P2 | partial. Environment scrubbing, init-frame verification and approval fencing exist per PR #3 reviewers and code. Orphan-process and crash cases not qualified. | `windows-preflight.test.ts`, `native-startup.test.ts` (opt-in), `native-lifecycle.test.ts` (opt-in) | none yet |
| B10 | Surfaces: Desktop, `studio ui`, interactive CLI, noninteractive CLI; UI-only tools gated | C3, C5, P4 | partial. Settings and CLI surfaces exist per the plan; not verified by M1. | `apps/ui/src/features/chats/session-view/claude-session-view.test.tsx`; `apps/cli/commands/ai/tests/*` | none yet |
| B11 | Existing providers unchanged | M2, M3 | not verified. The branch added a cross-runtime isolation test (per PR #3 comment). | `packages/agent/node/sessions/tests/chatgpt-selection.test.ts` and backend tests under `node/backends/tests/` | none yet |

## C. Platform cells

Spec target: Desktop, CLI and the local browser backend on six targets, for each provider. The only runner available to this program is this machine, Windows 11 Pro x64 (build 10.0.26320). Per decision of the program owner, the other five cells have **no runner assigned**; that is a scheduling blocker, not a dropped cell. Owner tasks: P1 (runtime/sign-in portability), P2 (process trees), P3 (ChatGPT native storage and browser), P4 (packaged app and CLI on each runner), G3/C5 (authenticated acceptance).

Required evidence per cell, from the spec: native account lifecycle; authenticated read, draft, readback, resume; cancellation and recovery; package execution (installer and standalone CLI). Windows ARM64 must record the existing x64 PHP dependency.

| # | Provider | Platform cell | Runner | Owner | Status | Test/eval | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | ChatGPT | Windows x64 | This machine (Windows 11 x64) | G3, P3, P4 | partial. Saved-account live run `live-passed`; session-only live `failed`; packaging claimed at an earlier SHA, not re-verified. Native Credential Manager qualification not recorded for `4ae1e38da`. | none yet beyond A-section tests | Section 2 |
| C2 | ChatGPT | Windows ARM64 | no runner assigned: scheduling blocker | P1, P3, P4 | blocked | none yet | none yet |
| C3 | ChatGPT | macOS x64 | no runner assigned: scheduling blocker | P3, P4 | blocked | none yet | none yet |
| C4 | ChatGPT | macOS ARM64 | no runner assigned: scheduling blocker | P3, P4 | blocked | none yet | none yet |
| C5 | ChatGPT | Linux x64 | no runner assigned: scheduling blocker | P3, P4 | blocked | none yet | none yet |
| C6 | ChatGPT | Linux ARM64 | no runner assigned: scheduling blocker | P3, P4 | blocked | none yet | none yet |
| C7 | Claude | Windows x64 | This machine (Windows 11 x64) | C5, P1, P4 | partial. The only platform the code allows today (`win32` + `x64` gate). Native startup/lifecycle tests exist (opt-in); authenticated acceptance open; package not qualified for the merged candidate (per PR #3 comment). | `native-startup.test.ts`, `native-lifecycle.test.ts` (opt-in) | none yet |
| C8 | Claude | Windows ARM64 | no runner assigned: scheduling blocker | P1, P4 | blocked. Code currently refuses non-x64. | none yet | none yet |
| C9 | Claude | macOS x64 | no runner assigned: scheduling blocker | P1, P4 | blocked. Code currently refuses non-Windows. | none yet | none yet |
| C10 | Claude | macOS ARM64 | no runner assigned: scheduling blocker | P1, P4 | blocked. Same. | none yet | none yet |
| C11 | Claude | Linux x64 | no runner assigned: scheduling blocker | P1, P4 | blocked. Same. | none yet | none yet |
| C12 | Claude | Linux ARM64 | no runner assigned: scheduling blocker | P1, P4 | blocked. Same. | none yet | none yet |

Test accounts and quota:

- Accounts to be used: the repository owner's own ChatGPT account and Claude account. No identifier is recorded here.
- Live-run consent: **pending, to be requested once the acceptance runners exist.** Earlier authorization is not extended by this record.
- Quota: the repository owner stated in a PR #3 comment that live-account checks are deferred because quota is exhausted. Quota for future runs is unknown.

### M2a record (November 11, 2026)

Credential-free CI workflow: `.github/workflows/subscription-provider-checks.yml` (pull requests and manual runs; read-only token, no secrets; actions pinned to commit SHAs). Cells, one job each with `fail-fast: false`; each job prints `process.platform`/`process.arch` and `uname -a`/`ver`:

| Cell | Runner label |
| --- | --- |
| Linux x64 (also lint, Knip) | `ubuntu-24.04` |
| Linux ARM64 | `ubuntu-24.04-arm` |
| macOS ARM64 | `macos-15` |
| macOS x64 | `macos-15-intel` |
| Windows x64 | `windows-2025` |
| Windows ARM64 | `windows-11-arm` |

All six labels are listed in GitHub's hosted-runner reference for public and private repositories (the repository is public); the page names no preview or deprecated status for them.

**The workflow has NOT run yet**: nothing was pushed. It was parsed, checked with actionlint 1.7.12, and its commands run locally on Windows x64 only. Hosted-runner results will be credential-free evidence only: they do not qualify any platform cell (C1-C12) for authenticated use, native credential storage, sign-in, packaging or process-tree behavior. Account-backed evals, `--live` acceptance runners, real keychain tests and the opt-in native Claude tests are deliberately absent.

### P3 record (November 11, 2026)

ChatGPT native storage and browser sign-in, offline part. Commits `ffef17540`, `d00961ae3`, `5d1f64e53`, `ab886d952`, `3e9e7136b` and the documentation commit that adds this record; fix round 1: `b095deaf9` (R2), `f5ccb89a6` (R1), `de76357fe`, `eee94c2fc`, `1530e526e`, then `2bca54245` (R3), `9b142a65c` (R4), `8710024ff`; fix round 2: `3251d02ed` (the listener and its socket tables), `0124dfe0b` (the preflight), `60c2ea2a2` (this record and the README), `77337395f` (the last test flow off the machine's own platform) and the commit that lists them here.

- **Keychain failures (offline-tested, all three adapters through their process seam).** Denied, locked or headless, unavailable (tool missing), no session bus, a bus without a Secret Service, no logon session, timeouts, and a tool that exits 0 without keeping the secret: each gives a typed `SecureStorageError` (or `available: false` with the tool's reason) and leaks no 12-character piece of the secret into an error, a reason or any spawned command line (`packages/common/lib/tests/os-credential-store-failures.test.ts`). None reads as "nothing saved" **for the emulated answers**, which use each tool's documented wording; what a dismissed Linux unlock prompt really returns is not established offline and may be exactly "nothing saved" (exit 1, no output). Fix round 1 (R2, below) makes the vault safe under either answer. Through the vault (`packages/agent/node/chatgpt/tests/credential-store-failures.test.ts`): `vault-unavailable`, no registration, no record and no token anywhere in the profile; a session-only sign-in still works when chosen, without asking the keychain again. Never a plaintext or automatic session-only fallback.
- **How a secret reaches each tool.** macOS: inside `security -i`, as the last word of a command line written to stdin; Linux: `secret-tool store` stdin; Windows: PowerShell stdin, with service and account in the `-EncodedCommand` script. Quotes, backslashes, whitespace, control and non-ASCII characters are refused before any tool runs; option-looking and shell-looking secrets are kept exactly; item names that could read as options are refused. Checked against the tools' sources (Apple `SecurityTool`, libsecret `secret-tool.c`).
- **Defect fixed (`ffef17540`).** `security -i` reads at most 4,095 characters of a line and runs the rest as a command; `secret-tool store` keeps 8,192 bytes of stdin and exits 0. A longer secret was stored cut short over the previous one, and on macOS its tail was echoed into the error. Such a secret is now refused before any tool runs. Stored format and reading are unchanged; the vault key is 43 characters.
- **Native tests: written, UNRUN on every platform, this machine included** (no consent yet to keychain writes). `STUDIO_NATIVE_CREDENTIAL_STORE_TEST=1` opts in; CI is refused whatever the opt-in. Files, what they write and remove, and per-OS prerequisites: `scripts/chatgpt-acceptance/README.md`, "Opt-in native keychain tests". Their gating, per-run service naming (`studio-native-test-<16 hex>`, never `wordpress-studio`) and cleanup on failure are proven offline (`os-credential-store-native-harness.test.ts`).
- **Linux package.** The DEB recommends `libsecret-tools` (not a dependency: without it Studio reports persistent storage unavailable and still offers session-only storage). Pinned in `apps/studio/src/tests/forge-config.test.ts`.
- **Browser sign-in (offline).** Loopback callback, port collision, cancel and timeout, returning identity and explicit session-only were pinned by G1 in `node/chatgpt/tests/oauth.test.ts`; P3 adds a second attempt while one is pending and the advertised callback being only the attempt's own `127.0.0.1` listener whatever is set, plus the CLI opener failing on a host without a browser (`apps/cli/lib/tests/browser.test.ts`).
- **Acceptance runner.** `prerequisites` records the platform's keychain (`storePasswordVault`, `storeKeychain`, `storeSecretService`) and `secureStorageAvailable` in every scenario; `session` records them without blocking.
- **Decided in fix round 1 (formerly open).** The review's two Important items were ruled on (R1, R2) and implemented, offline only:
  - **R1, the browser opener gets a one-time loopback start address** (`packages/agent/node/chatgpt/oauth.ts`). Every opener, the CLI's and the Desktop's (`shell.openExternal`), is given only `http://127.0.0.1:<port>/<43-character random segment>` on the attempt's own listener; the listener answers it once, while the attempt waits, with a `302` to the authorization URL (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`), and refuses another path (404), another method (405), another `Host` (400) or a second use (400) without the URL. It goes with the attempt. The registered redirect URI and every callback check (state, PKCE, nonce, returning identity) are unchanged. Pinned in `node/chatgpt/tests/oauth.test.ts`, "the start address": nothing of `state`, `nonce`, `code_challenge`, `id_token_hint`, `login_hint`, the client id, the host id or the authorization URL in what the opener got, for a first and a returning sign-in in both storage modes. The Windows CLI opener no longer builds PowerShell code from the address: a fixed command reads it from the environment (`apps/cli/lib/browser.ts`); a real Windows PowerShell run with `Start-Process` shadowed shows an address holding `$(`, backticks, quotes, `&` and `$env:` handed over exactly and nothing run (`apps/cli/lib/tests/browser.test.ts`; the old opener ran a `$(…)` from the address). The start address itself is still on the opener's command line, which other local users can read on Linux: R3 covers that.
  - **R3, on Linux the listener answers only its own user** (`packages/agent/node/chatgpt/loopback-peer.ts`, used by `oauth.ts` for the start address and the callback alike). For each request it finds the peer's socket in `/proc/net/tcp` and `/proc/net/tcp6` (the row whose local end is the request's remote end and whose remote end is the listener; layout from the kernel's `Documentation/networking/proc_net_tcp.rst` and `tcp4_seq_show()`/`tcp6_seq_show()`; nothing spawned) and refuses it, with the existing refusal page, the start address not used up and the attempt untouched, when the row's uid proves another user who isn't root, or (fix round 2) when a table can't be read or parsed for any reason but the kernel hiding it. The same user, root, a socket with no row proving its owner in a table that could be read (no row, rows that disagree, a TIME_WAIT row, an unmapped uid), or a table the kernel hides (`ENOENT`, `EACCES`, `EPERM`) go through. `/proc/net/tcp6` is read too because a peer connecting from an IPv6 socket to the IPv4-mapped 127.0.0.1 is listed only there. Not done on macOS or Windows, which don't show other users a process's arguments. Pinned offline: the parser over kernel-format fixture tables (`node/chatgpt/tests/loopback-peer.test.ts`) and the listener through an injected seam (`oauth.test.ts`, "the start address > on Linux"). **Never run on a real Linux kernel.**
  - **R4, an unreadable key is reported before the browser step** (`oauth.ts` `begin`, `credential-broker.ts` `checkVaultKey`): a sign-in to keep in secure storage while saved records exist and their key reads as none fails with `vault-key-unreadable` before discovery, the listener or the browser, in the shared start path the CLI and the Desktop app both use. Saving still checks again. Session-only sign-in is unaffected. Pinned in `oauth.test.ts`.
  - **Fix round 2 (re-review of R3 and R4), offline only:**
    - **The listener test that failed on POSIX runners.** The reader took `uid: undefined` as "this process's uid", so the "no uid" test answered from the runner's own uid (Ubuntu 1001, macOS 501; reproduced here by stubbing `process.getuid`). No uid is now `null`, which nothing replaces; every test in `loopback-peer.test.ts` injects the uid and byte order, and every flow in `oauth.test.ts` injects its platform and table lookup, so none depends on the machine running it.
    - **A read error no longer lets a request through.** Before, any failure to read a table counted as "no row", so another user who held the process at its open-file limit (connections to the listener, which had no cap) made every lookup fail and could take the start address. Now only `ENOENT`, `EACCES` or `EPERM` hide a table; `EMFILE`, `ENFILE`, `ENOMEM`, `EIO`, any other error, a table over 4 MiB, a lookup over 2 seconds or a table or row in a layout it doesn't know refuse the request, with nothing disclosed, the address unused and the attempt untouched, so the browser's retry works. The tables are opened once when the listener starts, before the opener gets the port, read again from offset 0 for each request (seq_file supports `pread`), one lookup at a time, and closed with the attempt; a table that failed to open is opened again at the next lookup. On every platform the listener serves at most 8 connections at once (a browser's 6 per host, plus 2 for a retry) and closes a connection that hasn't sent its whole request within 10 seconds (checked each second); answering a request isn't timed.
    - **A client that leaves before its answer** no longer uses up the start address: the address is spent only if the request wasn't aborted and its socket is still writable, in the same turn.
    - **`nobody` where every uid is mapped.** When `/proc/self/uid_map` is the initial user namespace's single line `0 0 4294967295` (user_namespaces(7)), a row with the overflow uid is the real account and is refused as another user; with any other map, or none readable, it stays unproven and goes through.
    - **The preflight reads the keychain only when a saved record needs the key**, so a first secure sign-in runs no keychain tool (no PowerShell run on Windows, no unlock prompt) before the browser; the refusal with saved records is unchanged.
    - Pinned: the reader through a scripted `/proc` (`loopback-peer.test.ts`), and the real listener through the reader's file seam for each failure on each table, for the start address and the callback alike, plus the cap, the timeouts and the leaving client (`oauth.test.ts`, "the start address"); the preflight on darwin, linux and win32 (`credential-store-failures.test.ts`). **Still never run on a real Linux kernel.**
    - Recorded by the re-review, not changed: any root-owned local relay passes the owner check by design, not only WSL's forwarder; the cross-process window between taking the key and writing the record in `saveSignIn` predates this work; a Windows browser that the opener launches fresh inherits `STUDIO_OPEN_URL`, which holds only the one-time start address and is visible only to the same user and administrators.
  - A `.vault` record that no listed registration owns doesn't stop a new key being made, because no sign-out could ever remove it (pinned in `credential-store-failures.test.ts`).
  - **R2, "nothing saved" is not trusted while saved sign-ins exist** (`packages/agent/node/chatgpt/credential-broker.ts`, every platform). A keychain that has no key for records it should open gives `vault-key-unreadable`: the record and the signed-in state are kept, a new "Secure storage" save is refused without writing a key, "This app session" still works when chosen, the kept record opens again once the keychain answers, and a new key is made only after every saved registration (one Studio lists) is signed out. A record that fails to open with a readable key is still cleared. Pinned through the real store and its process seam on darwin, linux and win32 in `node/chatgpt/tests/credential-store-failures.test.ts`, after a characterization run showed the old behavior: record cleared, registration flipped to `needs-sign-in`, and the next secure save replacing the key so the other saved registration was lost too.
  - Also: a timed-out keychain tool is reported as such (`SecureStorageError.timedOut`), the acceptance runner takes the keychain kind from the store, `/chatgpt` tells Linux users what keeping a sign-in needs, the README's Windows cleanup names the run's own service, and its manual Linux check records what a dismissed unlock prompt returns and that nothing is cleared or overwritten.
- **Remaining live, per platform (C1-C6):** the two native test files (the vault file's lost-key test now expects `vault-key-unreadable`, a kept record and a new key only after sign-out); the manual Linux lock check, now also confirming R2 and R4; on Linux, the listener's owner check (a same-user browser, Snap or Flatpak included, accepted; a second local account refused, and its eight held connections neither served past the cap nor using the address up; the tables kept open and re-read, and `Max open files` recorded for the Desktop main process, the CLI and the `studio ui` server; WSL2 in NAT and in mirrored networking mode), per the README; a real browser following the local `302` with ChatGPT's page loading without a `Referer`; on macOS, a secure sign-in whose preflight keychain read is cancelled at its prompt (saved records present); G3's `saved` and `session` scenarios with that platform's keychain, GUI and headless separately; browser sign-in on the platform, now through the start address (a real browser following the local redirect, on each OS). Status `offline-tested`. **No platform cell is qualified and no live gate is passed by this record.**

## D. Studio tool inventory (counted from code)

Read at `4ae1e38da` in the primary checkout. The registry is identical at `ce4eea5dc`: `git diff 4ae1e38da ce4eea5dc` shows no change to `tools/index.ts` or `runtime/index.ts`; `host.ts` differs only in an added optional `options` argument on `sites.wpCli` (abort signal and pre-spawn check).

### D.1 How the set is assembled

- `studioToolDefinitions` in `packages/agent/node/tools/index.ts` lists **29** Studio tools.
- `resolveStudioTools(host, options)` removes or substitutes some of them (D.2).
- The Pi runtime (`buildAgentTools` in `packages/agent/node/runtime/index.ts`) adds three tools conditionally and seven file/shell tools: **up to 39** tools in total (29 + 3 + 7). The count of 29 in the plans equals the Studio-tool list only; it excludes the ten runtime-bound tools.
- The MCP server (`apps/cli/ai/runtimes/mcp/index.ts`) also calls `agent.tools(...)` and adds `present_design_options` and `studio_instructions`, which are outside this count and are not listed in D.3.
- The registry does not branch on the session target. The session records `activeEnvironment: 'local' | 'live'` and `lastSelectedWpcomSiteId` (`packages/agent/protocol/sessions/types.ts`), and a `studio.site_selected` entry carries `siteId`, `remote`, `url`, `wpcomSiteId` (`protocol/sessions/entry-types.ts`). `resolveStudioTools` and `buildAgentTools` do not read them, and `ToolContext` holds only the host and a progress callback (`tools/define-tool.ts`). The active site reaches the Pi runtime only as `config.activeSite` (`SiteInfo`, `node/types.ts`), which the runtime uses in two places: the system prompt's "Active site" section (`buildActiveSiteSection`, which appends the remote-site runbook when `site.remote`), and result notes, enabled only for a non-remote site (`runtime/index.ts`, near line 675). No tool handler receives the target. Each tool takes its target as an argument. How each tool behaves in a global, local-site and live-site conversation is in D.4.
- "Global" is a conversation placement (a chat not tied to a site), tested by `node/sessions/tests/placement.test.ts`; M1 did not run it.
- The host contexts that do change the set: Studio UI attached (`host.ui`), the caller can ask the user (`onAskUser` / `canAskUser`), image generation configured, WordPress.com requests allowed, vision-capable model.

### D.2 Gates in `resolveStudioTools` and `buildAgentTools`

| Gate | Effect |
| --- | --- |
| `options.imageGeneration` falsy | `generate_images` is left out (and its prompt sections, per code comment) |
| `options.wpcomRequest === false` | `wpcom_request` left out. Set by the MCP server for Codex clients only. |
| `host.ui` absent | `refresh_browser` left out |
| `visionEnabled` | `take_screenshot` and `inspect_design` are rebuilt with vision on or off; `take_screenshot` also depends on `imageLink` and `host.ui` for whether the user sees the capture |
| `canAskUser` or `tracks` | `pick_design` is rebuilt so it can offer choices |
| `host.ui` present | Results are wrapped so chat artifacts are emitted to the UI |
| `config.onAskUser` set | `AskUserQuestion` is added |
| `config.onAskUser` and `host.ui` | `present_design_options` is added (Pi runtime). The MCP server adds it separately. |
| skills discovered | `Skill` is added; absent when no skills load |

### D.3 Registered tools, gates and Claude status

Annotation class: RO read-only, RR remote read, LC local change, LO local overwrite/destructive, RC remote change, RO-W remote overwrite/destructive (`define-tool.ts`). Claude status values: `bridged` (reachable through the Studio MCP bridge), `native` (a vendor-runtime equivalent is configured), `not yet` (not enabled; owner shown). Today the Claude runtime enables native `Read` and the bridged `wp_cli` only.

| # | Registered name | Origin | Gate (UI / host) | Class | Claude status at `ce4eea5dc` |
| --- | --- | --- | --- | --- | --- |
| 1 | `site_create` | Studio | always | LC | not yet: C2 |
| 2 | `site_list` | Studio | always | RR | not yet: C2 |
| 3 | `site_info` | Studio | always | RO | not yet: C2 |
| 4 | `site_start` | Studio | always | LC | not yet: C2 |
| 5 | `site_stop` | Studio | always | LC | not yet: C2 |
| 6 | `site_delete` | Studio | always | LO | not yet: C1 (approval policy), C2 |
| 7 | `preview_create` | Studio | always | RC | not yet: C2 |
| 8 | `preview_list` | Studio | always | RO | not yet: C2 |
| 9 | `preview_update` | Studio | always | RO-W | not yet: C1, C2 |
| 10 | `preview_delete` | Studio | always | RO-W | not yet: C1, C2 |
| 11 | `wp_cli` | Studio | always | RO-W | bridged, restricted: only `option get` of four named options, `post list`, `post get <id>`, and `post create` as draft with title (and optional content) after user approval (`classify` in `tool-bridge.ts`). Everything else is denied. Broader coverage: C1, C2. |
| 12 | `scaffold_theme` | Studio | always | LC | not yet: C2 |
| 13 | `pick_design` | Studio | rebuilt when `canAskUser` or `tracks` | RO | not yet: C2, C3 |
| 14 | `validate_blocks` | Studio | always | LO | not yet: C2 |
| 15 | `take_screenshot` | Studio | variant by vision, `imageLink`, `host.ui` | LC | not yet: C2, C3 (image result) |
| 16 | `inspect_design` | Studio | variant by vision | RO | not yet: C2, C3 |
| 17 | `generate_images` | Studio | only when `imageGeneration` is set | RC | not yet: C2 (see section G) |
| 18 | `install_taxonomy_scripts` | Studio | always | LC | not yet: C2 |
| 19 | `need_for_speed` | Studio | always | RO | not yet: C2 |
| 20 | `rank_me_up` | Studio | always | RO | not yet: C2 |
| 21 | `site_connected_remote_sites` | Studio | always | RR | not yet: C2 |
| 22 | `wpcom_request` | Studio | unless `wpcomRequest === false` | RO-W | not yet: C1 (remote policy), C2 |
| 23 | `site_push` | Studio | always | RO-W | not yet: C1, C2 |
| 24 | `site_pull` | Studio | always | RO-W | not yet: C1, C2 |
| 25 | `site_import` | Studio | always | LO | not yet: C1, C2 |
| 26 | `site_export` | Studio | always | LO | not yet: C2 |
| 27 | `open_annotation_browser` | Studio | always | LC | not yet: C2, C3 |
| 28 | `refresh_browser` | Studio | only when `host.ui` is present | RO | not yet: C3 |
| 29 | `send_feedback` | Studio | always | RC | not yet: C1 (external message), C2 |
| 30 | `AskUserQuestion` | Runtime | only when `onAskUser` | RO | not yet: C3 (native equivalent or bridge to be decided) |
| 31 | `present_design_options` | Runtime | `onAskUser` and `host.ui` (Pi runtime) | LC | not yet: C3 |
| 32 | `Skill` | Runtime | only when skills are found | RO | not yet: C2, C3 (guidance) |
| 33 | `Read` | Pi file tool | always | n/a | native: configured as the one native tool on Claude |
| 34 | `Write` | Pi file tool | always (with design-system preview wrapper) | n/a | not yet: C1, C2 |
| 35 | `Edit` | Pi file tool | always (same wrapper) | n/a | not yet: C1, C2 |
| 36 | `Bash` | Pi file tool | always (provider secrets removed from spawn env) | n/a | not yet: C1 (bounded approval), C2, P2 |
| 37 | `Grep` | Pi file tool | always | n/a | not yet: C2 |
| 38 | `Glob` | Pi file tool | always | n/a | not yet: C2 |
| 39 | `Ls` | Pi file tool | always | n/a | not yet: C2 (native equivalent to be determined) |

Counted from code: 29 Studio definitions, 3 runtime-bound conditional, 7 Pi file tools, 39 total possible. For the Claude runtime today: 1 native tool (`Read`) and 1 bridged tool (`wp_cli`, restricted); 37 of 39 are not yet covered. The plan requires every entry mapped to a tested native equivalent or a shared bridge operation with no unexplained exclusions; none of these 37 has that yet, and each has an owning task above.

Acceptance condition for each Claude row, per C2: a contract test and an outcome test that exercise the real tool, with required work settled before successful completion. These do not exist yet (`none yet`).

### D.4 Behavior by conversation target (global, local site, live site)

Established by reading each tool's definition and handler in `packages/agent/node/tools/` at `4ae1e38da`, `apps/cli/ai/host.ts` and `apps/cli/lib/cli-config/sites.ts` (what `host.sites.resolve` does), `node/site-selection.ts`, `node/system-prompt.ts` and `node/runtime/index.ts`. A "live site" is a WordPress.com site selected as the target (`SiteInfo.remote === true`). Codes:

- **Arg-local**: the handler resolves a local Studio site from a `nameOrPath` argument via `host.sites.resolve`, which looks in the CLI site registry by name, by folder name, then by path, and otherwise throws "The specified directory is not added to Studio" (`apps/cli/ai/host.ts`, `cli-config/sites.ts`). Works in any conversation that names a registered local site. It does not use the selected target. With a live site selected, the model must name a local site; a remote name or URL fails to resolve. Result for a live-site target: not applicable (the tool is not a live-site channel); what the model does instead is steered by the prompt only.
- **Arg-global**: needs no selected site. The target is in the arguments or none is needed.
- **Live channel**: the tool addresses a WordPress.com site by an argument (`siteId`, `remoteSite`).

| Tool | Global (no site selected) | Local site selected | Live site selected | Read in |
| --- | --- | --- | --- | --- |
| `site_create` | works; creates a new site under `sitesRoot`; the host's `selectSite` callback may then make it the conversation site | works (creates another site; target not read) | works the same; target not read | `create-site.ts` |
| `site_list` | works; it lists WordPress.com sites using the stored auth token, or reports not signed in | same | same | `list-sites.ts` |
| `site_info`, `site_start`, `site_stop`, `site_delete`, `preview_create`, `preview_list`, `preview_update`, `wp_cli`, `scaffold_theme`, `validate_blocks`, `install_taxonomy_scripts`, `need_for_speed`, `rank_me_up`, `site_import`, `site_export` | Arg-local: works when the model names a registered local site | Arg-local: works; no check that the named site equals the selected site | Arg-local: a remote target cannot be named; no local effect unless the model names a different local site; nothing in code stops it | each tool's file, `nameOrPath` and `host.sites.resolve` |
| `site_connected_remote_sites`, `site_push`, `site_pull` | Arg-local for the local site plus a WordPress.com token and, for push/pull, a `remoteSite` argument (Live channel for the remote side) | same | same; the selected live site is not passed to the tool | `list-connected-remote-sites.ts`, `push-site.ts`, `pull-site.ts` |
| `preview_delete` | Arg-global: takes a preview hostname | same | same | `delete-preview.ts` |
| `wpcom_request` | Live channel: works without a selected site because `siteId` is an argument; needs a stored token | same | the intended live-site channel (the prompt comment in `system-prompt.ts` says a WordPress.com site "changes only through wpcom_request"); `siteId` is still the model's argument, not taken from the selection | `wpcom-request.ts`, `system-prompt.ts` |
| `take_screenshot`, `inspect_design`, `open_annotation_browser` | Arg-global: take a URL; `themeScreenshot` is confined under `sitesRoot` | same | same; a live URL is only reached if the model passes it. Not tested here | `take-screenshot.ts`, `inspect-design.ts`, `open-annotation-browser.ts` |
| `generate_images` | Arg-global for the service; the handler finds the local site that contains the given file paths and throws if none (`findSiteContaining`) | same | same; images land in a local site, not a live one | `generate-images.ts` |
| `pick_design`, `AskUserQuestion`, `present_design_options`, `Skill`, `send_feedback` | Arg-global; no site involved | same | same | `pick-design.ts`, `ask-user-question.ts`, `present-design-options.ts`, `skill.ts`, `send-feedback.ts` |
| `refresh_browser` | needs `host.ui`; reloads the preview the app shows; no site argument | same | same; what the app's preview shows for a live site is not decided in this package | `refresh-browser.ts` |
| `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `Ls` | rooted at `host.sitesRoot` (all local sites), not at a selected site | same | same; a live site has no local files here | `runtime/index.ts` (`buildAgentTools`, `sitesRoot`) |

What this means, and what is not established:

1. The Pi tool set is the same in all three targets. Differences come from the prompt (the "Active site" section and, for a live site, the remote runbook) and from the model's arguments. The code does not enforce that a tool's target equals the selected target. For Claude that enforcement is the C1 contract.
2. Not established from reading: runtime behavior of each Arg-local tool when the selected target is a live site and the model passes a local site anyway; how the Desktop and `studio ui` apps resolve a live-site selection into `activeSite`. These need runtime outcomes, not code reading.
3. Claude at `ce4eea5dc`: the bridge is bound to a single local site per run (`siteId`, `workingDirectory` in `ClaudeToolPolicy`, checked against the resolved site's real path in `tool-bridge.ts`), and `createClaudeSession` takes one local site (`studio-surface.ts`). Global conversations and live-site targets are not supported there yet. Owner for the target contract: C1.

Open gates for the environment dimension are listed in section H (E1 to E3).

## E. Vendor decisions

Claude distribution, authentication and branding. This is **unresolved and blocking for PR #3**. The decision belongs to the repository owner and Anthropic; M1 does not make it and sends nothing. A clarification-request draft is in [claude-distribution-clarification-draft.md](claude-distribution-clarification-draft.md). It has not been sent.

References re-fetched on November 11, 2026:

| Reference | What it says today (paraphrase unless quoted) | Date checked |
| --- | --- | --- |
| [Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart) | A note states: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." It directs developers to API key authentication. The page also lists third-party cloud provider authentication. | 2026-11-11 |
| [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) | Under authentication: developers building products that use the Agent SDK should use API-key authentication; Anthropic does not permit third-party developers to offer Claude.ai login in their own applications or to route requests through subscription plan credentials for their users; developers may not collect, store or intermediate Claude.ai credentials or session tokens. It then states that this does not prevent an end user from signing in to the *unmodified* Claude Code binary with their own subscription, including where a platform hosts Claude Code. The "customers offering Claude Code in their products" section requires: unmodified binary, no removal of its authentication methods, no paying for or reselling usage, each end user authenticating with their own credentials, acceptance of the Commercial Terms, and no use of Claude Code or Anthropic names or logos as part of the product or feature name or in a way suggesting endorsement. It also says that unless the parties have agreed otherwise these conditions apply. | 2026-11-11 |
| [Setup](https://code.claude.com/docs/en/setup) | Supported: macOS 13+, Windows 10 1809+ or Server 2019+, Ubuntu 20.04+, Debian 10+, Alpine 3.19+; x64 and ARM64; 4 GB RAM. Releases publish a `manifest.json` with SHA256 checksums signed with an Anthropic GPG key (signatures from 2.1.89 onward). macOS and Windows binaries carry code signatures; Linux binaries are not individually code-signed (verify through the manifest or package repository). | 2026-11-11 |
| [ChatGPT inference route](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) | Fetch the account's model catalog and keep entries whose visibility is `list`. Requests use the Responses API with `store: false` and `stream: true`. This page does not list models, efforts, tools or image behavior. | 2026-11-11 |
| [ChatGPT route limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) | Hosted image generation, file search, code interpreter, native computer use, hosted MCP/connectors and `tool_search` are unsupported. Web search is supported subject to policy. Image inputs are supported when the model accepts them. Function/custom tools must be namespaced or passed as `additional_tools`. `store: false` and `stream: true` required; many sampling and output-cap parameters unsupported; `previous_response_id` not supported over HTTP. Rate limits are not mentioned. The page is titled as preview limitations. | 2026-11-11 |

The pages were retrieved through a summarizing fetch tool. The wording above is the tool's rendering, not a byte-exact copy; the one quoted sentence matches the quickstart text returned.

| ID | Decision | Status | Blocks | Next step |
| --- | --- | --- | --- | --- |
| V1 | Whether Studio may offer a Claude subscription sign-in (the end user signs in to the unmodified native runtime, Studio does not touch credentials) under the SDK quickstart note "unless previously approved" and the legal page's carve-out for end users of the unmodified binary | **unresolved**. No approval, exemption or written clarification is recorded. M1 does not infer an exemption. | PR #3 readiness (M4) | Repository owner reviews the draft; sending it is a separate user-authorized action |
| V2 | Branding: how the feature, settings text and PR may name Claude, Claude Code and Anthropic given the legal page's naming limits | **unresolved**. Not reviewed against actual UI strings by M1. | PR #3 readiness | Review UI strings (owner: C3/M3) against the legal page once the decision is made |
| V3 | Whether hosting the runtime path through Studio counts as "offering Claude Code in a product" (Commercial Terms acceptance, billing statements) | **unresolved** | PR #3 readiness | Included in the clarification draft |
| V4 | ChatGPT subscription route: stated limits and "preview" status of the vendor pages | **recorded, not a blocker by itself.** The spec says to qualify the actual route. Recheck when executing G2. | none identified at M1 | G2 records the route-qualified capabilities |

If V1 stays unresolved, PR #3 remains blocked independently of PR #2, and it is not converted to an API-key provider (spec).

## F. Qlty findings

Both PRs report a Qlty commit status of `success` whose description states the number of blocking issues.

| PR | Head SHA | Status description (`gh api repos/henryperkins/studio/commits/<sha>/status`) | Status link |
| --- | --- | --- | --- |
| #2 | `4ae1e38da` | "28 blocking issues" | `https://qlty.sh/gh/henryperkins/projects/studio/pull/2/issues` |
| #3 | `ce4eea5dc` | "40 blocking issues" | `https://qlty.sh/gh/henryperkins/projects/studio/pull/3/issues` |

**Gate Q1: Qlty finding details are not retrievable without a login. Unresolved.** What was tried (read-only):

1. `gh pr view 2` and `gh pr view 3` with `statusCheckRollup`: Qlty appears as a status context only; it is not a check run.
2. `gh api repos/henryperkins/studio/commits/<sha>/check-runs` for both SHAs: PR #2 returned two check runs (Sourcery review, skipped; CodeRabbit, skipped); PR #3 returned one (CodeRabbit, skipped). No Qlty check run and no annotations (`annotations_count` 0).
3. PR issue comments and review comments for both PRs, filtered for a Qlty author: none.
4. An unauthenticated HTTP GET of each status link: HTTP 302 redirect to `https://qlty.sh/login?returnTo=...`; the body is a login page.

Result: no finding ID, rule, file or line could be seen. M1 invents none. The counts 28 and 40 are quoted from the status descriptions only; whether they are cumulative, per-SHA, or include inherited trunk issues is not known.

Classification table (introduced / inherited / duplicate / false positive). Empty rows because there is nothing visible to classify:

| Finding ID | PR | Classification | Rationale | Action |
| --- | --- | --- | --- | --- |
| none retrievable | | | | Open gate Q1 |

To close Q1: the repository owner signs in to Qlty (or supplies an export of the issue list for each PR), then each finding is classified by comparing it with `trunk`. Real blockers are fixed in scoped commits. Suppression requires a reviewed rationale. Because #3 contains #2, some of the 40 may duplicate the 28 on #3; that is not confirmed.

Other review and CI state observed (read-only, not a substitute for Qlty triage):

- The repository's workflows (`gh workflow list`, `.github/workflows`) are: auto-assign, PHP CLI binary build and version check, Dependabot auto-merge, repo gardening, npm package publish, plugin publish, stale-PR notification. There is **no pull-request test, typecheck, lint or build workflow**. Both PRs therefore have no green automated test/build check; the Qlty status is the only passing status context.
- Codex review on PR #2 reported "Failed" at an earlier commit and later usage-limit messages. Sourcery reported a rate limit; CodeRabbit paused. Bot review comments exist from other tools (CodeRabbit, a review bot named Mergestorm, Amazon Q); M1 did not triage them. For PR #3, one Amazon Q review lists several "critical findings" (for example an auth identity comparison in `auth-status.ts`); M1 did not verify them against `ce4eea5dc`. These need triage under M3 and are not assumed resolved.

## G. Image-generation service boundary (recorded only)

From the spec: image generation remains Studio's existing, separately authenticated WordPress.com image service (`generate_images`, `packages/agent/node/image-generation.ts` path). Both providers must expose it consistently only when that service is explicitly configured, identify the service and account in the product, and explain its absence otherwise. Subscription credentials must never be reused for it. This is application parity with an optional dependency, not a claim that either subscription funds image generation. The ChatGPT route does not support hosted image generation (section E, route limitations).

Code state: `generate_images` is registered only when `options.imageGeneration` is true (`resolveStudioTools`); the legacy-provider behavior is that when it is off, no tool and no imagery prompt sections are present.

Not done by M1, and not claimed: the user-visible service/account indication. Owner: **G2** for ChatGPT (Settings/composer indication and execution metadata) and **C2/C3** for Claude. Status: ChatGPT `offline-tested` (G2 record, second half, section A; visual check pending); Claude `not started`. Acceptance condition: with the service configured, the tool is offered and the product names the service and account; without it, the tool and its guidance are absent and the UI explains how to set it up; the ChatGPT or Claude conversation's own account indicator is unchanged. Legacy-provider behavior is preserved.

## H. Remaining M1 gates and who owns them

| Gate | State | Owner |
| --- | --- | --- |
| Q1: Qlty details unavailable without login | open | Repository owner provides access; then M3 |
| V1-V3: Claude distribution, authentication and branding decision | open | Repository owner and Anthropic |
| Runners for five platform cells (C2-C6, C8-C12) | open: no runner assigned | Program scheduling |
| Live-run consent for both accounts | open: to be requested once runners exist | Account owner |
| Session-only ChatGPT failure cause | open (code only `assertion-failed` retained) | G1 |
| All capability rows with `none yet` evidence | open | Owners in sections A, B, D |
| PR test/build CI workflow absent | open | M2 |
| E1: Claude target contract for global, local-site and live-site conversations (today one local site per run; no global or live target) | open | C1. Acceptance: tests for global chat and site creation, explicit local/live target change, changed target after send; a tool call whose target differs from the selected target is refused before execution. |
| E2: Per-tool outcome evidence for each target on each provider, covering the Arg-local tools with a live site selected, `wpcom_request` as the live channel with a disposable staging site, and global-chat tools | open: not established from code (D.4 item 2) | ChatGPT: G4. Claude: C5. Acceptance: a recorded run per provider, bound to the candidate SHA, using designated disposable local and staging targets only, with the observed target for each tool call. |
| E3: How Desktop and `studio ui` resolve a live-site selection into `activeSite` and the "Active site" prompt text | open: not read by M1 | G4 for ChatGPT surfaces, C3 for Claude surfaces. Acceptance: a Desktop and a `studio ui` run with a live site selected shows the expected prompt section and remote-site tool use. |
| T1: ChatGPT route: image tool results (screenshots) are an inference, not sourced (A, G2 record) | open | G4. Acceptance: a live turn on the ChatGPT route returns a screenshot (image) tool result and the model's next response demonstrably uses it; if the route rejects image tool outputs, the capability flag is split so image tool results are unavailable on this route with a user-facing explanation, and the affected tests are inverted. |
| T2: ChatGPT route: encrypted-reasoning replay never observed (A, G2 record) | open: no captured turn has produced a reasoning item | G4. Acceptance: the live smoke includes a turn that produces a reasoning item, and the following request replays it and is accepted. |
