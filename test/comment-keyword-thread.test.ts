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
  number: 42,
  title: "Keyword comment test",
  html_url: "https://github.com/owner/repo/pull/42",
  state: "open",
  merged: false,
  user: { login: "alice" },
  requested_reviewers: [],
  head: { sha: "cafebabecafebabe", ref: "feat-kw" },
};

describe("keyword-based comment thread messages", () => {
  let probot: Probot;
  beforeEach(async () => {
    process.env.SLACK_TOKEN = "xoxb-test";
    process.env.SLACK_CHANNEL = "C123";
    process.env.SLACK_COMMENT_KEYWORDS = "urgent,security"; // comma separated
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
    delete process.env.SLACK_COMMENT_KEYWORDS;
  });

  function mockInitialPRFetch(pr = basePR) {
    nock("https://api.github.com").post("/app/installations/2/access_tokens").reply(200, { token: "test" });
    nock("https://api.github.com").get(`/repos/owner/repo/pulls/${pr.number}`).reply(200, pr);
    nock("https://api.github.com").get(`/repos/owner/repo/pulls/${pr.number}/reviews`).query(true).reply(200, []);
    nock("https://api.github.com").get(`/repos/owner/repo/commits/${pr.head.sha}/check-runs`).query(true).reply(200, { check_runs: [] });
  }

  test("issue_comment.created with keyword posts new thread message", async () => {
    // PR #42
    mockInitialPRFetch();
    nock("https://slack.com").post("/api/conversations.history").reply(200, { ok: true, messages: [], has_more: false });
    // main + checks thread
    nock("https://slack.com").post("/api/chat.postMessage").reply(200, { ok: true, ts: "999.1" });
    nock("https://slack.com").post("/api/chat.postMessage").reply(200, { ok: true, ts: "999.2" });

    await probot.receive({
      name: "pull_request",
      id: "evt-pr-open-42",
      payload: { action: "opened", number: 42, pull_request: basePR, repository: { name: "repo", owner: { login: "owner" } } } as any,
    } as any);

    // Second fetch for comment event
    mockInitialPRFetch();
    const updateMain = nock("https://slack.com").post("/api/chat.update", (b: any) => b.ts === "999.1").reply(200, { ok: true, ts: "999.1" });
    const updateThread = nock("https://slack.com").post("/api/chat.update", (b: any) => b.ts === "999.2").reply(200, { ok: true, ts: "999.2" });
    // Empty thread replies (no existing keyword reply)
    nock("https://slack.com").post("/api/conversations.replies").reply(200, { ok: true, messages: [
      { ts: "999.1", text: "parent" },
      { ts: "999.2", text: "checks" },
    ] });
    const postKeyword = nock("https://slack.com").post("/api/chat.postMessage", (b: any) => b.thread_ts === "999.1").reply(200, { ok: true, ts: "999.3" });

    const issueCommentPayload = {
      action: "created",
      issue: { number: 42, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/42" } },
      comment: { id: 55, body: "This needs SECURITY review asap", user: { login: "bob" } },
      repository: { name: "repo", owner: { login: "owner" } },
    };
    await probot.receive({ name: "issue_comment", id: "evt-issue-comment-kw-42", payload: issueCommentPayload as any } as any);

    expect(updateMain.isDone()).toBe(true);
    expect(updateThread.isDone()).toBe(true);
    expect(postKeyword.isDone()).toBe(true);
  });

  test("issue_comment.created without keyword does not post extra", async () => {
    // Use distinct PR #50 to avoid shared storage state
    const prNoKw = { ...basePR, number: 50, html_url: "https://github.com/owner/repo/pull/50", head: { sha: basePR.head.sha, ref: basePR.head.ref } };
    mockInitialPRFetch(prNoKw);
    nock("https://slack.com").post("/api/conversations.history").reply(200, { ok: true, messages: [], has_more: false });
    nock("https://slack.com").post("/api/chat.postMessage").reply(200, { ok: true, ts: "1000.1" });
    nock("https://slack.com").post("/api/chat.postMessage").reply(200, { ok: true, ts: "1000.2" });
  await probot.receive({ name: "pull_request", id: "evt-pr-open-50", payload: { action: "opened", number: 50, pull_request: prNoKw, repository: { name: "repo", owner: { login: "owner" } } } as any } as any);

    // Second fetch
  mockInitialPRFetch(prNoKw);
  const updateMain = nock("https://slack.com").post("/api/chat.update", (b: any) => b.ts === "1000.1").reply(200, { ok: true, ts: "1000.1" });
  const updateThread = nock("https://slack.com").post("/api/chat.update", (b: any) => b.ts === "1000.2").reply(200, { ok: true, ts: "1000.2" });

    const issueCommentPayload = {
      action: "created",
      issue: { number: 50, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/50" } },
      comment: { id: 56, body: "Just a casual note", user: { login: "bob" } },
      repository: { name: "repo", owner: { login: "owner" } },
    };
    await probot.receive({ name: "issue_comment", id: "evt-issue-comment-nokw-42", payload: issueCommentPayload as any } as any);

    expect(updateMain.isDone()).toBe(true);
    expect(updateThread.isDone()).toBe(true);
    // Ensure no third postMessage occurred
    expect(nock.pendingMocks().filter((m) => m.includes("chat.postMessage")).length).toBe(0);
  });

  test("issue_comment.edited now matching keyword creates thread message", async () => {
    // Use distinct PR #51
    const prEdit = { ...basePR, number: 51, html_url: "https://github.com/owner/repo/pull/51", head: { sha: basePR.head.sha, ref: basePR.head.ref } };
    mockInitialPRFetch(prEdit);
    nock("https://slack.com").post("/api/conversations.history").reply(200, { ok: true, messages: [], has_more: false });
    nock("https://slack.com").post("/api/chat.postMessage").reply(200, { ok: true, ts: "1001.1" });
    nock("https://slack.com").post("/api/chat.postMessage").reply(200, { ok: true, ts: "1001.2" });
  await probot.receive({ name: "pull_request", id: "evt-pr-open-51", payload: { action: "opened", number: 51, pull_request: prEdit, repository: { name: "repo", owner: { login: "owner" } } } as any } as any);
    // Second fetch on edit
  mockInitialPRFetch(prEdit);
  const updateMain = nock("https://slack.com").post("/api/chat.update", (b:any)=> b.ts === "1001.1").reply(200, { ok: true, ts: "1001.1" });
  const updateThread = nock("https://slack.com").post("/api/chat.update", (b:any)=> b.ts === "1001.2").reply(200, { ok: true, ts: "1001.2" });
    nock("https://slack.com").post("/api/conversations.replies").reply(200, { ok: true, messages: [
      { ts: "1001.1", text: "parent" },
      { ts: "1001.2", text: "checks" },
    ] });
    const postKeyword = nock("https://slack.com").post("/api/chat.postMessage", (b:any)=> b.thread_ts === "1001.1").reply(200, { ok: true, ts: "1001.3" });
    const editedPayload = {
      action: "edited",
      issue: { number: 51, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/51" } },
      comment: { id: 57, body: "Marking this as URGENT please", user: { login: "bob" } },
      repository: { name: "repo", owner: { login: "owner" } },
    };
    await probot.receive({ name: "issue_comment", id: "evt-issue-comment-edit-kw-42", payload: editedPayload as any } as any);
    expect(updateMain.isDone()).toBe(true);
    expect(updateThread.isDone()).toBe(true);
    expect(postKeyword.isDone()).toBe(true);
  });

  test("review comment created with keyword posts thread message", async () => {
    const prX = { ...basePR, number: 52, html_url: "https://github.com/owner/repo/pull/52" };
    mockInitialPRFetch(prX);
    nock("https://slack.com").post("/api/conversations.history").reply(200, { ok: true, messages: [], has_more: false });
    nock("https://slack.com").post("/api/chat.postMessage").reply(200, { ok: true, ts: "1002.1" });
    nock("https://slack.com").post("/api/chat.postMessage").reply(200, { ok: true, ts: "1002.2" });
  await probot.receive({ name: "pull_request", id: "evt-pr-open-52", payload: { action: "opened", number: 52, pull_request: prX, repository: { name: "repo", owner: { login: "owner" } } } as any } as any);
    // Second fetch for review comment event
    mockInitialPRFetch(prX);
    const updateMain = nock("https://slack.com").post("/api/chat.update", (b:any)=> b.ts === "1002.1").reply(200, { ok: true, ts: "1002.1" });
    const updateThread = nock("https://slack.com").post("/api/chat.update", (b:any)=> b.ts === "1002.2").reply(200, { ok: true, ts: "1002.2" });
    nock("https://slack.com").post("/api/conversations.replies").reply(200, { ok: true, messages: [
      { ts: "1002.1", text: "parent" },
      { ts: "1002.2", text: "checks" },
    ] });
    const postKeyword = nock("https://slack.com").post("/api/chat.postMessage", (b:any)=> b.thread_ts === "1002.1").reply(200, { ok: true, ts: "1002.3" });
    const reviewCommentPayload = {
      action: "created",
      comment: { id: 500, body: "Security concern in this diff", user: { login: "carol" } },
      pull_request: prX,
      repository: { name: "repo", owner: { login: "owner" } },
    };
    await probot.receive({ name: "pull_request_review_comment", id: "evt-review-comment-kw-52", payload: reviewCommentPayload as any } as any);
    expect(updateMain.isDone()).toBe(true);
    expect(updateThread.isDone()).toBe(true);
    expect(postKeyword.isDone()).toBe(true);
  });

  test("keyword comment recovery updates existing reply without posting new", async () => {
    // Simulate restart: no cached storage, but Slack already has parent message + existing keyword reply.
    const prRecover = { ...basePR, number: 60, html_url: "https://github.com/owner/repo/pull/60" };
    mockInitialPRFetch(prRecover);
    // Slack history includes existing main message with marker
    const mainMarker = `<!--[newline] pr-messaging-bot:owner/repo#60 -->`.replace("[newline]", " pr-messaging-bot:"); // force correct marker structure
    nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, { ok: true, messages: [{ ts: "2003.1", text: `[owner/repo] – Keyword comment recovery (#60) https://github.com/owner/repo/pull/60\n${mainMarker}` }], has_more: false });
    // Recovery path posts new checks thread (chat.postMessage) then updates main
    nock("https://slack.com").post("/api/chat.postMessage").reply(200, { ok: true, ts: "2003.2" });
    nock("https://slack.com").post("/api/chat.update", (b:any)=> b.ts === "2003.1").reply(200, { ok: true, ts: "2003.1" });

    await probot.receive({ name: "pull_request", id: "evt-pr-open-60", payload: { action: "opened", number: 60, pull_request: prRecover, repository: { name: "repo", owner: { login: "owner" } } } as any } as any);

    // Second fetch for issue_comment event
    mockInitialPRFetch(prRecover);
    // Updates due to forced event (main + thread)
    nock("https://slack.com").post("/api/chat.update", (b:any)=> b.ts === "2003.1").reply(200, { ok: true, ts: "2003.1" });
    nock("https://slack.com").post("/api/chat.update", (b:any)=> b.ts === "2003.2").reply(200, { ok: true, ts: "2003.2" });
    // Thread replies listing existing keyword reply
    const keywordReplyMarker = "<!-- pr-messaging-bot:comment:owner/repo#60:700 -->";
    nock("https://slack.com")
      .post("/api/conversations.replies")
      .reply(200, { ok: true, messages: [
        { ts: "2003.1", text: `[owner/repo] – Keyword comment recovery (#60) https://github.com/owner/repo/pull/60\n${mainMarker}` },
        { ts: "2003.2", text: "Checks breakdown (passed/failed/pending): 0/0/0" },
        { ts: "2003.99", text: `Comment by @bob – https://github.com/owner/repo/pull/60#issuecomment-700\nOriginal body\n${keywordReplyMarker}` },
      ] });
    // Expect update on existing keyword reply (not postMessage)
    const updateKeyword = nock("https://slack.com")
      .post("/api/chat.update", (b:any)=> b.ts === "2003.99")
      .reply(200, { ok: true, ts: "2003.99" });

    const issueCommentPayload = {
      action: "created",
      issue: { number: 60, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/60" } },
      comment: { id: 700, body: "Security follow-up after restart", user: { login: "bob" } },
      repository: { name: "repo", owner: { login: "owner" } },
    };
    await probot.receive({ name: "issue_comment", id: "evt-issue-comment-recover-60", payload: issueCommentPayload as any } as any);
    expect(updateKeyword.isDone()).toBe(true);
    // Ensure no new postMessage for keyword occurred (only two earlier for checks + initial recovery)
    const pendingPosts = nock.pendingMocks().filter(m => m.includes("chat.postMessage"));
    expect(pendingPosts.length).toBe(0);
  });
});
