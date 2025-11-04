import { describe, it, expect } from "vitest";
import { fetchPullRequestState } from "../src/github";

// Build a stub Octokit matching minimal interface used by fetchPullRequestState
function makeOctokitStub(prData: any, reviews: any[], checkRuns: any[]) {
  return {
    rest: {
      pulls: {
        get: async () => ({ data: prData }),
        listReviews: async () => ({ data: reviews }),
      },
      checks: {
        listForRef: async () => ({ data: { check_runs: checkRuns } }),
      },
    },
  } as any;
}

describe("fetchPullRequestState", () => {
  const basePr = {
    merged: false,
    state: "open",
    title: "Improve API latency",
    html_url: "https://github.com/org/repo/pull/99",
    user: { login: "alice" },
    requested_reviewers: [{ login: "carol" }],
    head: { sha: "abc123" },
  };

  it("maps reviews and includes requested reviewers pending", async () => {
    const reviews = [
      { user: { login: "bob" }, state: "COMMENTED" }, // stays pending
      { user: { login: "bob" }, state: "APPROVED" }, // latest approved wins
    ];
  const checks: any[] = [];
    const octokit = makeOctokitStub(basePr, reviews, checks);
    const state = await fetchPullRequestState(octokit, "org", "repo", 99);
    const bob = state.reviewers.find(r => r.login === "bob");
    const carol = state.reviewers.find(r => r.login === "carol");
    expect(bob?.status).toBe("approved");
    expect(carol?.status).toBe("pending");
  });

  it("latest review overrides earlier CHANGES_REQUESTED with APPROVED", async () => {
    const reviews = [
      { user: { login: "dave" }, state: "CHANGES_REQUESTED" },
      { user: { login: "dave" }, state: "APPROVED" },
    ];
    const octokit = makeOctokitStub(basePr, reviews, []);
    const state = await fetchPullRequestState(octokit, "org", "repo", 99);
    const dave = state.reviewers.find(r => r.login === "dave");
    expect(dave?.status).toBe("approved");
  });

  it("classifies check runs into success, failure, pending including neutral/skipped treated success", async () => {
    const reviews: any[] = [];
    const checkRuns = [
      { name: "lint", conclusion: "success", status: "completed" },
      { name: "unit", conclusion: "failure", status: "completed" },
      { name: "integration", conclusion: null, status: "in_progress" },
      { name: "style", conclusion: "neutral", status: "completed" },
      { name: "docs", conclusion: "skipped", status: "completed" },
      { name: "e2e", conclusion: null, status: "queued" },
    ];
    const octokit = makeOctokitStub(basePr, reviews, checkRuns);
    const state = await fetchPullRequestState(octokit, "org", "repo", 99);
    const map = Object.fromEntries(state.checks.map(c => [c.name, c.status]));
    expect(map.lint).toBe("success");
    expect(map.unit).toBe("failure");
    expect(map.integration).toBe("pending");
    expect(map.style).toBe("success");
    expect(map.docs).toBe("success");
    expect(map.e2e).toBe("pending");
  });

  it("returns merged and closed flags correctly", async () => {
    const pr = { ...basePr, merged: true, state: "closed" };
    const octokit = makeOctokitStub(pr, [], []);
    const state = await fetchPullRequestState(octokit, "org", "repo", 99);
    expect(state.merged).toBe(true);
    expect(state.closed).toBe(true);
  });
});
