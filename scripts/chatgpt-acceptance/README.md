# ChatGPT plan acceptance runner

A development-only runner that checks the ChatGPT plan provider end to end against a real ChatGPT account, and leaves sanitized, versioned evidence behind. It is built only by the development CLI build (`apps/cli/vite.config.dev.ts`); no production, npm or standalone build contains it.

Sources: `apps/cli/ai/chatgpt-acceptance-entry.ts` (entry), `chatgpt-acceptance.ts` (stages and live services), `chatgpt-acceptance-observer.ts` (request observer loaded into the CLI processes it starts), `acceptance-evidence.ts` and `acceptance-isolation.ts` (provider-neutral evidence format and run isolation, shared with other providers' runners). Offline tests: `apps/cli/ai/tests/chatgpt-acceptance*.test.ts` and `acceptance-evidence.test.ts`.

**A live run uses the account owner's real ChatGPT account and needs their consent and their presence at a browser.** Nothing reaches a network, a browser, the system keychain, a Studio profile or a site unless `--live` is passed.

## Command line

```text
npm run cli:build
node apps/cli/dist/cli/chatgpt-acceptance.mjs --scenario saved --run-dir <absolute-new-directory> [--model <model>] [--effort <effort>] [--gates T1,T2,T3,T4] [--live]
node apps/cli/dist/cli/chatgpt-acceptance.mjs --scenario session --run-dir <the-same-directory> [--live]
node apps/cli/dist/cli/chatgpt-acceptance.mjs --scenario provision --run-dir <absolute-new-directory> [--live]
node apps/cli/dist/cli/chatgpt-acceptance.mjs --scenario retire --run-dir <the-provisioned-directory> [--live]
```

| Option | Meaning |
| --- | --- |
| `--scenario saved\|session\|provision\|retire` | Required. `saved` starts a run; `session` continues the saved run in the same directory. `provision` makes a dedicated eval profile and `retire` signs it out (see "A dedicated eval profile"). |
| `--run-dir <path>` | Required. Absolute, outside `~/.studio`. For `saved` and `provision` it must not exist yet or be empty; for `session` it must hold that saved run, and for `retire` that provisioned profile. |
| `--live` | Run against the real account. Without it, the runner only checks local prerequisites and prints its plan. |
| `--model`, `--effort` | `saved` only (`session`, `provision` and `retire` refuse them). Default: the route's first qualified model and its default effort. Anything the route isn't qualified for (`packages/agent/protocol/chatgpt-models.ts`, today `gpt-6-luna` at `low` or `medium`) is refused with the reason. `session` uses the saved run's choice. |
| `--gates T1,T2,T3,T4` | `saved` only. Optional live gates, skipped (and recorded as skipped) unless named. |

Exit codes: `0` every required stage passed (a requested gate may be blocked); `1` a stage failed or was blocked, a requested gate failed, or cleanup failed; `2` refused before anything ran, which includes every run without `--live`; `130` interrupted. A second Ctrl+C ends the process trees of the CLI processes the runner started that are still running, and exits without finishing the rest of cleanup (see "If a run is killed").

**Without `--live` (dry check):** the runner validates the arguments, the run directory, the isolated environment, the state of your real Studio profile (see "Isolation"), the model and effort, and for `session` the saved run's manifest, source commit and registration. It reads only the run directory and whether two folders exist in your Studio profile, and runs `git` and `npm --version` locally. It prints the stages it would run, creates nothing and exits `2`.

## What the account owner does

Run the dry check first, then the same command with `--live`, from the repository root, on the commit to be qualified (both scenarios must run from the same commit).

1. `saved`: the browser opens ChatGPT's sign-in page **twice**. Sign in, and allow WordPress Studio to use your plan. The second time, sign in as the same account. Each sign-in must finish within 10 minutes of the browser opening; the runner says when the browser opened and prints the time left every minute. Then wait: the runner creates a disposable local site and runs the turns on its own.
2. `session`: the browser opens once. Sign in as the same account. The rest runs on its own.

The runner keeps its own Studio profile in the run directory, so this neither uses nor changes your normal Studio sign-ins. Nothing in the system keychain is shared with them either: the run's profile keeps the key to its saved ChatGPT sign-ins under a keychain item of its own, which the run removes after its sign-out (see "What still reaches outside the run directory" for the one read, never a write, of your own item). Before keys were kept per profile (earlier builds of this branch), the run's profile and yours used the same item, `chatgpt-vault-key`, so a run's first saved sign-in could replace your key where the keychain answered a locked item as missing, and your saved ChatGPT sign-ins could then no longer be opened. A fresh profile downloads WordPress and PHP the first time a site is created.

## Stages

Every stage records `passed`, `failed`, `blocked` or `skipped`, a typed code and its observations **before** anything judges it, so a failed sign-in keeps its code (`timed-out`, `denied`, `identity-mismatch`, …). After the first failed or blocked required stage the run stops and cleans up; an optional gate's result never stops it.

### `saved`

| Stage | What it does | Key observations |
| --- | --- | --- |
| `prerequisites` | Build present; the run's profile keeps its vault key under a keychain item of its own (`blocked`, `vault-key-not-scoped`, when that item would be the unscoped `chatgpt-vault-key` your own profile uses, or can't be named); which system keychain this platform uses, and that it is available (`blocked`, `secure-storage-unavailable`, when it isn't). | `buildPresent`, `vaultKeyScoped`, `storePasswordVault`, `storeKeychain`, `storeSecretService`, `secureStorageAvailable` |
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
| `gate-t1-image-tool-result` | T1: sets the site title to a marker, takes a screenshot, and the reply must read the marker from the image. Images in tool results are off on the route until this check passes, so its turn's CLI process alone also preloads `chatgpt-acceptance-tool-images.mjs`, which turns them on in that process. | `imageToolOutputsSent`, `routeAcceptedImageResult`, `markerReadFromImage`, `otherToolCalls` |
| `gate-t3-image-service-row` | T3: a `generate_images` tool row carries `details.studioService` when its event arrives, before the session persists the result. `blocked` (`image-service-not-configured`), never failed, without Studio's separate WordPress.com image service (for example `STUDIO_IMAGE_API_TOKEN`). | `detailsDelivered`, `deliveredBeforePersisted` |
| `refresh-before-sign-out` | Drops the saved access token and renews it once, so the grant rotates through the runner's own token client, which keeps the retired and the rotated refresh token in memory only (`refresh-not-forced` when no refresh went through it). | `refreshed` |
| `active-run-stops-on-sign-out` | Signs out while a real forked turn is running. The runner never interrupts it: the turn has to stop by itself. See below. | see below |
| `remote-revocation` | Separately from the broker's own report of the local clear: no vault record is left in the profile (`vault-record-left`); the sign-out's revocation of the grant `refresh-before-sign-out` rotated to was confirmed (`rotated-not-revoked-by-sign-out`); and a refresh with that rotated token, then one with the retired token, is refused (`rotated-grant-usable`, `retired-refresh-accepted`). The rotated token is probed first, as in the session scenario's refresh hold: presenting a spent token can make the service revoke the whole grant as reused. | `vaultRecordAfterSignOut`, `rotatedRevokedBySignOut`, `rotatedRefreshRejected`, `rejectionTerminal`, `retiredRefreshRejected`, `serviceConfirmedRevocation`, `revocationRequests` |
| `blocked-after-sign-out` | A later turn fails before any inference, with no fallback. | `routeRequests`, `apiKeyBearers`, `otherProviderRequests`, `reportedSignedOut` |

The active run is judged from the moment the sign-out **begins**, against the product's own bound, the turn watch poll (`CHATGPT_TURN_WATCH_POLL_MS`, 2 s, recorded as `watchPollS`):

- A model request or tool call that started before the sign-out began may finish. One that starts within the watch bound is counted (`routeRequestsInWatchWindow`, `toolStartsInWatchWindow`) and allowed. One that starts later fails the stage (`request-after-sign-out`, `tool-call-after-sign-out`), counting tool **starts** whether or not the call finished (`toolStartsAfterSignOut`; `toolRunsAfterSignOut` counts those that also ran to a result).
- The turn must end with the signed-out outcome (`reportedSignedOut`). A turn that ends successfully after the sign-out began fails with `completed-after-sign-out`; one that stops for any other reason fails with `stopped-for-other-reason`. The stage is `blocked` (`run-ended-before-sign-out`) only when the turn ended before the sign-out began (`endedBeforeSignOut`).
- `stopDelayS` is how long after the sign-out began the turn ended (expected: about one watch poll); `signOutTookS` is how long the sign-out itself took, remote revocation included.
- `stoppedByTurnHandle` means the turn's own ChatGPT connection signal ended it (its account watch, or its handle refusing the next request or tool), which the transport reports as an interrupted stop naming the sign-out. `stoppedByBrokerErrorOnly` means only an error the broker returned, when the turn next asked it for a token, reported the sign-out. Both are recorded, neither is judged, so a live run shows which one stopped the turn.

### `session`

| Stage | What it does | Key observations |
| --- | --- | --- |
| `prerequisites` | Build present. Which system keychain this platform uses and whether it answered are recorded but never block: session-only storage needs no keychain, so a run on a machine without one (headless Linux, for example) is told apart from one where the keychain was there and unused. | `buildPresent`, `storePasswordVault`, `storeKeychain`, `storeSecretService`, `secureStorageAvailable` |
| `returning-sign-in` | Browser sign-in to the saved run's registration, kept for this runner's session only. | `browserOpened`, `completedAfterS`, `timeoutS`, `timedOut`, `sameRegistration` |
| `no-persisted-record` | No credential record on disk. | `storageSession`, `vaultRecordPresent` |
| `offered-fork-inference` | A forked turn offered the session asks the runner for its token over IPC and completes a read-only reply. | `tokenAsks`, `tokensHandedOut`, `modelRequests`, `answeredReady` |
| `unoffered-process-fails` | A process started without the offer or an IPC channel fails before inference, with no other account or API key. | `routeRequests`, `tokenAsks`, `reportedUnavailable` |
| `refresh-hold-across-sign-out` | Holds a real refresh result in memory through the injectable token client, signs out, asks the owner for the session token and starts a fork while it is held, releases it. | see below |

The in-window check is made by the runner itself, which asks for the session token through the owner's answer path as a forked turn's request would reach it (a fork started in the window lists the account as disconnected and never asks); that a forked process is refused is pinned by the product's unit tests in `packages/agent/node/chatgpt/tests/credential-broker.test.ts`.

The refresh hold records: `refreshHeld`, `generationAdvancedDuringHold`, `offerAdvertisedDuringWindow` (the fork offer may linger until the held refresh settles; when it does, the runner's own ask must be answered, `windowDirectAskAnswered`, or the stage fails `window-ask-unanswered`), `windowDirectAskRefused` (answered without a token), `windowDirectAskGotToken` (must be false whether or not the offer lingered: `window-ask-got-token`), `windowForkTokenAsks` (recorded, not asserted), `windowForkTokensHandedOut` (must be 0), `windowForkRouteRequests` and `windowForkFallbackRequests` (must be 0: `inference-during-window`), `windowForkSucceeded` (must be false: `window-fork-completed`), `windowForkReportedUnavailable` (recorded), `heldRefreshRejectedSignedOut`, `offerGoneAfterSettle`, `localCleared`, `remoteRevocationConfirmed`, `rotatedRevokedBySignOut` (must be true: the sign-out's revocation of the grant the held refresh rotated to was confirmed), `rotatedRefreshRejected`, `retiredRefreshRejected`. The rotated refresh token is probed **before** the retired one: presenting a spent token can make the service revoke the whole grant as reused, which would hide whether the sign-out revoked anything. The hold is released within 20 s, under the broker's 30 s refresh timeout; if the broker gives up on a held result anyway, the runner revokes what it was issued. The waits for the hold, the window fork and the sign-out end at once on Ctrl+C; cleanup then releases the hold and waits for the sign-out the stage began. The two probes at the end are not cut short, since each revokes whatever it was issued (at most 30 s each).

### A dedicated eval profile: `provision` and `retire`

A provider-qualified eval (`scripts/eval/README.md`, "Provider-qualified parity runs") never takes its ChatGPT connection from your own Studio profile. It takes it from a dedicated test profile, which these two scenarios make and retire. Both use the same isolation, evidence and cleanup as the others.

| Scenario | Stage | What it does | Key observations |
| --- | --- | --- | --- |
| `provision` | `prerequisites` | Build present; the run's profile keeps its vault key under an item of its own (`blocked`, `vault-key-not-scoped`, otherwise, as for `saved`); system keychain available. | `buildPresent`, `vaultKeyScoped`, `storePasswordVault`, `storeKeychain`, `storeSecretService`, `secureStorageAvailable` |
| `provision` | `profile-sign-in` | One browser sign-in into the run's own profile (`<run>/profile`), saved with secure storage, and **left signed in**. Cleanup signs it out again only when the stage failed after the sign-in committed (or the run was interrupted). | `browserOpened`, `completedAfterS`, `timeoutS`, `timedOut`, `signedIn`, `storedInVault`, `leftSignedIn` |
| `retire` | `prerequisites` | Build present; system keychain available. | `buildPresent`, `storePasswordVault`, `storeKeychain`, `storeSecretService`, `secureStorageAvailable` |
| `retire` | `profile-sign-out` | Signs the provisioned registration out: its local records cleared and its grant revoked at ChatGPT; then removes the profile's own vault key item. `failed` (`remote-revocation-unconfirmed`) when the local records were cleared but ChatGPT did not confirm the revocation: remove WordPress Studio's access in ChatGPT's settings yourself. `failed` (`vault-key-not-removed`) when the item is still there after the sign-out: cleanup tries once more, and "If a run is killed" says how to remove it yourself. `blocked` (`already-signed-out`) when it was not signed in; cleanup then still removes the item, unless a saved sign-in in the profile still needs it. | `wasSignedIn`, `localCleared`, `remoteRevocationConfirmed`, `vaultKeyRemoved` |

- `provision` needs a new or empty run directory and starts no site, turn or CLI process. When it passes it prints how to use the profile: `STUDIO_EVAL_CHATGPT_PROFILE` is `<run>/profile`, and `STUDIO_EVAL_CONNECTION` is `registrationId` in `<run>/state.json` (a private file; the runner never prints identifiers or paths).
- `retire` needs that run directory: refused before anything runs when it has no manifest (`manifest-missing`), no `provision` run (`no-provision-run`) or no registration in `state.json`. It works from any commit, unlike `session`.
- While the profile is in use, an eval reads and writes its ChatGPT state in place, under the profile's own locks (nothing links to it or copies it); don't run `retire` while an eval runs on it.
- The profile's own vault key item (`chatgpt-vault-key-<16 hex digits>`) stays in the keychain while the profile is provisioned, since its saved sign-in needs it; `retire` removes it after the sign-out.
- After `retire`, the run directory still holds the account store (with the account's email address and subject identifier) in `profile/`: delete the directory when you no longer need its evidence.

## Evidence

**Only `manifest.json`, `evidence.ndjson` and `observer/` may leave this machine.** Everything else in the run directory is private and stays where it is.

Shareable:

- `manifest.json`: `schemaVersion`, `provider`, and one entry per run in `runs`: `run`, `scenario`, `createdOn` (a date), `source` (`sha`, `dirty`), `platform` (`os`, `release` (`null` when the system's release string isn't a plain version), `arch`), `runtime` (`node`, `npm`), `build` (`cliVersion`, `buildId`: the first 12 hex digits of the SHA-256 of `main.mjs`), `model`, `effort`, `gates`. Runs are appended, never replaced.
- `evidence.ndjson`: append-only, one line per stage: `schemaVersion`, `run`, `scenario`, `stage`, `status`, `code` (typed, never a message), `durationS`, `observations` (counts, booleans and durations only). Each run ends with a `cleanup` record; when cleanup removed, or failed to remove, the run profile's own vault key item, it says so in `vaultKeyRemoved`. An earlier failure stays in the file when a scenario is run again.
- `observer/*.ndjson`: per-turn request summaries (destination class, bearer shape, model, effort, item counts). Read back into the counts above.

Private, never shared:

- `state.json`: local test identifiers (registration id, site path, chat ids, the draft marker) and `vaultKeySuffix`, what follows `chatgpt-vault-key-` in the name of the run profile's own keychain item (recorded by `saved` and `provision` before any sign-in).
- `profile/`: the run's Studio profile, holding the ChatGPT account store (with the account's email address and subject identifier) and the sealed credential records. For `provision`, this is the dedicated eval profile.
- `appdata/`: the full transcripts of every chat the run held.
- `daemon/`, `sites/`: the run's process manager and its disposable site.
- `wp-cli/`: WP-CLI's cache for this run (and packages, which no stage installs).

Before anything is written, `acceptance-evidence.ts` refuses: any field outside the record's shape; a string that looks like a token (JWT, API key, bearer header, long opaque run), a URL (scheme, loopback address, host name, OAuth query parameter), an email address, an account or registration identifier (UUID) or a local path; and non-finite or out-of-range numbers. The refusal names the field, never its value. `state.json` may hold identifiers and paths but no token, URL or email. Console lines go through the same check. Authorization URLs go only to the browser; tokens stay in memory.

## Isolation and cleanup

- **Environment.** Before any application module loads, the entry (and the runner again) removes every inherited `E2E_*` variable, then sets `DEV_CONFIG_DIR=<run>/profile`, `STUDIO_PROCESS_MANAGER_HOME=<run>/daemon`, `E2E=1`, `E2E_SITES_ROOT=<run>/sites`, `E2E_APP_DATA_PATH=<run>/appdata`, `E2E_CLI_CONFIG_PATH=<run>/profile` and `E2E_SHARED_CONFIG_PATH=<run>/profile`. `E2E=1` arms every `E2E_*` path the Studio path helpers read, so each is pointed at the run. WP-CLI, which the CLI runs in a PHP process with that environment, gets its own global config, cache and packages too: `WP_CLI_CONFIG_PATH=<run>/wp-cli/config.yml` (a file the run never creates, so no global config applies), `WP_CLI_CACHE_DIR=<run>/wp-cli/cache` and `WP_CLI_PACKAGES_DIR=<run>/wp-cli/packages`, replacing any inherited values. The CLI processes the runner starts get that environment without `OPENAI_API_KEY`, `STUDIO_OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `STUDIO_WPCOM_API_KEY`; a turn also gets its observer file, and a turn that is not offered the session gets no session offer. `HOME`, `USERPROFILE` and `APPDATA` are left as they are: the system keychain and the browser opener need them. An offline test (`apps/cli/ai/tests/chatgpt-acceptance-isolation.test.ts`) checks that, under exactly that environment, every path the helpers in `packages/common/lib/well-known-paths.ts`, `apps/cli/lib/appdata.ts`, `paths.ts`, `site-paths.ts` and `dependency-management/paths.ts` export resolves inside the run directory (or to files that ship with the CLI), so a helper added later that escapes fails it, and that the environment the CLI hands the PHP process running WP-CLI (`getPhpChildEnv`) points WP-CLI's three paths inside the run directory with the home directory unchanged.
- **Refusals before anything runs.** The runner refuses when the profile or process manager would resolve to `~/.studio`, and when your real profile has `.studio/pm2` but no `.studio/daemon`: every CLI process renames that folder under your home directory whatever its environment (CLI migration 03). Run any command of your installed Studio CLI once, for example `studio site list`, to finish that rename, then run the runner again. The check only reads whether the two folders exist.
- **What still reaches outside the run directory.** The system keychain, where a run never writes, replaces or removes anything your normal sign-ins use. The run's profile keeps the ChatGPT vault's wrapping key under an item of its own, `chatgpt-vault-key-<16 hex digits>` (from a hash of the profile's real path, never the path), not under the item your own Studio profile uses (`chatgpt-vault-key`, service `wordpress-studio`); `saved` and `provision` are blocked before any sign-in (`vault-key-not-scoped`) when the run's profile would use that one. The first secure sign-in in a run's profile creates its item. Cleanup removes it once the run's registration is signed out (for a `provision` run that passed, `retire` does) and records `vaultKeyRemoved`; a run killed before then leaves it (see "If a run is killed"). Your own item is read in one case only, and never written: a profile whose own item reads as missing while one of its accounts has a sealed record (as a locked keyring may answer) reads that shared item for its records, read-only, because a profile whose sign-ins were saved before keys were kept per profile (by earlier builds of this branch, under the shared `chatgpt-vault-key`) still needs it; a record that key can't open is kept and reported `vault-key-unreadable`. Such a profile still opens and renews its old sign-ins that way, but refuses a new "Secure storage" sign-in with `vault-key-unreadable`: sign out every saved account in that profile, and the next secure sign-in makes the profile's own item. Before keys were kept per profile, every profile, a run's included, wrote and read that one shared item. A saved OpenAI API key in the keychain is also still reachable from the children: nothing hides it. Instead the request observer classifies every request a turn makes by destination and bearer shape, and the audit stages fail on any request with an API-key bearer or to the OpenAI API, Anthropic or the WordPress.com AI proxy (`api-key-bearer`, `provider-fallback`, `fallback-attempted`). Also outside: the system temporary folder (WordPress downloads and Blueprint files while `site create` runs), the system browser (sign-in pages), and `~/.studio/pulls`, which only `studio pull` uses and no stage runs. WP-CLI's `~/.wp-cli` (its global `config.yml`, installed packages and download cache) is no longer read or written: the three `WP_CLI_*` variables above point inside the run directory.
- On every way out (pass, failed stage, thrown error, Ctrl+C) cleanup runs in this order: cancel a pending sign-in and wait for it to settle; release a held refresh and wait for it; stop the processes this runner started, by their own handles: a turn is first asked over its IPC channel to stop, and any process still running 3 s later (at once for one with no channel) has its whole process tree ended while it still runs, so nothing it started is left without a parent first: on Windows `taskkill /T /F` by that process's PID, on POSIX SIGKILL to the process group it leads (each is started as the leader of a group of its own; a process that starts a group or session of its own, as the process manager and WP-CLI's PHP processes do there, isn't in it); never anything by name; stop and unregister the disposable site and the run's own process manager (its control pipe is keyed to the run directory, so no other Studio process is touched); sign out the test registration if it is still signed in (a `provision` run leaves its registration signed in once `profile-sign-in` passed); then, for `saved`, `provision` and `retire` once past `prerequisites`, remove the run profile's own vault key item, which the broker refuses while a saved sign-in in the profile still needs it (a `provision` run that passed keeps it). A cleanup failure is recorded in the `cleanup` record and never replaces the stage that failed first.
- The runner never touches other registrations. The only keychain item it ever removes is its own profile's `chatgpt-vault-key-<16 hex digits>`, through the broker's own removal call, after that profile's sign-out: never `chatgpt-vault-key`, and never by a pattern.
- **Sign-in and sign-out ordering.** A returning sign-in begun before a sign-out still commits if it completes afterwards (the broker counts a sign-in when it is saved). So the runner never signs out while an attempt is pending: each sign-in stage waits for its outcome, and cleanup cancels and waits for a pending attempt before it signs out. An attempt that commits although it was cancelled (Ctrl+C while the browser was already coming back) is kept in `state.json` like any other, and cleanup signs it out.
- **Session-only sign-ins.** The session scenario's credential lives only in the runner's memory. That a fork's session-only token ends with the app that holds it (the fork drops it at its next broker call, or within the 2 s account poll of an active turn, and stops with `session-unavailable`) is product behaviour pinned by unit tests in `packages/agent/node/chatgpt/tests/credential-broker.test.ts` ("fails a forked turn whose app no longer holds its session…", "ends a forked turn's session-only sign-in once sending to the app that held it fails…", "ends a forked turn's session-only sign-in with the app that held it…"). This runner does not observe it: no stage ends the runner while a fork is running.

## If a run is killed

If the runner is killed before cleanup finishes, stop what it started from the repository root, in a new terminal, with the same environment the runner gives its children. Replace the run directory below with yours. On POSIX the CLI processes it started lead process groups of their own, so closing the terminal doesn't end a turn that was still running when the runner was killed: find it among your `node` processes running `apps/cli/dist/cli/main.mjs code sessions resume`, and end it by its PID.

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

Last, once the registration is signed out (the sign-out needs the key to open its record), remove the run profile's own keychain item, unless the run is a provisioned eval profile you are still using. Its exact name is `chatgpt-vault-key-` followed by `vaultKeySuffix` from `<run>/state.json` (16 hex digits). `saved` and `provision` record it before any sign-in, so a run directory without it made no item, unless an earlier version of the runner, which recorded none, made that directory. Type that full name, as below: never remove `chatgpt-vault-key` on its own, which is your own Studio profile's key, and never remove items by a pattern. Replace `<vaultKeySuffix>` with the recorded value.

PowerShell (Windows):

```powershell
[void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
$vault = New-Object Windows.Security.Credentials.PasswordVault
$vault.Remove($vault.Retrieve('wordpress-studio', 'chatgpt-vault-key-<vaultKeySuffix>'))
```

macOS: `security delete-generic-password -s wordpress-studio -a chatgpt-vault-key-<vaultKeySuffix>`

Linux: `secret-tool clear service wordpress-studio account chatgpt-vault-key-<vaultKeySuffix>`

## Saved sign-ins on Linux: what persistent storage needs

A sign-in kept with "Secure storage" is a sealed record in the Studio profile whose key lives in the system keychain; on Linux that is the Secret Service, reached through libsecret's `secret-tool`. The Desktop app, the standalone CLI (`studio code`, `/chatgpt`) and this runner need all of:

- `secret-tool` on the `PATH`: `libsecret-tools` on Debian and Ubuntu, `libsecret` on Fedora and Arch. The Desktop `.deb` recommends `libsecret-tools`, so `apt` installs it unless recommended packages are turned off (`--no-install-recommends`). The standalone CLI declares no system packages: install it yourself.
- A Secret Service running on your session's D-Bus: GNOME Keyring, KWallet's Secret Service interface on KDE Plasma, or KeePassXC with its Secret Service integration turned on.
- Its default collection unlocked, or a desktop session that can ask you to unlock it. An installed `secret-tool` alone is not enough.

Without them Studio says so before it offers to keep a sign-in. When `secret-tool` is missing, or there is no session bus (SSH, a container, a server without a desktop), or no Secret Service on it, the keychain check fails with the tool's reason: Settings shows secure storage as unavailable, `/chatgpt` offers only "This app session" and, on Linux, says what keeping a sign-in needs (the same list as above), and a saved sign-in tried anyway fails with `vault-unavailable` and writes nothing. Studio never falls back to a plaintext file and never switches to session-only storage by itself. "This app session" keeps the sign-in in that process's memory until it exits.

A locked keyring may answer a lookup as if nothing were saved. So while any saved account still has a sealed record, Studio never reads a missing key as lost: using that account fails with `vault-key-unreadable` ("couldn't read the key… unlock the keychain and try again"), its record and its signed-in state are kept, and a new "Secure storage" sign-in is refused, before any browser opens and again when saving should the keyring lock in between, rather than make a key that would replace the one those records need. While no account has a sealed record, nothing is asked of the keyring before the browser opens: a first sign-in meets any unlock prompt only when it saves. "This app session" still works when chosen. Once the keyring is unlocked, the kept records open again. If the key really is gone, sign out of every saved ChatGPT account: that removes their records, and the next "Secure storage" sign-in makes a new key.

Signing in needs a browser **on the same machine**: Studio opens the system browser and waits for ChatGPT's answer on `127.0.0.1` there. The browser opener (`xdg-open`, `open`, or on Windows a fixed PowerShell command that reads the address from its environment) is given only a one-time address on that `127.0.0.1` listener, which sends the browser on to ChatGPT's sign-in page once, so nothing of the sign-in request appears on a command line other users can read. On Linux, where other local users can read that start address from the opener's command line, the listener also looks up who owns the other end of each request in the kernel's socket tables (`/proc/net/tcp` and `/proc/net/tcp6`; nothing is run), opened once when the listener starts and scanned again, as they are read, for each request, whatever their size. It refuses, without using up the address or changing the sign-in, a request that belongs to another user who isn't root (`nobody` included, where every uid is mapped as in the initial user namespace): that page says the link isn't valid. It also refuses one it can't check, because a table failed to read (too many open files, an I/O error, a lookup over 2 seconds), a table's header isn't the kernel's, or the request's own row doesn't parse: that page says to reload it, and reloading works. Rows of other sockets that don't parse are skipped. Your own user, root (a relay such as WSL's localhost forwarding), a socket listed in no table it could read, or a table the kernel hides (absent or forbidden) go through. On every platform the listener serves at most 8 connections at once and closes one that hasn't sent its request within 10 seconds; a client that leaves before its answer doesn't use up the address. Without a browser (no `xdg-open`, or `xdg-open` finds none), the sign-in fails at once with "Studio couldn't open your web browser" (`browser-unavailable`). A browser on another machine can't complete it, and Studio offers no remote or device-code callback.

## Opt-in native keychain tests

Two test files use this machine's **real** system keychain (Windows Credential Manager, the macOS Keychain or the Linux Secret Service) and are skipped, with the reason in the test name, unless `STUDIO_NATIVE_CREDENTIAL_STORE_TEST=1` is set:

- `packages/common/lib/tests/os-credential-store-native.test.ts`: the store itself. It checks the keychain is available; saves, reads, replaces and removes a secret; reads in a fresh process what this one saved and the other way round; keeps option- and shell-looking secrets exactly; takes long secrets (1,024 to 16,384 characters) whole or refuses them, never storing part of one or losing the previous value, and prints which lengths it took; refuses secrets that would need escaping before anything is written.
- `packages/agent/node/chatgpt/tests/credential-vault-native.test.ts`: the ChatGPT vault on that keychain. A sign-in with 26 KB of tokens read back by a fresh process, with only the 43-character key in the keychain; a damaged record (ciphertext changed) asking for a sign-in again while the key stays; a deleted key reported as unreadable (`vault-key-unreadable`) with the record and the account kept and a new secure save refused, and, once the account is signed out, the next sign-in making a new key; a session-only sign-in staying out of the keychain and off the disk.

Their gating, naming and cleanup live in `packages/common/lib/tests/utils/native-credential-store.ts` and are proven offline, against an in-memory keychain, by `packages/common/lib/tests/os-credential-store-native-harness.test.ts`, which runs everywhere.

**What they write and remove.** Everything goes under one keychain service named for the run, `studio-native-test-<16 random hex digits>`, never Studio's own `wordpress-studio`, so Studio's saved keys and other programs' entries are never read or touched. Accounts under it: `round-trip`, `across-processes`, `option-like`, `long` and `needs-escaping` (refused before anything is written) from the store file, and the temporary profile's own vault key, `chatgpt-vault-key-<16 hex digits>`, from the vault file. Values are generated at random by the tests, never taken from the machine; longer ones start `test-only-`, and the vault's tokens `test-access-token-`, `test-id-token-` and `test-refresh-token-`. The vault file also uses a temporary profile, `studio-native-vault-*` in the system temporary folder. Each test removes the entries it wrote under that service, and the temporary profile, whether it passes or fails; an entry it can't remove fails the test with its account and service names, and never a value.

**Never in CI.** The tests refuse to run when `CI` is set, whatever the opt-in says. `.github/workflows/subscription-provider-checks.yml` doesn't set the variable (its header forbids `STUDIO_NATIVE_*` variables), so its `npm test` step lists both files as skipped.

**Running them**, from the repository root, on a machine whose owner agreed to test entries in their keychain:

```sh
STUDIO_NATIVE_CREDENTIAL_STORE_TEST=1 npx vitest run packages/common/lib/tests/os-credential-store-native.test.ts packages/agent/node/chatgpt/tests/credential-vault-native.test.ts --maxWorkers=1
```

```powershell
$env:STUDIO_NATIVE_CREDENTIAL_STORE_TEST = '1'
npx vitest run packages/common/lib/tests/os-credential-store-native.test.ts packages/agent/node/chatgpt/tests/credential-vault-native.test.ts --maxWorkers=1
Remove-Item env:STUDIO_NATIVE_CREDENTIAL_STORE_TEST
```

Each test allows three minutes, for a keychain prompt that waits for you.

**Per platform:**

- **Windows:** an interactive desktop logon, and Windows PowerShell (`powershell.exe`) on the `PATH`. Over SSH or as a service, expect "A specified logon session does not exist": that is the headless result, recorded as such, not a pass.
- **macOS:** a logged-in desktop session with the login keychain unlocked. The first write may ask to allow `security`: allow it. Over SSH `security` can't ask, so the tests fail with "User interaction is not allowed" unless you unlock the keychain first (`security unlock-keychain`): record either as the headless result.
- **Linux:** what "Saved sign-ins on Linux" above lists, from a terminal inside the desktop session (so `DBUS_SESSION_BUS_ADDRESS` is set). Without a session bus or a Secret Service, every test fails at its first keychain call with the tool's reason: the headless result. A Secret Service started in a throwaway D-Bus session is a separate result again ("headless with a keyring").

**Not automated, Linux:** with the default collection locked, `secret-tool lookup` asks to unlock it. libsecret's lookup returns no value and no error when that unlock leaves nothing unlocked, which is also how `secret-tool` reports that nothing is saved (exit 1, no output). Whether a *dismissed* unlock prompt ends that way depends on the Secret Service and is not established offline. Studio is built to be safe either way (see "Saved sign-ins on Linux" above); this check records which answer this desktop gives and confirms nothing is lost. On a test account only, from a terminal in the desktop session:

1. Keep a sign-in with Secure storage, in your default profile (`~/.studio`; in any other profile the account below is that profile's `chatgpt-vault-key-<16 hex digits>`). Note a fingerprint of the key for step 5, never the key itself, and keep it out of the evidence: `secret-tool lookup service wordpress-studio account chatgpt-vault-key | sha256sum`.
2. Lock the collection (for example in Seahorse). Run `secret-tool lookup service wordpress-studio account chatgpt-vault-key > /dev/null; echo "exit $?"`, dismiss the unlock prompt, and record the exit code and whatever it printed to the terminal (stderr). That is what a dismissed prompt returns here.
3. With the collection still locked, start a ChatGPT turn on that account and dismiss every unlock prompt. Record the message shown (expected: Studio couldn't read the key, `vault-key-unreadable`, or the keychain couldn't be reached, `vault-unavailable`), that `/chatgpt` still lists the account as signed in rather than needing a sign-in, and that its `<registration id>.vault` file is still in `chatgpt-credentials` under the Studio profile.
4. Still locked, try a new `/chatgpt` sign-in with "Secure storage" and dismiss the prompts. Record that it is refused with the same reason and that no account was added.
5. Unlock the collection. Record whether the fingerprint matches step 1's (it should: no new key was written) and that a ChatGPT turn on the account works again.
6. Still on that test account, with the collection locked and its key unreadable as in step 3, start a `/chatgpt` sign-in with "Secure storage": record that it is refused at once with the `vault-key-unreadable` explanation and that no browser opens.

**Not automated, Linux: the sign-in listener answers only its own user.** This has never run on a real Linux kernel. On a machine with a second local account you control:

1. **Your own browser is let through.** Sign in from the desktop's browser as usual and record that it completes: the browser followed the local redirect and ChatGPT's page loaded. In the browser's developer tools (Network, with "Preserve log" on), record that the request for ChatGPT's page carried no `Referer` header. Repeat with a Snap or a Flatpak browser if the machine has one, and record which.
2. **The tables are opened once, and the limit on open files.** For each process that can run the sign-in listener (the Desktop app's main process, the CLI's `studio code`, and the `studio ui` server), record `grep 'Max open files' /proc/<pid>/limits`. While a sign-in from one of them waits, record `ls -l /proc/<pid>/fd | grep -c 'net/tcp'` (expected `2`, `/proc/net/tcp` and `/proc/net/tcp6`), and again after the browser's request and after step 3's refused one: it should stay `2`.
3. **Another account is refused, and the address survives it.** Make a stand-in opener that records the address instead of opening a browser. Put an executable file named `xdg-open` in an empty directory, with two lines: `#!/bin/sh` and `printf '%s\n' "$1" > "$HOME/studio-start-address"`. Run the CLI with that directory first on `PATH` and start a `/chatgpt` sign-in, which then waits. Make the recorded address readable to the second account, then:
   - As the second account, run `curl -s -D - -o /dev/null "<address>"`. Record the status line (expected `400`) and whether a `Location` header came back (expected none). Keep any `Location` value out of the evidence.
   - As the second account again, hold the listener's connections: `for i in 1 2 3 4 5 6 7 8; do sleep 30 | nc 127.0.0.1 <port> & done` (the port is in the address). Within those 30 seconds, run the `curl` above once more and record that it gets no answer (`curl` reports an empty reply or a reset); after about 10 seconds, record that each `nc` printed `HTTP/1.1 408 Request Timeout`: the listener closed the idle connections.
   - As yourself, run `curl -s -o /dev/null -w '%{http_code}\n' "<address>"`. Record `302`: neither the refused request nor the held connections used the address up.
   - Cancel the sign-in (Esc).
4. **WSL2, in both networking modes.** Sign in from the Windows browser to the CLI running in WSL2, first in the default NAT mode, then with `networkingMode=mirrored` under `[wsl2]` in `%UserProfile%\.wslconfig` (run `wsl --shutdown` after changing it), and record for each whether it completes. The connection reaches the listener through WSL's localhost forwarding, which the check treats as root or as an owner it can't establish, so it should go through.
5. **Table sizes, and a table longer than one read.** Record `wc -c /proc/net/tcp /proc/net/tcp6` on this machine and on a busy one (a development host with many open connections: containers, a database, browsers). On a machine whose `/proc/net/tcp` is larger than one 4 KiB page (some 27 sockets or more), record that step 1's sign-in completes: the kernel then hands the table over in several reads.
6. **Emulated `/proc`: WSL1 and gVisor.** Sign in from a browser in the same environment to the CLI running on WSL1, and in a gVisor sandbox (`runsc`) if you have one. Record whether it completes, is told the link isn't valid, or is told to reload, and the first line of `/proc/net/tcp` there (its header).
7. **Reload after "couldn't check".** If any request in these checks gets the page "WordPress Studio couldn't check this sign-in just now. Reload this page to try again.", record what was going on, reload the page, and record that the sign-in then completes.

**If a run is killed** before a test cleans up, remove what the failure or the console named:

- Windows PowerShell: `[void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]; $vault = New-Object Windows.Security.Credentials.PasswordVault; $vault.RetrieveAll() | Where-Object Resource -eq 'studio-native-test-<run id>' | ForEach-Object { $vault.Remove($_) }` with the service the failure named (it lists entries without their passwords, and removes only that run's, never another run's still going).
- macOS: `security delete-generic-password -s studio-native-test-<run id> -a <account>` for each account.
- Linux: `secret-tool clear service studio-native-test-<run id> account <account>` for each account.

**What to record** for each platform: the OS, its version and architecture, Node, the source commit, each test's result, and the "took secrets of … characters whole" line. Neither file prints a secret; a failed assertion may show the fake test values.
