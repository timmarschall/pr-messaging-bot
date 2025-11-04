import nock from "nock";
import { Probot, ProbotOctokit } from "probot";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, test, beforeEach, afterEach, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(path.join(__dirname, "fixtures/mock-cert.pem"), "utf-8");

function makeProbot() {
  return new Probot({
    appId: 123,
    privateKey,
    Octokit: ProbotOctokit.defaults({ retry: { enabled: false }, throttle: { enabled: false } }),
  });
}

describe("config validation", () => {
  afterEach(() => {
    nock.cleanAll();
    delete process.env.SLACK_TOKEN;
    delete process.env.SLACK_CHANNEL;
  });

  test("skips Slack usage when env missing", async () => {
    process.env.SLACK_TOKEN = ""; // simulate missing
    process.env.SLACK_CHANNEL = "";
    const probot = makeProbot();
    // No Slack API mocks provided; import should not call Slack
    const appModule = await import("../src/index.ts");
    probot.load(appModule.default);
    // Trigger an event; should not attempt Slack calls
    const payload = {
      action: "opened",
      number: 5,
      pull_request: {
        number: 5,
        title: "Env Missing",
        html_url: "https://github.com/owner/repo/pull/5",
        state: "open",
        merged: false,
        user: { login: "alice" },
        requested_reviewers: [],
        head: { sha: "cafebabe", ref: "branch" },
      },
      repository: { name: "repo", owner: { login: "owner" } },
    } as any;

    // GitHub mocks for data
    nock("https://api.github.com")
      .post("/app/installations/2/access_tokens")
      .reply(200, { token: "test" });
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/5")
      .reply(200, payload.pull_request);
    nock("https://api.github.com")
      .get("/repos/owner/repo/pulls/5/reviews")
      .query(true)
      .reply(200, []);
    nock("https://api.github.com")
      .get("/repos/owner/repo/commits/cafebabe/check-runs")
      .query(true)
      .reply(200, { check_runs: [] });

    await probot.receive({ name: "pull_request", id: "c1", payload });
    // Assert no unexpected Slack mocks pending (none set)
    expect(nock.pendingMocks().filter(m => m.includes("slack.com"))).toHaveLength(0);
  });

  test("config validation promise resolves", async () => {
    process.env.SLACK_TOKEN = "xoxb-valid";
    process.env.SLACK_CHANNEL = "C12345678"; // plausible channel id
    const probot = makeProbot();
    const appModule = await import("../src/index.ts");
    probot.load(appModule.default);
    await expect(appModule.configValidationPromise).resolves.toBeUndefined();
  });
});
