# GitHub Copilot Instructions – pr-messaging-bot

Authoritative guidance for AI assistants contributing to this repository. Keep edits focused, typed, test‑backed, and aligned with the stateless Slack sync architecture.

## 1. Mission & Scope
Mirror the live state of a GitHub Pull Request into exactly one Slack parent message (summary) plus one Slack thread message (detailed check breakdown), updating them reactively as PR reviews and CI checks evolve.

## 2. Core Architecture (High Level)
Flow: GitHub webhook event → `syncPR()` in `src/index.ts` → aggregate state (`fetchPullRequestState`) → format messages (`buildMainMessage`, `buildThreadMessage`) → Slack post/update via `SlackClient` → cache Slack timestamps in in‑memory `Storage` → recover missing ts via channel history scan (hidden marker).
Stateless design: after restart, messages are rediscovered by scanning Slack history for an HTML comment marker.

## 3. Modules & Responsibilities
- `src/index.ts`: Registers webhook handlers; central orchestration (`syncPR`).
- `src/github.ts`: Pull Request state aggregation (reviews, requested reviewers, checks classification, lifecycle flags).
- `src/formatters.ts`: Pure deterministic formatting; no side effects besides returning strings. Adds lifecycle prefix + hidden marker.
- `src/slack.ts`: Thin wrapper over `@slack/web-api` with typed post/update/history operations.
- `src/storage.ts`: In-memory capped Map (FIFO eviction). No persistence.
- `src/user-mapping.ts`: YAML-driven GitHub→Slack handle translation.
- `test/*.test.ts`: Vitest specs covering formatting, state mapping, eviction, integration behavior.

## 4. Message Contract
Main message lines (in order):
• Optional lifecycle prefix line: owner/repo – title (PR number) URL
2. `Author: @slack_handle`
3. `Reviewers: @user1 ✅, @user2 ❌, @user3 🟡` OR `(none)`
4. `Status: passedCount/total checks passed`
• Hidden marker HTML comment pattern (must remain exactly as implemented in code): refer to `buildMainMessage` in `src/formatters.ts` for the current constant string.
Thread message:
- Header: `Checks breakdown (passed/failed/pending): X/Y/Z`
- Per line: emoji + check name, order preserved from GitHub API list.
Do NOT alter the hidden marker format; recovery relies on substring `pr-messaging-bot:`.

## 5. Reviewer Status Rules
- Latest review per user wins (iterate reviews chronologically; overwrite map each time).
- State mapping: APPROVED → `approved`; CHANGES_REQUESTED → `changes_requested`; others → `pending`.
- Requested reviewers with no review must appear as `pending`.

## 6. Check Run Classification
Map each check run:
- conclusion success → `success`
- conclusion failure|cancelled|timed_out → `failure`
- status not completed → `pending`
- conclusion neutral|skipped (completed) → treat as `success`
Edge: No checks → main message shows 0/x; thread returns `"No checks reported."`.

## 7. Storage & Recovery
- In-memory only (class `Storage`). Capacity via `STORAGE_MAX_ENTRIES` (default 500). Evicts oldest when exceeded.
- On cache miss: `SlackClient.findMessageByKey` scans recent channel history (default up to 400 messages) for hidden marker.
- If found: update existing main message; (re)post thread message; then cache both timestamps.
- If not found: create new messages.
Avoid operations that assume durable persistence (e.g., reading/writing a JSON file) unless adding optional persistence backend (see Future Improvements).

## 8. Slack Integration Guidelines
- Use `postMessage` only for new parent or thread messages; use `updateMessage` for edits.
- Always include `thread_ts` when posting the thread reply.
- Handle absent Slack credentials gracefully (early return in `syncPR`).
- Keep history scan bounded; do not increase `maxMessages` arbitrarily without justification.
- Prefer minimal error logging (stdout); future enhancement: structured logging.

## 9. TypeScript Standards
- Strict typing; avoid `any`. If API response partially typed, create narrow interfaces.
- Pure functions: `formatters.ts` only transforms inputs.
- Side-effect boundaries: Slack/GitHub interactions confined to orchestrator & client wrappers.

## 10. Testing Conventions
- Use Vitest (`npm test`).
- For GitHub API: stub via small object implementing only used methods (see `github-state.test.ts`).
- For integration tests: use `nock` to mock both GitHub and Slack endpoints (assert payload structure and hidden marker presence).
- Prefer tests before or alongside feature changes (formatting, event coverage, recovery logic).
- When adding events: extend integration test with scenario (create → update).

## 11. Edge Cases to Consider
- PR closed but not merged: lifecycle prefix `Closed ❌ |`.
- PR merged: prefix `Merged ✅ |`.
- Empty reviewers & checks.
- High number of reviewers (layout readability—avoid extra spaces or trailing commas).
- Slack history scan failing (return undefined; create new message).
- Missing Slack env vars (skip all Slack flows). Tests should set them explicitly.

## 12. Performance & Rate Limits
- Minimize redundant API calls: `fetchPullRequestState` should only perform required requests (PR, reviews, checks). Consider future caching.
- Avoid scanning entire channel; keep configured cap.
- Batch updates not currently implemented; each webhook triggers full sync—future improvement may debounce.

## 13. Future Improvement Hooks
Add (with tests):
- Durable storage (Redis/Postgres) implementing same interface as `Storage`.
- Retry/backoff logic for Slack & GitHub (exponential w/ jitter; limit attempts).
- Concurrency guard to prevent duplicate messages on rapid successive events.
- Thread finalization (e.g., append summary when merged).
Document deviations if implementing.

## 14. Do’s and Don’ts
Do:
- Maintain hidden marker integrity.
- Keep formatting pure and deterministic.
- Add tests for every new classification or formatting change.
- Fail gracefully (log + continue) on external API errors.
- Use existing emoji semantics.
Don’t:
- Introduce Slack block kit without clear requirement (would break recovery method relying on raw text).
- Persist state to disk without explicit feature addition & documentation.
- Remove or rename existing exported interfaces.
- Expand history scan beyond safe limits without reason.

## 15. Quick Recipes
Add new webhook event → Register handler in `index.ts` → call `syncPR` with needed SHA → add integration test.
Add persistence backend → Create `RedisStorage` with same `get/set/delete/size` interface → inject via env switch → update README.
Change check classification → Update logic in `github.ts` + adjust tests in `github-state.test.ts` + ensure `formatters` still accurate.

## 16. Environment Variables
Required for Slack: `SLACK_TOKEN`, `SLACK_CHANNEL`.
GitHub (Probot): `APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET`.
Optional: `STORAGE_MAX_ENTRIES`.
Never hardcode secrets; tests inject ephemeral values.

## 17. User Mapping
File: `config/github-to-slack.yml`. Fallback is GitHub login if no mapping. When modifying mapping logic, preserve `@` prefix behavior in `mapUser`.

## 18. Concurrency & Idempotency
Current implementation lacks explicit locking; multiple simultaneous events may trigger multiple updates—acceptable but can be optimized. Recovery scan ensures idempotent re-association to existing message. When adding persistence or locks, ensure no double‐posting.

## 19. Logging & Observability
Minimal console logging only. If enhancing:
- Introduce structured logger (e.g., `pino`) with context fields (repo, PR number, event name).
- Avoid verbose logs in tight loops (e.g., history scan).

## 20. Error Handling Pattern
Wrap `syncPR` in try/catch; log error; never throw to Probot runtime. Slack client throws on unsuccessful post/update; caller handles.

## 21. Code Style Notes
- Use const/let; prefer const.
- Keep function lengths modest; extract helpers if > ~50 lines.
- Avoid premature abstraction; clarity favored.
- Prefer template literals for multi-line messages.
 - Prefer nullish coalescing (`??`) over logical OR (`||`) when you need to distinguish between undefined/null and valid falsy values (0, false, "").
 - Avoid single-letter variable names (except minimal loop indices like `i` in very tight scopes); use descriptive camelCase identifiers.

## 22. Adding Tests for New Features
1. Unit tests: isolate pure logic (formatting, classification).
2. Integration tests: simulate full event with nock stubs for GitHub + Slack.
3. Assertions: hidden marker present, correct emoji/status counts, update vs create flows.

## 23. Hidden Marker Integrity
Do not modify the hidden marker format (see `buildMainMessage`). Any change breaks recovery.
Used solely as substring search; must remain in main message body.

## 24. Safe Refactors
Allowed if behavior unchanged:
- Extract internal helper functions inside `fetchPullRequestState`.
- Split large test fixtures into helper builder functions.
- Replace Map eviction with LRU only if interface stable & tests added.

## 25. Known Gaps
- No retry/backoff.
- No durable storage.
- No rate limit adaptation.
- Thread message not marked final on merge.
Document any gap closure in README + update this file.

## 26. Pull Request Acceptance Criteria (for AI-created PRs)
- Passes `npm test` (existing + new tests).
- No TypeScript errors (`npm run lint`).
- README updated if feature user-visible.
- No removal of hidden marker.
- Slack & GitHub interactions remain typed and minimal.

## 27. When Unsure
Prefer reading existing tests for patterns. If a change alters public behavior, add or modify tests first. If a requirement conflicts with current architecture, document rationale in PR description.

## 28. Glossary
- ts: Slack message timestamp.
- thread_ts: Timestamp of parent message (used to post replies) OR thread reply message ts when updating.
- Hidden marker: HTML comment uniquely identifying PR message.

## 29. Example End-to-End (Simplified)
Event: pull_request.opened → fetch PR (number) → list reviews → list checks → format messages → post main → post thread → cache {ts, thread_ts} using key composed of owner/repo and PR number.
Event: check_run.completed → map commit SHA → associated PR(s) → recompute state → update both messages.

## 30. Future Persistence Extension (Guideline)
Implement `IStorage` interface (same methods) → Provide adapter injection in `index.ts` → Add health test verifying record retention across simulated restart (mock flush) → Document env var toggle in README.

---
Keep contributions lean, typed, and test‑verified. Update this file if you introduce architectural changes.
