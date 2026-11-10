# WordPress Studio subscription-provider handoff

Prepared November 8, 2026 for `henryperkins/studio`, initially inspected at `8672a64e7daf368051db0b35989dc9dd89523ff9`. Implementation status updated November 10, 2026.

This package records the design and acceptance requirements for draft [PR #2](https://github.com/henryperkins/studio/pull/2) (ChatGPT plan) and stacked [PR #3](https://github.com/henryperkins/studio/pull/3) (Claude runtime). Each plan's **Observed completion** section records verified work and remaining gates. The original checkboxes describe requirements, not completion status.

Read in order:

1. `docs/superpowers/specs/2026-11-08-subscription-connections-design.md`
2. `docs/superpowers/plans/2026-11-08-chatgpt-plan-implementation.md`
3. `docs/superpowers/plans/2026-11-08-claude-runtime-implementation.md`

ChatGPT stays on Studio's Pi runtime with direct OpenAI OAuth and a dedicated transport. Claude uses its official runtime and sign-in through the Agent SDK, with a separate backend adapter. Existing API-key providers remain intact.

Both features remain disabled by default. Authenticated acceptance is deferred pending quota and explicit local authorization. Merge PR #2 first, then retarget PR #3 to `trunk`; neither draft is merge-ready. Refresh repository state before continuing and keep credentials out of chat, commits and test fixtures.
