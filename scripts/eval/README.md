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
- **global-instructions** — The reply carries the sentinel token from the seeded global instructions (`~/.studio/knowledge/instructions.md`, restored after the turn).
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

`subscription-parity.config.yaml` runs the same Studio workflows on one explicitly selected provider and connection. Every case sets `requireProvider` (a run that selects no provider is refused) and asserts `ranOnRequestedRoute`. The config names no provider, connection, model or effort: they come from the environment, so another subscription provider runs the same config with its own selection.

```bash
# A ChatGPT plan connection saved with secure storage in the Studio profile the eval reads.
STUDIO_EXPERIMENTAL_CHATGPT=1 \
STUDIO_EVAL_PROVIDER=chatgpt-oauth \
STUDIO_EVAL_CONNECTION=<registration id> \
STUDIO_EVAL_MODEL=gpt-6-luna \
STUDIO_EVAL_EFFORT=medium \
npm run eval:parity -- --filter-pattern "^parity"
```

PowerShell: set each with `$env:NAME = 'value'` first, then run `npm run eval:parity -- --filter-pattern "^parity"`. The registration id is shown by `/chatgpt` → Select saved account in Studio Code (`<label> · <id>`); it stays in your environment and never appears in a result (see `connectionRef` below).

### Selecting a provider

| Setting | Where | Meaning |
| --- | --- | --- |
| `STUDIO_EVAL_PROVIDER` | environment, or the case's `provider` var (they must agree) | `chatgpt-oauth`, `openai-api-key`, `anthropic-api-key` or `wpcom`. Without it the runner takes the default path, exactly as before. |
| `STUDIO_EVAL_CONNECTION` | environment only | The connection a subscription provider runs on. Never read from a config. |
| `STUDIO_EVAL_MODEL` | environment, or the case's `model` var | For ChatGPT, a slug the route is qualified for (`packages/agent/protocol/chatgpt-models.ts`, today `gpt-6-luna`); default: the table's first. For a legacy provider, one of its models; default: its default. |
| `STUDIO_EVAL_EFFORT` | environment, or the case's `effort` var | ChatGPT only: a qualified effort for the model (`low` or `medium` for `gpt-6-luna`); default `medium`. |
| `requireProvider: true` | case var | Refuses a run that selects no provider. |

A selected run executes on that provider (and, for ChatGPT, that connection) or is refused before any site, turn or model request. The result then has `success: false`, `refusal: { code, message }` and `providerRoute.failure`, and `ranOnRequestedRoute` fails with the code. Nothing falls back to the global provider, another connection, model or effort:

| Code | When |
| --- | --- |
| `provider-unknown`, `provider-conflict`, `provider-required`, `selection-without-provider` | The selection itself: an unknown id; the environment and the case name different providers; a `requireProvider` case with no provider; a connection or effort with no provider. |
| `experimental-flag-off` | `STUDIO_EXPERIMENTAL_CHATGPT=1` is not set. |
| `connection-required`, `connection-not-applicable` | ChatGPT without `STUDIO_EVAL_CONNECTION`; a connection for a legacy provider (they have one implicit connection). |
| `connection-unknown`, `connection-signed-out`, `connection-unsupported`, `connection-state-unavailable` | No such ChatGPT connection in the profile; it isn't signed in here (a session-only sign-in lives only in the app that holds it, so sign in with secure storage); it isn't a ChatGPT connection Studio's agent runs on; the profile's connections can't be read. |
| `model-not-qualified`, `effort-not-qualified` | A model or effort the ChatGPT route isn't qualified for, with the same explanation the app gives. |
| `effort-not-applicable`, `model-provider-mismatch`, `provider-not-ready` | A legacy provider given an effort, a model it doesn't serve, or no credentials. |
| `staging-not-designated`, `staging-needs-active-site`, `history-needs-provider`, `fixture-missing`, `image-service-not-configured`, `image-service-still-configured` | A case's own setup, below. |

How a ChatGPT run reaches its connection: each case runs in a Studio profile of its own (as every eval does), into which the runner links the source profile's ChatGPT sign-ins (`chatgpt-credentials/` by a directory link, so a refresh and its locks land in the source's records, and `chatgpt-accounts.json` by a file link or a copy), and removes those links when the case ends. The source profile is the one Studio reads: `~/.studio`, or `DEV_CONFIG_DIR` when set. The runner also installs the ChatGPT token client and writes the conversation's ChatGPT record before every turn, as the CLI does.

### What the run reports

A selected run's result has `providerRoute`:

- `requested`: `kind` (the provider), `backend` (where its model requests go: `chatgpt-route`, `openai-api`, `anthropic` or `wpcom-ai-proxy`), `subscription`, `connectionRef`, `model`, `wireModel` (the model id requests carry, or null where the observer can't see it) and `effort`.
- `executed`, read back from the run, never from the selection: the runner wraps `fetch` with the ChatGPT acceptance runner's request observer (`apps/cli/ai/chatgpt-acceptance-observer.ts`), which classifies each request by destination and bearer shape and keeps no URL, header, token or content. From it: `kind` and `backend` (`mixed` when the requests went to more than one route, `none` when there were none), `modelRequests`, `apiKeyBearers`, `imageServiceRequests` (Studio's separate WordPress.com image service, kept apart from inference), `models`, `efforts` and `requests` (per request: destination, bearer shape, model, effort, input and image counts, and `turn`, the user message it belongs to). `replyKinds` and `replyModels` are the providers and models the runtime stamped on its replies. `connectionRef` is, for ChatGPT, a fingerprint (`conn-` and 12 hex digits of a hash) of the connection the conversation's record names, which the runtime checks against the connection it begins before every turn; for a legacy provider, the provider id.

`ranOnRequestedRoute` fails when no provider was selected, the run was refused, no model request ran, the executed kind, backend or connection differs from the requested one, a subscription run sent an API-key bearer, a request named another model or effort, or the runtime recorded replies from another provider.

### Parity cases

Every case runs with `remote: mock`: each push, pull and preview create, update or delete is recorded in `remoteCalls` and answered with a fixture, so nothing reaches WordPress.com. The `staging:` cases at the end are the exception (see below).

| Case | Checks (besides `ranOnRequestedRoute`) | Needs |
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
| `parity-pending-work` | `imageGenerated`, `inspectionMatches` | image service |
| `parity-image-generation-absent` | `imageGenerationUnavailable`, `noSiteCreated` | automatic (the runner turns the image service off) |
| `staging-push` | `remoteOperationRan` | designated disposable staging site |

- **Image service.** The `[image service]` cases need Studio's separate WordPress.com image service (a WordPress.com login in the profile, or `STUDIO_IMAGE_API_TOKEN`) and are refused (`image-service-not-configured`) without it. `imageService: "off"` runs a case without it: the case's profile gets no WordPress.com login and `STUDIO_IMAGE_API_TOKEN` is removed; the case is refused (`image-service-still-configured`) if the service is still on, for example under a `DEV_CONFIG_DIR` profile that has a login. The result's `imageService.configured` says which held.
- **Fixture-forced compaction.** `parity-compaction-fixture` seeds a short history (`seed.history`) whose last reply reports a context of 190,000 tokens, so the next turn compacts first: a real summarization request on the route, without sending a request that size. It is labelled as a fixture: it qualifies compaction and resume on the route, not a conversation that grew to the limit by itself.
- **Staging.** A `remote: staging` case pushes for real, and only to a WordPress.com site you designate as disposable staging: set `STUDIO_EVAL_STAGING_SITE_ID` and `STUDIO_EVAL_STAGING_SITE_URL` (https), and the runner connects that site to the case's seeded active site. Without both the case is refused (`staging-not-designated`). Leave staging cases out of automatic runs with `--filter-pattern "^parity"`; run them on their own with `--filter-pattern "^staging:"`.

### Vars and result fields the parity cases use

These work in any config:

- `remote: mock` (each remote operation recorded in the result's `remoteCalls` and answered with a fixture) or `remote: staging` (above). Without `remote`, the real host runs, as before.
- `imageService: "off"` or `"required"` (above; quote `"off"`, which some YAML parsers read as false).
- `attachments` (a list of `{ "fixture": "<file in fixtures/>" }`): images are sent as image input with the first message, other files as absolute paths appended to it, as the composer and CLI attach them. `STUDIO_EVAL_FIXTURES_DIR` overrides the folder. The result's `attachments` lists what was attached.
- `followUps[].reopen: true`: the conversation is reopened from its session file in a fresh agent before that message, as a resumed chat is.
- `resumeAfterStop: true`: the follow-ups still run after a `stopAt` interrupt, as a user who cancelled a turn and went on.
- `answers[].label: "@first"`: answers the question with its first option.
- `seed.history` (a list of `{ "role": "user" | "assistant", "text": "…", "contextTokens": n }`): messages the conversation holds before the first turn, the assistant's recorded as replies on the selected route. Needs a provider selection (`history-needs-provider`).

Every result now also has `turns` (per user message: whether it was `reopened`, when it started and where its `toolCalls`, `textSegments` and `questions` start) and `compactions` (compaction entries in the session after the run); a `ui: true` run has `uiEvents` (each artifact shown, by id and widget types, and how many times the preview was reloaded).

`subscription-parity.test.mjs` checks the config without running a case: it parses, names only exported checks, passes the runner only vars it reads (parsed with the runner's own parser in `apps/cli/ai/eval-input.ts`) or a check reads, keeps remote operations mocked outside the separated staging cases, and holds no identifier or credential.

## Running the runner directly

`node apps/cli/dist/cli/eval-runner.mjs "<prompt>" "" '{"vars":{"timeoutMs":1800000}}'` runs one turn outside promptfoo and prints `EVAL_RUNNER_RESULT_FILE=<path>`. Environment variables: `STUDIO_EVAL_MODEL` picks the model (`fast`, `claude-sonnet-5`, …) on the global provider unless `STUDIO_EVAL_PROVIDER` selects one (see "Provider-qualified parity runs"), and `STUDIO_EVAL_SESSION_DIR` sets where the session JSONL (the full transcript, kept for every run and reported as `sessionFile`) is written, by default `<tmpdir>/studio-eval-sessions`. A turn that ends with an empty reply is resumed by the runtime itself, as in the app, and shows up in `timing.emptyStops`. A `followUps` var (a list of `{ "prompt": "…" }` objects; objects because promptfoo turns an array of strings into one test per element) sends each as a further user message in the same session once the previous one finishes, for cases that measure a conversation rather than a single request. An `answers` var (a list of `{ "label": "…" }` objects) scripts the user's replies: the turn then runs with Studio chat's ask-the-user handler, so `AskUserQuestion` and tools that confirm with the user work, each question taking the next label in order, and the user cancels once they run out. Without it the agent has no way to ask the user, unlike the app and `studio ai`, which always give it one. A `stopAt` var (a list of `{ "tool": "<name>", "input": { "<field>": "<regex>" } }` rules, `input` optional) ends the run at the first tool call matching a rule, whose argument fields each match their regex, before any follow-ups; the result's `stoppedAt` names that call (`toolUseId`, `toolName`, and `index` in `toolCalls`). The matched call may already have started when the run ends.

## Adding tests

Cases live in `promptfoo.config.yaml`; checks live in `outcome.mjs` and are referenced as `value: file://outcome.mjs:<check>`, with parameters in the case's `vars`. Judge the state a user would see, not the route to it. Cost is the exception: a right result reached by looping through dozens of tool calls still costs the user credits, so a case can cap the turn with `withinBudget` and `vars.maxToolCalls` / `vars.maxTokens`, set from the spread of repeated passing runs (`--repeat`) with headroom for normal variance. When a check needs state the capture lacks, add it to `eval-outcome.ts` rather than reading tool calls. The runner also returns the transcript (`toolCalls`, `toolResults`, `toolEvents`, `textSegments`, `questions` (each question the agent asked the user, its option labels and the scripted answer; see `answers`), `turnDurationsMs`, and `inspections` when the seed asks for them), `usage` (input, output, cache read, cache write and total tokens, summed over every assistant message), `stopReason` and `errorMessage` (from the last assistant message, so a provider failure shows its cause), `sessionFile` (the session JSONL), `requests` (one per model request: start, end and duration, context tokens sent, output tokens, `stopReason` and any `errorMessage`, and whether it carried text or tool calls) and `timing` (model time, tool wall time with parallel calls counted once, peak context, empty stops — a `stop` with neither text nor a tool call — and per-tool calls, total and max time and output size), for reasons and debugging. Each `toolEvents` entry also carries `outputChars`, the length of the result's text. Each `toolResults` entry carries the result's text block plus any image content blocks (`images`, base64) and structured `details` (e.g. `studioArtifacts`).

Every case also asserts `github.mjs:githubAnswered`, from `defaultTest`. GitHub's unauthenticated API serves 60 requests an hour per IP address, shared by everything on the network, and an agent refused by it can conclude a repository has no releases. A `beforeEach` extension records the quota as each case starts; a case whose commands used `github.com` fails as `INVALID (environment)` when it started with fewer than 10 requests left, ended with none, or was told "API rate limit exceeded". Leave those runs out of comparisons, and run again later or from another network.

### Seeding fixtures

Set a `seed` var on a test to pre-populate config files before the agent turn — useful for flows that depend on connected remote sites or preview sites without making a real WordPress.com connection or preview. The seed accepts `localSite` (written to `cli.json`), `activeSite` (creates a real stopped site in the case's sites folder, with optional `files` written into it by path relative to the site root, and makes it the session's active site, which the system prompt states in its `## Active site` section, as it does for the site picked in the app or CLI; the site is deleted after the turn. `wpCli` is a list of WP-CLI argv arrays run on it after the files are written, for state that lives in the database, such as activating a theme or saving Site Editor customizations; a command fails the seed when it exits non-zero or prints `SEED_ERROR`, since `wp eval` exits 0 on PHP warnings. `inspect` is a list of WP-CLI argv arrays run after the turn, before the site is deleted; their output lands in the result's `inspections` for assertions on the final site state. `connectedWpcomSites` connects WordPress.com sites to it, as below without `localSiteId`, which is the new site's), `remoteActiveSite` (`name`, `url` and `wpcomSiteId` of one of the user's existing WordPress.com sites, made the session's active site as when it is picked in the app or CLI; nothing is created or deleted, so any change the agent makes stays on that site), `connectedWpcomSites` (written to `shared.json`, requires `studio auth login`), `snapshots` (written to `cli.json`), and `globalInstructions` (written to `~/.studio/knowledge/instructions.md`; the file's prior content — or absence — is restored after the turn). Everything seeded is removed automatically after the turn so reruns start clean.

### Graded assertions

The suite currently has **no LLM-graded (`llm-rubric`/`model-graded`) assertions** — every check is deterministic JavaScript over the runner's structured output.

There used to be a custom grader (`grader-provider.mjs`) that reused the Studio WP.com login through the AI proxy. The proxy's Studio lane now rejects plain judge calls: `studio-assistant*` requests are refused unless they carry the Studio Code agent envelope (a `system` prompt + `tools`) *and* the system prompt contains Studio Code's own identity. A grader is a bare single-turn judge, so it legitimately has neither — and faking them to pass would mean copying Studio's anti-abuse signature into a non-agent call, defeating a control that exists to stop exactly that. Rather than ship a grader that can't authenticate, the one `llm-rubric` assertion and the grader were removed.

To reintroduce graded assertions, give the grader an auth path that doesn't abuse the Studio lane: back it with an `ANTHROPIC_API_KEY` (calling `api.anthropic.com` directly), or ask #ai-ops for a dedicated eval-grader feature slug exempt from the agent-envelope/identity checks.
