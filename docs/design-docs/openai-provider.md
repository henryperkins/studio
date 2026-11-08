# The OpenAI API provider

## About this doc

Studio Code can run on OpenAI with the user's own API key, beside WordPress.com and Anthropic. This document describes how that provider keeps its key, decides which model and reasoning a turn uses, and what it promises about falling back. The code lives in `packages/agent/protocol/openai-models.ts` (catalog and validation), `packages/agent/node/openai-credentials.ts` and `packages/common/lib/os-credential-store.ts` (key storage), `packages/agent/node/settings-store.ts` (settings and the model list) and `packages/agent/node/runtime/openai-transport.ts` (requests).

## The model catalog

Studio offers an OpenAI model only when its capabilities are written down in `OPENAI_MODEL_CAPABILITIES`: the API model id, Responses and function-tool support, image input, the reasoning efforts and modes it accepts, and its context and output limits, each with the documentation page it was read from and when. The account's model list (`GET /v1/models`) carries no capabilities, so it only narrows the catalog: it can rule a model out, never in, and listing a model doesn't prove a request will succeed. A model the list includes that the catalog lacks (an embedding model, a newer chat model) is not offered.

Updating the catalog means reading each model page again, changing the entry and its tests, and bumping `OPENAI_MODEL_CATALOG_VERSION`. A cached model list checked against another version reads as unknown until the next refresh.

The cached list is stored with a short SHA-256 fingerprint of the key that read it, never the key itself, and applies only while that key is in use. After a switch to another key (a session-only key for another project, then back to the keychain's), the list reads as unknown until the next refresh. A refresh fails, keeping the previous list, when OpenAI's answer can't be read: an error status, a body that breaks off, or JSON that isn't a model list. Only a readable list replaces it, even an empty one.

## Choosing what a turn sends

New conversations start from the defaults in Settings. Each conversation records its own model, effort and mode in `studio.session_context` entries, so it keeps them across restarts and later changes to the defaults. The CLI reads them once when a turn starts and passes the result to the runtime as `OpenAiTurnSettings`; every request in that turn, tool continuations, retries and compaction's summary included, uses that snapshot. A change made while a turn runs is written to the session and applies to the next turn.

The composer writes a chat's model, provider and reasoning changes one at a time, in the order they were made (`apps/ui/src/data/session-setting-changes.ts`), and a message sent while one is saving waits for it, so the turn reads the choice the composer showed. When that save fails, the composer goes back to the last saved choice, says why, and the waiting message isn't sent; a failure already shown doesn't hold up later messages. Until it is written, a change is kept beside the cached session rather than in it, so a reload of the chat that read the file before the write can't replace it, and a failure takes back only its own change. Once every change made together has settled and no reload that might have read the file before them is under way, the written ones join the cache.

Nothing adjusts a choice to fit. `resolveOpenAiTurnSettings` reports a model Studio doesn't support, a model the project's list lacks, an effort or mode the model doesn't accept, or an output limit outside the model's bounds as a problem. The composer blocks sending and offers a fix the user applies; the CLI fails the turn with the same explanation. pi would clamp an unsupported effort to a neighbouring one, so the runtime also refuses any request whose effort differs from the snapshot.

Effort and mode are sent as `reasoning.effort` and, for Pro, `reasoning.mode`. Reasoning summaries are not requested (they can require a verified OpenAI organization), and `configuration_update` items are never sent, because OpenAI documents them as incompatible with compaction, which Studio uses. Studio sends `store: false` and replays the encrypted reasoning items the API returns; pi drops them when the model changes, since they only replay to the model that produced them.

## No silent fallback

An OpenAI conversation stays on OpenAI. Without a key, its turns fail with a disconnected error and the composer says so; the conversation is never sent to another provider. The reverse also holds: Studio never moves a conversation to OpenAI on its own, whether on a first run or when WordPress.com becomes unavailable (`autoSelectable` in the CLI's provider definitions). Making OpenAI the default affects only conversations without a reply yet. One with a reply keeps the provider it ran on, read from the model it recorded or, when Studio no longer offers that model, from the provider pi recorded on its latest reply (`readLastReplyProvider`); one that ran on Anthropic goes to WordPress.com without an Anthropic key, as before. One that ran on OpenAI stays there even after Studio drops its model, and its turns fail with a fix to apply. The rules for WordPress.com and Anthropic are unchanged.

Errors are classified by HTTP status and OpenAI error code (authentication, permission, unavailable model, invalid request, rate limit, quota, server, network, cancelled, interrupted stream) and explained without the WordPress.com usage-cap wording. Each explanation carries an untranslated marker that keeps pi's retry decision independent of the user's language: rate limits, server errors, network failures and interrupted streams retry, the rest don't.

## The key

The key is kept in the system keychain: macOS Keychain through `security`, the Secret Service through `secret-tool` on Linux, and Credential Manager through PowerShell on Windows. It reaches those tools over stdin, never as a command-line argument. Studio's settings files hold only non-secret choices; responses to the UI carry where the key is kept and its last four characters.

When a machine has no usable keychain, saving to it fails with an explicit error instead of falling back to a file. The user can instead keep a key for the current session: it lives in the memory of the process that owns settings (the desktop app's main process or the `studio ui` server). A forked CLI turn that needs it asks for it over the Node IPC channel; the fork's environment only says that a key is on offer (`STUDIO_OPENAI_SESSION_KEY_OFFERED`). A turn that was offered the session key uses that key or fails: when the request times out, the channel closes or the app no longer has a key, the turn stops with an explanation rather than use the keychain's key, which may belong to another project. The key never goes into a child's environment or arguments, which other programs running as the user can read: on Linux, `/proc/<pid>/environ` keeps a process's starting environment even after it deletes a variable. A session key doesn't touch the keychain: Studio offers one only when the keychain can't be used, so a key saved there earlier stays, and Studio uses it again once the session key is gone and the keychain is reachable. Settings and the terminal prompt say so.

Removing the key clears the session key and deletes the keychain item, checking the keychain afresh. If the machine has a keychain this process can't reach (a locked keychain, or `studio ui` over SSH without a session bus), the removal fails and says so, since a key saved there would come back once the keychain is reachable again.

The runtime receives the key in its provider environment, apart from the environment the agent's tools run in. The Bash tool's environment is stripped of model provider keys, so neither Studio's key nor an `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` the user exported reaches commands the agent runs. Requests carry Studio's key and no organization or project, whatever `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` or `OPENAI_CUSTOM_HEADERS` hold: the OpenAI SDK reads those from the process environment, and a custom `Authorization` header would otherwise replace the key.

### What this does not protect against

Keychain storage protects the key at rest. The agent can run commands as the user, and any program running as the user can ask the keychain for the same item. On macOS the item is created through `/usr/bin/security`, which its access list then trusts, so `security find-generic-password -w` reads it without a prompt; on Linux, `secret-tool lookup` reads it from an unlocked keyring. A program running as the user may also be able to read the memory of the process that holds a session key. Stripping provider keys from the Bash tool's environment keeps them out of commands' output by accident; it doesn't stop a command that goes looking. This change does not isolate the key from such programs and is not a sandbox.

## Image generation

Image generation is a separate service: it runs through the user's WordPress.com connection whatever the chat's provider, and is off without one. Settings says so next to the OpenAI options.
