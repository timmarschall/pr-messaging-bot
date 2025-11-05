import { Probot, ProbotOctokit } from "probot";
import { loadUserMapping } from "./user-mapping";
import { SlackClient } from "./slack";
import { Storage } from "./storage";
import { buildMainMessage, buildThreadMessage, buildKeywordCommentMessage } from "./formatters";
import { fetchPullRequestState } from "./github";
import { createLogger, classifyError } from "./logger";

const slackToken = process.env.SLACK_TOKEN;
const slackChannel = process.env.SLACK_CHANNEL;
const slack = slackToken && slackChannel ? new SlackClient(slackToken) : null;
// Keyword matching env var: comma-separated list; case-insensitive substring match.
// Example: SLACK_COMMENT_KEYWORDS="security,urgent review,needs benchmark"
const rawKeywords = process.env.SLACK_COMMENT_KEYWORDS || "";
const COMMENT_KEYWORDS = rawKeywords
  .split(/[,\n]/)
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
function findMatchingKeyword(body: string): string | undefined {
  if (!COMMENT_KEYWORDS.length) return undefined;
  const lower = body.toLowerCase();
  for (const kw of COMMENT_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return kw;
  }
  return undefined;
}

// Shared handler for keyword-triggering comments (issue or review).
// Accepts GitHub comment object with id, body, user.login and a URL builder.
async function processKeywordComment(params: {
  owner: string;
  repo: string;
  prNumber: number;
  comment: { id: number; body?: string; user?: { login?: string } };
  buildUrl: (commentId: number) => string;
  loggerTag: string; // for logging source (issue_comment / review_comment)
}): Promise<void> {
  if (!slack) return; // Slack disabled
  const { owner, repo, prNumber, comment, buildUrl, loggerTag } = params;
  const body = comment.body ?? "";
  const matched = findMatchingKeyword(body);
  if (!matched) return;
  const commentId = comment.id;
  const author = comment.user?.login || "unknown";
  const prKey = `${owner}/${repo}#${prNumber}`;
  const mainRecord = storage.get(prKey);
  let parentRecord = mainRecord;
  if (!parentRecord) {
    // Attempt recovery for the main PR message if not cached yet.
    const foundTs = await slack.findMessageByKey(slackChannel!, prKey);
    if (!foundTs) return; // cannot proceed without parent
    // Recreate thread message (checks) to maintain consistency
    // We need minimal state to build thread message; reuse existing sync path would complicate.
    // Accept posting a generic placeholder if state not ready.
    const placeholderThread = "No checks reported."; // safe minimal fallback
    const threadRes = await slack.postMessage({ channel: slackChannel!, text: placeholderThread, thread_ts: foundTs });
    parentRecord = { channel: slackChannel!, ts: foundTs, thread_ts: threadRes.ts, last_thread: placeholderThread };
    storage.set(prKey, parentRecord);
  }
  const commentKey = `comment:${owner}/${repo}#${prNumber}:${commentId}`;
  const existing = storage.get(commentKey);
  const url = buildUrl(commentId);
  const messageText = buildKeywordCommentMessage({ owner, repo, prNumber, commentId, author, body, url });
  const logger = createLogger({ component: "keyword" });
  logger.info("keyword_comment_match", { repo: `${owner}/${repo}`, prNumber, commentId, keyword: matched, source: loggerTag });
  try {
    if (!existing) {
      // Attempt recovery of existing reply by scanning thread replies for the comment anchor fragment
      // Anchor patterns: issue comments -> #issuecomment-<id>; review comments -> #discussion_r<id>
      let anchorFragment = "";
      const hashIndex = url.indexOf("#");
      if (hashIndex !== -1) anchorFragment = url.substring(hashIndex); // includes leading '#'
      const replyTs = anchorFragment
        ? await slack.findReplyByMarker(slackChannel!, parentRecord.ts, anchorFragment)
        : undefined;
      if (replyTs) {
        await slack.updateMessage({ channel: slackChannel!, ts: replyTs, text: messageText });
        storage.set(commentKey, { channel: slackChannel!, ts: parentRecord.ts, thread_ts: replyTs, last_main: messageText });
      } else {
        const postRes = await slack.postMessage({ channel: slackChannel!, text: messageText, thread_ts: parentRecord.ts });
        storage.set(commentKey, { channel: slackChannel!, ts: parentRecord.ts, thread_ts: postRes.ts, last_main: messageText });
      }
    } else {
      await slack.updateMessage({ channel: existing.channel, ts: existing.thread_ts, text: messageText });
      existing.last_main = messageText;
    }
  } catch (e) {
    const { code, message } = classifyError(e);
    logger.error("keyword_comment_failed", { code, error: message, repo: `${owner}/${repo}`, prNumber, commentId });
  }
}
const storage = new Storage();
const userMap = loadUserMapping();

// Exported promise placeholder; replaced once app initializes.
export let configValidationPromise: Promise<void> = Promise.resolve();

export default (app: Probot) => {
  // Provide Probot logger globally for createLogger consumers.
  (globalThis as any).__APP_LOGGER = app.log;
  const rootLogger = createLogger({ component: "app" });
  if (!slackToken || !slackChannel) {
    rootLogger.warn("Slack disabled: missing token or channel", { code: "config_missing" });
  }
  rootLogger.debug("Logger initialized", { level: process.env.LOG_LEVEL });

  // Define and kick off config validation now that logger is available.
  const validateConfig = async () => {
    if (!slack) return;
    const ok = await slack.validateChannel(slackChannel!);
    if (!ok) {
      rootLogger.error("Slack channel validation failed", { code: "config_invalid", channel: slackChannel });
    }
  };
  configValidationPromise = new Promise((resolve) => {
    setImmediate(() => {
      validateConfig()
        .catch((e) => {
          const { code, message } = classifyError(e);
          rootLogger.error("Config validation exception", { code, error: message });
        })
        .finally(resolve);
    });
  });

  app.onAny(async (context) => {
    app.log.info({ event: context.name, action: (context.payload as any).action as string | undefined }, "event_dispatch");
  });

  const executeSync = async (
    octokit: ProbotOctokit,
    owner: string,
    repo: string,
    prNumber: number,
    headSha?: string,
    event?: string
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
        const forceUpdateEvents = new Set([
          // Issue (PR) conversation comments
          "issue_comment.created",
          "issue_comment.edited",
          "issue_comment.deleted",
          // Inline review comments
            "pull_request_review_comment.created",
            "pull_request_review_comment.edited",
            "pull_request_review_comment.deleted",
          // Overall review submissions (already handled elsewhere)
          "pull_request_review.submitted",
        ]);
        const force = event && forceUpdateEvents.has(event);

        if (!force && sameMain && sameThread) {
          return;
        }

        // When forcing, update both to reflect latest activity timestamp even if identical text
        if (force || !sameMain) {
          await slack.updateMessage({
            channel: record.channel,
            ts: record.ts,
            text: mainText,
          });
          record.last_main = mainText;
        }

        if (force || !sameThread) {
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
    return executeSync(octokit, owner, repo, prNumber, headSha, event);
  };

  // Pull request lifecycle events
  app.on(
    [
      "pull_request.opened",
      "pull_request.reopened",
      "pull_request.synchronize",
      "pull_request.edited",
    ],
    async (context) => {
      const prNumber = context.payload.pull_request!.number;
      const sha = context.payload.pull_request!.head.sha;
      const { owner, repo } = context.repo();
      rootLogger.info("Event received", { event: context.name, action: context.payload.action, repo: `${owner}/${repo}`, prNumber, sha });
  await scheduleSync(context.octokit, owner, repo, prNumber, sha, context.payload.action);
    }
  );

  app.on("pull_request.closed", async (context) => {
    const prNumber = context.payload.pull_request!.number;
    const sha = context.payload.pull_request!.head.sha;
    const { owner, repo } = context.repo();
    rootLogger.info("Event received", { event: context.name, action: context.payload.action, repo: `${owner}/${repo}`, prNumber, sha });
  await scheduleSync(context.octokit, owner, repo, prNumber, sha, context.payload.action);
  });

  // Reviews
  app.on(
    ["pull_request_review.submitted", "pull_request_review.dismissed"],
    async (context) => {
      const prNumber = context.payload.pull_request!.number;
      const sha = context.payload.pull_request!.head.sha;
      const { owner, repo } = context.repo();
      rootLogger.info("Event received", { event: context.name, action: context.payload.action, repo: `${owner}/${repo}`, prNumber, sha });
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
      rootLogger.info("Event received", { event: context.name, action: context.payload.action, repo: `${owner}/${repo}`, prNumber, sha });
  await scheduleSync(context.octokit, owner, repo, prNumber, sha, context.payload.action);
    }
  );

  // Issue comments on a PR (regular conversation comments)
  app.on("issue_comment.created", async (context) => {
    // Only act if the issue is a PR (GitHub includes pull_request key)
    if (!('pull_request' in context.payload.issue)) return;
    const prNumber = context.payload.issue.number;
    const { owner, repo } = context.repo();
    rootLogger.info("Event received", { event: context.name, action: context.payload.action, repo: `${owner}/${repo}`, prNumber });
    await scheduleSync(context.octokit, owner, repo, prNumber, undefined, "issue_comment.created");
    await processKeywordComment({
      owner,
      repo,
      prNumber,
      comment: context.payload.comment,
      buildUrl: (id) => `https://github.com/${owner}/${repo}/pull/${prNumber}#issuecomment-${id}`,
      loggerTag: "issue_comment.created",
    });
  });

  app.on(["issue_comment.edited", "issue_comment.deleted"], async (context) => {
    if (!('pull_request' in context.payload.issue)) return;
    const prNumber = context.payload.issue.number;
    const { owner, repo } = context.repo();
    const eventName = context.name + "." + context.payload.action; // results like issue_comment.edited/deleted
    rootLogger.info("Event received", { event: context.name, action: context.payload.action, repo: `${owner}/${repo}`, prNumber });
    await scheduleSync(context.octokit, owner, repo, prNumber, undefined, eventName);
    // For edited only: update keyword comment if previously created OR now matches.
    if (context.payload.action === "edited") {
      await processKeywordComment({
        owner,
        repo,
        prNumber,
        comment: context.payload.comment,
        buildUrl: (id) => `https://github.com/${owner}/${repo}/pull/${prNumber}#issuecomment-${id}`,
        loggerTag: "issue_comment.edited",
      });
    }
  });

  // Inline review comments (not the overall review submission which is already handled)
  app.on("pull_request_review_comment.created", async (context) => {
    const prNumber = context.payload.pull_request!.number;
    const { owner, repo } = context.repo();
    // Head SHA is obtainable from pull_request object
    const sha = context.payload.pull_request!.head.sha;
    rootLogger.info("Event received", { event: context.name, action: context.payload.action, repo: `${owner}/${repo}`, prNumber, sha });
    await scheduleSync(context.octokit, owner, repo, prNumber, sha, "pull_request_review_comment.created");
    await processKeywordComment({
      owner,
      repo,
      prNumber,
      comment: context.payload.comment,
      buildUrl: (id) => `https://github.com/${owner}/${repo}/pull/${prNumber}#discussion_r${id}`,
      loggerTag: "review_comment.created",
    });
  });

  app.on(["pull_request_review_comment.edited", "pull_request_review_comment.deleted"], async (context) => {
    const prNumber = context.payload.pull_request!.number;
    const { owner, repo } = context.repo();
    const sha = context.payload.pull_request!.head.sha;
    const eventName = context.name + "." + context.payload.action; // edited/deleted
    rootLogger.info("Event received", { event: context.name, action: context.payload.action, repo: `${owner}/${repo}`, prNumber, sha });
    await scheduleSync(context.octokit, owner, repo, prNumber, sha, eventName);
    if (context.payload.action === "edited") {
      await processKeywordComment({
        owner,
        repo,
        prNumber,
        comment: context.payload.comment,
        buildUrl: (id) => `https://github.com/${owner}/${repo}/pull/${prNumber}#discussion_r${id}`,
        loggerTag: "review_comment.edited",
      });
    }
  });

  // Checks & statuses
  app.on("check_suite.completed", async (context) => {
    const owner = context.payload.repository!.owner.login;
    const repo = context.payload.repository!.name;
    const sha = context.payload.check_suite?.head_sha;
    rootLogger.info("Event received", { event: context.name, repo: `${owner}/${repo}`, sha });
    if (!sha) return;
    try {
      const prs =
        await context.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
          owner,
          repo,
          commit_sha: sha,
        });
      for (const pr of prs.data) {
        rootLogger.info("Associated PR sync", { event: context.name, repo: `${owner}/${repo}`, prNumber: pr.number, sha });
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
    rootLogger.info("Event received", { event: context.name, repo: `${owner}/${repo}`, sha });
    if (!sha) return;
    try {
      const prs =
        await context.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
          owner,
          repo,
          commit_sha: sha,
        });
      for (const pr of prs.data) {
        rootLogger.info("Associated PR sync", { event: context.name, repo: `${owner}/${repo}`, prNumber: pr.number, sha });
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
    rootLogger.info("Event received", { event: context.name, repo: `${owner}/${repo}`, sha, state: context.payload.state });
    if (!sha) return;
    try {
      const prs =
        await context.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
          owner,
          repo,
          commit_sha: sha,
        });
      for (const pr of prs.data) {
        rootLogger.info("Associated PR sync", { event: context.name, repo: `${owner}/${repo}`, prNumber: pr.number, sha });
  await scheduleSync(context.octokit, owner, repo, pr.number, sha, context.name);
      }
    } catch (e) {
      const { code, message } = classifyError(e);
      rootLogger.error("Commit association failed", { code, error: message, repo: `${owner}/${repo}` });
    }
  });
};
