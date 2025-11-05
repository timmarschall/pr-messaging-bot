# pr-messaging-bot

> Probot GitHub App that mirrors Pull Request state into exactly one Slack parent message plus one thread reply (CI checks breakdown). It keeps both continuously updated as reviews and checks evolve.

## ✨ Features

* Deterministic 1:1 mapping: one Slack parent message per PR (author, reviewers w/ status emojis, checks summary, lifecycle prefix).
* Thread reply lists each check run with status emoji (✅ success, ❌ failure, 🟡 pending). Shows aggregate passed/failed/pending counts.
* Lifecycle prefixes: `Merged ✅ |` or `Closed ❌ |` automatically prepended when PR merges/closes.
* Tracking query param in PR mrkdwn link (`<https://github.com/owner/repo/pull/123?frombot=pr-message-bot|#123>`) enables stateless recovery (no hidden HTML marker needed).
* Duplicate update suppression: skips Slack `chat.update` calls if newly formatted text is identical (reduces rate‑limit pressure & noise).
* Structured logging (pino or console fallback) with contextual fields (`repo`, `prNumber`, `event`, `code`).
* Error taxonomy: GitHub API, Slack API, parse, internal—each logged with a concise `code`.
* Config validation: optional Slack channel accessibility probe at startup.
* Stateless in-memory storage with history recovery (no persistent DB required). Eviction capped by `STORAGE_MAX_ENTRIES`.

## ⚙️ Environment Variables

Required (create a `.env` in local dev):

| Variable | Purpose |
|----------|---------|
| `APP_ID` | GitHub App ID |
| `PRIVATE_KEY` | GitHub App private key (PEM contents) |
| `WEBHOOK_SECRET` | GitHub App webhook secret |
| `SLACK_TOKEN` | Slack bot token (`chat:write`) |
| `SLACK_CHANNEL` | Slack channel ID (e.g. `C0123456789`) |

Optional:
| Variable | Purpose |
|----------|---------|
| `STORAGE_MAX_ENTRIES` | Max in-memory cache entries (default 500) |
| `LOG_LEVEL` | pino/console log level (`info`, `debug`, etc.) |
| `USE_PINO` | Set to `0` to force console fallback |
| `SLACK_DEBUG` | `1` for verbose Slack client internal debug |
| `SLACK_COMMENT_KEYWORDS` | Comma/newline separated substrings; when a PR issue comment or review comment body contains any, a dedicated thread message is created/updated (case-insensitive). |

Optional configuration file: `config/github-to-slack.yml` mapping GitHub usernames → Slack handles (without `@`). Example:

```yaml
octocat: octo.slack
your-github-user: your.slack
```

## 🛠 GitHub App Setup

Permissions (minimum principle of least privilege):
* Pull Requests: Read
* Checks: Read
* Statuses: Read (legacy status API)
* Metadata: Read

Webhook Events:
* `pull_request` (opened, reopened, synchronize, closed, review_requested, review_request_removed)
* `pull_request_review` (submitted, dismissed)
* `check_run` (completed) – can add created/queued for earlier pending visibility
* `check_suite` (completed)
* `status`

## 🧪 Local Development

```sh
npm install

# Run in dev mode (TypeScript directly)
npm run dev

# Or build & run compiled code
npm run build
npm start
```

Use a webhook forwarder (e.g. [smee.io](https://smee.io)) to receive GitHub events locally:

```sh
npx smee -u https://smee.io/your-channel -t http://localhost:3000/api/github/webhooks
```

Place your `.env` file with required variables at project root.

## 💬 Slack Setup

Create a Slack App with the following Bot Token scopes:

* `chat:write`
* (Optional) `channels:read` if you want to validate the channel

Install the app to your workspace and capture the Bot User OAuth Token (starts with `xoxb-`). Set it as `SLACK_TOKEN`. Set `SLACK_CHANNEL` to the channel ID (not name) for posting (open channel details in Slack → Copy ID).

## 🗄 Storage & State Recovery

The app uses an in-memory capped cache (size via `STORAGE_MAX_ENTRIES`). On a cache miss (e.g. restart), it scans recent channel history to locate an existing message by searching for the PR URL containing the tracking query param:

`https://github.com/owner/repo/pull/<number>?frombot=pr-message-bot`

If found, the message is updated; otherwise a new parent + thread pair is created. This enables stateless restarts without durable storage. For high‑volume channels consider adding a Redis/Postgres implementation of the `Storage` interface.

Slack history scanning requires the app’s token to have access to the channel (public channels: `channels:read`; private channels: appropriate scopes or be invited). For very large channels, you can reduce `maxMessages` scanned by adjusting logic in `SlackClient.findMessageByKey`.

## 🐳 Docker

```sh
# Build
docker build -t pr-messaging-bot .

# Run (mount data for persistence)
docker run \
	-e APP_ID=<app-id> \
	-e PRIVATE_KEY="$(cat private-key.pem)" \
	-e WEBHOOK_SECRET=<secret> \
	-e SLACK_TOKEN=<xoxb-token> \
	-e SLACK_CHANNEL=<channel-id> \
	-v $(pwd)/data:/app/data \
	-p 3000:3000 \
	pr-messaging-bot
```

## 📝 Message Format

Main message:

```
<https://github.com/owner/repo|owner/repo> – *PR title* (<https://github.com/owner/repo/pull/123?frombot=pr-message-bot|#123>)
Author: @slack_handle | Reviewers: @alice ✅, @bob ❌, @carol 🟡
❌ Status: 5/7 checks passed
```

Thread reply (checks breakdown):

```
Checks breakdown (passed/failed/pending): 5/1/1
✅ lint
✅ build
❌ unit-tests
🕒 integration-tests
...
```

Lifecycle prefixes: `Merged ✅ |` or `Closed ❌ |` added to the first line when appropriate.

Status line emoji legend:
* `✅` all checks passed (and at least one check exists)
* `❌` one or more failures present
* `🟡` no failures, some pending
* `➖` no checks reported

### Keyword-triggered Comment Thread Messages

If you set `SLACK_COMMENT_KEYWORDS` (e.g. `SLACK_COMMENT_KEYWORDS="security,urgent"`), any PR conversation comment (`issue_comment`) or inline review comment (`pull_request_review_comment`) whose body contains one of those substrings (case-insensitive) will generate a separate reply in the PR's Slack thread. Format (keyword itself is not shown):

```
Comment by @author – https://github.com/owner/repo/pull/123#issuecomment-456789
<trimmed first 400 chars of comment body>
```

Edits to such comments re-render and update the corresponding Slack thread message. Deletions currently do not remove the thread message (future enhancement). On restart the bot recovers the main PR message via the tracking PR URL. Keyword comment replies are recreated or updated opportunistically (no hidden markers). Every match is logged with code `keyword_comment_match` including repo, PR number, comment id, and keyword.

## ✅ Testing

Unit tests (Vitest) cover message formatting logic:

```sh
npm test
```

Type checking / lint (using `tsc`):

```sh
npm run lint
```

## 🚀 Deployment Notes

* Provide environment variables securely (e.g. platform secrets manager).
* Persist `data/messages.json` via volume or database alternative (future enhancement).
* Scale horizontally: replace file storage with Redis/Postgres for shared state.

## 🤝 Contributing

Suggestions & fixes welcome—open an issue or PR. See [CONTRIBUTING.md](CONTRIBUTING.md).

## 📄 License

[ISC](LICENSE) © 2025 Tim Marschall
