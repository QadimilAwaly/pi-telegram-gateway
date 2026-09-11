import dotenv from "dotenv";
import path from "path";
import os from "os";

const defaultHome = os.homedir();

function resolvePath(p?: string, fallback: string = ""): string {
  if (!p || !p.trim()) return fallback;
  const trimmed = p.trim();
  if (trimmed.startsWith("~/")) {
    return path.resolve(defaultHome, trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

// Explicitly load .env from gateway root with override: true so .env takes precedence over ambient/stale shell env
const projectRoot = path.resolve(import.meta.dir, "..");
dotenv.config({
  path: path.join(projectRoot, ".env"),
  override: true,
});

export interface GatewayConfig {
  mode: "dual" | "telegram" | "discord";
  botToken: string;
  discordBotToken: string;
  allowedUsers: number[];
  discordAllowedUsers: string[];
  defaultCwd: string;
  sessionsDir: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: "off" | "low" | "medium" | "high";
  defaultTimezone: string;
}

function parseAllowedUsers(raw?: string): number[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));
}

const defaultCwd = resolvePath(process.env.DEFAULT_CWD, defaultHome);
const sessionsDir = resolvePath(
  process.env.SESSIONS_DIR,
  path.join(defaultHome, ".pi", "telegram-sessions")
);

export const config: GatewayConfig = {
  mode: (process.env.GATEWAY_MODE as any) || "dual",
  botToken: process.env.TELEGRAM_BOT_TOKEN || "",
  discordBotToken: process.env.DISCORD_BOT_TOKEN || "",
  allowedUsers: parseAllowedUsers(process.env.ALLOWED_USERS),
  discordAllowedUsers: (process.env.DISCORD_ALLOWED_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  defaultCwd,
  sessionsDir,
  defaultProvider: process.env.DEFAULT_PROVIDER,
  defaultModel: process.env.DEFAULT_MODEL,
  defaultThinkingLevel: (process.env.DEFAULT_THINKING_LEVEL as any) || undefined,
  defaultTimezone: process.env.DEFAULT_TIMEZONE || process.env.TZ || "Asia/Makassar",
};

