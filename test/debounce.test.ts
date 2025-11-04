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

describe("debounce logic", () => {
  let probot: Probot;
  beforeEach(async () => {
    process.env.SLACK_TOKEN = "xoxb-test";
    process.env.SLACK_CHANNEL = "C999";
      process.env.DEBOUNCE_MS = "50"; // small debounce for real timers
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
    delete process.env.DEBOUNCE_MS;
  });

  test("coalesces rapid events into single Slack update", async () => {
    // GitHub API responses (same state)
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/10")
      .times(3)
      .reply(200, {
        number: 10,
        title: "Debounce Test",
        html_url: "https://github.com/owner/repo/pull/10",
        state: "open",
        merged: false,
        user: { login: "alice" },
        requested_reviewers: [],
        head: { sha: "deadbeef", ref: "debounce" },
      });
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/10/reviews")
      .query(true)
      .times(3)
      .reply(200, []);
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/deadbeef/check-runs")
      .query(true)
      .times(3)
      .reply(200, { check_runs: [] });

    // Slack history scan (once)
    nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, { ok: true, messages: [], has_more: false });

    // Expect only one pair of postMessage calls due to debounce
    const postMain = nock("https://slack.com")
      .post("/api/chat.postMessage")
      .reply(200, { ok: true, ts: "777.1" });
    const postThread = nock("https://slack.com")
      .post("/api/chat.postMessage")
      .reply(200, { ok: true, ts: "777.2" });

    const payloadBase = {
      pull_request: {
        number: 10,
        head: { sha: "deadbeef" },
      },
      repository: { name: "repo", owner: { login: "owner" } },
    } as any;

    // Fire three events rapidly
    await probot.receive({ name: "pull_request", id: "d1", payload: { ...payloadBase, action: "synchronize" } });
    await probot.receive({ name: "pull_request", id: "d2", payload: { ...payloadBase, action: "synchronize" } });
    await probot.receive({ name: "pull_request", id: "d3", payload: { ...payloadBase, action: "synchronize" } });

    // Wait longer than debounce for coalesced execution
    await new Promise((r) => setTimeout(r, 120));
    await Promise.resolve();
    expect(postMain.isDone()).toBe(true);
    expect(postThread.isDone()).toBe(true);
    // Ensure no extra updates created
    const pending = nock.pendingMocks().filter(m => m.includes("chat.postMessage") || m.includes("chat.update"));
    expect(pending).toHaveLength(0);
  });
});
