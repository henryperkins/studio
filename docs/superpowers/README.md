# WordPress Studio subscription-provider handoff

Prepared November 8, 2026 for `henryperkins/studio`, inspected at `8672a64e7daf368051db0b35989dc9dd89523ff9`.

This package contains proposed design and implementation plans, not application code or test results. No repository was modified.

Read in order:

1. `docs/superpowers/specs/2026-11-08-subscription-connections-design.md`
2. `docs/superpowers/plans/2026-11-08-chatgpt-plan-implementation.md`
3. `docs/superpowers/plans/2026-11-08-claude-runtime-implementation.md`

ChatGPT stays on Studio's Pi runtime with direct OpenAI OAuth and a dedicated transport. Claude uses its official runtime and sign-in through the Agent SDK, with a separate backend adapter. Existing API-key providers remain intact.

Refresh primary docs and repository state before coding. Never put credentials in chat, commits or test fixtures. Live tests require local user authorization.
