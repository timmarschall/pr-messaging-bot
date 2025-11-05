import nock from "nock";
import { Probot, ProbotOctokit } from "probot";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, beforeEach, afterEach, test, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(path.join(__dirname, "fixtures/mock-cert.pem"), "utf-8");

function makeProbot() {
  return new Probot({
    appId: 123,
    privateKey,
    Octokit: ProbotOctokit.defaults({ retry: { enabled: false }, throttle: { enabled: false } }),
  });
}

const basePR = {
  number: 10,
  title: "Comment sync test",
  html_url: "https://github.com/owner/repo/pull/10",
  state: "open",
  merged: false,
  user: { login: "alice" },
  requested_reviewers: [],
  head: { sha: "deadbeefdeadbeef", ref: "feature-branch" },
};

describe("comment event triggers sync", () => {
  let probot: Probot;
  beforeEach(async () => {
    process.env.SLACK_TOKEN = "xoxb-test";
    process.env.SLACK_CHANNEL = "C123";
    nock("https://slack.com").post("/api/conversations.info").reply(200, { ok: true });
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

  test("issue_comment.created forces Slack update even if content unchanged", async () => {
    // Auth token
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    // Initial PR fetch + empty reviews + empty checks
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/10")
      .reply(200, basePR);
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/10/reviews")
      .query(true)
      .reply(200, []);
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/deadbeefdeadbeef/check-runs")
      .query(true)
      .reply(200, { check_runs: [] });

    // Slack history -> none
    nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, { ok: true, messages: [], has_more: false });

    // Create main + thread
    nock("https://slack.com")
      .post("/api/chat.postMessage")
      .reply(200, { ok: true, ts: "555.1" });
    nock("https://slack.com")
      .post("/api/chat.postMessage")
      .reply(200, { ok: true, ts: "555.2" });

    // Send pull_request.opened event
    await probot.receive({
      name: "pull_request",
      id: "evt-pr-open-10",
      payload: { action: "opened", number: 10, pull_request: basePR, repository: { name: "repo", owner: { login: "owner" } } } as any,
    } as any);

    // Second fetch triggered by issue_comment event; responses identical to original to test forced update
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/10")
      .reply(200, basePR);
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/10/reviews")
      .query(true)
      .reply(200, []);
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/deadbeefdeadbeef/check-runs")
      .query(true)
      .reply(200, { check_runs: [] });

    const updateMain = nock("https://slack.com")
      .post("/api/chat.update", (body: any) => body.ts === "555.1")
      .reply(200, { ok: true, ts: "555.1" });
    const updateThread = nock("https://slack.com")
      .post("/api/chat.update", (body: any) => body.ts === "555.2")
      .reply(200, { ok: true, ts: "555.2" });

    // Issue comment created payload (on a PR issue)
    const issueCommentPayload = {
      action: "created",
      issue: { number: 10, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/10" } },
      comment: { id: 1, body: "Looks good", user: { login: "reviewer" } },
      repository: { name: "repo", owner: { login: "owner" } },
    };

    await probot.receive({
      name: "issue_comment",
      id: "evt-issue-comment-1",
      payload: issueCommentPayload as any,
    } as any);

    expect(updateMain.isDone()).toBe(true);
    expect(updateThread.isDone()).toBe(true);
  });

  test("pull_request_review_comment.created forces update", async () => {
    // Auth token
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    // Use distinct PR number 11 to avoid storage reuse across tests
    const pr11 = { ...basePR, number: 11, html_url: "https://github.com/owner/repo/pull/11" };

    // Initial PR fetch + empty reviews + empty checks
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/11")
      .reply(200, pr11);
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/11/reviews")
      .query(true)
      .reply(200, []);
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/deadbeefdeadbeef/check-runs")
      .query(true)
      .reply(200, { check_runs: [] });

    nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, { ok: true, messages: [], has_more: false });

    nock("https://slack.com")
      .post("/api/chat.postMessage")
      .reply(200, { ok: true, ts: "666.1" });
    nock("https://slack.com")
      .post("/api/chat.postMessage")
      .reply(200, { ok: true, ts: "666.2" });

    await probot.receive({
      name: "pull_request",
      id: "evt-pr-open-11",
      payload: { action: "opened", number: 11, pull_request: pr11, repository: { name: "repo", owner: { login: "owner" } } } as any,
    } as any);

    // Second fetch identical to original to test forced update
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/11")
      .reply(200, pr11);
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/11/reviews")
      .query(true)
      .reply(200, []);
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/deadbeefdeadbeef/check-runs")
      .query(true)
      .reply(200, { check_runs: [] });

    const updateMain = nock("https://slack.com")
      .post("/api/chat.update", (body: any) => body.ts === "666.1")
      .reply(200, { ok: true, ts: "666.1" });
    const updateThread = nock("https://slack.com")
      .post("/api/chat.update", (body: any) => body.ts === "666.2")
      .reply(200, { ok: true, ts: "666.2" });

    const reviewCommentPayload = {
      action: "created",
      comment: { id: 200, body: "Inline note", user: { login: "bob" } },
      pull_request: pr11,
      repository: { name: "repo", owner: { login: "owner" } },
    };

    await probot.receive({
      name: "pull_request_review_comment",
      id: "evt-review-comment-11",
      payload: reviewCommentPayload as any,
    } as any);

    expect(updateMain.isDone()).toBe(true);
    expect(updateThread.isDone()).toBe(true);
  });

  test("issue_comment.edited forces update", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const pr12 = { ...basePR, number: 12, html_url: "https://github.com/owner/repo/pull/12" };

    nock("https://api.github.com").get("/repos/owner/repo/pulls/12").reply(200, pr12);
    nock("https://api.github.com").get("/repos/owner/repo/pulls/12/reviews").query(true).reply(200, []);
    nock("https://api.github.com").get("/repos/owner/repo/commits/deadbeefdeadbeef/check-runs").query(true).reply(200, { check_runs: [] });

    nock("https://slack.com").post("/api/conversations.history").reply(200, { ok: true, messages: [], has_more: false });
    nock("https://slack.com").post("/api/chat.postMessage").reply(200, { ok: true, ts: "777.1" });
    nock("https://slack.com").post("/api/chat.postMessage").reply(200, { ok: true, ts: "777.2" });

    await probot.receive({
      name: "pull_request",
      id: "evt-pr-open-12",
      payload: { action: "opened", number: 12, pull_request: pr12, repository: { name: "repo", owner: { login: "owner" } } } as any,
    } as any);

    // Second identical fetch on edit
    nock("https://api.github.com").get("/repos/owner/repo/pulls/12").reply(200, pr12);
    nock("https://api.github.com").get("/repos/owner/repo/pulls/12/reviews").query(true).reply(200, []);
    nock("https://api.github.com").get("/repos/owner/repo/commits/deadbeefdeadbeef/check-runs").query(true).reply(200, { check_runs: [] });

    const updateMain = nock("https://slack.com").post("/api/chat.update", (b:any)=> b.ts === "777.1").reply(200, { ok: true, ts: "777.1" });
    const updateThread = nock("https://slack.com").post("/api/chat.update", (b:any)=> b.ts === "777.2").reply(200, { ok: true, ts: "777.2" });

    const issueCommentEdited = {
      action: "edited",
      issue: { number: 12, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/12" } },
      comment: { id: 300, body: "Edited text", user: { login: "someone" } },
      repository: { name: "repo", owner: { login: "owner" } },
    };

    await probot.receive({ name: "issue_comment", id: "evt-issue-comment-edit-12", payload: issueCommentEdited as any } as any);

    expect(updateMain.isDone()).toBe(true);
    expect(updateThread.isDone()).toBe(true);
  });

  test("pull_request_review_comment.deleted forces update", async () => {
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });

    const pr13 = { ...basePR, number: 13, html_url: "https://github.com/owner/repo/pull/13" };

    nock("https://api.github.com").get("/repos/owner/repo/pulls/13").reply(200, pr13);
    nock("https://api.github.com").get("/repos/owner/repo/pulls/13/reviews").query(true).reply(200, []);
    nock("https://api.github.com").get("/repos/owner/repo/commits/deadbeefdeadbeef/check-runs").query(true).reply(200, { check_runs: [] });

    nock("https://slack.com").post("/api/conversations.history").reply(200, { ok: true, messages: [], has_more: false });
    nock("https://slack.com").post("/api/chat.postMessage").reply(200, { ok: true, ts: "888.1" });
    nock("https://slack.com").post("/api/chat.postMessage").reply(200, { ok: true, ts: "888.2" });

    await probot.receive({
      name: "pull_request",
      id: "evt-pr-open-13",
      payload: { action: "opened", number: 13, pull_request: pr13, repository: { name: "repo", owner: { login: "owner" } } } as any,
    } as any);

    // Second identical fetch on deletion
    nock("https://api.github.com").get("/repos/owner/repo/pulls/13").reply(200, pr13);
    nock("https://api.github.com").get("/repos/owner/repo/pulls/13/reviews").query(true).reply(200, []);
    nock("https://api.github.com").get("/repos/owner/repo/commits/deadbeefdeadbeef/check-runs").query(true).reply(200, { check_runs: [] });

    const updateMain = nock("https://slack.com").post("/api/chat.update", (b:any)=> b.ts === "888.1").reply(200, { ok: true, ts: "888.1" });
    const updateThread = nock("https://slack.com").post("/api/chat.update", (b:any)=> b.ts === "888.2").reply(200, { ok: true, ts: "888.2" });

    const reviewCommentDeleted = {
      action: "deleted",
      comment: { id: 400, body: "(was removed)", user: { login: "bob" } },
      pull_request: pr13,
      repository: { name: "repo", owner: { login: "owner" } },
    };

    await probot.receive({ name: "pull_request_review_comment", id: "evt-review-comment-del-13", payload: reviewCommentDeleted as any } as any);

    expect(updateMain.isDone()).toBe(true);
    expect(updateThread.isDone()).toBe(true);
  });
});
