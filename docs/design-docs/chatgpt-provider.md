# Experimental ChatGPT plan connection

Set `STUDIO_EXPERIMENTAL_CHATGPT=1` before launching Studio or `studio ui` to enable the local proof of concept. It remains disabled by default while authenticated acceptance is pending.

In **Settings → Providers → ChatGPT plan**, start or cancel browser sign-in, select a saved account, sign in again, refresh its model list, or sign out. `studio ui` offers sign-in only on `localhost`, `127.0.0.1`, `[::1]`, or `studio.local`, where the local callback can be reached. Secure storage keeps the connection across restarts; **This app session** is an explicit alternative when secure storage is unavailable.

ChatGPT is selected per conversation, never as the global default provider. Switching to or from ChatGPT, or between accounts, starts a new conversation. Only a summary the user explicitly reviews may carry over. Same-account model and supported reasoning-effort changes stay in the conversation and are serialized with pending sends. Queued prompts wait when their connection, model or effort is unavailable. There is no automatic fallback to API billing or another account.

Studio's existing Pi agent loop uses a dedicated ChatGPT Responses transport. Model capabilities and availability are specific to this route and account; API-key output caps and unsupported reasoning modes are not offered. The CLI exposes the same flow through `/chatgpt`, with `/model`, `/reasoning` and `/clear` respecting the pinned account.

The backend owns OAuth, ID-token verification, refresh and revocation. Returning authorization URLs, credentials and token material do not cross the renderer boundary. Forked turns use scoped IPC with opaque generations. Sign-out ends active turns and clears the local connection; Settings reports remote revocation separately when it cannot be confirmed.

See the [implementation plan](../superpowers/plans/2026-11-08-chatgpt-plan-implementation.md) for verification evidence and the deferred authenticated acceptance checklist.
