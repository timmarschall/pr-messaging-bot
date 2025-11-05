import { describe, it, expect } from "vitest";
import { buildMainMessage, buildThreadMessage, PullRequestState } from "../src/formatters.js";

const baseState: PullRequestState = {
  owner: "org",
  repo: "repo",
  number: 42,
  title: "Improve performance",
  url: "https://github.com/org/repo/pull/42",
  author: "alice",
  merged: false,
  closed: false,
  reviewers: [
    { login: "bob", status: "approved" },
    { login: "carol", status: "changes_requested" },
    { login: "dave", status: "pending" },
  ],
  checks: [
    { name: "lint", status: "success" },
    { name: "unit", status: "failure" },
    { name: "build", status: "pending" },
  ],
};

describe("formatters", () => {
  it("builds main message with combined people line and status emoji", () => {
    const text = buildMainMessage(baseState, { alice: "alice.slack", bob: "bob.slack" });
    expect(text).toMatch(/<https:\/\/github\.com\/org\/repo\|org\/repo>/); // repo mrkdwn link
    expect(text).toMatch(/<https:\/\/github\.com\/org\/repo\/pull\/42\?frombot=pr-message-bot\|#42>/); // PR link with tracking param
    // Combined line
    expect(text).toMatch(/Author: @alice.slack \| Reviewers:/);
    expect(text).toMatch(/@bob.slack ✅/);
    expect(text).toMatch(/@carol ❌/); // fallback mapping
    expect(text).toMatch(/@dave 🟡/);
    // Status emoji should be ❌ because there is a failure present
    expect(text).toMatch(/❌ Status: 1\/3 checks passed/);
  });

  it("builds thread message breakdown", () => {
    const thread = buildThreadMessage(baseState);
    expect(thread).toContain("Checks breakdown");
    expect(thread).toMatch(/✅ lint/);
    expect(thread).toMatch(/❌ unit/);
    expect(thread).toMatch(/🕒 build/);
  });

  it("marks merged state", () => {
    const merged = { ...baseState, merged: true };
    const text = buildMainMessage(merged, {});
    expect(text.startsWith("Merged ✅"));
  });

  it("marks closed state", () => {
    const closed = { ...baseState, closed: true };
    const text = buildMainMessage(closed, {});
    expect(text.startsWith("Closed ❌"));
  });
});
