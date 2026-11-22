# Draft: Claude subscription sign-in distribution clarification request

**Status: DRAFT. Not sent.** Prepared November 11, 2026 for the repository owner to review, edit and, if they choose, send. Sending it is a separate action that the owner must authorize. Nothing in this file has been transmitted to anyone. Remove or adjust any details before use; do not add credentials, account identifiers or private URLs.

**Before sending:** the statements about how the integration works are tied to code M1 read at `ce4eea5dc` (see the Basis list at the end of this file). Items marked `[verify before sending]` could not be confirmed from that code. The owner must resolve them against the final PR #3 code, then remove the markers and the Basis list. The code is an experimental proof of concept, not a completed qualification.

**Suggested recipient:** Anthropic, through the contact route the repository owner prefers (the legal page refers authentication questions to Anthropic sales). The owner decides the route.

**Background for the owner (not part of the message):** Ledger section E records that the Agent SDK quickstart says third-party developers may not offer claude.ai login or rate limits "unless previously approved", and that the legal and compliance page separates credential mediation (not permitted) from an end user signing in to the unmodified Claude Code binary with their own subscription. The ledger records no approval or exemption for Studio. See [the readiness ledger](subscription-readiness.md).

---

Subject: Question about offering native Claude sign-in in an open-source desktop app

Hello,

I maintain a fork of WordPress Studio, an open-source desktop application for running local WordPress sites. It includes an AI assistant. I am preparing an optional, off-by-default experimental integration that runs the official Claude Code native binary through the Claude Agent SDK. Before I offer it to anyone, I would like to confirm that the design is permitted.

How the integration works:

1. The user points Studio at a Claude Code native executable that is already installed, by absolute path. Studio has no code that downloads or modifies it. [verify before sending: whether the SDK package Studio bundles also ships its own copy of the binary]. Before use, Studio checks that the file is a 64-bit Windows executable with a valid code signature whose signer is "Anthropic, PBC", and that its reported version equals the one version Studio has tested. It supports Windows x64 only at present. [B1]
2. To sign in, Studio launches that executable with its `auth login` command in a separate visible window. The sign-in itself happens in the vendor's own flow; Studio does not take part in it. [B2] [verify before sending: what the vendor flow shows to the user, since Studio does not control it]
3. Studio's own code that I reviewed does not read Claude credential or token files, and the connection it saves holds only an identifier, the executable path and an optional configuration directory. Studio does read the output of the binary's `auth status --json` command, including the account email, organization and plan type, to confirm that the account that was checked is the account that runs. [B3] [verify before sending: a complete review of every Studio file that touches the Claude runtime for credential access has not been done]
4. Studio starts the selected binary through the Agent SDK for each conversation, using the selected executable path, no setting sources, and the default permission mode. Studio passes the child process an allowlisted environment and refuses to start if API-key, cloud-provider or proxy variables are present. It accepts only a `claude.ai` sign-in through the first-party provider on a Pro or Max plan, and rejects a run if the SDK reports an API key or token source. Studio does not supply an API key or route requests through any Studio account. [B4] [verify before sending: who is billed for the usage is a matter of your terms; Studio contains no billing logic]
5. The runtime is limited to one native tool, `Read`, and one Studio tool, `wp_cli`, which allows only a few named read commands and the creation of a draft post, and a draft is created only after the user approves it. The terminal approval prompt is in the CLI code I read. [B5] [verify before sending: the Desktop and browser approval dialogs were not read]
6. The feature does nothing unless an experimental environment flag is set. [B6] [verify before sending: whether a Settings toggle also exists]


Questions:

1. Is this design, in which an end user signs in to the unmodified native binary with their own Claude subscription and Studio hosts or launches that binary, permitted under the Agent SDK guidance and your legal and compliance terms? Is prior approval required for it, and how do I request it?
2. If approval is required, what conditions apply (for example Commercial Terms acceptance, usage limits, how the feature is described to users, or restrictions on which plans may be used)?
3. How may the product refer to Claude, Claude Code and Anthropic in its settings, documentation and release notes? I plan to say in plain text that the feature runs Claude Code and to avoid using your names or logos in the feature or product name.
4. Is there any difference in your answer if the app is distributed as an open-source project with the feature off by default, compared with a commercial product?
5. Are there requirements for the minimum or maximum native binary version, or for verifying the binary's signature or manifest, that you expect an integrator to follow?

Until I hear back, I will treat the feature as unapproved: it stays experimental, off by default, and unpublished.

Thank you,
[Repository owner name and contact, to be added by the owner]

---

## Basis (for the owner; remove before sending)

Files read in the Claude worktree at `ce4eea5dc` (`~/.codex/worktrees/add-claude-runtime/studio`), under `packages/agent/node/claude-code/` unless noted:

- B1: `discovery.ts` `inspectClaudeExecutable` (absolute `.exe` path, PE header and x64 machine check, PowerShell `Get-AuthenticodeSignature` status Valid with signer `Anthropic, PBC`, `--version` compared with `QUALIFIED_CLAUDE_CODE_VERSION`, platform gate `win32`). `studio-surface.ts` `configureClaudeRuntime` ("save" takes `executablePath` from the user). No download code in `discovery.ts` or `connection.ts`.
- B2: `connection.ts` `openClaudeNativeSignIn` (PowerShell `Start-Process ... -ArgumentList @('auth','login') -WindowStyle Normal`, after the same executable, environment, configuration and managed-policy checks).
- B3: `connection.ts` `readNativeStatus` (runs `auth status --json`) and the identity fields taken from it in `prepareClaudeInvocation`; `saveClaudeConnection` fields (id, executablePath, configDirectory) from `studio-surface.ts`. `auth-status.ts` was read only for `buildClaudeEnvironment`, `assessClaudeAuth` and `compareClaudeExecutionAuth`.
- B4: `runtime.ts` option lines (`pathToClaudeCodeExecutable`, `settingSources: []`, `permissionMode: 'default'`, `env: invocation.env`); `auth-status.ts` (`buildClaudeEnvironment` allowlist and conflicts for `ANTHROPIC_`, `AWS_`, `GOOGLE_CLOUD_`, `AZURE_` and `_PROXY` variables; `assessClaudeAuth` requires `authMethod` `claude.ai`, `apiProvider` `firstParty`, plan `pro` or `max`; `compareClaudeExecutionAuth` rejects a token or API key source); `connection.ts` `prepareClaudeInvocation` (blocks on conflicts).
- B5: `runtime.ts` (`tools: ['Read']`, `canUseTool` and init check allowing only `Read` and `mcp__studio__wp_cli`); `tool-bridge.ts` (`classify` allowlist, approval request before a draft); `apps/cli/ai/claude-approval.ts` (terminal prompt). The Desktop and browser surfaces were not read; only the file names under `apps/ui/src/data/agent-runs/` that mention approval events were listed.
- B6: `connection.ts` and `studio-surface.ts` check `STUDIO_EXPERIMENTAL_CLAUDE_CODE === '1'`. From `d1d217d5e` on, `studio-surface.ts` also requires a host that is one of the six targets in `CLAUDE_QUALIFICATION_MATRIX` (`platform.ts`); only the Windows x64 record is qualified, and inspection refuses the other five as `platform-unqualified`. No Settings toggle was looked for.
