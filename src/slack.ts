import {
  WebClient,
  ChatPostMessageArguments,
  ChatUpdateArguments,
  ErrorCode,
  WebAPICallResult,
} from "@slack/web-api";
import { createLogger, classifyError } from "./logger";

/**
 * Minimal typed representation of a Slack message used by this bot.
 * We only include fields we actually read to keep types narrow & safe.
 */
interface SlackMessage {
  ts?: string;
  text?: string; // May be absent for purely block-based messages
  blocks?: any[]; // Slack Block Kit structures (kept loose but not any elsewhere)
  thread_ts?: string; // Parent thread identifier if message is part of a thread
  reply_count?: number; // Number of replies (for deciding whether to fetch thread replies)
}

interface SlackHistoryResponse extends WebAPICallResult {
  ok: boolean;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
  error?: string;
}

// Helper: sleep for ms
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Config options for SlackClient */
interface SlackClientConfig {
  debug?: boolean; // enable verbose debug logs
  findCacheSize?: number; // LRU size for key->ts cache (0 disables)
}

// Extract visible text recursively from Block Kit structures
function extractTextFromBlocks(blocks: any[] | undefined): string {
  if (!blocks || !Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    // Common block types that contain text objects
    if (block.text) {
      if (typeof block.text === "string") parts.push(block.text);
      else if (block.text.text) parts.push(block.text.text);
    }
    if (Array.isArray(block.fields)) {
      for (const f of block.fields) {
        if (!f) continue;
        if (typeof f === "string") parts.push(f);
        else if (f.text) parts.push(f.text);
      }
    }
    // Context elements
    if (Array.isArray(block.elements)) {
      for (const el of block.elements) {
        if (!el) continue;
        if (typeof el === "string") parts.push(el);
        else if (el.text) parts.push(el.text);
      }
    }
  }
  return parts.join("\n");
}

// Combine classic text + block derived text
function getPlainTextFromMessage(message: SlackMessage): string {
  const base = message.text ?? "";
  const blocks = extractTextFromBlocks(message.blocks);
  return [base, blocks].filter(Boolean).join("\n");
}

/**
 * Wrapper to gracefully handle Slack rate limits (429) by respecting retry_after.
 * Retries once by default; can be extended easily.
 */
async function withRateLimitRetry<T>(
  op: () => Promise<T>,
  attempt = 1
): Promise<T> {
  try {
    return await op();
  } catch (err: any) {
    // Slack SDK uses error.code === ErrorCode.RateLimitedError
    const isRateLimited =
      err?.code === ErrorCode.RateLimitedError ||
      err?.data?.error === "ratelimited";
    if (isRateLimited && attempt <= 3) {
      const retryAfterSec: number | undefined =
        err?.data?.retryAfter ??
        err?.retryAfter ??
        parseInt(err?.headers?.["retry-after"], 10);
      const waitMs =
        (retryAfterSec && !Number.isNaN(retryAfterSec) ? retryAfterSec : 1) *
        1000;
      const logger = createLogger({ component: "slack", attempt });
      logger.warn("rate_limit", { waitMs, code: "slack_rate_limit" });
      await sleep(waitMs);
      return withRateLimitRetry(op, attempt + 1);
    }
    throw err;
  }
}

/**
 * Async generator paginating channel history up to maxMessages.
 * Yields individual messages (flattened) to enable early exit.
 */
async function* iterateHistory(
  client: WebClient,
  channel: string,
  maxMessages: number,
  pageSize = 200,
  debug = false
): AsyncGenerator<SlackMessage, void, void> {
  let cursor: string | undefined;
  let scanned = 0;
  const markerLimit = Math.max(1, maxMessages);
  while (scanned < markerLimit) {
    const remaining = markerLimit - scanned;
    const limit = Math.min(pageSize, remaining);
    const res = (await withRateLimitRetry(() =>
      client.conversations.history({ channel, cursor, limit })
    )) as SlackHistoryResponse;

    if (!res.ok) {
      throw new Error(res.error ?? "history_failed");
    }

    const messages = res.messages ?? [];
    if (debug) {
      // eslint-disable-next-line no-console
      console.debug(`Slack history page fetched: +${messages.length} messages (scanned=${scanned})`);
    }
    for (const m of messages) {
      scanned++;
      yield m;
      if (scanned >= markerLimit) return;
    }
    const hasMore = !!res.has_more;
    const nextCursor = res.response_metadata?.next_cursor;
    if (!hasMore || !nextCursor) return; // Guardrails
    cursor = nextCursor;
  }
}

/** Iterate replies for a given parent message (only if we need to). */
async function* iterateThreadReplies(
  client: WebClient,
  channel: string,
  parentTs: string,
  debug = false
): AsyncGenerator<SlackMessage, void, void> {
  // conversations.replies returns the parent as the first message; skip it.
  const res = (await withRateLimitRetry(() =>
    client.conversations.replies({ channel, ts: parentTs, limit: 100 })
  )) as SlackHistoryResponse & { messages?: SlackMessage[] };
  if (!res.ok) throw new Error(res.error ?? "replies_failed");
  const list = res.messages ?? [];
  if (debug) {
    // eslint-disable-next-line no-console
    console.debug(`Slack thread fetch for ts=${parentTs} replies=${Math.max(0, list.length - 1)}`);
  }
  for (let i = 1; i < list.length; i++) {
    yield list[i];
  }
}

// Wrapper around Slack Web API w/ typed responses and robust history scanning.
export class SlackClient {
  private client: WebClient;
  private debug: boolean;
  private findCacheSize: number;
  private findCache: Map<string, string>; // key -> ts

  constructor(token: string, config: SlackClientConfig = {}) {
    this.client = new WebClient(token);
    this.debug = !!config.debug || process.env.SLACK_DEBUG === "1";
    this.findCacheSize = config.findCacheSize ?? 100;
    this.findCache = new Map();
  }

  private logDebug(msg: string) {
    if (this.debug) {
      createLogger({ component: "slack" }).debug(msg);
    }
  }

  private rememberKey(key: string, ts: string) {
    if (this.findCacheSize <= 0) return;
    if (this.findCache.has(key)) this.findCache.delete(key); // refresh recency
    this.findCache.set(key, ts);
    // Evict oldest if over capacity
    while (this.findCache.size > this.findCacheSize) {
      const oldest = this.findCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.findCache.delete(oldest);
    }
  }

  private lookupKey(key: string): string | undefined {
    const val = this.findCache.get(key);
    if (!val) return undefined;
    // LRU refresh
    this.findCache.delete(key);
    this.findCache.set(key, val);
    return val;
  }

  async postMessage(params: ChatPostMessageArguments) {
    const res = await withRateLimitRetry(() =>
      this.client.chat.postMessage(params)
    );
    if (!res.ok || !res.ts)
      throw new Error(
        `Slack postMessage failed: ${res.error ?? "unknown_error"}`
      );
    return { ts: res.ts as string, raw: res };
  }

  async updateMessage(params: ChatUpdateArguments) {
    const res = await withRateLimitRetry(() => this.client.chat.update(params));
    if (!res.ok || !res.ts)
      throw new Error(`Slack update failed: ${res.error ?? "unknown_error"}`);
    return { ts: res.ts as string, raw: res };
  }

  /**
   * Scan recent channel history for a message containing the hidden marker for a PR.
   * Returns the message ts if found, otherwise undefined.
   * Uses streaming pagination with early exit & block-aware text extraction.
   */
  async findMessageByKey(
    channel: string,
    key: string,
    maxMessagesOrOptions: number | { maxMessages?: number; includeThread?: boolean } = 400
  ): Promise<string | undefined> {
    const opts = typeof maxMessagesOrOptions === "number" ? { maxMessages: maxMessagesOrOptions } : maxMessagesOrOptions;
    const { maxMessages = 400, includeThread = false } = opts;
    const markerFragment = `pr-messaging-bot:${key}`;

    // Cache lookup
    const cached = this.lookupKey(key);
    if (cached) {
      this.logDebug(`Cache hit for key=${key} ts=${cached}`);
      return cached;
    }

    try {
      for await (const message of iterateHistory(
        this.client,
        channel,
        maxMessages,
        200,
        this.debug
      )) {
        const plain = getPlainTextFromMessage(message);
        if (plain.includes(markerFragment) && message.ts) {
          this.rememberKey(key, message.ts);
            return message.ts;
        }
        // Optional thread reply search only if parent could have replies
        if (includeThread && message.reply_count && message.reply_count > 0 && message.ts) {
          for await (const reply of iterateThreadReplies(this.client, channel, message.ts, this.debug)) {
            const rPlain = getPlainTextFromMessage(reply);
            if (rPlain.includes(markerFragment)) {
              this.rememberKey(key, message.ts);
              return message.ts; // Return parent ts
            }
          }
        }
      }
    } catch (e) {
      const { code, message } = classifyError(e);
      createLogger({ component: "slack" }).error("history_scan_failed", { code, error: message });
    }
    return undefined;
  }

  async validateChannel(channel: string): Promise<boolean> {
    try {
      const res = await withRateLimitRetry(() => this.client.conversations.info({ channel }));
      if ((res as any).ok) return true;
      createLogger({ component: "slack" }).error("channel_invalid", { code: "slack_channel", channel });
      return false;
    } catch (err) {
      const { code, message } = classifyError(err);
      createLogger({ component: "slack" }).error("channel_validation_error", { code, error: message, channel });
      return false;
    }
  }

  /**
   * Scan replies of a parent thread for a message containing a marker fragment.
   * Returns the reply message ts if found, otherwise undefined.
   * Does NOT return the parent ts unless parent itself holds the marker (keyword replies are separate).
   */
  async findReplyByMarker(channel: string, parentTs: string, markerFragment: string): Promise<string | undefined> {
    try {
      for await (const reply of iterateThreadReplies(this.client, channel, parentTs, this.debug)) {
        const plain = getPlainTextFromMessage(reply);
        if (plain.includes(markerFragment) && reply.ts) {
          return reply.ts;
        }
      }
    } catch (e) {
      const { code, message } = classifyError(e);
      createLogger({ component: "slack" }).error("thread_scan_failed", { code, error: message });
    }
    return undefined;
  }
}
