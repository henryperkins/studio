# Claude subscription tool acceptance

This development-only runner uses a qualified native Claude Code executable and its signed-in Claude subscription. Each turn forks the built Studio CLI. It creates a new Studio profile, process manager, WordPress site and site-scoped chat. The account owner must authorize subscription usage and the local test changes.

From the repository root, build the CLI with `npm run cli:build`. Choose an unused absolute directory name under an existing parent, outside the Studio and Claude profiles. Pass the absolute paths of the executable and its signed-in native config directory. The following example uses PowerShell.

```powershell
$env:STUDIO_EXPERIMENTAL_CLAUDE_CODE = '1'
node apps/cli/dist/cli/claude-acceptance.mjs --live --run-dir $runDir --executable $claudeExecutable --config-directory $nativeConfig --model $model --effort low --next-effort medium
```

Site setup installs the bundled WordPress version and the configured default Studio PHP package in the disposable profile. Development builds can use the PHP package installed by the repository postinstall script. To use an existing package directory, set `STUDIO_BUNDLED_PHP_BIN_ROOT` to its parent. Only site creation runs with external requests disabled. Ctrl+C during setup lets the current administrative command finish before cleanup.

The two efforts must differ and the workspace catalog must offer both for the selected model. The runner checks Studio's reported billing route, executable version and connection before sending a turn. Native Claude manages sign-in and its own session history. Studio's isolated profile has no connected WordPress.com site.

The runner seeds a local WordPress option, checks a native tool read, denies a guarded draft creation, allows a separate draft and verifies its content and metadata through WP-CLI. It changes effort through Studio, starts a fresh CLI process for the same conversation, then stops a pending approval and sends a late Allow. Approval replies require the expected session, run, turn, tool, operation, arguments and local site. For tools Studio runs directly, the runner observes tool events and checks the independent WordPress outcome. Every turn checks its terminal event and process exit.

A run exits successfully only after its workflows and cleanup pass. The runner stops and unregisters its allocated site, removes the disposable site files and stops the isolated daemon. Keep the run directory private. Its `manifest.json` and `evidence.ndjson` contain build provenance, typed outcomes and counts. The remaining profile and native session data may include conversation content. Share only the two evidence files after review.

This command exercises the Claude CLI workflow on the host where it runs. Desktop and browser interactions, recovery after a process crash, other platforms and optional service workflows need their own evidence.
