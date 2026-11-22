# Subscription provider parity and platform scope

**Status:** Planning only, November 11, 2026. The user explicitly selected **full feature parity and broader platforms** over completing the existing Windows x64 proofs of concept.

**Goal:** Make both subscription-provider PRs reviewable and merge-ready with Studio workflow parity, native platform support, reproducible qualification and resolved distribution constraints.

This supplements `2026-11-08-subscription-connections-design.md`. Its Windows-only and restricted-Claude-tool milestones are intermediate checkpoints, not the completion target. Preserve its connection identity, credential ownership, no-fallback, history separation, locking and consent boundaries.

## Definition of parity

Parity means the same Studio workflows as the existing providers under the same host capabilities and optional service configuration. It does not mean identical vendor models, reasoning settings, transcript internals or hosted API products.

| Capability | Required outcome for both providers |
| --- | --- |
| Account lifecycle | Sign-in, cancel, inspect, reconnect, disconnect/sign-out, account-change detection and clear billing-route identity. ChatGPT supports persistent and session-only storage; Claude retains vendor-owned credentials. |
| Conversations | New/global/site conversations, explicit target selection, model/effort changes, queued sends, restart/resume, compaction, cancellation and recoverable crashes. Provider/account switches create a fresh conversation with only reviewed context transfer. |
| File work | Read, search, list, write, edit and shell workflows through the owning runtime, with workspace boundaries and existing safety rules. |
| Studio operations | Every production Studio tool applicable to the current host, including site creation/management, WordPress operations, import/export and sync/preview workflows. Site operations continue through their CLI commands. |
| User interaction | Questions, choices, design alternatives and mutation approvals; reconnect restores only unresolved requests belonging to the current run. |
| Rich results | Text, images/screenshots, attachments, artifacts, progress, background-work completion, preview refresh and annotations reach both the model and the appropriate Studio surface. |
| Guidance | Studio identity, user instructions, skill routing and procedures, with explicit tool-name mapping for the native Claude runtime. |
| Models | Account/runtime discovery intersected with qualified capabilities. Unsupported settings are explained and never silently replaced. |
| Failures | No false successful completion, duplicate tool side effects, paid-API fallback, account substitution, leaked credentials or orphan run processes. |
| Surfaces | Desktop, `studio ui`, interactive CLI and noninteractive CLI. UI-only tools remain gated when no Studio UI is attached, including MCP contexts. |
| Existing providers | WordPress.com, Anthropic API and OpenAI API routing, persisted sessions and settings semantics continue working. |

Image generation remains Studio's existing separately authenticated WordPress.com image service. Both providers must expose it consistently when that service is explicitly configured, identify its service/account in the product, and explain its absence otherwise. Subscription credentials must never be reused for that service. This is application parity with the existing optional dependency, not a claim that either subscription funds image generation.

No new audio/video, hosted computer-use, Responses file-search or hosted-MCP product is implied. Existing Studio file attachments can retain file-tool semantics. A genuinely unsupported required Studio workflow remains an open parity gap; do not quietly relabel it complete or deferred.

## Target platforms

Qualify Desktop, CLI and the local browser backend on all six existing Studio build targets:

| OS | Architectures | Required native evidence |
| --- | --- | --- |
| Windows | x64, ARM64 | Credential Manager, browser callback, native terminal/sign-in, process-tree cleanup, packaged app and standalone CLI. Identify the existing x64 PHP dependency on ARM64 where applicable. |
| macOS | x64, ARM64 | Keychain, browser callback, terminal/sign-in, process cleanup, packaged app and standalone CLI. |
| Linux | x64, ARM64 | Secret Service with an unlocked desktop session, unavailable/locked-store behavior, browser/terminal integration, process cleanup, packaged app and standalone CLI. Cover supported X11/Wayland behavior. |

Use the intersection of Studio's supported OS versions and the qualified vendor runtime's requirements. Record the exact OS/version/libc, runtime and SDK pair. A cross-built installer, container test or mocked `process.platform` is not native execution proof. Headless Linux must support explicit session-only ChatGPT use and clearly report unavailable interactive sign-in/storage capabilities. Native Windows support must not silently depend on WSL.

## Required evidence

For each provider, retain separate, source-SHA-bound records for unit/integration tests, credential-free full-suite and CI checks, real native-process tests, authenticated workflow acceptance, Desktop/browser light-and-dark verification, and installer/standalone-CLI execution.

Every capability row must have an automated contract/outcome test. Every platform cell must have native account lifecycle, authenticated read/draft/readback/resume, cancellation/recovery and package execution evidence. Rich workflow/eval coverage runs for each provider; platform-sensitive cases repeat on every platform. Missing machines, credentials, quota or vendor approval leave named gates open.

Live tests use disposable local sites and dedicated test registrations/configurations. Remote operations use fixtures and explicitly designated disposable staging resources, never production sites. Acceptance may approve only the named test mutation; it must reject unexpected targets, publish operations and unrelated commands. Provider credentials and raw authorization/callback material never enter evidence or CI artifacts.

## Distribution and provider-contract decisions

Resolve the Claude offering/branding decision before declaring PR #3 ready. Default-off alone does not establish permission to offer a subscription integration. Record the intended end-user native-login flow, applicable vendor guidance, and any required clarification/approval. If unresolved, PR #3 stays blocked independently of PR #2; do not silently convert it to an API-key provider.

Primary references checked November 11, 2026; recheck when executing:

- [Claude SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart): third-party products offering Claude.ai login/plan limits require prior approval under the stated SDK guidance.
- [Claude legal and compliance](https://code.claude.com/docs/en/legal-and-compliance): distinguishes third-party credential mediation from end users signing into an unmodified native runtime, and specifies branding conditions. The plan does not infer an exemption for Studio.
- [Claude setup and integrity](https://code.claude.com/docs/en/setup): native platform availability, runtime requirements and manifest/code-signature verification.
- [ChatGPT inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) and [route limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations): qualify the actual subscription route; hosted image generation is unsupported and custom/function tools remain distinct from hosted tools.

## Delivery boundaries

Keep both flags off during implementation and qualification. Default enablement, public release and publishing are separate decisions after readiness; they are not authorized by this planning request. Do not merge, send vendor messages, change production sites or alter account billing while preparing the plan.

The implementation program is coordinated by [the merge-readiness plan](../plans/2026-11-11-subscription-merge-readiness.md).
