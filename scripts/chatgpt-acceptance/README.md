# ChatGPT plan acceptance runner

A development-only runner that checks the ChatGPT plan provider end to end against a real ChatGPT account, and leaves sanitized, versioned evidence behind. It is built only by the development CLI build (`apps/cli/vite.config.dev.ts`); no production, npm or standalone build contains it.

Sources: `apps/cli/ai/chatgpt-acceptance-entry.ts` (entry), `chatgpt-acceptance.ts` (stages and live services), `chatgpt-acceptance-observer.ts` (request observer loaded into the CLI processes it starts), `acceptance-evidence.ts` and `acceptance-isolation.ts` (provider-neutral evidence format and run isolation, shared with other providers' runners). Offline tests: `apps/cli/ai/tests/chatgpt-acceptance*.test.ts` and `acceptance-evidence.test.ts`.

**A live run uses the account owner's real ChatGPT account and needs their consent and their presence at a browser.** Nothing reaches a network, a browser, the system keychain, a Studio profile or a site unless `--live` is passed.

## Command line

```text
npm run cli:build
node apps/cli/dist/cli/chatgpt-acceptance.mjs --scenario saved --run-dir <absolute-new-directory> [--model <model>] [--effort <effort>] [--gates T1,T2,T3,T4] [--live]
node apps/cli/dist/cli/chatgpt-acceptance.mjs --scenario session --run-dir <the-same-directory> [--live]
```

| Option | Meaning |
| --- | --- |
| `--scenario saved\|session` | Required. `saved` starts a run; `session` continues the saved run in the same directory. |
| `--run-dir <path>` | Required. Absolute, outside `~/.studio`. For `saved` it must not exist yet or be empty; for `session` it must hold that saved run. |
| `--live` | Run against the real account. Without it, the runner only checks local prerequisites and prints its plan. |
| `--model`, `--effort` | `saved` only. Default: the route's first qualified model and its default effort. Anything the route isn't qualified for (`packages/agent/protocol/chatgpt-models.ts`, today `gpt-6-luna` at `low` or `medium`) is refused with the reason. `session` uses the saved run's choice. |
| `--gates T1,T2,T3,T4` | `saved` only. Optional live gates, skipped (and recorded as skipped) unless named. |

Exit codes: `0` every required stage passed (a requested gate may be blocked); `1` a stage failed or was blocked, a requested gate failed, or cleanup failed; `2` refused before anything ran, which includes every run without `--live`; `130` interrupted. A second Ctrl+C exits without finishing cleanup (see "If a run is killed").

**Without `--live` (dry check):** the runner validates the arguments, the run directory, the isolated environment, the state of your real Studio profile (see "Isolation"), the model and effort, and for `session` the saved run's manifest, source commit and registration. It reads only the run directory and whether two folders exist in your Studio profile, and runs `git` and `npm --version` locally. It prints the stages it would run, creates nothing and exits `2`.

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
| `gate-t4-smoke-1`, `gate-t4-smoke-2`, … | T4: one stage per pair of the route's qualified table (`CHATGPT_MODEL_CAPABILITIES` in `packages/agent/protocol/chatgpt-models.ts`), numbered in its order (models, then each model's efforts; today `gpt-6-luna` at `low`, then at `medium`). Each pair reads the account's model list again (`blocked`, `model-not-listed`, when the pair's model isn't listed), then answers a read-only READY turn in a new chat with no site, selected at that model and effort, and gets the same route audit as `draft-request-audit`. A single model never qualifies the list: each pair passes or fails on its own record, and a failed pair doesn't stop the others. The plan printed without `--live` names each number's model and effort; the numbering is the table at the run's source commit, which the manifest records. | `modelListed`, `answeredReady`, `modelRequests`, `apiKeyBearers`, `otherProviderRequests`, `allOnSelectedModel`, `allAtSelectedEffort`, `noOutputCap`, `stateless` |
| `disposable-site` | `site create` in the run directory; baseline post list over WP-CLI. | `siteCreated`, `baselinePosts` |
| `draft-turn` | A forked CLI turn reads the site title and creates exactly one named draft. At least one WP-CLI read must have run and returned (`no-site-read` otherwise): a read is decided by the command's verb, as the tool policy decides it, so the draft's own `post create` never counts, nor does a write whose later words look like read verbs (`option update status x`). Tool calls outside the turn's policy (other sites, publishing, deleting, other tools) are interrupted and fail the stage. | `toolCalls`, `wpCliCalls`, `wpCliReads`, `unexpectedToolCalls`, `questionsAsked`, `completed` |
| `draft-request-audit` | Every model request of that turn: on the route, the selected model and effort, streamed, stateless, no output cap, no API-key bearer, no other provider. | `modelRequests`, `apiKeyBearers`, `otherProviderRequests`, `allOnSelectedModel`, `allAtSelectedEffort`, `noOutputCap`, `stateless` |
| `draft-readback` | Independent WP-CLI readback. | `newPosts`, `statusDraft`, `titleMatches`, `contentMatches`, `otherPostsUnchanged` |
| `gate-t2-reasoning-replay` | T2: a turn whose first response produces a reasoning item, replayed in the next request and accepted. It runs before the effort change, at the run's starting effort, and needs `medium` (the default): with `--effort low` it runs at `low`, where it will most likely end `blocked`. `blocked` (`no-reasoning-item`) when the model produced none. | `reasoningItemsProduced`, `reasoningItemsReplayed`, `replayAccepted` |
| `effort-change` | Moves the chat to the other qualified effort. | `effortChanged` |
| `resume` | A fresh CLI process resumes the chat and recalls the draft's marker with no tools. | `freshProcess`, `historyReplayed`, `requestsAtNewEffort`, `markerRecovered` |
| `gate-t1-image-tool-result` | T1: sets the site title to a marker, takes a screenshot, and the reply must read the marker from the image. | `imageToolOutputsSent`, `routeAcceptedImageResult`, `markerReadFromImage`, `otherToolCalls` |
| `gate-t3-image-service-row` | T3: a `generate_images` tool row carries `details.studioService` when its event arrives, before the session persists the result. `blocked` (`image-service-not-configured`), never failed, without Studio's separate WordPress.com image service (for example `STUDIO_IMAGE_API_TOKEN`). | `detailsDelivered`, `deliveredBeforePersisted` |
| `active-run-stops-on-sign-out` | Signs out while a real forked turn is running. The runner never interrupts it: the turn has to stop by itself. See below. | see below |
| `remote-revocation` | Separately from the local clear: a refresh with the token the sign-out revoked (kept in memory only) must be refused. | `revokedRefreshRejected`, `rejectionTerminal` |
| `blocked-after-sign-out` | A later turn fails before any inference, with no fallback. | `routeRequests`, `apiKeyBearers`, `otherProviderRequests`, `reportedSignedOut` |

The active run is judged from the moment the sign-out **begins**, against the product's own bound, the turn watch poll (`CHATGPT_TURN_WATCH_POLL_MS`, 2 s, recorded as `watchPollS`):

- A model request or tool call that started before the sign-out began may finish. One that starts within the watch bound is counted (`routeRequestsInWatchWindow`, `toolStartsInWatchWindow`) and allowed. One that starts later fails the stage (`request-after-sign-out`, `tool-call-after-sign-out`), counting tool **starts** whether or not the call finished (`toolStartsAfterSignOut`; `toolRunsAfterSignOut` counts those that also ran to a result).
- The turn must end with the signed-out outcome (`reportedSignedOut`). A turn that ends successfully after the sign-out began fails with `completed-after-sign-out`; one that stops for any other reason fails with `stopped-for-other-reason`. The stage is `blocked` (`run-ended-before-sign-out`) only when the turn ended before the sign-out began (`endedBeforeSignOut`).
- `stopDelayS` is how long after the sign-out began the turn ended (expected: about one watch poll); `signOutTookS` is how long the sign-out itself took, remote revocation included.
- `stoppedByTurnHandle` means the turn's own ChatGPT connection signal ended it (its account watch, or its handle refusing the next request or tool), which the transport reports as an interrupted stop naming the sign-out. `stoppedByBrokerErrorOnly` means only an error the broker returned, when the turn next asked it for a token, reported the sign-out. Both are recorded, neither is judged, so a live run shows which one stopped the turn.

### `session`

| Stage | What it does | Key observations |
| --- | --- | --- |
| `prerequisites` | Build present. | `buildPresent` |
| `returning-sign-in` | Browser sign-in to the saved run's registration, kept for this runner's session only. | `browserOpened`, `completedAfterS`, `timeoutS`, `timedOut`, `sameRegistration` |
| `no-persisted-record` | No credential record on disk. | `storageSession`, `vaultRecordPresent` |
| `offered-fork-inference` | A forked turn offered the session asks the runner for its token over IPC and completes a read-only reply. | `tokenAsks`, `tokensHandedOut`, `modelRequests`, `answeredReady` |
| `unoffered-process-fails` | A process started without the offer or an IPC channel fails before inference, with no other account or API key. | `routeRequests`, `tokenAsks`, `reportedUnavailable` |
| `refresh-hold-across-sign-out` | Holds a real refresh result in memory through the injectable token client, signs out, asks the owner for the session token and starts a fork while it is held, releases it. | see below |

The in-window check is made by the runner itself, which asks for the session token through the owner's answer path as a forked turn's request would reach it (a fork started in the window lists the account as disconnected and never asks); that a forked process is refused is pinned by the product's unit tests in `packages/agent/node/chatgpt/tests/credential-broker.test.ts`.

The refresh hold records: `refreshHeld`, `generationAdvancedDuringHold`, `offerAdvertisedDuringWindow` (the fork offer may linger until the held refresh settles; when it does, the runner's own ask must be answered, `windowDirectAskAnswered`, without a token, `windowDirectAskRefused`, or the stage fails `window-ask-unanswered` / `window-ask-got-token`), `windowForkTokenAsks` (recorded, not asserted), `windowForkTokensHandedOut` (must be 0), `windowForkRouteRequests` and `windowForkFallbackRequests` (must be 0: `inference-during-window`), `windowForkSucceeded` (must be false: `window-fork-completed`), `windowForkReportedUnavailable` (recorded), `heldRefreshRejectedSignedOut`, `offerGoneAfterSettle`, `localCleared`, `remoteRevocationConfirmed`, `rotatedRevokedBySignOut` (must be true: the sign-out's revocation of the grant the held refresh rotated to was confirmed), `rotatedRefreshRejected`, `retiredRefreshRejected`. The rotated refresh token is probed **before** the retired one: presenting a spent token can make the service revoke the whole grant as reused, which would hide whether the sign-out revoked anything. The hold is released within 20 s, under the broker's 30 s refresh timeout; if the broker gives up on a held result anyway, the runner revokes what it was issued. The waits for the hold, the window fork and the sign-out end at once on Ctrl+C; cleanup then releases the hold and waits for the sign-out the stage began. The two probes at the end are not cut short, since each revokes whatever it was issued (at most 30 s each).

## Evidence

**Only `manifest.json`, `evidence.ndjson` and `observer/` may leave this machine.** Everything else in the run directory is private and stays where it is.

Shareable:

- `manifest.json`: `schemaVersion`, `provider`, and one entry per run in `runs`: `run`, `scenario`, `createdOn` (a date), `source` (`sha`, `dirty`), `platform` (`os`, `release` (`null` when the system's release string isn't a plain version), `arch`), `runtime` (`node`, `npm`), `build` (`cliVersion`, `buildId`: the first 12 hex digits of the SHA-256 of `main.mjs`), `model`, `effort`, `gates`. Runs are appended, never replaced.
- `evidence.ndjson`: append-only, one line per stage: `schemaVersion`, `run`, `scenario`, `stage`, `status`, `code` (typed, never a message), `durationS`, `observations` (counts, booleans and durations only). Each run ends with a `cleanup` record. An earlier failure stays in the file when a scenario is run again.
- `observer/*.ndjson`: per-turn request summaries (destination class, bearer shape, model, effort, item counts). Read back into the counts above.

Private, never shared:

- `state.json`: local test identifiers (registration id, site path, chat ids, the draft marker).
- `profile/`: the run's Studio profile, holding the ChatGPT account store (with the account's email address and subject identifier) and the sealed credential records.
- `appdata/`: the full transcripts of every chat the run held.
- `daemon/`, `sites/`: the run's process manager and its disposable site.
- `wp-cli/`: WP-CLI's cache for this run (and packages, which no stage installs).

Before anything is written, `acceptance-evidence.ts` refuses: any field outside the record's shape; a string that looks like a token (JWT, API key, bearer header, long opaque run), a URL (scheme, loopback address, host name, OAuth query parameter), an email address, an account or registration identifier (UUID) or a local path; and non-finite or out-of-range numbers. The refusal names the field, never its value. `state.json` may hold identifiers and paths but no token, URL or email. Console lines go through the same check. Authorization URLs go only to the browser; tokens stay in memory.

## Isolation and cleanup

- **Environment.** Before any application module loads, the entry (and the runner again) removes every inherited `E2E_*` variable, then sets `DEV_CONFIG_DIR=<run>/profile`, `STUDIO_PROCESS_MANAGER_HOME=<run>/daemon`, `E2E=1`, `E2E_SITES_ROOT=<run>/sites`, `E2E_APP_DATA_PATH=<run>/appdata`, `E2E_CLI_CONFIG_PATH=<run>/profile` and `E2E_SHARED_CONFIG_PATH=<run>/profile`. `E2E=1` arms every `E2E_*` path the Studio path helpers read, so each is pointed at the run. WP-CLI, which the CLI runs in a PHP process with that environment, gets its own global config, cache and packages too: `WP_CLI_CONFIG_PATH=<run>/wp-cli/config.yml` (a file the run never creates, so no global config applies), `WP_CLI_CACHE_DIR=<run>/wp-cli/cache` and `WP_CLI_PACKAGES_DIR=<run>/wp-cli/packages`, replacing any inherited values. The CLI processes the runner starts get that environment without `OPENAI_API_KEY`, `STUDIO_OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `STUDIO_WPCOM_API_KEY`; a turn also gets its observer file, and a turn that is not offered the session gets no session offer. `HOME`, `USERPROFILE` and `APPDATA` are left as they are: the system keychain and the browser opener need them. An offline test (`apps/cli/ai/tests/chatgpt-acceptance-isolation.test.ts`) checks that, under exactly that environment, every path the helpers in `packages/common/lib/well-known-paths.ts`, `apps/cli/lib/appdata.ts`, `paths.ts`, `site-paths.ts` and `dependency-management/paths.ts` export resolves inside the run directory (or to files that ship with the CLI), so a helper added later that escapes fails it, and that the environment the CLI hands the PHP process running WP-CLI (`getPhpChildEnv`) points WP-CLI's three paths inside the run directory with the home directory unchanged.
- **Refusals before anything runs.** The runner refuses when the profile or process manager would resolve to `~/.studio`, and when your real profile has `.studio/pm2` but no `.studio/daemon`: every CLI process renames that folder under your home directory whatever its environment (CLI migration 03). Run any command of your installed Studio CLI once, for example `studio site list`, to finish that rename, then run the runner again. The check only reads whether the two folders exist.
- **What still reaches outside the run directory.** The system keychain: the ChatGPT vault's wrapping key is one machine-wide item shared by every Studio profile; on a machine that has none yet, the first run creates it, and the runner never deletes it. A saved OpenAI API key in the keychain is also still reachable from the children: nothing hides it. Instead the request observer classifies every request a turn makes by destination and bearer shape, and the audit stages fail on any request with an API-key bearer or to the OpenAI API, Anthropic or the WordPress.com AI proxy (`api-key-bearer`, `provider-fallback`, `fallback-attempted`). Also outside: the system temporary folder (WordPress downloads and Blueprint files while `site create` runs), the system browser (sign-in pages), and `~/.studio/pulls`, which only `studio pull` uses and no stage runs. WP-CLI's `~/.wp-cli` (its global `config.yml`, installed packages and download cache) is no longer read or written: the three `WP_CLI_*` variables above point inside the run directory.
- On every way out (pass, failed stage, thrown error, Ctrl+C) cleanup runs in this order: cancel a pending sign-in and wait for it to settle; release a held refresh and wait for it; stop the processes this runner started (by their own handles, interrupt first, then the child's own process tree by its PID); stop and unregister the disposable site and the run's own process manager (its control pipe is keyed to the run directory, so no other Studio process is touched); sign out the test registration if it is still signed in. A cleanup failure is recorded in the `cleanup` record and never replaces the stage that failed first.
- The runner never touches other registrations, and never deletes the vault's wrapping key.
- **Sign-in and sign-out ordering.** A returning sign-in begun before a sign-out still commits if it completes afterwards (the broker counts a sign-in when it is saved). So the runner never signs out while an attempt is pending: each sign-in stage waits for its outcome, and cleanup cancels and waits for a pending attempt before it signs out. An attempt that commits although it was cancelled (Ctrl+C while the browser was already coming back) is kept in `state.json` like any other, and cleanup signs it out.
- **Session-only sign-ins.** The session scenario's credential lives only in the runner's memory. That a fork's session-only token ends with the app that holds it (the fork drops it at its next broker call, or within the 2 s account poll of an active turn, and stops with `session-unavailable`) is product behaviour pinned by unit tests in `packages/agent/node/chatgpt/tests/credential-broker.test.ts` ("fails a forked turn whose app no longer holds its session…", "ends a forked turn's session-only sign-in once sending to the app that held it fails…", "ends a forked turn's session-only sign-in with the app that held it…"). This runner does not observe it: no stage ends the runner while a fork is running.

## If a run is killed

If the runner is killed before cleanup finishes, stop what it started from the repository root, in a new terminal, with the same environment the runner gives its children. Replace the run directory below with yours.

PowerShell (Windows):

```powershell
$run = 'C:\absolute\run\directory'
Get-ChildItem env: | Where-Object Name -like 'E2E_*' | ForEach-Object { Remove-Item "env:$($_.Name)" }
$env:DEV_CONFIG_DIR = "$run\profile"; $env:STUDIO_PROCESS_MANAGER_HOME = "$run\daemon"; $env:E2E = '1'
$env:E2E_SITES_ROOT = "$run\sites"; $env:E2E_APP_DATA_PATH = "$run\appdata"
$env:E2E_CLI_CONFIG_PATH = "$run\profile"; $env:E2E_SHARED_CONFIG_PATH = "$run\profile"
$env:WP_CLI_CONFIG_PATH = "$run\wp-cli\config.yml"; $env:WP_CLI_CACHE_DIR = "$run\wp-cli\cache"; $env:WP_CLI_PACKAGES_DIR = "$run\wp-cli\packages"
node apps/cli/dist/cli/main.mjs site stop --all
```

POSIX shells:

```sh
run=/absolute/run/directory
unset $(env | sed -n 's/^\(E2E_[^=]*\)=.*/\1/p')
DEV_CONFIG_DIR="$run/profile" STUDIO_PROCESS_MANAGER_HOME="$run/daemon" E2E=1 \
E2E_SITES_ROOT="$run/sites" E2E_APP_DATA_PATH="$run/appdata" \
E2E_CLI_CONFIG_PATH="$run/profile" E2E_SHARED_CONFIG_PATH="$run/profile" \
WP_CLI_CONFIG_PATH="$run/wp-cli/config.yml" WP_CLI_CACHE_DIR="$run/wp-cli/cache" \
WP_CLI_PACKAGES_DIR="$run/wp-cli/packages" \
node apps/cli/dist/cli/main.mjs site stop --all
```

Then sign the test registration out: in the same terminal, with the same variables and `STUDIO_EXPERIMENTAL_CHATGPT=1` (PowerShell: `$env:STUDIO_EXPERIMENTAL_CHATGPT = '1'`), run `node apps/cli/dist/cli/main.mjs code` and use `/chatgpt` → Sign out. You can also remove WordPress Studio's access in ChatGPT's settings. A session-only sign-in lives only in the runner's memory, so it went with the runner's process. In PowerShell the variables stay set until you close that terminal.
