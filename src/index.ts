import { Probot, ProbotOctokit } from "probot";
import { loadUserMapping } from "./user-mapping";
import { SlackClient } from "./slack";
import { Storage } from "./storage";
import { buildMainMessage, buildThreadMessage } from "./formatters";
import { fetchPullRequestState } from "./github";
import { createLogger, classifyError } from "./logger";
import dotenv from "dotenv";

dotenv.config();

const slackToken = process.env.SLACK_TOKEN;
const slackChannel = process.env.SLACK_CHANNEL;

const rootLogger = createLogger({ component: "app" });
if (!slackToken || !slackChannel) {
  rootLogger.warn("Slack disabled: missing token or channel", { code: "config_missing" });
}

const slack = slackToken && slackChannel ? new SlackClient(slackToken) : null;
const storage = new Storage();
const userMap = loadUserMapping();

async function validateConfig() {
  if (!slack) return;
  // Validate Slack channel accessibility
  const ok = await slack.validateChannel(slackChannel!);
  if (!ok) {
    rootLogger.error("Slack channel validation failed", { code: "config_invalid", channel: slackChannel });
  }
}

// Kick off validation after tick so tests can mock endpoint before import completes
export const configValidationPromise: Promise<void> = new Promise((resolve) => {
  setImmediate(() => {
    validateConfig()
      .catch((e) => {
        const { code, message } = classifyError(e);
        rootLogger.error("Config validation exception", { code, error: message });
      })
      .finally(resolve);
  });
});

export default (app: Probot) => {
  // Central handler to sync a PR to Slack
  const debounceMs = parseInt(process.env.DEBOUNCE_MS ?? "0", 10);
  const pendingTimers = new Map<string, NodeJS.Timeout>();
  const latestArgs = new Map<string, { octokit: ProbotOctokit; owner: string; repo: string; prNumber: number; headSha?: string }>();

  const executeSync = async (
    octokit: ProbotOctokit,
    owner: string,
    repo: string,
    prNumber: number,
    headSha?: string
  ) => {
    try {
      const logger = rootLogger.child({ repo: `${owner}/${repo}`, prNumber });
      if (!slack) {
        logger.debug("Skip sync: slack disabled");
        return;
      }
      const state = await fetchPullRequestState(
        octokit,
        owner,
        repo,
        prNumber,
        headSha
      );
      const key = `${owner}/${repo}#${prNumber}`;
      let record = storage.get(key);

      // Create message if missing
      if (!record) {
        // Attempt recovery by scanning channel history
        const foundTs = await slack.findMessageByKey(slackChannel!, key);
        if (foundTs) {
          // Found existing message; ensure thread reply exists or create
          const threadText = buildThreadMessage(state);
          // We need to fetch thread replies? Simplify: create/update a thread message anew.
          const threadRes = await slack.postMessage({
            channel: slackChannel!,
            text: threadText,
            thread_ts: foundTs,
          });
          record = {
            channel: slackChannel!,
            ts: foundTs,
            thread_ts: threadRes.ts,
            last_main: undefined,
            last_thread: threadText,
          };
          storage.set(key, record);
          // Update main message to latest state
          const mainTextUpdate = buildMainMessage(state, userMap);
          await slack.updateMessage({
            channel: record.channel,
            ts: record.ts,
            text: mainTextUpdate,
          });
          record.last_main = mainTextUpdate;
          record.last_thread = threadText;
        } else {
          // Create new message
          const mainText = buildMainMessage(state, userMap);
          const res = await slack.postMessage({
            channel: slackChannel!,
            text: mainText,
          });
          const threadText = buildThreadMessage(state);
          const threadRes = await slack.postMessage({
            channel: slackChannel!,
            text: threadText,
            thread_ts: res.ts,
          });
          const newRecord = {
            channel: slackChannel!,
            ts: res.ts,
            thread_ts: threadRes.ts,
            last_main: mainText,
            last_thread: threadText,
          };
          storage.set(key, newRecord);
        }
      } else {
        const mainText = buildMainMessage(state, userMap);
        const threadText = buildThreadMessage(state);

        const sameMain = record.last_main === mainText;
        const sameThread = record.last_thread === threadText;

        // Skip Slack API calls entirely if both unchanged
        if (sameMain && sameThread) {
          return;
        }

        if (!sameMain) {
          await slack.updateMessage({
            channel: record.channel,
            ts: record.ts,
            text: mainText,
          });
          record.last_main = mainText;
        }

        if (!sameThread) {
          await slack.updateMessage({
            channel: record.channel,
            ts: record.thread_ts,
            text: threadText,
          });
          record.last_thread = threadText;
        }
      }
    } catch (err) {
      const { code, message } = classifyError(err);
      rootLogger.error("Failed to sync PR", { code, error: message, repo: `${owner}/${repo}`, prNumber });
    }
  };

  const scheduleSync = (
    octokit: ProbotOctokit,
    owner: string,
    repo: string,
    prNumber: number,
    headSha?: string,
    event?: string
  ): Promise<void> => {
    const key = `${owner}/${repo}#${prNumber}`;
    latestArgs.set(key, { octokit, owner, repo, prNumber, headSha });
    if (debounceMs <= 0) {
      return executeSync(octokit, owner, repo, prNumber, headSha);
    }
    const existing = pendingTimers.get(key);
    if (existing) clearTimeout(existing);
    const logger = rootLogger.child({ repo: `${owner}/${repo}`, prNumber, event });
    logger.debug("Debounce schedule", { code: "debounce" });
    const t = setTimeout(() => {
      pendingTimers.delete(key);
      const latest = latestArgs.get(key)!;
      executeSync(latest.octokit, latest.owner, latest.repo, latest.prNumber, latest.headSha);
    }, debounceMs);
    pendingTimers.set(key, t);
    return Promise.resolve();
  };

  // Pull request lifecycle events
  app.on(
    [
      "pull_request.opened",
      "pull_request.reopened",
      "pull_request.synchronize",
    ],
    async (context) => {
      const prNumber = context.payload.pull_request!.number;
      const sha = context.payload.pull_request!.head.sha;
      const { owner, repo } = context.repo();
  await scheduleSync(context.octokit, owner, repo, prNumber, sha, context.payload.action);
    }
  );

  app.on("pull_request.closed", async (context) => {
    const prNumber = context.payload.pull_request!.number;
    const sha = context.payload.pull_request!.head.sha;
    const { owner, repo } = context.repo();
  await scheduleSync(context.octokit, owner, repo, prNumber, sha, context.payload.action);
  });

  // Reviews
  app.on(
    ["pull_request_review.submitted", "pull_request_review.dismissed"],
    async (context) => {
      const prNumber = context.payload.pull_request!.number;
      const sha = context.payload.pull_request!.head.sha;
      const { owner, repo } = context.repo();
  await scheduleSync(context.octokit, owner, repo, prNumber, sha, context.payload.action);
    }
  );

  // Review requests add/remove
  app.on(
    ["pull_request.review_requested", "pull_request.review_request_removed"],
    async (context) => {
      const prNumber = context.payload.pull_request!.number;
      const sha = context.payload.pull_request!.head.sha;
      const { owner, repo } = context.repo();
  await scheduleSync(context.octokit, owner, repo, prNumber, sha, context.payload.action);
    }
  );

  // Checks & statuses
  app.on("check_suite.completed", async (context) => {
    const owner = context.payload.repository!.owner.login;
    const repo = context.payload.repository!.name;
    const sha = context.payload.check_suite?.head_sha;
    if (!sha) return;
    try {
      const prs =
        await context.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
          owner,
          repo,
          commit_sha: sha,
        });
      for (const pr of prs.data) {
  await scheduleSync(context.octokit, owner, repo, pr.number, sha, context.name);
      }
    } catch (e) {
      const { code, message } = classifyError(e);
      rootLogger.error("Commit association failed", { code, error: message, repo: `${owner}/${repo}` });
    }
  });
  app.on("check_run.completed", async (context) => {
    const owner = context.payload.repository!.owner.login;
    const repo = context.payload.repository!.name;
    const sha = context.payload.check_run?.head_sha;
    if (!sha) return;
    try {
      const prs =
        await context.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
          owner,
          repo,
          commit_sha: sha,
        });
      for (const pr of prs.data) {
  await scheduleSync(context.octokit, owner, repo, pr.number, sha, context.name);
      }
    } catch (e) {
      const { code, message } = classifyError(e);
      rootLogger.error("Commit association failed", { code, error: message, repo: `${owner}/${repo}` });
    }
  });

  app.on("status", async (context) => {
    const owner = context.payload.repository!.owner.login;
    const repo = context.payload.repository!.name;
    const sha = context.payload.sha;
    if (!sha) return;
    try {
      const prs =
        await context.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
          owner,
          repo,
          commit_sha: sha,
        });
      for (const pr of prs.data) {
  await scheduleSync(context.octokit, owner, repo, pr.number, sha, context.name);
      }
    } catch (e) {
      const { code, message } = classifyError(e);
      rootLogger.error("Commit association failed", { code, error: message, repo: `${owner}/${repo}` });
    }
  });
};
