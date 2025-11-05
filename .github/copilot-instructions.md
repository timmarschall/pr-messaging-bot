Hard cut migration: hidden HTML markers removed. Recovery now keys off the PR mrkdwn link containing `?frombot=pr-message-bot` (e.g. `<https://github.com/owner/repo/pull/123?frombot=pr-message-bot|#123>`). Do not reintroduce the old marker.

# GitHub Copilot Instructions – pr-messaging-bot (Updated for Query Param Recovery)

Authoritative guidance for AI assistants contributing to this repository. Keep edits focused, typed, test‑backed, and aligned with the stateless Slack sync architecture.

## 1. Mission & Scope
Mirror the live state of a GitHub Pull Request into exactly one Slack parent message (summary) plus one Slack thread message (detailed check breakdown), updating them reactively as PR reviews and CI checks evolve.

## 2. Core Architecture (High Level)
Flow: GitHub webhook event → `syncPR()` in `src/index.ts` → aggregate state (`fetchPullRequestState`) → format messages (`buildMainMessage`, `buildThreadMessage`) → Slack post/update via `SlackClient` → cache Slack timestamps in in‑memory `Storage` → recover missing ts via channel history scan (tracking PR link).
Stateless design: after restart, messages are rediscovered by scanning Slack history for a PR URL containing the tracking query param.

## 3. Modules & Responsibilities
- `src/index.ts`: Registers webhook handlers; central orchestration (`syncPR`).
- `src/github.ts`: Pull Request state aggregation (reviews, requested reviewers, checks classification, lifecycle flags).
- `src/formatters.ts`: Pure deterministic formatting; builds mrkdwn header with repo + PR links.
- `src/slack.ts`: Thin wrapper over `@slack/web-api` with typed post/update/history operations.
- `src/storage.ts`: In-memory capped Map (FIFO eviction). No persistence.
- `src/user-mapping.ts`: YAML-driven GitHub→Slack handle translation.
- `test/*.test.ts`: Vitest specs covering formatting, state mapping, eviction, integration behavior.

## 4. Message Contract
Main message lines (in order):
1. Optional lifecycle prefix (`Merged ✅ |` or `Closed ❌ |`).
2. Header (mrkdwn): repo link + title + PR link with tracking param (e.g. issue number 123 uses URL https://github.com/owner/repo/pull/123?frombot=pr-message-bot )
3. Combined people line: `Author: @slack_handle | Reviewers: @user1 ✅, @user2 ❌, @user3 🟡` OR `(none)`
4. Status line prefixed with an emoji summarizing overall check health:
	* `✅ Status: x/y checks passed` (all checks successful and y>0)
	* `❌ Status: x/y checks passed` (at least one failure)
	* `🟡 Status: x/y checks passed` (no failures, some pending)
	* `➖ Status: 0/0 checks passed` (no checks reported)
Thread message:
* Header: `Checks breakdown (passed/failed/pending): X/Y/Z`
* Per line: emoji + check name, order preserved from GitHub API list.
Identification: Presence of the PR link containing `?frombot=pr-message-bot` is the unique recovery anchor.

## 5. Reviewer Status Rules
- Latest review per user wins (iterate reviews chronologically; overwrite map each time).
- State mapping: APPROVED → `approved`; CHANGES_REQUESTED → `changes_requested`; others → `pending`.
- Requested reviewers with no review must appear as `pending`.

## 6. Check Run Classification
Map each check run:
- conclusion success|neutral|skipped → `success`
- conclusion failure|cancelled|timed_out → `failure`
- status not completed → `pending`
Edge: No checks → main message shows 0/x; thread returns `"No checks reported."`.

## 7. Storage & Recovery
- In-memory only (class `Storage`). Capacity via `STORAGE_MAX_ENTRIES` (default 500). Evicts oldest when exceeded.
- On cache miss: `SlackClient.findMessageByKey` scans recent channel history for the PR URL fragment with tracking param.
- If found: update existing main message; (re)post thread message; then cache ts values.
- If not found: create new messages.

## 8. Slack Integration Guidelines
- Use `postMessage` only for new parent or thread messages; use `updateMessage` for edits.
- Always include `thread_ts` when posting the thread reply.
- Handle absent Slack credentials gracefully (early return in `syncPR`).
- Keep history scan bounded; do not increase `maxMessages` arbitrarily without justification.
- Prefer minimal error logging (stdout); future enhancement: structured logging.

## 9. TypeScript Standards
- Strict typing; avoid `any`.
- Pure functions where possible; formatting contains no side effects.
- Side-effect boundaries: Slack/GitHub interactions confined to orchestrator & client wrappers.

## 10. Testing Conventions
- Use Vitest (`npm test`).
- Mock GitHub & Slack via `nock`.
- Assert presence of PR tracking URL (not hidden marker) in main message.
- For new classification changes: add tests before implementation.

## 11. Edge Cases
- Merged vs closed vs open lifecycle.
- No reviewers or checks.
- Large reviewer lists formatting.
- Slack history scan miss (creates new message). Acceptable on race conditions.
- Title edits (`pull_request.edited`) update header text (main message only unless other state changed).

## 12. Performance & Rate Limits
- Minimize redundant API calls.
- Early exit history scan on first match.
- Basic rate-limit retry implemented.

## 13. Future Improvements
- Durable storage backend.
- Debounce rapid successive events.
- Retry/backoff with jitter.
- Thread finalization summary on merge.

## 14. Do’s and Don’ts
Do:
- Keep recovery URL pattern stable.
- Add tests for formatting changes.
- Fail gracefully on external API errors.
Don’t:
- Introduce Block Kit unless adding genuine layout improvements (requires updating recovery extractor).
- Persist state without documented feature addition.
- Change the tracking query param without updating tests & docs.

## 15. Quick Recipes
Add webhook event → Register in `index.ts` → call `syncPR` → add integration test.
Change check classification → Update logic + tests.
Add keyword → Set env var `SLACK_COMMENT_KEYWORDS` (no markers used for comment replies).

## 16. Environment Variables
`SLACK_TOKEN`, `SLACK_CHANNEL`, `APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET`, optional: `STORAGE_MAX_ENTRIES`, `SLACK_COMMENT_KEYWORDS`.

## 17. User Mapping
File: `config/github-to-slack.yml`. Fallback is GitHub login.

## 18. Concurrency & Idempotency
No locking; race may produce duplicates (acceptable). Recovery picks first matching message.

## 19. Logging
Minimal console logging; upgrade path to structured logger future.

## 20. Error Handling
Wrap sync in try/catch; classify errors; never throw to top-level runtime.

## 21. Style Notes
Use template literals; prefer nullish coalescing; avoid unnecessary abstraction.

## 22. Testing Additions
Ensure new PR URL pattern tests included whenever changing header formatting.

## 23. Recovery Identifier
`?frombot=pr-message-bot` query param in PR URL. Do not change without coordinated update.

## 24. Safe Refactors
Extract helpers; maintain public interfaces.

## 25. Known Gaps
No durable storage, no debounce, no merge finalization.

## 26. Acceptance Criteria
Tests pass; lint passes; README updated if user-visible change; recovery still works.

## 27. When Unsure
Inspect tests; add/adjust before implementing behavior shift.

## 28. Glossary
ts: Slack message timestamp; thread_ts: parent ts for replies.

## 29. Example End-to-End
pull_request.opened → fetch state → format → post main + thread → cache.
check_run.completed → resolve associated PRs → reformat → update main/thread.
Restart → scan history for tracking PR URL → recover and update.

---
Keep contributions lean, typed, and test‑verified. Update this file if you introduce architectural changes.
