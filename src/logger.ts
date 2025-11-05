// This module now strictly relies on Probot's built-in pino logger.
// No local fallback (console or standalone pino) is retained; absence is a hard error.

import pino from "pino";

export interface LogFields {
  repo?: string;
  prNumber?: number;
  event?: string;
  code?: string; // error or classification code
  [k: string]: unknown;
}

export interface ILogger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): ILogger;
}

export function createLogger(base: LogFields = {}): ILogger {
  const probotLogger = (globalThis as any).__APP_LOGGER as pino.Logger;
  if (!probotLogger || typeof probotLogger.child !== "function") {
    throw new Error("Probot logger unavailable: ensure app initialized before createLogger is called");
  }
  const child = probotLogger.child(base);
  return {
    info: (msg: string, f?: LogFields) => child.info(f || {}, msg),
    warn: (msg: string, f?: LogFields) => child.warn(f || {}, msg),
    error: (msg: string, f?: LogFields) => child.error(f || {}, msg),
    debug: (msg: string, f?: LogFields) => child.debug(f || {}, msg),
    child: (bindings: LogFields) => createLogger({ ...base, ...bindings }),
  } as ILogger;
}

export function classifyError(err: unknown): { code: string; message: string } {
  if (!err) return { code: "unknown", message: "Unknown error" };
  const anyErr: any = err;
  if (anyErr?.status && anyErr?.response?.headers?.['x-github-request-id']) {
    return { code: "github_api", message: anyErr.message || "GitHub API error" };
  }
  if (anyErr?.code === "slack_webapi_platform_error" || anyErr?.data?.error) {
    return { code: "slack_api", message: anyErr.message || "Slack API error" };
  }
  if (anyErr instanceof SyntaxError) {
    return { code: "parse", message: anyErr.message };
  }
  return { code: "internal", message: (anyErr && anyErr.message) || "Internal error" };
}
