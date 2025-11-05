import nock from "nock";
import { Probot, ProbotOctokit } from "probot";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, beforeEach, afterEach, test, expect } from "vitest";

// This suite expands end-to-end coverage of the PR → Slack sync pipeline across
// additional lifecycle & event scenarios not covered in existing integration tests.
// All external network calls (GitHub + Slack) are mocked via nock.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(path.join(__dirname, "fixtures/mock-cert.pem"), "utf-8");

function makeProbot() {
  return new Probot({
    appId: 123,
    privateKey,
    Octokit: ProbotOctokit.defaults({ retry: { enabled: false }, throttle: { enabled: false } }),
  });
}

// Base PR fixture builder so we can tweak fields per test
function prFixture(number: number, overrides: Partial<any> = {}) {
  return {
    number,
    title: `PR ${number} title`,
    html_url: `https://github.com/owner/repo/pull/${number}`,
    state: overrides.state ?? "open",
    merged: overrides.merged ?? false,
    user: { login: overrides.author ?? "author" },
    requested_reviewers: overrides.requested_reviewers ?? [],
    head: { sha: overrides.sha ?? "abcdef1234567890" },
    ...overrides,
  };
}

describe("extended integration pipeline scenarios", () => {
  let probot: Probot;

  beforeEach(async () => {
    process.env.SLACK_TOKEN = "xoxb-test";
    process.env.SLACK_CHANNEL = "C123";
    nock("https://slack.com")
      .post("/api/conversations.info")
      .reply(200, { ok: true });
    nock.disableNetConnect();
    probot = makeProbot();
    const appModule = await import("../src/index.ts");
    probot.load(appModule.default);
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    delete process.env.SLACK_TOKEN;
    delete process.env.SLACK_CHANNEL;
  });

  test("open PR with no reviewers & no checks posts correct minimal messages", async () => {
    // GitHub auth
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });
    // PR data
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/10")
      .reply(200, prFixture(10));
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/10/reviews")
      .query(true)
      .reply(200, []); // none
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/abcdef1234567890/check-runs")
      .query(true)
      .reply(200, { check_runs: [] });
    // No recovery found
    nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, { ok: true, messages: [], has_more: false });
    // Expect main message minimal reviewers line & hidden marker
    const mainPost = nock("https://slack.com")
      .post("/api/chat.postMessage", (b: any) => {
        console.log("MAIN POST BODY:", b);
        expect(b.text).toMatch(/Reviewers: \(none\)/);
        expect(b.text).toMatch(/Status: 0\/0 checks passed/);
        expect(b.text).toMatch(/pr-messaging-bot:owner\/repo#10/);
        return true;
      })
      .reply(200, { ok: true, ts: "10.1" });
    const threadPost = nock("https://slack.com")
      .post("/api/chat.postMessage", (b: any) => {
        console.log("THREAD POST BODY:", b);
        expect(b.thread_ts).toBe("10.1");
        expect(b.text).toBe("No checks reported.");
        return true;
      })
      .reply(200, { ok: true, ts: "10.2" });

    await probot.receive({ name: "pull_request", id: "evt-open-10", payload: { action: "opened", number: 10, pull_request: prFixture(10), repository: { name: "repo", owner: { login: "owner" } } } as any });
    expect(mainPost.isDone()).toBe(true);
    expect(threadPost.isDone()).toBe(true);
  });

  test("review submitted transitions reviewer status and updates main message", async () => {
    // Auth
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });
    // Initial open (requested reviewer bob appears pending)
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/11")
      .twice() // open + review event fetch
      .reply(200, prFixture(11, { requested_reviewers: [{ login: "bob" }] }));
    // First reviews call: none
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/11/reviews")
      .query(true)
      .reply(200, []);
    // First checks call: empty
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/abcdef1234567890/check-runs")
      .query(true)
      .reply(200, { check_runs: [] });
    // History scan empty
    nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, { ok: true, messages: [], has_more: false });
    // Create messages
    nock("https://slack.com")
      .post("/api/chat.postMessage")
      .reply(200, { ok: true, ts: "11.1" });
    nock("https://slack.com")
      .post("/api/chat.postMessage")
      .reply(200, { ok: true, ts: "11.2" });
    await probot.receive({ name: "pull_request", id: "evt-open-11", payload: { action: "opened", number: 11, pull_request: prFixture(11, { requested_reviewers: [{ login: "bob" }] }), repository: { name: "repo", owner: { login: "owner" } } } as any });
    // Second reviews call: bob approved
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/11/reviews")
      .query(true)
      .reply(200, [ { user: { login: "bob" }, state: "APPROVED" } ]);
    // Checks still none
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/abcdef1234567890/check-runs")
      .query(true)
      .reply(200, { check_runs: [] });
    const updateMain = nock("https://slack.com")
      .post("/api/chat.update", (b: any) => {
        expect(b.ts).toBe("11.1");
        expect(b.text).toMatch(/@bob ✅/); // status updated
        return true;
      })
      .reply(200, { ok: true, ts: "11.1" });
    // Thread unchanged (no update expected) — absence of interceptor okay

    await probot.receive({ name: "pull_request_review", id: "evt-review-11", payload: { action: "submitted", pull_request: prFixture(11, { requested_reviewers: [{ login: "bob" }] }), repository: { name: "repo", owner: { login: "owner" } }, review: { state: "APPROVED" } } as any });
    expect(updateMain.isDone()).toBe(true);
  });

  test("check_run.completed updates thread message with success classification", async () => {
    // Auth
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });
    // Open PR
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/12")
      .reply(200, prFixture(12));
    // Reviews none
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/12/reviews")
      .query(true)
      .reply(200, []);
    // Initial checks: pending build
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/abcdef1234567890/check-runs")
      .query(true)
      .reply(200, { check_runs: [ { name: "build", conclusion: null, status: "in_progress" } ] });
    // History empty
    nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, { ok: true, messages: [], has_more: false });
    nock("https://slack.com")
      .post("/api/chat.postMessage")
      .reply(200, { ok: true, ts: "12.1" });
    nock("https://slack.com")
      .post("/api/chat.postMessage")
      .reply(200, { ok: true, ts: "12.2" });
    await probot.receive({ name: "pull_request", id: "evt-open-12", payload: { action: "opened", number: 12, pull_request: prFixture(12), repository: { name: "repo", owner: { login: "owner" } } } as any });
    // check_run.completed event: GitHub associates commit -> PR list
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/abcdef1234567890/pulls")
      .reply(200, [ prFixture(12) ]);
    // Fetch PR again
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/12")
      .reply(200, prFixture(12));
    // Reviews still none
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/12/reviews")
      .query(true)
      .reply(200, []);
    // Checks now success
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/abcdef1234567890/check-runs")
      .query(true)
      .reply(200, { check_runs: [ { name: "build", conclusion: "success", status: "completed" } ] });
    const threadUpdate = nock("https://slack.com")
      .post("/api/chat.update", (b: any) => {
        // thread update (ts must match recorded thread ts 12.2)
        if (b.ts === "12.2") {
          expect(b.text).toMatch(/✅ build/);
          return true;
        }
        return false;
      })
      .reply(200, { ok: true, ts: "12.2" });
    // Main update also expected (Status line changes 0/1 -> 1/1)
    const mainUpdate = nock("https://slack.com")
      .post("/api/chat.update", (b: any) => {
        if (b.ts === "12.1") {
          expect(b.text).toMatch(/Status: 1\/1 checks passed/);
          return true;
        }
        return false;
      })
      .reply(200, { ok: true, ts: "12.1" });

  await probot.receive({ name: "check_run", id: "evt-checkrun-12", payload: { action: "completed", check_run: { head_sha: "abcdef1234567890" }, repository: { name: "repo", owner: { login: "owner" } } } as any });
    expect(threadUpdate.isDone()).toBe(true);
    expect(mainUpdate.isDone()).toBe(true);
  });

  test("merged PR updates lifecycle prefix on closure", async () => {
    // Auth
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });
    // Open PR
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/13")
      .reply(200, prFixture(13));
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/13/reviews")
      .query(true)
      .reply(200, []);
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/abcdef1234567890/check-runs")
      .query(true)
      .reply(200, { check_runs: [] });
    nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, { ok: true, messages: [], has_more: false });
    nock("https://slack.com")
      .post("/api/chat.postMessage")
      .reply(200, { ok: true, ts: "13.1" });
    nock("https://slack.com")
      .post("/api/chat.postMessage")
      .reply(200, { ok: true, ts: "13.2" });
    await probot.receive({ name: "pull_request", id: "evt-open-13", payload: { action: "opened", number: 13, pull_request: prFixture(13), repository: { name: "repo", owner: { login: "owner" } } } as any });
    // Closed with merged true
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/13")
      .reply(200, prFixture(13, { state: "closed", merged: true }));
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/13/reviews")
      .query(true)
      .reply(200, []);
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/abcdef1234567890/check-runs")
      .query(true)
      .reply(200, { check_runs: [] });
    const updateMain = nock("https://slack.com")
      .post("/api/chat.update", (b: any) => {
        if (b.ts === "13.1") {
          expect(b.text.startsWith("Merged ✅"));
          return true;
        }
        return false;
      })
      .reply(200, { ok: true, ts: "13.1" });
    // Thread unchanged (no checks) — no update expected
    await probot.receive({ name: "pull_request", id: "evt-closed-13", payload: { action: "closed", number: 13, pull_request: prFixture(13, { state: "closed", merged: true }), repository: { name: "repo", owner: { login: "owner" } } } as any });
    expect(updateMain.isDone()).toBe(true);
  });

  test("recovery flow finds existing main message and updates it", async () => {
    // Auth
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });
    // PR fetch (will be updated state with reviewers & check)
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/14")
      .reply(200, prFixture(14, { requested_reviewers: [{ login: "rev" }] }));
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/14/reviews")
      .query(true)
      .reply(200, [ { user: { login: "rev" }, state: "APPROVED" } ]);
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/abcdef1234567890/check-runs")
      .query(true)
      .reply(200, { check_runs: [ { name: "lint", conclusion: "success", status: "completed" } ] });
    // History scan returns existing message containing marker (simulating restart lost cache)
    const existingTs = "777.1";
    nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, { ok: true, messages: [ { ts: existingTs, text: `Random text <!-- pr-messaging-bot:owner/repo#14 -->` } ], has_more: false });
    // Recovery path posts a new thread message
    const threadPost = nock("https://slack.com")
      .post("/api/chat.postMessage", (b: any) => {
        expect(b.thread_ts).toBe(existingTs);
        expect(b.text).toMatch(/✅ lint/);
        return true;
      })
      .reply(200, { ok: true, ts: "777.2" });
    // And updates main message
    const mainUpdate = nock("https://slack.com")
      .post("/api/chat.update", (b: any) => {
        expect(b.ts).toBe(existingTs);
        expect(b.text).toMatch(/@rev ✅/);
        expect(b.text).toMatch(/Status: 1\/1 checks passed/);
        return true;
      })
      .reply(200, { ok: true, ts: existingTs });
    await probot.receive({ name: "pull_request", id: "evt-open-14", payload: { action: "opened", number: 14, pull_request: prFixture(14, { requested_reviewers: [{ login: "rev" }] }), repository: { name: "repo", owner: { login: "owner" } } } as any });
    expect(threadPost.isDone()).toBe(true);
    expect(mainUpdate.isDone()).toBe(true);
  });

  test("neutral & skipped check runs counted as success via check_suite.completed", async () => {
    // Auth
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });
    // Open PR
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/15")
      .reply(200, prFixture(15));
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/15/reviews")
      .query(true)
      .reply(200, []);
    // Initial checks: pending two
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/abcdef1234567890/check-runs")
      .query(true)
      .reply(200, { check_runs: [ { name: "style", conclusion: null, status: "in_progress" }, { name: "docs", conclusion: null, status: "queued" } ] });
    nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, { ok: true, messages: [], has_more: false });
    nock("https://slack.com")
      .post("/api/chat.postMessage")
      .reply(200, { ok: true, ts: "15.1" });
    nock("https://slack.com")
      .post("/api/chat.postMessage")
      .reply(200, { ok: true, ts: "15.2" });
    await probot.receive({ name: "pull_request", id: "evt-open-15", payload: { action: "opened", number: 15, pull_request: prFixture(15), repository: { name: "repo", owner: { login: "owner" } } } as any });
    // check_suite.completed -> commit association listing PR
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/abcdef1234567890/pulls")
      .reply(200, [ prFixture(15) ]);
    // Fetch PR again
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/15")
      .reply(200, prFixture(15));
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/15/reviews")
      .query(true)
      .reply(200, []);
    // Checks now neutral & skipped (treated success) + failure
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/abcdef1234567890/check-runs")
      .query(true)
      .reply(200, { check_runs: [
        { name: "style", conclusion: "neutral", status: "completed" },
        { name: "docs", conclusion: "skipped", status: "completed" },
        { name: "unit", conclusion: "failure", status: "completed" }
      ] });
    const mainUpdate = nock("https://slack.com")
      .post("/api/chat.update", (b: any) => {
        if (b.ts === "15.1") {
          // 2 successes out of 3
          expect(b.text).toMatch(/Status: 2\/3 checks passed/);
          return true;
        }
        return false;
      })
      .reply(200, { ok: true, ts: "15.1" });
    const threadUpdate = nock("https://slack.com")
      .post("/api/chat.update", (b: any) => {
        if (b.ts === "15.2") {
          expect(b.text).toMatch(/✅ style/);
          expect(b.text).toMatch(/✅ docs/);
          expect(b.text).toMatch(/❌ unit/);
          return true;
        }
        return false;
      })
      .reply(200, { ok: true, ts: "15.2" });
  await probot.receive({ name: "check_suite", id: "evt-checksuite-15", payload: { action: "completed", check_suite: { head_sha: "abcdef1234567890" }, repository: { name: "repo", owner: { login: "owner" } } } as any });
    expect(mainUpdate.isDone()).toBe(true);
    expect(threadUpdate.isDone()).toBe(true);
  });
});
