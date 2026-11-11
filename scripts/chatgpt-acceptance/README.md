# ChatGPT plan acceptance runner

A development-only runner that checks the ChatGPT plan provider end to end against a real ChatGPT account, and leaves sanitized, versioned evidence behind. It is built only by the development CLI build (`apps/cli/vite.config.dev.ts`); no production, npm or standalone build contains it.

Sources: `apps/cli/ai/chatgpt-acceptance-entry.ts` (entry), `chatgpt-acceptance.ts` (stages and live services), `chatgpt-acceptance-observer.ts` (request observer loaded into the CLI processes it starts), `acceptance-evidence.ts` and `acceptance-isolation.ts` (provider-neutral evidence format and run isolation, shared with other providers' runners). Offline tests: `apps/cli/ai/tests/chatgpt-acceptance*.test.ts` and `acceptance-evidence.test.ts`.

**A live run uses the account owner's real ChatGPT account and needs their consent and their presence at a browser.** Nothing reaches a network, a browser, the system keychain, a Studio profile or a site unless `--live` is passed.

## Command line

```text
npm run cli:build
node apps/cli/dist/cli/chatgpt-acceptance.mjs --scenario saved --run-dir <absolute-new-directory> [--model <model>] [--effort <effort>] [--gates T1,T2,T3] [--live]
node apps/cli/dist/cli/chatgpt-acceptance.mjs --scenario session --run-dir <the-same-directory> [--live]
```

| Option | Meaning |
| --- | --- |
| `--scenario saved\|session` | Required. `saved` starts a run; `session` continues the saved run in the same directory. |
| `--run-dir <path>` | Required. Absolute, outside `~/.studio`. For `saved` it must not exist yet or be empty; for `session` it must hold that saved run. |
| `--live` | Run against the real account. Without it, the runner only checks local prerequisites and prints its plan. |
| `--model`, `--effort` | `saved` only. Default: the route's first qualified model and its default effort. Anything the route isn't qualified for (`packages/agent/protocol/chatgpt-models.ts`, today `gpt-6-luna` at `low` or `medium`) is refused with the reason. `session` uses the saved run's choice. |
| `--gates T1,T2,T3` | `saved` only. Optional live gates, skipped (and recorded as skipped) unless named. |

Exit codes: `0` every required stage passed (a requested gate may be blocked); `1` a stage failed or was blocked, a requested gate failed, or cleanup failed; `2` refused before anything ran, which includes every run without `--live`; `130` interrupted. A second Ctrl+C exits without finishing cleanup (see "If a run is killed").

**Without `--live` (dry check):** the runner validates the arguments, the run directory, the isolated environment, the model and effort, and for `session` the saved run's manifest, source commit and registration. It reads only the run directory and runs `git` and `npm --version` locally. It prints the stages it would run, creates nothing and exits `2`.

## What the account owner does

Run the dry check first, then the same command with `--live`, from the repository root, on the commit to be qualified (both scenarios must run from the same commit).

1. `saved`: the browser opens ChatGPT's sign-in page **twice**. Sign in, and allow WordPress Studio to use your plan. The second time, sign in as the same account. Each sign-in must finish within 10 minutes of the browser opening; the runner says when the browser opened and prints the time left every minute. Then wait: the runner creates a disposable local site and runs the turns on its own.
2. `session`: the browser opens once. Sign in as the same account. The rest runs on its own.

The runner keeps its own Studio profile in the run directory, so this neither uses nor changes your normal Studio sign-ins. A fresh profile downloads WordPress and PHP the first time a site is created.

## Stages

Every stage records `passed`, `failed`, `blocked` or `skipped`, a typed code and its observations **before** anything judges it, so a failed sign-in keeps its code (`timed-out`, `denied`, `identity-mismatch`, …). After the first failed or blocked required stage the run stops and cleans up; an optional gate's result never stops it.

### `saved`

| Stage | What it does | Key observations |
| --- | --- | --- |
| `prerequisites` | Build present; system keychain available. | `buildPresent`, `secureStorageAvailable` |
| `sign-in` | Browser sign-in, saved credential, new registration. | `browserOpened`, `completedAfterS`, `timeoutS`, `timedOut`, `storedInVault` |
| `re-sign-in` | Browser sign-in again to the same registration. | `sameRegistration`, `sameRevision` |
| `model-discovery` | Reads the account's model list. | `listedModels`, `selectedModelListed`, `unqualifiedModelsListed` |
| `disposable-site` | `site create` in the run directory; baseline post list over WP-CLI. | `siteCreated`, `baselinePosts` |
| `draft-turn` | A forked CLI turn reads the site title and creates exactly one named draft. Tool calls outside the turn's policy (other sites, publishing, deleting, other tools) are interrupted and fail the stage. | `toolCalls`, `wpCliCalls`, `unexpectedToolCalls`, `questionsAsked`, `completed` |
| `draft-request-audit` | Every model request of that turn: on the route, the selected model and effort, streamed, stateless, no output cap, no API-key bearer, no other provider. | `modelRequests`, `apiKeyBearers`, `otherProviderRequests`, `allOnSelectedModel`, `allAtSelectedEffort`, `noOutputCap`, `stateless` |
| `draft-readback` | Independent WP-CLI readback. | `newPosts`, `statusDraft`, `titleMatches`, `contentMatches`, `otherPostsUnchanged` |
| `effort-change` | Moves the chat to the other qualified effort. | `effortChanged` |
| `resume` | A fresh CLI process resumes the chat and recalls the draft's marker with no tools. | `freshProcess`, `historyReplayed`, `requestsAtNewEffort`, `markerRecovered` |
| `gate-t1-image-tool-result` | T1: sets the site title to a marker, takes a screenshot, and the reply must read the marker from the image. | `imageToolOutputsSent`, `routeAcceptedImageResult`, `markerReadFromImage`, `otherToolCalls` |
| `gate-t2-reasoning-replay` | T2: a turn whose first response produces a reasoning item, replayed in the next request and accepted. `blocked` (`no-reasoning-item`) when the model produced none. | `reasoningItemsProduced`, `reasoningItemsReplayed`, `replayAccepted` |
| `gate-t3-image-service-row` | T3: a `generate_images` tool row carries `details.studioService` when its event arrives, before the session persists the result. `blocked` (`image-service-not-configured`), never failed, without Studio's separate WordPress.com image service (for example `STUDIO_IMAGE_API_TOKEN`). | `detailsDelivered`, `deliveredBeforePersisted` |
| `active-run-stops-on-sign-out` | Signs out while a real forked turn is running. The runner never interrupts it: the turn has to stop by itself. | `localCleared`, `remoteRevocationConfirmed`, `stoppedAfterS`, `watchPollS`, `routeRequestsAfterSignOut`, `toolRunsAfterSignOut`, `reportedSignedOut`, `ownerInterruptSent` |
| `remote-revocation` | Separately from the local clear: a refresh with the token the sign-out revoked (kept in memory only) must be refused. | `revokedRefreshRejected`, `rejectionTerminal` |
| `blocked-after-sign-out` | A later turn fails before any inference, with no fallback. | `routeRequests`, `apiKeyBearers`, `otherProviderRequests`, `reportedSignedOut` |

### `session`

| Stage | What it does | Key observations |
| --- | --- | --- |
| `prerequisites` | Build present. | `buildPresent` |
| `returning-sign-in` | Browser sign-in to the saved run's registration, kept for this runner's session only. | `browserOpened`, `completedAfterS`, `timeoutS`, `timedOut`, `sameRegistration` |
| `no-persisted-record` | No credential record on disk. | `storageSession`, `vaultRecordPresent` |
| `offered-fork-inference` | A forked turn offered the session asks the runner for its token over IPC and completes a read-only reply. | `tokenAsks`, `tokensHandedOut`, `modelRequests`, `answeredReady` |
| `unoffered-process-fails` | A process started without the offer or an IPC channel fails before inference, with no other account or API key. | `routeRequests`, `tokenAsks`, `reportedUnavailable` |
| `refresh-hold-across-sign-out` | Holds a real refresh result in memory through the injectable token client, signs out, starts a fork while it is held, releases it. | see below |

The refresh hold records: `refreshHeld`, `generationAdvancedDuringHold`, `offerAdvertisedDuringWindow` (informational: the fork offer may linger until the held refresh settles, so it is **not** asserted), `windowForkTokensHandedOut` (must be 0), `windowForkRouteRequests` (must be 0), `heldRefreshRejectedSignedOut`, `offerGoneAfterSettle`, `localCleared`, `remoteRevocationConfirmed`, `rotatedRevokedBySignOut`, `retiredRefreshRejected`, `rotatedRefreshRejected`. The hold is released within 20 s, under the broker's 30 s refresh timeout; if the broker gives up on a held result anyway, the runner revokes what it was issued.

## Evidence

All in the run directory:

- `manifest.json`: `schemaVersion`, `provider`, and one entry per run in `runs`: `run`, `scenario`, `createdOn` (a date), `source` (`sha`, `dirty`), `platform` (`os`, `release`, `arch`), `runtime` (`node`, `npm`), `build` (`cliVersion`, `buildId`: the first 12 hex digits of the SHA-256 of `main.mjs`), `model`, `effort`, `gates`. Runs are appended, never replaced.
- `evidence.ndjson`: append-only, one line per stage: `schemaVersion`, `run`, `scenario`, `stage`, `status`, `code` (typed, never a message), `durationS`, `observations` (counts, booleans and durations only). Each run ends with a `cleanup` record. An earlier failure stays in the file when a scenario is run again.
- `state.json`: local test identifiers (registration id, site path, chat ids, the draft marker). **Keep it on this machine.**
- `observer/*.ndjson`: per-turn request summaries (destination class, bearer shape, model, effort, item counts). Read back into the counts above.
- `profile/`, `daemon/`, `sites/`: the run's own Studio profile, process manager and disposable site.

Before anything is written, `acceptance-evidence.ts` refuses: any field outside the record's shape; a string that looks like a token (JWT, API key, bearer header, long opaque run), a URL (scheme, loopback address, host name, OAuth query parameter), an email address, an account or registration identifier (UUID) or a local path; and non-finite or out-of-range numbers. The refusal names the field, never its value. `state.json` may hold identifiers and paths but no token, URL or email. Console lines go through the same check. Authorization URLs go only to the browser; tokens stay in memory.

## Isolation and cleanup

- The entry points `DEV_CONFIG_DIR`, `STUDIO_PROCESS_MANAGER_HOME`, `E2E` and `E2E_SITES_ROOT` at the run directory before any application module loads, and the runner refuses to run if the profile or process manager would resolve to `~/.studio`. It never reads the normal Studio profile.
- Children get no provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and the like are removed from their environment), so any API-key bearer the observer sees is a real fallback.
- On every way out (pass, failed stage, thrown error, Ctrl+C) cleanup runs in this order: cancel a pending sign-in and wait for it to settle; release a held refresh and wait for it; stop the processes this runner started (by their own handles, interrupt first, then the child's own process tree by its PID); stop and unregister the disposable site and the run's own process manager (its control pipe is keyed to the run directory, so no other Studio process is touched); sign out the test registration if it is still signed in. A cleanup failure is recorded in the `cleanup` record and never replaces the stage that failed first.
- The vault's wrapping key in the system keychain is shared with every Studio profile on the machine. The runner never deletes it, and never touches other registrations.
- **Sign-in and sign-out ordering.** A returning sign-in begun before a sign-out still commits if it completes afterwards (the broker counts a sign-in when it is saved). So the runner never signs out while an attempt is pending: each sign-in stage waits for its outcome, and cleanup cancels and waits for a pending attempt before it signs out.
- **Session-only sign-ins end with the runner.** The session scenario's credential lives in the runner's memory. A fork that loses its IPC channel drops its token at its next broker call (or within the 2 s account poll of an active turn) and stops with `session-unavailable`.

## If a run is killed

If the runner is killed before cleanup finishes, from the repository root, with the run directory in place of `<run>`:

```text
DEV_CONFIG_DIR=<run>/profile STUDIO_PROCESS_MANAGER_HOME=<run>/daemon node apps/cli/dist/cli/main.mjs site stop --all
```

Then sign the test registration out: run `node apps/cli/dist/cli/main.mjs code` with the same two variables and `STUDIO_EXPERIMENTAL_CHATGPT=1`, and use `/chatgpt` → Sign out. You can also remove WordPress Studio's access in ChatGPT's settings. A session-only sign-in ends with the runner's process.
