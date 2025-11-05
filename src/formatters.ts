import { mapUser, UserMap } from "./user-mapping.js";

export interface ReviewerState {
  login: string;
  status: "approved" | "changes_requested" | "pending";
}

export interface CheckRunState {
  name: string;
  status: "success" | "failure" | "pending";
}

export interface PullRequestState {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  merged: boolean;
  closed: boolean;
  reviewers: ReviewerState[];
  checks: CheckRunState[];
}

function reviewerEmoji(status: ReviewerState["status"]): string {
  switch (status) {
    case "approved":
      return "✅";
    case "changes_requested":
      return "❌";
    case "pending":
    default:
      return "🟡";
  }
}

function checkEmoji(status: CheckRunState["status"]): string {
  switch (status) {
    case "success":
      return "✅";
    case "failure":
      return "❌";
    case "pending":
    default:
      return "🕒";
  }
}

export function buildMainMessage(state: PullRequestState, mapping: UserMap): string {
  const header = `[${state.owner}/${state.repo}] – ${state.title} (#${state.number}) ${state.url}`;
  const author = `Author: ${mapUser(mapping, state.author)}`;
  const reviewersLine =
    state.reviewers.length === 0
      ? "Reviewers: (none)"
      : "Reviewers: " +
        state.reviewers
          .map((r) => `${mapUser(mapping, r.login)} ${reviewerEmoji(r.status)}`)
          .join(", ");
  const totalChecks = state.checks.length;
  const passed = state.checks.filter((c) => c.status === "success").length;
  const statusLine = `Status: ${passed}/${totalChecks} checks passed`;

  let lifecyclePrefix = "";
  if (state.merged) lifecyclePrefix = "Merged ✅ | ";
  else if (state.closed && !state.merged) lifecyclePrefix = "Closed ❌ | ";

  const key = `${state.owner}/${state.repo}#${state.number}`;
  const marker = `<!-- pr-messaging-bot:${key} -->`;
  return `${lifecyclePrefix}${header}\n${author}\n${reviewersLine}\n${statusLine}\n${marker}`;
}

export function buildThreadMessage(state: PullRequestState): string {
  if (state.checks.length === 0) return "No checks reported.";
  const lines = state.checks
    .map((c) => `${checkEmoji(c.status)} ${c.name}`)
    .join("\n");
  const total = state.checks.length;
  const passed = state.checks.filter((c) => c.status === "success").length;
  const failed = state.checks.filter((c) => c.status === "failure").length;
  const pending = total - passed - failed;
  return `Checks breakdown (passed/failed/pending): ${passed}/${failed}/${pending}\n${lines}`;
}

/**
 * Build a Slack thread message for a PR comment (issue comment, review comment) that matched a keyword.
 * This must include a hidden marker so we can recover/update it later. We DO NOT change the existing
 * main message marker contract; instead we add a distinct marker namespace: comment:<owner>/<repo>#<prNumber>:<commentId>
 */
export function buildKeywordCommentMessage(args: {
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  author: string;
  body: string;
  url?: string; // direct URL to the comment if available
}): string {
  const { owner, repo, prNumber, commentId, author, body, url } = args;
  const trimmed = body.length > 400 ? body.slice(0, 397) + "…" : body;
  const header = `Comment by @${author}`;
  const linkPart = url ? ` – ${url}` : "";
  const key = `comment:${owner}/${repo}#${prNumber}:${commentId}`;
  const marker = `<!-- pr-messaging-bot:${key} -->`;
  return `${header}${linkPart}\n${trimmed}\n${marker}`;
}

