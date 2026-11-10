# Studio subscription connections: proposed design

**Status:** Design and implementation handoff. No application patch, branch, tests, authenticated requests, or deployment was performed in preparing these documents.

**Repository:** `henryperkins/studio`. Source inspected at `8672a64e7daf368051db0b35989dc9dd89523ff9`, the merge of PR #1. Refresh the branch and record the actual base before implementing. Preserve unrelated work and never force-push or modify the upstream Automattic repository.

## Intent and selected approaches

Henry selected direct ChatGPT-plan OAuth while retaining Studio's Pi agent, and the official Claude Code runtime using its own sign-in. Preserve the existing WordPress.com, Anthropic API, and OpenAI API integrations.

The rejected alternatives are Codex App Server for ChatGPT (unneeded for the selected direct route), subscription-token extraction for Claude (not the requested or documented runtime boundary), and running Claude Code as an opaque tool inside a Pi turn (two competing agent loops and misleading session ownership).

## Boundaries

- `chatgpt-oauth` is a distinct Studio-owned connection and Pi transport, not another key inside `openai-api-key`.
- `claude-code` identifies a vendor-runtime connection. Studio stores the executable/configuration reference and non-secret identity information, never Claude account tokens.
- A model family is descriptive, not sufficient to choose credentials or billing. A selection includes provider, connection, model identifier and configuration revision.
- ChatGPT accounts are keyed by registration and verified identity, not email or a rotating token fingerprint.
- Existing Pi session files remain readable. Claude native history belongs to Claude; Studio retains a display journal and the explicit native session ID. It must not claim that the display journal can replace native resume state.
- The first version starts a new conversation when a conversation moves to or from a subscription connection (`chatgpt-oauth` or `claude-code`), or between subscription accounts. Switches among the existing WordPress.com and API-key providers keep today's behavior, so those integrations are preserved. An explicit, user-reviewed context summary may be copied; opaque reasoning/history is not transferred.
- Preserve `session-setting-changes.ts`: settings chosen after Send apply to the next turn; pending writes and failures must not produce a mismatch between displayed and executed settings.

## ChatGPT connection

Implement authorization against the current official open-source Sign in with ChatGPT documentation, including dynamic registration, loopback PKCE, validated identity, permission checking, account separation, rotating refresh and revocation. Do not borrow another application's client registration or inspect Codex's credential store.

Use a record-oriented credential broker. A concrete proposed storage design is an atomic authenticated-encrypted file per account registration, with a random wrapping key in the existing OS credential store. Use standard platform/library primitives, not a custom cipher. Associate ciphertext with the registration ID and schema version. A missing or locked vault must not fall back silently to plaintext. Explicit session-only storage may remain in the owning application process, with short-lived access-token delivery to a forked turn over authenticated IPC.

The refresh lock must work across Desktop, CLI and `studio ui`. Maintain a logout generation/tombstone so an old refresh cannot restore credentials after logout. Never silently rotate to a different account. Keep the current account active until a new sign-in is completely validated.

Build a dedicated public Responses transport. Do not assume the existing Pi OAuth behavior is the public SIWC contract. Reuse tested SSE/tool-conversion components only after request-capture tests prove the actual wire request. Model discovery must parse the ChatGPT-route envelope independently of API-key model discovery, preserve server ordering, and intersect availability with supported/tested capabilities. Unknown capabilities are not guessed.

No paid-API fallback. No server output-cap control for this route. Distinguish local context budgeting from server-enforced token limits. Request an explicit completion signal; text alone is not success. Preserve partial output as incomplete on failures and do not replay already-executed tool side effects automatically.

## Claude runtime connection

For the first implementation, use a user-installed, unmodified Windows Claude Code binary; pin the SDK dependency and qualify the SDK/binary version pair. A later bundled-binary release is a separate packaging decision.

Detect the executable, run its version and native authentication-status commands, and let the user complete native sign-in in an actual terminal/system browser. Use the same executable, user, configuration directory and environment for authentication checks and execution. Do not recreate a Claude OAuth callback, collect a login code in Studio, or read `.credentials.json`.

The installed runtime retains all of its authentication methods. Studio may require a subscription-compatible identity for this particular connection, but reports a mismatch rather than rewriting vendor settings or silently using API billing. Do not inject Studio's API credentials. Runtime-reported identity and authentication source must be checked before a turn; missing evidence is not proof of subscription billing.

The runtime owns its model loop, native tools, compaction and session history. Studio owns the host-tool bridge, interface, scheduling, permission decisions and display projection. Use the official Agent SDK's supported APIs, including model discovery, account information, resume and structured events. Do not force arbitrary Claude events into Pi's private message types.

Expose Studio's WordPress operations through an SDK MCP server using the actual per-turn Studio host. Preserve schema validation, safety checks, artifacts, progress, pending-work settling, screenshot results and explicit errors. Use Claude's own file/shell tools instead of duplicating Pi file tools. Carry Studio-specific instructions as an addition to the official Claude Code preset; adapt skill references explicitly rather than assuming Pi skills auto-load.

Permission checks must apply at execution boundaries. `canUseTool` is a prompt channel, not a guarantee of interception for every operation. Test hooks, allow rules, MCP policies and Studio host guards together. No blanket `bypassPermissions` or unconditional allow callback. Stop/cancel denies pending approvals and cleans up this run's processes, not unrelated Claude sessions.

Public distribution requires reviewing Anthropic's hosting conditions and the SDK documentation's separate third-party-login warning. The technical design is native end-user sign-in to an unmodified runtime, not Studio-mediated Claude credentials.

## Acceptance and non-goals

Windows-native local Desktop, CLI and `studio ui` are the initial targets. No silent WSL bridge, shared cloud account pool, production-site testing, automatic API fallback, new image-generation backend, or automatic backend switching.

A source implementation, mocked integration test, real-process test, authenticated smoke test, and packaged Windows build are separate evidence levels. Report each explicitly. Preserve existing-provider regression tests, particularly setting-save races and credential routing.

## Primary references to recheck before coding

- `https://developers.openai.com/siwc/token-sharing-open-source/sign-in`
- `https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions`
- `https://developers.openai.com/siwc/token-sharing-open-source/token-reference`
- `https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference`
- `https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations`
- `https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery`
- `https://code.claude.com/docs/en/legal-and-compliance`
- `https://code.claude.com/docs/en/agent-sdk/quickstart`
- `https://code.claude.com/docs/en/cli-reference`
- `https://code.claude.com/docs/en/authentication`
- `https://code.claude.com/docs/en/agent-sdk/typescript`
- `https://code.claude.com/docs/en/agent-sdk/custom-tools`
- `https://code.claude.com/docs/en/agent-sdk/permissions`
- `https://code.claude.com/docs/en/agent-sdk/sessions`
