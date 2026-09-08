import dotenv from "dotenv";
import path from "path";
import os from "os";

// Load .env from current directory or gateway root
dotenv.config();

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
}

function parseAllowedUsers(raw?: string): number[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));
}

const defaultHome = os.homedir();

export const config: GatewayConfig = {
  mode: (process.env.GATEWAY_MODE as any) || "dual",
  botToken: process.env.TELEGRAM_BOT_TOKEN || "",
  discordBotToken: process.env.DISCORD_BOT_TOKEN || "",
  allowedUsers: parseAllowedUsers(process.env.ALLOWED_USERS),
  discordAllowedUsers: (process.env.DISCORD_ALLOWED_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  defaultCwd: process.env.DEFAULT_CWD || defaultHome,
  sessionsDir:
    process.env.SESSIONS_DIR || path.join(defaultHome, ".pi", "telegram-sessions"),
  defaultProvider: process.env.DEFAULT_PROVIDER,
  defaultModel: process.env.DEFAULT_MODEL,
  defaultThinkingLevel: (process.env.DEFAULT_THINKING_LEVEL as any) || undefined,
};
