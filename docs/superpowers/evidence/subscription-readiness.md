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
| A6 | Rich results: text, images/screenshots, attachments, artifacts, progress, background completion, preview refresh, annotations | G2, G4 | not started. G2 plans real-Pi tests for image/screenshot results; the route's documented image-input support is a vendor statement (section E). | `node/tests/chat-artifacts.test.ts`, `screenshot-helpers.test.ts`, `strip-stale-images.test.ts` (shared); `protocol/tests/chat-images.test.ts`, `composer-attachments.test.ts` | none yet |
| A7 | Guidance: identity, user instructions, skill routing | G4, M2 | not started for the ChatGPT route. The existing eval config uses the legacy provider path. | `node/tests/system-prompt.test.ts`, `global-instructions.test.ts`; `scripts/eval/promptfoo.config.yaml` cases (legacy-provider regression evidence only) | none yet |
| A8 | Models: discovery intersected with qualified capabilities; unsupported settings explained, never silently replaced | G2 | partial. One live discovery recorded (section 2). Capability qualification not started. | `node/chatgpt/tests/models.test.ts`, `protocol/tests/openai-models.test.ts` | Discovery: section 2; qualification: none yet |
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

Not done by M1, and not claimed: the user-visible service/account indication. Owner: **G2** for ChatGPT (Settings/composer indication and execution metadata) and **C2/C3** for Claude. Status: `not started`. Acceptance condition: with the service configured, the tool is offered and the product names the service and account; without it, the tool and its guidance are absent and the UI explains how to set it up; the ChatGPT or Claude conversation's own account indicator is unchanged. Legacy-provider behavior is preserved.

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
