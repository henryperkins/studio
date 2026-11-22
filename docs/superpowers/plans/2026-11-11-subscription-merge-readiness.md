# Subscription Providers Merge-Readiness Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to execute the linked workstreams task-by-task. Checkboxes below are future work, not completion claims.

**Goal:** Make ChatGPT PR #2 and Claude PR #3 merge-ready with full Studio workflow parity across Windows, macOS and Linux, on x64 and ARM64.

**Architecture:** Retain direct ChatGPT OAuth on Pi and the independent official Claude runtime. Extend shared Studio contracts where needed, keep host wrappers thin, and qualify each provider independently before integrating the stacked branch.

**Tech Stack:** Existing TypeScript/npm workspaces, React/Electron, Pi, Claude Agent SDK, Vitest, Playwright, native OS credential/process services and repository packaging scripts.

**Spec:** [Subscription provider parity and platform scope](../specs/2026-11-11-subscription-provider-parity.md), supplementing the November 8 design and implementation plans.

## Global constraints

- Work in `henryperkins/studio`; preserve the original Automattic remote and unrelated dirty/untracked work.
- Keep `STUDIO_EXPERIMENTAL_CHATGPT` and `STUDIO_EXPERIMENTAL_CLAUDE_CODE` off by default until qualification is complete; merging does not itself enable or release them.
- No implicit account/provider/billing fallback; no Claude token-file parsing or modified vendor binaries.
- Preserve config locking, UI theme tokens, runtime i18n, both connectors, CLI-owned site operations and capability-gated tools/prompts.
- After code changes run modified-file `npx eslint --fix`, `npm run typecheck` and relevant tests. UI changes require Desktop and browser checks in light and dark. Build the CLI before testing commands; restart Electron fully after main/IPC changes.
- Agent-facing tool/prompt/result/skill changes require updated eval assertions and affected eval runs; system-prompt changes require the full applicable suite.
- Live acceptance requires the account owner's local consent and a recorded disposable-test scope. Reuse existing authorization only where it clearly covers the same account, platform and operations. Do not request it repeatedly or treat elapsed time as consent.

## Review focus

1. Native tool and shell paths must not bypass Studio's approval, target or execution guards (Claude tasks C1-C3).
2. Delayed refresh, sign-out, compaction or queued writes must not resurrect an account or repeat effects (ChatGPT tasks G1-G3).
3. Stale locks, PID reuse and reconnect events must not resume the wrong conversation or revive old approvals (Claude task C4).
4. OS-specific path case, environment, keychain and process behavior must not be inferred from Windows mocks (platform tasks P1-P3).
5. Green status icons, old binaries, synthetic UI data and another provider's evals must not stand in for final-candidate evidence (tasks M1-M4).

## Starting point and evidence

Assessment baseline on November 11:

| Item | Observed state |
| --- | --- |
| ChatGPT | `add-chatgpt-plan-provider`, `4ae1e38da8af219f4289ab8710f6a756393a01a2`, draft [PR #2](https://github.com/henryperkins/studio/pull/2), base `trunk`. |
| Claude | `add-claude-code-runtime`, `ce4eea5dc44de1be7f1cdf7abb81052909cabe2e`, draft [PR #3](https://github.com/henryperkins/studio/pull/3), based on PR #2. Worktree: `C:/Users/htper/.codex/worktrees/add-claude-runtime/studio`. |
| ChatGPT live | Saved-account draft/readback, effort change, restart/resume and sign-out passed in retained evidence. Session-only acceptance failed at sign-in; its underlying safe failure code was not retained. |
| Claude live | Native startup/lifecycle and packaging evidence exists; authenticated Studio workflow acceptance remains open. Current bridge is only native Read plus selected WP reads/draft creation. |
| Fresh focused checks | ChatGPT 326 backend/CLI tests and a separate 50-test surface run passed; Claude 140 tests passed with six opt-in native cases skipped. These counts overlap in places and are not a full-suite total. ChatGPT-branch typecheck passed. |
| Review | Qlty descriptions report 28 blockers on #2 and 40 on #3 despite successful statuses; details still need triage. No PR test/build workflow evidence was returned. |

The three existing modified documentation files in the primary checkout and `.playwright-cli/` in the Claude worktree predate this plan. Preserve them. The primary checkout's Claude completion notes lag the actual Claude worktree. Revalidate all refs and statuses before execution.

## Workstreams and sequence

1. **M1 first:** record the parity matrix, review baseline and vendor decisions; make test resources and platform owners explicit.
2. **ChatGPT:** [G1-G4 completion and parity](2026-11-11-chatgpt-parity.md).
3. **Claude:** [C1-C5 full parity](2026-11-11-claude-parity.md), in its existing worktree. C1 establishes contracts before C2/C3 tool and UI work.
4. **Platforms:** [P1-P4 native support and qualification](2026-11-11-subscription-platform-qualification.md). Platform code can proceed in parallel with provider feature work; final qualification waits for the candidate.
5. **M2-M4:** shared regression/eval CI, independent review, evidence reconciliation and readiness decision. PR #2 can finish independently when all of its capability/platform gates pass. PR #3 must include the final #2 fixes and pass its own gates.

Assign separate owners to ChatGPT files, Claude runtime/tool files, UI/protocol files and platform files. Shared-file changes require an explicit handoff; workers must preserve one another's edits. Stage reviewed paths only and use small descriptive commits. Merge updated parent branches rather than rebasing published branches.

### M1: Establish the capability, review and vendor gate records

**Files:** Create `docs/superpowers/evidence/subscription-readiness.md`; update the new parity spec only for recorded decisions. Inspect `packages/agent/node/tools/index.ts`, `runtime/index.ts`, `host.ts`, the original plans and `.github/PULL_REQUEST_TEMPLATE.md`.

**Interface:** The ledger maps each spec capability and each platform cell to provider, owner, implementation status, exact test/eval, source SHA and evidence link. It separately lists vendor decisions and Qlty finding IDs.

- [ ] Capture remote/local SHAs, branch bases, dirty-work ownership and the exact existing evidence provenance; preserve failures as well as successes.
- [ ] Enumerate the canonical Studio registry and runtime-specific tools under global/local/live and UI/non-UI host contexts. Map every entry to a tested native equivalent or shared bridge operation; no unexplained exclusions.
- [ ] Retrieve Qlty details and classify each finding as introduced, inherited, duplicate or false positive. Fix real blockers in scoped commits; suppress only with an explicit reviewed rationale. A missing Qlty login is a named unresolved gate.
- [ ] Record the Claude distribution/authentication/branding decision against current primary references. Prepare any clarification request as a reviewable draft; sending it is a separate user-authorized action. Resolve the decision before marking #3 ready.
- [ ] Record the image-generation service boundary from the spec and add a user-visible service/account indication before enabling that tool for a subscription conversation. Preserve existing legacy-provider behavior.
- [ ] Assign native runners for all six platform cells and test accounts/quota. Unavailable hardware is a scheduling blocker, not permission to drop a cell.

**Exit:** Every required capability and platform has an owner and an observable acceptance condition; no assumed vendor exemption or hidden scope reduction.

### M2: Make regression and agent-eval coverage provider-specific

**Files:** Modify `apps/cli/ai/eval-runner-entry.ts`, `eval-runner.ts`, `eval-outcome.ts`, their tests, `scripts/eval/promptfoo.config.yaml`, `outcome.mjs`, tests and README as required. Add `scripts/eval/subscription-parity.config.yaml` and `.github/workflows/subscription-provider-checks.yml`.

**Interfaces:** Keep the existing eval runner's default behavior unchanged. Add an explicit provider selection to the subscription harness/config; `model` alone never selects billing or runtime. Reuse the development-only acceptance runners defined in G3/C5. Provider runs must emit the provider/connection/backend actually executed and deterministic final-state assertions.

- [ ] Add offline regressions proving a ChatGPT eval cannot resolve a global API-key provider and a Claude eval cannot enter Pi merely because its model name contains `claude`.
- [ ] Cover identity/instructions/skills, site creation and target selection, file/theme work, questions, preview/screenshot, annotation, artifacts, pending work, attachment replay, approvals, cancellation and resumed conversations for each provider. Reuse existing outcome capture/assertions; extend capture where the user-visible outcome is missing.
- [ ] Keep destructive remote operations mocked in automatic CI; qualify the real connector only on explicitly designated disposable staging resources.
- [ ] Run affected evals for each agent-facing change. Run all applicable parity cases after prompt/tool expansion; run the full original suite if the shared system prompt changes. A legacy-provider eval pass is regression evidence only.
- [ ] Add credential-free PR CI using `.nvmrc` (currently `24.22.1`), the repository's npm version and pinned action SHAs. Run changed-file lint without `--fix`, typecheck, Knip, dependency-range tests, unit/integration tests and CLI/UI builds. Exercise both default-off and test-isolated enabled routing.
- [ ] Keep account-backed evals, native keychain tests and vendor sign-in off public PR runners. Use controlled opt-in runs and sanitized evidence. No account credentials in workflow secrets for untrusted PR code.

**Exit:** CI covers the final revision; provider-qualified eval reports identify the actual route and pass outcome assertions. Required checks are green, not merely absent.

### M3: Review and qualify final candidates

**Files:** Provider/platform files touched by findings; the evidence ledger and existing behavior/implementation documents.

- [ ] Complete independent reviews of credential lifecycle, execution guards/tool equivalence, event/session recovery and platform/package behavior. Review all new boundaries, not just lines changed after the PoC.
- [ ] Run modified-file ESLint, typecheck, Knip, `npm test` and targeted native/eval gates on each candidate. Reproduce unrelated failures on the unchanged base; resolve blocking failures or a documented reviewer-approved false positive before readiness. Focused passes do not waive the full-suite gate.
- [ ] Complete P4 native package and light/dark evidence. Record source/build SHA, runtime/SDK versions, OS/architecture, artifact hash, execution result and whether the artifact is signed. A previous Windows package does not qualify new code or another platform.
- [ ] Reconcile documentation, parity matrix and PR descriptions with the results. Identify optional service dependencies and genuine vendor limitations without advertising incomplete required features as parity.
- [ ] Any fix invalidates affected downstream evidence. Rerun those checks; rebuild when shipped bytes change. Distinguish a later documentation-only commit from the tested code/build SHA explicitly.

**Exit:** No unresolved security/correctness/quality blockers, no missing required capability or platform cells, and all mandatory checks tied to the candidate.

### M4: Finish the stack without conflating readiness and publication

**Files:** `.github/PULL_REQUEST_TEMPLATE.md` is the required structure; update PR bodies and the evidence ledger during authorized publication.

- [ ] Prepare #2's template-compliant body with current live evidence, full parity/platform results and reviewed limitations. Verify local/tracking/remote parity after any authorized push.
- [ ] Mark #2 ready only after all ChatGPT gates pass. Keep #3 draft if its vendor, feature or platform gates remain open.
- [ ] Merge the final #2 branch into #3 and rerun affected shared regressions. Do not force-push or lose the existing stack history.
- [ ] After an explicitly authorized #2 merge, retarget #3 to `trunk`, inspect its remaining diff and rerun final integration checks. A planned merge is not execution authorization.
- [ ] Mark #3 ready only after all Claude gates, including the distribution decision, pass. Remove the Proof of Concept status only when the reviewer accepts the complete implementation and evidence.

**Done means:** Each PR is independently reviewable against its actual base, all required checks pass, the complete capability/platform matrix is supported by evidence, and the remaining action is maintainer review/authorized merge. Default enablement and public release remain separate.
