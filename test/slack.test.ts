import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { SlackClient } from "../src/slack";

// Helper to build a history response
function historyResponse(messages: any[], has_more = false, next_cursor?: string) {
  return {
    ok: true,
    messages,
    has_more,
    response_metadata: next_cursor ? { next_cursor } : undefined,
  };
}

const channel = "C123";
const key = "owner/repo#42";
// New recovery identifier: unique PR URL with tracking query param.
const prUrl = `https://github.com/owner/repo/pull/42?frombot=pr-message-bot`;

describe("SlackClient.findMessageByKey", () => {
  let client: SlackClient;
  beforeEach(() => {
    client = new SlackClient("xoxb-test-token");
    nock.disableNetConnect();
  });
  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it("finds PR URL fragment in first page (text message)", async () => {
    const scope = nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, historyResponse([
  { ts: "1", text: `Hello ${prUrl} here` },
      ]));

    const ts = await client.findMessageByKey(channel, key);
    expect(ts).toBe("1");
    expect(scope.isDone()).toBe(true);
  });

  it("paginates and finds PR URL on second page", async () => {
    const first = nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, historyResponse([
        { ts: "10", text: "nope" },
        { ts: "11", text: "still no" },
      ], true, "cursor-2"));

    const second = nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, historyResponse([
  { ts: "12", text: `Something ${prUrl}` },
      ], false));

    const ts = await client.findMessageByKey(channel, key, 50);
    expect(ts).toBe("12");
    expect(first.isDone()).toBe(true);
    expect(second.isDone()).toBe(true);
  });

  it("respects maxMessages and returns undefined if PR URL appears later", async () => {
    const scope = nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, historyResponse([
        { ts: "1", text: "a" },
        { ts: "2", text: "b" },
        { ts: "3", text: "c" },
  { ts: "4", text: `late ${prUrl}` }, // should not be reached when maxMessages=3
      ], false));

    const ts = await client.findMessageByKey(channel, key, 3);
    expect(ts).toBeUndefined();
    expect(scope.isDone()).toBe(true);
  });

  it("extracts PR URL from block-only message", async () => {
    const blockMsg = {
      ts: "22",
      blocks: [
  { type: "section", text: { type: "mrkdwn", text: `Intro line ${prUrl}` } },
      ],
    };
    const scope = nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, historyResponse([blockMsg]));

    const ts = await client.findMessageByKey(channel, key);
    expect(ts).toBe("22");
    expect(scope.isDone()).toBe(true);
  });

  it("early exits after finding PR URL without fetching next page", async () => {
    // First page contains marker and advertises more pages; absence of second mock ensures early exit.
    const first = nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, historyResponse([
  { ts: "31", text: `Here ${prUrl}` },
        { ts: "32", text: "other" },
      ], true, "cursor-next"));

    const ts = await client.findMessageByKey(channel, key, 400);
    expect(ts).toBe("31");
    expect(first.isDone()).toBe(true); // Would fail if second call attempted
  });

  it("handles has_more true but missing next_cursor gracefully", async () => {
    const scope = nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, { ok: true, messages: [{ ts: "41", text: "no marker" }], has_more: true }); // no response_metadata.next_cursor

    const ts = await client.findMessageByKey(channel, key, 10);
    expect(ts).toBeUndefined();
    expect(scope.isDone()).toBe(true);
  });

  it("retries on rate limit and eventually finds PR URL", async () => {
    // First call 429, second call success with marker
    const first = nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(429, { ok: false, error: "ratelimited" }, { 'Retry-After': '0' });
    const second = nock("https://slack.com")
      .post("/api/conversations.history")
  .reply(200, historyResponse([{ ts: "51", text: `Rate ${prUrl}` }]));

    const ts = await client.findMessageByKey(channel, key, 10);
    expect(ts).toBe("51");
    expect(first.isDone()).toBe(true);
    expect(second.isDone()).toBe(true);
  });
  it("scans thread replies when includeThread enabled (reply contains PR URL)", async () => {
    // Parent message without marker but with reply_count, thread has reply containing marker
    const parent = { ts: "200", text: "Parent only", reply_count: 1 };
    const history = nock("https://slack.com")
      .post("/api/conversations.history")
      .reply(200, historyResponse([parent]));
    const replies = nock("https://slack.com")
      .post("/api/conversations.replies")
      .reply(200, {
        ok: true,
  messages: [parent, { ts: "200.1", text: `thread ${prUrl}` }],
      });
    const ts = await client.findMessageByKey(channel, key, { includeThread: true });
    expect(ts).toBe("200");
    expect(history.isDone()).toBe(true);
    expect(replies.isDone()).toBe(true);
  });

  it("uses cache on subsequent lookups to avoid second API call", async () => {
    const scope = nock("https://slack.com")
      .post("/api/conversations.history")
      .once()
  .reply(200, historyResponse([{ ts: "300", text: `x ${prUrl}` }]));
    // First call populates cache
    const ts1 = await client.findMessageByKey(channel, key);
    expect(ts1).toBe("300");
    expect(scope.isDone()).toBe(true);
    // Second call should return cached value without hitting API
    const ts2 = await client.findMessageByKey(channel, key);
    expect(ts2).toBe("300");
  });
});

describe("SlackClient rate limit retry for post/update", () => {
  let client: SlackClient;
  beforeEach(() => {
    client = new SlackClient("xoxb-test-token");
    nock.disableNetConnect();
  });
  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it("retries postMessage after 429", async () => {
    const first = nock("https://slack.com").post("/api/chat.postMessage").reply(429, { ok: false, error: "ratelimited" }, { 'Retry-After': '0' });
    const second = nock("https://slack.com").post("/api/chat.postMessage").reply(200, { ok: true, ts: "999.1" });
    const res = await client.postMessage({ channel: "C123", text: "hello" });
    expect(res.ts).toBe("999.1");
    expect(first.isDone()).toBe(true);
    expect(second.isDone()).toBe(true);
  });

  it("retries updateMessage after 429", async () => {
    const first = nock("https://slack.com").post("/api/chat.update").reply(429, { ok: false, error: "ratelimited" }, { 'Retry-After': '0' });
    const second = nock("https://slack.com").post("/api/chat.update").reply(200, { ok: true, ts: "123.45" });
    const res = await client.updateMessage({ channel: "C123", ts: "123.45", text: "upd" });
    expect(res.ts).toBe("123.45");
    expect(first.isDone()).toBe(true);
    expect(second.isDone()).toBe(true);
  });
});
