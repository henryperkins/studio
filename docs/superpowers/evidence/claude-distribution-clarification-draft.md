# Draft: Claude subscription sign-in distribution clarification request

**Status: DRAFT. Not sent.** Prepared November 11, 2026 for the repository owner to review, edit and, if they choose, send. Sending it is a separate action that the owner must authorize. Nothing in this file has been transmitted to anyone. Remove or adjust any details before use; do not add credentials, account identifiers or private URLs.

**Before sending:** the owner should confirm each statement about how the integration works against the final PR #3 code; they describe the design in the plans and what M1 saw in `ce4eea5dc`, not a completed qualification.

**Suggested recipient:** Anthropic, through the contact route the repository owner prefers (the legal page refers authentication questions to Anthropic sales). The owner decides the route.

**Background for the owner (not part of the message):** Ledger section E records that the Agent SDK quickstart says third-party developers may not offer claude.ai login or rate limits "unless previously approved", and that the legal and compliance page separates credential mediation (not permitted) from an end user signing in to the unmodified Claude Code binary with their own subscription. The ledger records no approval or exemption for Studio. See [the readiness ledger](subscription-readiness.md).

---

Subject: Question about offering native Claude sign-in in an open-source desktop app

Hello,

I maintain a fork of WordPress Studio, an open-source desktop application for running local WordPress sites. It includes an AI assistant. I am preparing an optional, off-by-default experimental integration that runs the official Claude Code native binary through the Claude Agent SDK. Before I offer it to anyone, I would like to confirm that the design is permitted.

How the integration works:

1. The user installs the official Claude Code native binary themselves, or selects an existing install. Studio does not download, patch or modify the binary. Studio checks that the file is the executable it expects and records its version.
2. The user signs in by running the binary's own login in a terminal that Studio opens. Sign-in completes in Anthropic's own flow.
3. Studio never reads, copies, stores or forwards Claude credentials, session tokens or token files. The binary keeps its credentials in its own configuration directory.
4. Studio starts the unmodified binary through the SDK for each conversation. It passes no API key and does not route requests through any Studio account. Usage is billed to the signed-in user under their own agreement with Anthropic.
5. Studio exposes a limited set of its local site tools to the runtime and asks the user to approve changes.
6. The feature is disabled unless the user turns on an experimental setting.

Questions:

1. Is this design, in which an end user signs in to the unmodified native binary with their own Claude subscription and Studio hosts or launches that binary, permitted under the Agent SDK guidance and your legal and compliance terms? Is prior approval required for it, and how do I request it?
2. If approval is required, what conditions apply (for example Commercial Terms acceptance, usage limits, how the feature is described to users, or restrictions on which plans may be used)?
3. How may the product refer to Claude, Claude Code and Anthropic in its settings, documentation and release notes? I plan to say in plain text that the feature runs Claude Code and to avoid using your names or logos in the feature or product name.
4. Is there any difference in your answer if the app is distributed as an open-source project with the feature off by default, compared with a commercial product?
5. Are there requirements for the minimum or maximum native binary version, or for verifying the binary's signature or manifest, that you expect an integrator to follow?

Until I hear back, I will treat the feature as unapproved: it stays experimental, off by default, and unpublished.

Thank you,
[Repository owner name and contact, to be added by the owner]
