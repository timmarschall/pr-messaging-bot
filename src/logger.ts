import type { LoggerOptions } from "pino";

// Lazy import pino to keep optional; fallback to console if unavailable.
let pinoFactory: any = null;
try {
  // dynamic require via eval to avoid bundler complaints if removed
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  pinoFactory = require("pino");
} catch {
  pinoFactory = null;
}

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

class ConsoleLogger implements ILogger {
  constructor(private base: LogFields = {}) {}
  private fmt(level: string, msg: string, fields?: LogFields) {
    const merged = { ...this.base, ...(fields || {}) };
    // Simple key=value formatting
    const kv = Object.entries(merged)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    // eslint-disable-next-line no-console
    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
      `[${level}] ${msg}${kv ? " " + kv : ""}`
    );
  }
  info(msg: string, f?: LogFields) { this.fmt("info", msg, f); }
  warn(msg: string, f?: LogFields) { this.fmt("warn", msg, f); }
  error(msg: string, f?: LogFields) { this.fmt("error", msg, f); }
  debug(msg: string, f?: LogFields) { if (process.env.LOG_LEVEL === "debug") this.fmt("debug", msg, f); }
  child(bindings: LogFields): ILogger { return new ConsoleLogger({ ...this.base, ...bindings }); }
}

class PinoLogger implements ILogger {
  private logger: any;
  constructor(bindings: LogFields = {}, options: LoggerOptions = {}) {
    this.logger = pinoFactory(options).child(bindings);
  }
  info(msg: string, f?: LogFields) { this.logger.info(f || {}, msg); }
  warn(msg: string, f?: LogFields) { this.logger.warn(f || {}, msg); }
  error(msg: string, f?: LogFields) { this.logger.error(f || {}, msg); }
  debug(msg: string, f?: LogFields) { this.logger.debug(f || {}, msg); }
  child(bindings: LogFields): ILogger { return new PinoLogger({ ...bindings }, {}); }
}

export function createLogger(base: LogFields = {}): ILogger {
  const usePino = pinoFactory && process.env.USE_PINO !== "0";
  if (usePino) {
    return new PinoLogger(base, {
      level: process.env.LOG_LEVEL || "info",
      timestamp: pinoFactory.stdTimeFunctions.isoTime,
    });
  }
  return new ConsoleLogger(base);
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
