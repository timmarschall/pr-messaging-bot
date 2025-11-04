import nock from "nock";
import { Probot, ProbotOctokit } from "probot";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, beforeEach, afterEach, test, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(path.join(__dirname, "fixtures/mock-cert.pem"), "utf-8");

// Pull request opened payload fixture (inline minimal version)
const prOpenedPayload = {
  action: "opened",
  number: 1,
  pull_request: {
    number: 1,
    title: "Add new feature",
    html_url: "https://github.com/owner/repo/pull/1",
    state: "open",
    merged: false,
    user: { login: "alice" },
    requested_reviewers: [{ login: "bob" }],
    head: { sha: "abcdef1234567890", ref: "feature-branch" },
  },
  repository: { name: "repo", owner: { login: "owner" } },
};

function makeProbot() {
  return new Probot({
    appId: 123,
    privateKey,
    Octokit: ProbotOctokit.defaults({ retry: { enabled: false }, throttle: { enabled: false } }),
  });
}

describe("index.ts PR Slack sync", () => {
  let probot: Probot;
  beforeEach(async () => {
    // Set env for Slack
    process.env.SLACK_TOKEN = "xoxb-test";
    process.env.SLACK_CHANNEL = "C123";
    // Slack channel validation call
    nock("https://slack.com")
      .post("/api/conversations.info")
      .reply(200, { ok: true });
    nock.disableNetConnect();
    probot = makeProbot();
    // Dynamic import after env vars set so index.ts picks them up
    const appModule = await import("../src/index.ts");
    probot.load(appModule.default);
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    delete process.env.SLACK_TOKEN;
    delete process.env.SLACK_CHANNEL;
  });

  test("creates Slack main + thread messages on pull_request.opened", async () => {
    // Mock GitHub auth token
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    // GitHub PR data
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/1")
      .reply(200, { ...prOpenedPayload.pull_request });

    // Reviews (none yet) and checks (empty)
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/1/reviews")
      .query(true)
      .reply(200, []);
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/abcdef1234567890/check-runs")
      .query(true)
      .reply(200, { check_runs: [] });

    // Slack history scan (no existing message)
    nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, { ok: true, messages: [], has_more: false });

    // Slack post main message
    const mainPost = nock("https://slack.com")
      .post("/api/chat.postMessage", (body: any) => {
        expect(body.channel).toBe("C123");
        expect(body.text).toMatch(/owner\/repo/);
        expect(body.text).toMatch(/pr-messaging-bot:owner\/repo#1/);
        return true;
      })
      .reply(200, { ok: true, ts: "111.1" });

    // Slack post thread message
    const threadPost = nock("https://slack.com")
      .post("/api/chat.postMessage", (body: any) => {
        expect(body.thread_ts).toBe("111.1");
        return true;
      })
      .reply(200, { ok: true, ts: "111.2" });

    await probot.receive({
      name: "pull_request",
      id: "test-delivery-1",
      payload: prOpenedPayload as any,
    } as any);

    expect(mainPost.isDone()).toBe(true);
    expect(threadPost.isDone()).toBe(true);
  });

  test("updates existing Slack messages on pull_request.synchronize when content changes", async () => {
    // Use distinct PR #2 so state is isolated
    const pr2Opened = {
      action: "opened",
      number: 2,
      pull_request: { ...prOpenedPayload.pull_request, number: 2, html_url: "https://github.com/owner/repo/pull/2" },
      repository: prOpenedPayload.repository,
    };
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/2")
      .twice()
      .reply(200, pr2Opened.pull_request);
    // First call: no reviews
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/2/reviews")
      .query(true)
      .reply(200, []);
    // Second call: an approved review to force message content change
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/2/reviews")
      .query(true)
      .reply(200, [
        {
          user: { login: "bob" },
          state: "APPROVED",
        },
      ]);
    // First check-runs call: none
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/abcdef1234567890/check-runs")
      .query(true)
      .reply(200, { check_runs: [] });
    // Second call: introduce a successful check to force thread message change
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/abcdef1234567890/check-runs")
      .query(true)
      .reply(200, { check_runs: [ { name: "build", conclusion: "success", status: "completed" } ] });

    nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, { ok: true, messages: [], has_more: false });

    // Initial create main + thread
    nock("https://slack.com")
      .post("/api/chat.postMessage")
      .reply(200, { ok: true, ts: "333.1" });
    nock("https://slack.com")
      .post("/api/chat.postMessage")
      .reply(200, { ok: true, ts: "333.2" });

    await probot.receive({
      name: "pull_request",
      id: "test-delivery-PR2-open",
      payload: pr2Opened as any,
    } as any);

    // Synchronize update should use chat.update
    const pr2Sync = { ...pr2Opened, action: "synchronize" };
    const updateMain = nock("https://slack.com")
      .post("/api/chat.update", (body: any) => body.ts === "333.1")
      .reply(200, { ok: true, ts: "333.1" });
    const updateThread = nock("https://slack.com")
      .post("/api/chat.update", (body: any) => body.ts === "333.2")
      .reply(200, { ok: true, ts: "333.2" });

    await probot.receive({
      name: "pull_request",
      id: "test-delivery-PR2-sync",
      payload: pr2Sync as any,
    } as any);

    expect(updateMain.isDone()).toBe(true);
    expect(updateThread.isDone()).toBe(true);
  });

  test("skips Slack update when content unchanged (duplicate suppression)", async () => {
    // PR #3 scenario
    const pr3Opened = {
      action: "opened",
      number: 3,
      pull_request: { ...prOpenedPayload.pull_request, number: 3, html_url: "https://github.com/owner/repo/pull/3" },
      repository: prOpenedPayload.repository,
    };

    // Single token call (Probot may cache token between events)
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    // GitHub data (persist so second event reuses same interceptors)
    nock("https://api.github.com")
      .persist()
      .get("/repos/owner/repo/pulls/3")
      .reply(200, pr3Opened.pull_request);
    nock("https://api.github.com")
      .persist()
      .get("/repos/owner/repo/pulls/3/reviews")
      .query(true)
      .reply(200, []);
    nock("https://api.github.com")
      .persist()
      .get("/repos/owner/repo/commits/abcdef1234567890/check-runs")
      .query(true)
      .reply(200, { check_runs: [] });

    // Initial history scan (empty)
    nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, { ok: true, messages: [], has_more: false });

    // First create main + thread
    nock("https://slack.com")
      .post("/api/chat.postMessage")
      .reply(200, { ok: true, ts: "444.1" });
    nock("https://slack.com")
      .post("/api/chat.postMessage")
      .reply(200, { ok: true, ts: "444.2" });

    await probot.receive({
      name: "pull_request",
      id: "test-delivery-PR3-open",
      payload: pr3Opened as any,
    } as any);

    // Second event with identical state should trigger synchronize path but no chat.update calls
    const pr3Sync = { ...pr3Opened, action: "synchronize" };

    // We DO NOT set up nock interceptors for chat.update; any such call would cause test to fail.

    await probot.receive({
      name: "pull_request",
      id: "test-delivery-PR3-sync",
      payload: pr3Sync as any,
    } as any);

    // Ensure no chat.update calls occurred (duplicate suppression)
    expect(
      nock.pendingMocks().filter((m) => m.includes("chat.update"))
    ).toHaveLength(0);
  });
});
