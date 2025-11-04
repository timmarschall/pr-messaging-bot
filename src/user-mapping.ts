import fs from "fs";
import path from "path";
import yaml from "yaml";

export type UserMap = Record<string, string>; // github -> slack handle (without @)

const DEFAULT_FILE = path.join(process.cwd(), "config", "github-to-slack.yml");

export function loadUserMapping(file: string = DEFAULT_FILE): UserMap {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, "utf-8");
  const data = yaml.parse(raw) as Record<string, string>;
  return data ?? {};
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("Failed to load user mapping", e);
    return {};
  }
}

export function mapUser(userMap: UserMap, githubLogin: string): string {
  const slack = userMap[githubLogin];
  return slack ? `@${slack}` : `@${githubLogin}`; // fallback to github handle
}
