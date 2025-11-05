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
  // Mrkdwn formatted header with repo + PR number links. Query param uniquely identifies bot messages for recovery.
  const repoLink = `<https://github.com/${state.owner}/${state.repo}|${state.owner}/${state.repo}>`;
  const prLink = `<${state.url}?frombot=pr-message-bot|#${state.number}>`;
  const header = `${repoLink} – *${state.title}* (${prLink})`;
  const authorHandle = `Author: ${mapUser(mapping, state.author)}`;
  const reviewersSegment =
    state.reviewers.length === 0
      ? "Reviewers: (none)"
      : "Reviewers: " +
        state.reviewers
          .map((r) => `${mapUser(mapping, r.login)} ${reviewerEmoji(r.status)}`)
          .join(", ");
  const totalChecks = state.checks.length;
  const passed = state.checks.filter((c) => c.status === "success").length;
  let statusEmoji: string;
  if (totalChecks === 0) statusEmoji = "🤷"; // no checks
  else if (passed === totalChecks) statusEmoji = "✅"; // all passed
  else if (state.checks.some((c) => c.status === "failure")) statusEmoji = "❌"; // at least one failure
  else statusEmoji = "🟡"; // pending
  const statusLine = `${statusEmoji} Status: ${passed}/${totalChecks} checks passed`;

  let lifecyclePrefix = "";
  if (state.merged) lifecyclePrefix = "Merged ✅ | ";
  else if (state.closed && !state.merged) lifecyclePrefix = "Closed ❌ | ";

  // Combine author + reviewers on one line
  const peopleLine = `${authorHandle} | ${reviewersSegment}`;
  return `${lifecyclePrefix}${header}\n${peopleLine}\n${statusLine}`;
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
  const { author, body, url } = args;
  const trimmed = body.length > 400 ? body.slice(0, 397) + "…" : body;
  const header = `Comment by @${author}`;
  const linkPart = url ? ` – ${url}` : "";
  // Hard cut migration: comment messages no longer carry hidden markers.
  return `${header}${linkPart}\n${trimmed}`;
}

