# Agent Evaluation

[PromptFoo](https://www.promptfoo.dev/) eval suite for the Studio Code agent. Runs the real agent and judges the outcome: the site it leaves behind, the sites it leaves alone, and what it tells the user. Which tools the agent used, and in what order, is not judged.

## Usage

```bash
studio auth login
npm run eval
npm run eval:view
```

`studio auth login` is all the suite needs — the agent under test runs through the WP.com AI proxy like the real app, and every assertion is a deterministic JavaScript check in `outcome.mjs`. (There is no LLM grader; see "Graded assertions" below.)

This suite runs on the globally configured provider, so a pass is regression evidence for that provider only, never evidence for a subscription route. For a provider-qualified run see "Provider-qualified parity runs" below.

`npm run eval -- -n 1` to run a single test.

Each case creates its sites in a temporary folder of its own instead of `~/Studio`, so concurrent cases, including repeats of one case, never share or delete each other's sites. Ports are the one thing still shared: two cases starting sites at the same moment can pick the same free port, so the config keeps `maxConcurrency: 1`.

Run one named test with `npm run eval -- --filter-pattern "preview sites"` (regex against the test description). Note: the flag is `--filter-pattern`, **not** `--filter-description` (which is not a valid promptfoo flag).

## How a case is judged

After the turn, the runner captures what it left (`apps/cli/ai/eval-outcome.ts`) into the result's `outcome`:

- **Each site the turn created, and the seeded active site:** active theme and parent, active plugins, every published page, post, template, template part, navigation and pattern (content plus block counts), registered block style variations, the merged theme palette and styles, saved Global Styles, custom CSS, `DESIGN.md`, the active theme's files, its screenshot's real format, and which theme files differ from their WordPress.org release. The home page is rendered (status, PHP errors, navigation links, element ids), and every published page, template and part is validated in the site's own block editor.
- **Every other site:** whether the turn changed or removed it, by its `wp-content` modification time. Each case runs against its own site registry holding two stopped sites the request is not about ("Portfolio" and "Client Work"), so concurrent cases and the user's real sites stay out of the comparison.

The checks in `outcome.mjs` read that state. A case names the site it asks for in `vars.siteName`; the runner deletes a leftover from an earlier run before the turn, so prompts read the way a user would write them. Most site cases also assert `siteWorks` (renders without PHP errors, all blocks valid) and `otherSitesUntouched`.

## Cases

- **identity** — The reply identifies as WordPress Studio.
- **global-instructions** — The reply carries the sentinel token from the seeded global instructions (`knowledge/instructions.md` in the case's own Studio profile, removed with it).
- **site-creation** — The requested site exists and works.
- **screenshot-all-timing** — The model saw a desktop and a mobile capture of the home page, in under 15s of screenshot time. Runs on the `balanced` tier, since text-only models get files instead of image payloads.
- **single-page-build-turn-cadence** — A one-page build: a static front page with blocks, the site's own theme (self-hosted fonts that exist, a real JPEG or PNG screenshot), a palette that carries the `DESIGN.md` colors, no turn over 60s, and a closing message offering the performance and SEO audits.
- **one-page-nav-anchor-links** — The rendered navigation's section links work from every page: home-relative (`/#contact`, not `#contact`), and each target id exists on the home page.
- **differentiate-preview-vs-remote** — Regression for STU-1775. The reply describes the seeded preview as a preview and the connected site as a WordPress.com remote site.
- **push-confirms-target** — The seeded remote no longer exists. No push ran and the reply asks the user for a target.
- **feedback-confirms-message** — The agent showed a draft of the feedback that names what the user reported, asked before sending, and never called `send_feedback` once the user declined.
- **feedback-skill-confirms-message** — The same, invoked through the `/feedback` skill.
- **jetpack-catchall-slideshow** — Jetpack is active and the front page uses a `jetpack/*` block.
- **woocommerce-shop-setup** — WooCommerce is active with published products.
- **child-theme-for-installed-theme** — Regression for STU-2017. The active theme is a child of Ollie, Ollie still matches its WordPress.org release file for file, and headings have a font family.
- **section-uses-theme-palette** — The site keeps Twenty Twenty-Five, and what the turn added (pages, saved templates, custom CSS, theme files changed from the release) uses palette colors with no hardcoded hex.
- **inline-block-constrained-alignment** — No CSS rule gives a block wrapper class an inline-level `display`, which escapes the constrained layout's centering.
- **repeated-treatment-uses-block-style** — A registered block style variation is applied at least twice, and no raw font size repeats three or more times.
- **active-site-reused** — A plan-only request on the active site creates no new site.
- **active-site-different-name** — With an active site and a request naming another site, no site is created or changed and the reply asks whether to use the active site or a new one.
- **design-system-annotation** — `DESIGN.md`'s primary color changed, and the active theme's palette carries the new value.
- **template-part-db-override** — Regression for STU-2155. The header WordPress renders opens submenus on click and keeps the user's Site Editor tagline, or the agent asked about the customization.
- **global-styles-db-override** — Regression for STU-2155. The rendered background is the requested color with the saved line height intact, or the agent asked about the saved styles.
- **routing-\*** — Routing: the skills in `skills` (a list of `{ "name": "…" }` objects, like `followUps`, so promptfoo keeps them in one test) were loaded before the agent started the work. These are the one kind of case judged on the route rather than the outcome, since which runbook the agent read is the thing under test. Each run stops at its first call that does the work (`stopAt`), so it costs only the turns before it. Run just these with `npm run eval -- --filter-pattern "^routing:"`.

## Provider-qualified parity runs

> **A pass on the default provider is regression evidence only.** `npm run eval` runs on whatever provider is configured globally (WordPress.com, an Anthropic API key or an OpenAI API key), and a model name such as `STUDIO_EVAL_MODEL=gpt-6-luna` never picks a billing route: the OpenAI API also serves that slug. Such a run says nothing about a subscription route. Only a run with an explicit provider selection whose `ranOnRequestedRoute` check passed counts as evidence for a provider route, and only for the provider, connection, model and effort it reports.

`subscription-parity.config.yaml` runs the same Studio workflows on one explicitly selected provider and connection. Every case sets `requireProvider` (a run that selects no provider is refused) and asserts `ranOnRequestedRoute` and `noWordPressComWrites`. The config names no provider, connection, profile, model or effort: they come from the environment, so another subscription provider runs the same config with its own selection.

### A dedicated ChatGPT test profile

A ChatGPT eval never uses your own Studio profile (`~/.studio`) for its ChatGPT connection. It takes the connection from a **dedicated test profile**: a folder you sign in to only for testing, with the ChatGPT acceptance runner (`scripts/chatgpt-acceptance/README.md`, scenarios `provision` and `retire`). In order, from the repository root, with your consent each time (nothing here runs without `--live`):

```bash
npm run cli:build
# 1. Create the dedicated profile and sign in to it (the browser opens once). Dry check first.
node apps/cli/dist/cli/chatgpt-acceptance.mjs --scenario provision --run-dir <new absolute folder>
node apps/cli/dist/cli/chatgpt-acceptance.mjs --scenario provision --run-dir <new absolute folder> --live
# 2. Run the parity eval on it. The profile is <run folder>/profile; the registration id is
#    "registrationId" in <run folder>/state.json (a private file: it never leaves your machine).
STUDIO_EXPERIMENTAL_CHATGPT=1 \
STUDIO_EVAL_PROVIDER=chatgpt-oauth \
STUDIO_EVAL_CHATGPT_PROFILE=<run folder>/profile \
STUDIO_EVAL_CONNECTION=<registration id> \
STUDIO_EVAL_MODEL=gpt-6-luna \
STUDIO_EVAL_EFFORT=medium \
npm run eval:parity -- --filter-pattern "^parity"
# 3. The per-model smoke (gate T4) runs in the acceptance runner's own saved scenario, in another new folder.
node apps/cli/dist/cli/chatgpt-acceptance.mjs --scenario saved --run-dir <another new absolute folder> --gates T4 --live
# 4. Retire the dedicated profile: sign its registration out, locally and at ChatGPT.
node apps/cli/dist/cli/chatgpt-acceptance.mjs --scenario retire --run-dir <run folder> --live
```

PowerShell: set each variable with `$env:NAME = 'value'` first, then run the `npm run` line; `Remove-Item env:NAME` afterwards. Run the eval from a shell where `DEV_CONFIG_DIR` is unset or points anywhere but the dedicated profile (`profile-is-config-directory` otherwise). After `retire`, the run folder still holds the account store (with the account's email address) and the signed-out records: delete the folder when you no longer need its evidence.

How a case reaches the connection: before anything else, the runner checks `STUDIO_EVAL_CHATGPT_PROFILE` (an absolute path to an existing folder that is not `~/.studio`, not inside it, does not resolve into it through a link, and is not the folder the eval process keeps its own Studio config in), then points this process's ChatGPT state at it with `setChatGptStateDirectory` (`packages/agent/node/chatgpt/state-directory.ts`, development-only callers; it refuses to move the state once used), and only then lists the connections there. Every read and write of ChatGPT state (the account index, the sealed credential records, a refresh, a sign-in marked as needed) happens in the dedicated profile itself, under the lockfiles that profile's own processes take. Nothing links to or copies credential state; the case's own Studio profile (`shared.json`, global instructions) and site registry are still temporary folders of its own (below). The agent runs in the eval process, so no forked process needs the profile. The runner also installs the ChatGPT token client and writes the conversation's ChatGPT record before every turn, as the CLI does.

**The source profile, read only.** The Studio profile the eval process starts with (`DEV_CONFIG_DIR`, or `~/.studio` when it is unset) is the source. Each case only reads it, for the copy of your WordPress.com login and for links to Studio's downloads (`server-files`, `php-bin`, `import-runtime`); then, for the whole case, `DEV_CONFIG_DIR`, which every Studio path helper reads first, names the case's temporary profile, and it is put back when the case ends. So what a case seeds (global instructions, connected sites) and whatever its turn writes to the Studio profile (`shared.json`, the global instructions, the mu-plugins a site start writes) stay in the case's profile, whether or not `DEV_CONFIG_DIR` is set. The download links are read as Studio reads them; a case that needed a download the source doesn't have yet (a PHP version, the import runtime) would make it there through the link, as Studio itself would. A case that names a provider also runs its sites under a process manager of its own (`STUDIO_PROCESS_MANAGER_HOME`, a `studio-eval-daemon-*` folder in the system temporary folder), which the runner ends, with any site it still runs, when the case ends; a case on the default path uses the process manager it always did.

**WordPress.com login.** A provider-qualified case gets your WordPress.com login the same way every eval case does: a copy of the login from the source profile, written into the case's temporary profile and removed with it. It is used for WordPress.com reads and, in cases labelled `[image service]`, for Studio's image service, exactly as the rest of the suite uses it. Under `remote: mock` no state-changing request leaves the eval process itself (below); a command the agent starts from its shell still runs with that copy of your login and is not covered. Every parity case states its image-service mode (see "Image service" below): `"required"` for the `[image service]` cases, `"off"` for a case that is purely local (no copy of the login), and `"unused"` for a case that needs a signed-in WordPress.com state without images.

### Selecting a provider

| Setting | Where | Meaning |
| --- | --- | --- |
| `STUDIO_EVAL_PROVIDER` | environment, or the case's `provider` var (they must agree) | `chatgpt-oauth`, `openai-api-key`, `anthropic-api-key` or `wpcom`. Without it the runner takes the default path, exactly as before. |
| `STUDIO_EVAL_CHATGPT_PROFILE` | environment only | ChatGPT: the dedicated test profile's absolute path. Never read from a config. |
| `STUDIO_EVAL_CONNECTION` | environment only | The connection a subscription provider runs on, saved in that profile. Never read from a config. |
| `STUDIO_EVAL_MODEL` | environment, or the case's `model` var | For ChatGPT, a slug the route is qualified for (`packages/agent/protocol/chatgpt-models.ts`, today `gpt-6-luna`); default: the table's first. For a legacy provider, one of its models; default: its default. |
| `STUDIO_EVAL_EFFORT` | environment, or the case's `effort` var | ChatGPT only: a qualified effort for the model (`low` or `medium` for `gpt-6-luna`); default `medium`. |
| `requireProvider: true` | case var | Refuses a run that selects no provider. |

A selected run executes on that provider (and, for ChatGPT, that connection in that profile) or is refused before any site, turn or model request. The result then has `success: false`, `refusal: { code, message }` and `providerRoute.failure`, and `ranOnRequestedRoute` fails with the code. Nothing falls back to the global provider, another connection, profile, model or effort:

| Code | When |
| --- | --- |
| `provider-unknown`, `provider-conflict`, `provider-required`, `selection-without-provider` | The selection itself: an unknown id; the environment and the case name different providers; a `requireProvider` case with no provider; a connection, profile or effort with no provider. |
| `connection-required`, `connection-not-applicable` | ChatGPT without `STUDIO_EVAL_CONNECTION`; a connection for a legacy provider (they have one implicit connection). |
| `profile-required`, `profile-relative`, `profile-not-found`, `profile-in-studio-profile`, `profile-is-config-directory`, `profile-unavailable`, `profile-not-applicable` | ChatGPT without `STUDIO_EVAL_CHATGPT_PROFILE`; a relative path; no such folder; `~/.studio`, a folder inside it or a link resolving into it; the folder `DEV_CONFIG_DIR` names, which the eval reads as its source profile; this process already reads ChatGPT state elsewhere; a profile for a legacy provider. |
| `experimental-flag-off` | `STUDIO_EXPERIMENTAL_CHATGPT=1` is not set. |
| `connection-unknown`, `connection-signed-out`, `connection-unsupported`, `connection-state-unavailable` | No such ChatGPT connection in the dedicated profile; it isn't signed in there (a session-only sign-in lives only in the app that holds it, so sign in with secure storage); it isn't a ChatGPT connection Studio's agent runs on; the profile's connections can't be read. |
| `model-not-qualified`, `effort-not-qualified` | A model or effort the ChatGPT route isn't qualified for, with the same explanation the app gives. |
| `effort-not-applicable`, `model-provider-mismatch`, `provider-not-ready` | A legacy provider given an effort, a model it doesn't serve, or no credentials. |
| `staging-not-designated`, `staging-not-confirmed`, `staging-needs-active-site`, `history-needs-provider`, `fixture-missing`, `image-service-not-configured`, `image-service-still-configured` | A case's own setup, below. |

### What the run reports

A selected run's result has `providerRoute`:

- `requested`: `kind` (the provider), `backend` (where its model requests go: `chatgpt-route`, `openai-api`, `anthropic` or `wpcom-ai-proxy`), `subscription`, `connectionRef`, `model`, `wireModel` (the model id requests carry, or null where the observer can't see it) and `effort`.
- `executed`, read back from the run: the runner wraps `fetch` with the ChatGPT acceptance runner's request observer (`apps/cli/ai/chatgpt-acceptance-observer.ts`), which classifies each request by destination and bearer shape and keeps no URL, header, token or content, for as long as the case's turns run. From it: `kind` and `backend` (`mixed` when the requests went to more than one route, `none` when there were none), `modelRequests`, `apiKeyBearers`, `imageServiceRequests` (Studio's separate WordPress.com image service, kept apart from inference), `models`, `efforts` and `requests` (per request: destination, bearer shape, model, effort, input and image counts, and `turn`, the user message it belongs to). `replyKinds` and `replyModels` are the providers and models the runtime stamped on its replies.
- `connectionRef`: for ChatGPT, a fingerprint (`conn-` and 12 hex digits of a hash of the registration id, a random local identifier) of the connection the conversation's record names. The runner writes that record from the selection before every turn and the runtime refuses a turn whose record differs from the connection it begins, so this field restates the selection: it is not evidence of which account served the run. For a legacy provider it is the provider id.
- `connectionMatchesBearer`: the evidence. While the turns run, the observer hands each ChatGPT route request's `authorization` header, in memory, to a comparison the plan built from the selected registration's recorded identity (the `sub` of the ID token it was signed in with). The bearer's `sub` claim is read without verifying the token's signature, compared, and dropped; only the answer is kept. `true` when every route request's bearer named that identity, `false` when any named another, `unverified` when any bearer could not be decoded or carried no `sub`, `null` for a legacy provider. No claim, subject, email or hash of one is written anywhere. This evidence assumes the access token's `sub` equals the ID token's `sub` (the identity recorded at sign-in). That is unverified until the first live run; if they differ, runs fail closed with `connection-mismatch`.

What `connectionMatchesBearer: true` proves: every model request on the ChatGPT route carried an access token issued for the same ChatGPT identity the selected registration was signed in as. What it does not prove: which of several registrations of that same identity served it (the registration is held by the runtime's own checks, restated by `connectionRef`); that ChatGPT accepted the token (the request outcomes say that); that the token is genuine (its signature is not checked; the route checks it); or anything about requests that did not go to the ChatGPT route (kept apart by `kind`, `backend` and `apiKeyBearers`).

`ranOnRequestedRoute` fails when no provider was selected, the run was refused, no model request ran, the executed kind, backend or connection differs from the requested one, a subscription run sent an API-key bearer, a request named another model or effort, the runtime recorded replies from another provider, or, for a subscription run, `connectionMatchesBearer` is `false` (`connection-mismatch`) or anything but `true` (`connection-unverified`).

### What may leave this machine, and what stays private

**Only the sanitized summary may be shared.** Each case that selects a provider (or must: `requireProvider`) appends one record to `eval-summary.ndjson` in `STUDIO_EVAL_SUMMARY_DIR`, or else in `studio-eval-summary` in the system temporary folder. The record has the acceptance runners' stage-record shape (`scenario` `eval-<provider>`, `stage` the case's `caseId`, `run` counting that case's records in the file, `status`, `code`, `durationS`, `observations`) and is written only once the acceptance evidence's record guard (`findUnsafeRecord`, `apps/cli/ai/acceptance-evidence.ts`) accepts it; one it refuses is written as `failed`, `unsafe-evidence`, with no observations, as the acceptance runners write theirs. `status` is `blocked` when the case was refused or blocked before it ran (its refusal code, or `tool-images-not-qualified`); `failed` when the guard refused a write (`wpcom-write-under-mock`, `wpcom-write-outside-staging`), the case timed out (`timed-out`), its route was not the one selected (`no-model-request`, `route-mismatch`, `api-key-bearer`, `connection-mismatch`, `connection-unverified`, `model-mismatch`, `effort-mismatch`, `reply-provider-mismatch`), or the run failed (`run-failed`); `passed` otherwise. So it says whether the case ran on its selected route with nothing refused; the case's own checks (its reply, its site) are judged in promptfoo's results. The observations are counts and booleans only: the executed route's model, API-key-bearer and image-service request counts, whether its kind, backend, connection and (for a subscription) bearer matched the selection, how many other models, efforts and reply providers it saw and whether the reply models are the requests' models; the guard's refused writes and, in a staging case, the writes it let through; the remote operations recorded and how many reached the designated staging site; turns, tool calls and compactions.

The reasons a provider-qualified case's checks give hold no text the run produced: replies, tool output, site state and error messages read `[run output withheld]`, and a reason in which anything still looks like an address, an email address, a path, a token or an identifier (by the evidence's own check) keeps only its leading code. A case that selects no provider gives its reasons as before.

**Everything else stays on this machine.** It can hold your WordPress.com display name and email, site addresses and ids, local paths with your user name, transcripts and tool outputs:

- promptfoo's results (each case's output, vars and reasons, which `npm run eval:view` shows), kept in promptfoo's own store (by default under `~/.promptfoo`): remove an eval there with promptfoo itself, or delete the store;
- the runner's result files (`studio-eval-<time>-<pid>.json`: the whole transcript, tool results and the outcome), the session files (`studio-eval-sessions`, or `STUDIO_EVAL_SESSION_DIR`) and the outcome folders (`studio-eval-outcome-*`), in the system temporary folder: delete them when you no longer need them (see "Temporary folders" below for the rest);
- what the runner and the agent print while a case runs, which promptfoo may keep with the case.

### What `remote: mock` guarantees

Every parity case runs with `remote: mock` (the `staging:` cases excepted), and so does any selected case that names no `remote`. Under it no state-changing request leaves the eval process itself, counting method overrides in the query and in the override headers (below).

A query key counts as a method override when any of these holds: after percent-decoding, with leading whitespace dropped, anything from its first `[` on ignored, `.` and whitespace read as `_` and case ignored, it reads `_method` or `method` (this covers the spellings PHP folds into `_method`, such as `%20.method[x]`); its letters and digits alone spell `method` (`me-thod`); or it holds a control character such as NUL or tab. Such a key makes the request a write when its value is not GET or HEAD (trimmed, case ignored), when it has a `[` or an array value whatever it names, and always when it holds a control character. This is stricter than PHP on purpose: a read refused here costs the model one retry.

- each push, pull and preview create, update or delete is recorded in `remoteCalls` and answered with a fixture by the mocked host;
- each `wpcom_request` whose effective method is not GET or HEAD, whether declared or through an override key in its `query` argument or in a query written into its `path` (from the first `?` up to any `#`, since the fragment is never sent, and read as the server reads it: percent-escapes decoded, `+` a space), is recorded in `remoteCalls` (`operation: "wpcom-request"`, its effective method, site id and path) and answered with a fixture (`{"eval_mock": true, …}`); other GET requests stay the real tool's;
- any other request to a WordPress.com host (`wordpress.com`, `wp.com` and their subdomains) with a method other than GET or HEAD, or with an override key in its query (read as the server reads it: percent-escapes decoded, `+` a space; from a `fetch` URL or `Request`, or an `http`/`https` URL string, `URL` object or `options.path`), or whose headers have `X-HTTP-Method-Override`, `X-HTTP-Method` or `X-Method-Override` (any case) with a value other than GET or HEAD, sent by `fetch` or by the `http`/`https` modules (which `wpcom` requests use), is refused before it is sent, recorded in `remoteGuard.blocked` (method, host class, whether it was the image endpoint, and how it was sent; never the address), and fails the case: `success: false`, an `error` starting `wpcom-write-under-mock`, and `noWordPressComWrites` fails with that code;
- named exceptions: Studio's image service, only in a case labelled `imageService: "required"` (the `[image service]` cases); and model requests to the WordPress.com AI proxy only on a run whose provider is WordPress.com. Under ChatGPT, any request to the AI proxy that is not the labelled image service is refused.

What still reaches WordPress.com under `remote: mock`:

- **reads**: GET and HEAD requests, including `wpcom_request` reads, go out with the case's copy of your login;
- **a process the agent starts from its shell** (`Bash`), such as a `studio` CLI command or `curl`, exactly as in the existing eval suite: the guard covers the eval process only, from setup until the case's turns end, and such a process reads the case's copy of your login, so it could change a WordPress.com site. No parity case asks for one; one that ran shows in the result's `toolCalls`.

The result's `remoteGuard` is `{ code, blocked }`, with `allowed` added in a staging case (below); `remoteCalls` appears for a mocked or a staging case.

### Parity cases

| Case | Checks (besides `ranOnRequestedRoute` and `noWordPressComWrites`) | Needs |
| --- | --- | --- |
| `parity-identity` | `identifiesAsStudio` | automatic |
| `parity-global-instructions` | `replyIncludes` | automatic |
| `parity-skill-routing` | `skillsLoadedFirst` | automatic |
| `parity-site-creation` | `siteWorks`, `otherSitesUntouched` | automatic |
| `parity-target-selection` | `asksCurrentOrNew`, `otherSitesUntouched` | automatic |
| `parity-theme-file` | `themeFileIncludes`, `siteWorks`, `otherSitesUntouched` | automatic |
| `parity-import-export` | `inspectionIncludes` (the title the export kept is back), `otherSitesUntouched` | automatic |
| `parity-question` | `questionnaireSkip` | automatic |
| `parity-design-choice` | `designChosen`, `noSiteCreated` | automatic |
| `parity-screenshot-desktop-mobile` | `sawDesktopAndMobile`, `otherSitesUntouched` | automatic |
| `parity-screenshot-interpretation` | `replyIncludes` (the title read from the image), `usedOnlyTools` | automatic |
| `parity-preview-refresh` | `previewRefreshed`, `inspectionIncludes` | automatic |
| `parity-preview-create` | `remoteOperationRan` | automatic (mocked remote) |
| `parity-annotation` | `designTokenReachedTheme`, `designSystemReplyLink`, `otherSitesUntouched` | automatic |
| `parity-artifact` | `artifactShown` | automatic |
| `parity-attachment-replay` | `finalReplyIncludes`, `lastTurnUsedNoTools`, `attachmentReachedModel` | automatic (fixtures in `fixtures/`) |
| `parity-push-declined` | `pushNotRunAndAsks`, `noRemoteOperation` | automatic (mocked remote) |
| `parity-push-approved` | `remoteOperationRan` | automatic (mocked remote) |
| `parity-cancellation` | `cancelledThenContinued` | automatic |
| `parity-resume` | `finalReplyIncludes`, `resumedFromDisk`, `lastTurnUsedNoTools` | automatic |
| `parity-compaction-fixture` | `compacted`, `finalReplyIncludes`, `resumedFromDisk` | automatic; fixture-forced compaction |
| `parity-image-generation` | `imageGenerated`, `inspectionMatches` | image service |
| `parity-pending-work` | `imageGenerated`, `toolsInOrder` (a successful `generate_images` before a successful `take_screenshot` in the recorded tool sequence), `inspectionMatches` (images saved when the turn ends) | image service |
| `parity-image-generation-absent` | `imageGenerationUnavailable`, `noSiteCreated` | automatic (the runner turns the image service off) |
| `staging-push` | `remoteOperationRan` | a staging site you name for the run |

- **Image service.** The `[image service]` cases need Studio's separate WordPress.com image service (a WordPress.com login in the profile the eval reads, or `STUDIO_IMAGE_API_TOKEN`) and are refused (`image-service-not-configured`) without it. They are the only cases whose image-service requests the guard lets through; in any other case an image request is refused and fails the case. The modes: `"required"` is the above. `"off"` runs a case without the service: the case's profile gets no WordPress.com login (so no connected sites either) and `STUDIO_IMAGE_API_TOKEN` is removed; the case is refused (`image-service-still-configured`) if the service is still on, which is what happens to every `"off"` case under a `DEV_CONFIG_DIR` profile that already has a login. `"unused"` keeps the copied login, for a case that needs a signed-in state (a connected remote site, a mocked push or preview); the harness cannot withhold `generate_images` from the agent without a product change, because the runtime offers it whenever a login exists, so the tool is offered, and a case that uses it fails with `wpcom-write-under-mock`. The parity test requires a case that seeds a connected site or exercises push, pull or preview to be `"unused"` rather than `"off"`. The result's `imageService.configured` says which held. `parity-pending-work` checks the order of the calls and the saved images; it does not time when the background generation settled.
- **Fixture-forced compaction.** `parity-compaction-fixture` seeds a short history (`seed.history`) whose last reply reports a context of 190,000 tokens, so the next turn compacts first: a real summarization request on the route, without sending a request that size. It is labelled as a fixture: it qualifies compaction and resume on the route, not a conversation that grew to the limit by itself.
- **Staging.** A `remote: staging` case pushes for real, and only to a WordPress.com staging site you name for that run: set `STUDIO_EVAL_STAGING_SITE_ID` and `STUDIO_EVAL_STAGING_SITE_URL` (https) on the command that runs it (POSIX: as a prefix of that one command; PowerShell: set them, run, then `Remove-Item env:STUDIO_EVAL_STAGING_SITE_ID, env:STUDIO_EVAL_STAGING_SITE_URL`). Without both the case is refused (`staging-not-designated`). The variables only name the site: before any site or turn the runner asks WordPress.com (a read, with the case's login) for the account's sites, and refuses the case (`staging-not-confirmed`) unless WordPress.com lists that site, at that address, as a staging site. It connects the site as WordPress.com lists it to the case's seeded active site. The write guard stays on in a staging case, with that site as the one thing it may change: a push or pull runs only when its remote is the site (its id, or its address), and no preview is created, updated or deleted; a `wpcom_request` write goes to the real service only when its `siteId` is the site and its path is under it (not `!`); any other request to a WordPress.com host that could change something (as under `remote: mock`, method overrides included) goes only when the address it sends names the site: on `public-api.wordpress.com`, the site its path names after the namespace (`/<namespace>/sites/<id or address>/…`, or the push upload's `/rest/<version>/studio-file-uploads/<id>/…`), with no dot segment, encoded slash or empty segment in that path; on any other WordPress.com host, that host being the site's own. Anything else is refused before it is sent, recorded in `remoteGuard.blocked`, and fails the case (`success: false`, an `error` starting `wpcom-write-outside-staging`, and `noWordPressComWrites` fails with that code). The writes let through are recorded in `remoteGuard.allowed` (method and how each was sent, never the address); `remoteCalls` lists each push, pull, preview change and `wpcom_request` write with `designated: true` or `false`, and `remoteOperationRan` passes only on a designated one whose tool result says it succeeded (`staging-target-not-designated` when it went elsewhere and was refused). Studio's image service and the AI proxy keep the exceptions they have under `remote: mock`, and a command the agent starts from its shell is outside the guard here too. A staging case should still be the only case in its run. Leave staging cases out of automatic runs with `--filter-pattern "^parity"`; run them on their own with `--filter-pattern "^staging:"`.

### Vars and result fields the parity cases use

These work in any config:

- `caseId`: the case's kebab-case id, which names it in a provider-qualified case's sanitized summary (above).
- `remote: mock` (above) or `remote: staging` (above). Without `remote`, an unselected case runs the real host, as before; a selected case runs as `remote: mock`. `remoteOperationRan` and `noRemoteOperation` read the mode the case declares, never the shape of the result.
- `imageService: "off"`, `"required"` or `"unused"` (above; quote `"off"`, which some YAML parsers read as false).
- `attachments` (a list of `{ "fixture": "<file in fixtures/>" }`): images are sent as image input with the first message, other files as absolute paths appended to it, as the composer and CLI attach them. `STUDIO_EVAL_FIXTURES_DIR` overrides the folder. The result's `attachments` lists what was attached.
- `followUps[].reopen: true`: the conversation is reopened from its session file in a fresh agent before that message, as a resumed chat is.
- `resumeAfterStop: true`: the follow-ups still run after a `stopAt` interrupt, as a user who cancelled a turn and went on.
- `answers[].label: "@first"`: answers the question with its first option.
- `seed.history` (a list of `{ "role": "user" | "assistant", "text": "…", "contextTokens": n }`): messages the conversation holds before the first turn, the assistant's recorded as replies on the selected route. Needs a provider selection (`history-needs-provider`).
- `toolOrder` (a list of `{ "name": "<tool>" }`): for `toolsInOrder`.

Every result now also has `turns` (per user message: whether it was `reopened`, when it started and where its `toolCalls`, `textSegments` and `questions` start) and `compactions` (compaction entries in the session after the run); a `ui: true` run has `uiEvents` (each artifact shown, by id and widget types, and how many times the preview was reloaded). An unselected run's other fields are those it always had.

`subscription-parity.test.mjs` checks the config without running a case: it parses, names only exported checks, passes the runner only vars it reads (parsed with the runner's own parser in `apps/cli/ai/eval-input.ts`) or a check reads, keeps remote operations mocked outside the separated staging cases, and holds no identifier or credential.

### Temporary folders, and a run that is killed

Each case makes a site registry (`studio-eval-registry-*`) and a Studio profile (`studio-eval-config-*`, holding the copy of your WordPress.com login, links to Studio's downloads, `server-files`, `php-bin` and `import-runtime`, in the source profile, and the case's own `mu-plugins`) in the system temporary folder, and a sites folder (`studio-eval-sites-*`); a case that names a provider also makes a process manager home (`studio-eval-daemon-*`). The runner removes the registry and the profile when the case ends, whether it passed, failed, was refused or threw (the download links first, as links), the request observations file with them, the process manager home once its process manager has ended, and the sites folder when no site is left in it. It keeps what the result points to: the session file (`studio-eval-sessions`), the outcome folder (`studio-eval-outcome-*`) and the result file. No folder links to ChatGPT state.

A case killed before it ends (Ctrl+C on promptfoo, a closed terminal) leaves its registry, profile, sites folder (`studio-eval-sites-*`) and request observations file (`studio-eval-requests-*`) behind, and may leave a site server running: check for one (`studio site list`, or look for a leftover PHP process) and stop it before removing its folder. Remove a leftover profile's links before the folder, so nothing they point to is touched:

```powershell
Get-ChildItem $env:TEMP -Directory -Filter 'studio-eval-config-*' | ForEach-Object {
	Get-ChildItem $_.FullName -Force | Where-Object { $_.LinkType } | ForEach-Object { $_.Delete() }
	Remove-Item $_.FullName -Recurse -Force
}
Get-ChildItem $env:TEMP -Directory -Filter 'studio-eval-registry-*' | Remove-Item -Recurse -Force
Get-ChildItem $env:TEMP -Directory -Filter 'studio-eval-sites-*' | Remove-Item -Recurse -Force
Get-ChildItem $env:TEMP -File -Filter 'studio-eval-requests-*' | Remove-Item -Force
```

```sh
for dir in "${TMPDIR:-/tmp}"/studio-eval-config-*; do
	find "$dir" -maxdepth 1 -type l -delete && rm -rf "$dir"
done
rm -rf "${TMPDIR:-/tmp}"/studio-eval-registry-* "${TMPDIR:-/tmp}"/studio-eval-sites-* "${TMPDIR:-/tmp}"/studio-eval-requests-*
```

## Running the runner directly

`node apps/cli/dist/cli/eval-runner.mjs "<prompt>" "" '{"vars":{"timeoutMs":1800000}}'` runs one turn outside promptfoo and prints `EVAL_RUNNER_RESULT_FILE=<path>`. Environment variables: `STUDIO_EVAL_MODEL` picks the model (`fast`, `claude-sonnet-5`, …) on the global provider unless `STUDIO_EVAL_PROVIDER` selects one (see "Provider-qualified parity runs"), and `STUDIO_EVAL_SESSION_DIR` sets where the session JSONL (the full transcript, kept for every run and reported as `sessionFile`) is written, by default `<tmpdir>/studio-eval-sessions`. A turn that ends with an empty reply is resumed by the runtime itself, as in the app, and shows up in `timing.emptyStops`. A `followUps` var (a list of `{ "prompt": "…" }` objects; objects because promptfoo turns an array of strings into one test per element) sends each as a further user message in the same session once the previous one finishes, for cases that measure a conversation rather than a single request. An `answers` var (a list of `{ "label": "…" }` objects) scripts the user's replies: the turn then runs with Studio chat's ask-the-user handler, so `AskUserQuestion` and tools that confirm with the user work, each question taking the next label in order, and the user cancels once they run out. Without it the agent has no way to ask the user, unlike the app and `studio ai`, which always give it one. A `stopAt` var (a list of `{ "tool": "<name>", "input": { "<field>": "<regex>" } }` rules, `input` optional) ends the run at the first tool call matching a rule, whose argument fields each match their regex, before any follow-ups; the result's `stoppedAt` names that call (`toolUseId`, `toolName`, and `index` in `toolCalls`). The matched call may already have started when the run ends.

## Adding tests

Cases live in `promptfoo.config.yaml`; checks live in `outcome.mjs` and are referenced as `value: file://outcome.mjs:<check>`, with parameters in the case's `vars`. Judge the state a user would see, not the route to it. Cost is the exception: a right result reached by looping through dozens of tool calls still costs the user credits, so a case can cap the turn with `withinBudget` and `vars.maxToolCalls` / `vars.maxTokens`, set from the spread of repeated passing runs (`--repeat`) with headroom for normal variance. When a check needs state the capture lacks, add it to `eval-outcome.ts` rather than reading tool calls. The runner also returns the transcript (`toolCalls`, `toolResults`, `toolEvents`, `textSegments`, `questions` (each question the agent asked the user, its option labels and the scripted answer; see `answers`), `turnDurationsMs`, and `inspections` when the seed asks for them), `usage` (input, output, cache read, cache write and total tokens, summed over every assistant message), `stopReason` and `errorMessage` (from the last assistant message, so a provider failure shows its cause), `sessionFile` (the session JSONL), `requests` (one per model request: start, end and duration, context tokens sent, output tokens, `stopReason` and any `errorMessage`, and whether it carried text or tool calls) and `timing` (model time, tool wall time with parallel calls counted once, peak context, empty stops — a `stop` with neither text nor a tool call — and per-tool calls, total and max time and output size), for reasons and debugging. Each `toolEvents` entry also carries `outputChars`, the length of the result's text. Each `toolResults` entry carries the result's text block plus any image content blocks (`images`, base64) and structured `details` (e.g. `studioArtifacts`).

Every case also asserts `github.mjs:githubAnswered`, from `defaultTest`. GitHub's unauthenticated API serves 60 requests an hour per IP address, shared by everything on the network, and an agent refused by it can conclude a repository has no releases. A `beforeEach` extension records the quota as each case starts; a case whose commands used `github.com` fails as `INVALID (environment)` when it started with fewer than 10 requests left, ended with none, or was told "API rate limit exceeded". Leave those runs out of comparisons, and run again later or from another network.

### Seeding fixtures

Set a `seed` var on a test to pre-populate config files before the agent turn — useful for flows that depend on connected remote sites or preview sites without making a real WordPress.com connection or preview. The seed accepts `localSite` (written to `cli.json`), `activeSite` (creates a real stopped site in the case's sites folder, with optional `files` written into it by path relative to the site root, and makes it the session's active site, which the system prompt states in its `## Active site` section, as it does for the site picked in the app or CLI; the site is deleted after the turn. `wpCli` is a list of WP-CLI argv arrays run on it after the files are written, for state that lives in the database, such as activating a theme or saving Site Editor customizations; a command fails the seed when it exits non-zero or prints `SEED_ERROR`, since `wp eval` exits 0 on PHP warnings. `inspect` is a list of WP-CLI argv arrays run after the turn, before the site is deleted; their output lands in the result's `inspections` for assertions on the final site state. `connectedWpcomSites` connects WordPress.com sites to it, as below without `localSiteId`, which is the new site's), `remoteActiveSite` (`name`, `url` and `wpcomSiteId` of one of the user's existing WordPress.com sites, made the session's active site as when it is picked in the app or CLI; nothing is created or deleted, so any change the agent makes stays on that site), `connectedWpcomSites` (written to `shared.json`, requires `studio auth login`), `snapshots` (written to `cli.json`), and `globalInstructions` (written to `knowledge/instructions.md` in the case's own Studio profile). Everything seeded goes into the case's own profile and registry, removed with them when the case ends, so reruns start clean and the source profile is never written.

### Graded assertions

The suite currently has **no LLM-graded (`llm-rubric`/`model-graded`) assertions** — every check is deterministic JavaScript over the runner's structured output.

There used to be a custom grader (`grader-provider.mjs`) that reused the Studio WP.com login through the AI proxy. The proxy's Studio lane now rejects plain judge calls: `studio-assistant*` requests are refused unless they carry the Studio Code agent envelope (a `system` prompt + `tools`) *and* the system prompt contains Studio Code's own identity. A grader is a bare single-turn judge, so it legitimately has neither — and faking them to pass would mean copying Studio's anti-abuse signature into a non-agent call, defeating a control that exists to stop exactly that. Rather than ship a grader that can't authenticate, the one `llm-rubric` assertion and the grader were removed.

To reintroduce graded assertions, give the grader an auth path that doesn't abuse the Studio lane: back it with an `ANTHROPIC_API_KEY` (calling `api.anthropic.com` directly), or ask #ai-ops for a dedicated eval-grader feature slug exempt from the agent-envelope/identity checks.
