import { ProbotOctokit } from "probot";
import { PullRequestState, ReviewerState, CheckRunState } from "./formatters";
import { createLogger, classifyError } from "./logger";


export async function fetchPullRequestState(
  octokit: ProbotOctokit,
  owner: string,
  repo: string,
  number: number,
  headSha?: string,
): Promise<PullRequestState> {
  // Pull request data
  const logger = createLogger({ component: "github", repo: `${owner}/${repo}`, prNumber: number });
  let pr;
  try {
    pr = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
  } catch (e) {
    const { code, message } = classifyError(e);
    logger.error("pull_request_fetch_failed", { code, error: message });
    throw e; // propagate; caller handles
  }
  const merged = !!pr.data.merged;
  const closed = pr.data.state === "closed";
  const title = pr.data.title;
  const url = pr.data.html_url;
  const author = pr.data.user?.login ?? "unknown";

  // Reviewers & reviews
  let reviewsResp;
  try {
    reviewsResp = await octokit.rest.pulls.listReviews({ owner, repo, pull_number: number, per_page: 100 });
  } catch (e) {
    const { code, message } = classifyError(e);
    logger.error("reviews_fetch_failed", { code, error: message });
    reviewsResp = { data: [] } as any; // degrade gracefully
  }
  const latestReviewByUser: Record<string, ReviewerState["status"]> = {};
  for (const r of reviewsResp.data) {
    const login = r.user?.login;
    if (!login) continue;
    let status: ReviewerState["status"] = "pending";
    if (r.state === "APPROVED") status = "approved";
    else if (r.state === "CHANGES_REQUESTED") status = "changes_requested";
    // COMMENTED or others keep pending
    latestReviewByUser[login] = status;
  }

  // Requested reviewers from PR object
  const requested = pr.data.requested_reviewers?.map((u) => u.login).filter(Boolean) ?? [];
  // Combine: ensure requested appear even without review
  for (const login of requested) {
    if (login && !latestReviewByUser[login]) {
      latestReviewByUser[login] = "pending";
    }
  }

  const reviewers: ReviewerState[] = Object.entries(latestReviewByUser).map(([login, status]) => ({ login, status }));

  // Checks
  const sha = headSha ?? pr.data.head.sha;
  let checksResp;
  try {
    checksResp = await octokit.rest.checks.listForRef({ owner, repo, ref: sha, per_page: 100 });
  } catch (e) {
    const { code, message } = classifyError(e);
    logger.error("checks_fetch_failed", { code, error: message, sha });
    checksResp = { data: { check_runs: [] } } as any; // fallback
  }
  const checks: CheckRunState[] = checksResp.data.check_runs.map((run: any) => ({
    name: run.name,
    status: run.conclusion === "success"
      ? "success"
      : run.conclusion === "failure" || run.conclusion === "cancelled" || run.conclusion === "timed_out"
        ? "failure"
        : run.status !== "completed"
          ? "pending"
          : run.conclusion === "neutral" || run.conclusion === "skipped"
            ? "success" // treat neutral/skipped as pass for summary simplicity
            : "pending",
  }));

  return {
    owner,
    repo,
    number,
    title,
    url,
    author,
    merged,
    closed,
    reviewers,
    checks,
  };
}
