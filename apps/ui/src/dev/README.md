# Playground pages

Development pages that render real components with sample data on the in-memory connector, with no Studio backend, so you can iterate on a design without driving the app into each state. They are Vite entries outside the Desktop and `studio ui` builds.

```bash
npm -w @studio/ui run playground
```

It opens http://localhost:5300, which links to each page:

- `/chat.html`: the chat transcript in every state: Markdown, tool calls with results, diffs and errors, a running turn, streaming, pending and answered questions, the image picker, screenshots, annotations and the error markers. Samples are in `chat-samples.ts`.
- `/animation.html`: the preview loading animation, active, still, easing and the selection wave.

Each page shows light and dark side by side, or one scheme from the header. To add a page, add `<name>.html` next to `index.html`, an entry here that imports the theme CSS first and calls `renderPlayground`, a link in `playground.html`, and the entry to `knip.json`.

- `/annotate-tip.html`: accent feature announcements and a two-step walkthrough, with optional badges and footer actions in light and dark.
- `/update-preview.html`: app update failure, dismissal, retry, download, and restart states. Use `?scheme=dark` for dark mode, `?result=error` for a failed retry, or `?state=ready` to start with a downloaded update.
- `/email-preview.html`: the email log loading skeleton, empty state, multiple selectable sample emails, and loading error. Use `?state=skeleton`, `?state=empty`, `?state=multiple`, or `?state=error` to start in a particular state.
- `/sidebar-preview.html`: the real app shell with its sidebar held in loading. Use the links to switch to loaded rows or between light and dark mode.
  Add `&rows=30` for a scrolling sidebar or `&chat=long` for a sample conversation.
- `/image-service-preview.html`: the real app on a ChatGPT chat: the composer's image service line, the generate_images result naming the account that made the image (expand the tool row), and the model picker's note on models Studio doesn't support yet (open Model). Use the links, or `?service=account|token|off`, `?view=settings` for Settings › AI and `?scheme=dark`. `?account=signed-out|needs-sign-in` shows the chat's account disconnected (the composer's notice, and Settings with Sign in again first); `?read=failing` fails every ChatGPT settings read after the first, for the error row with Retry in Settings and the composer's notice (it appears at the next poll, within 5 seconds). `?accounts=two` adds a signed-out second registration of the same email (its row in the picker, and Settings' account list); `?chat=empty` opens a chat with nothing in it yet (the picker's ChatGPT groups beside the models; choosing one puts the chat on it without a dialog); `?provider=off` turns ChatGPT plans off on that empty WordPress.com chat, for the model picker as on trunk. `?chat=new` opens the site's new chat, where choosing a ChatGPT model starts a chat on the account; the start takes 5 seconds there, so the busy Model control and the Send it holds can be seen.
- `/claude-approval-preview.html`: the approval card of a Claude Code chat, with made-up sites and messages: a WordPress.com request on the live site (`?approval=wpcom`), an export (`export`), a push to a production site and to its staging copy (`push-production`, `push-staging`), a feedback message and a very long one (`feedback`, `long-feedback`), two images to generate (`images`) and a local change after a recovery (`recovery`). Without `?approval=` it shows them all; Allow and Deny note the answer in the sample's title.
