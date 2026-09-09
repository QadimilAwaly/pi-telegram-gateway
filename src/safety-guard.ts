import path from "path";
import os from "os";
import {
  createBashTool,
  createEditTool,
  createWriteTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { config } from "./config";

const gatewayPid = process.pid;
const gatewayPpid = process.ppid;
const gatewayDir = path.resolve(__dirname, "..");
const sessionsDir = path.resolve(config.sessionsDir);

/**
 * Checks if a bash command attempts to terminate the gateway or delete critical files.
 */
export function isDangerousCommand(cmd: string): { blocked: boolean; reason?: string } {
  if (!cmd || typeof cmd !== "string") return { blocked: false };

  const trimmed = cmd.trim();

  // 1. Check direct kill on gateway PID or parent PID
  const pidRegex = new RegExp(`\\b(kill|killall|pkill|taskkill)\\b.*\\b(${gatewayPid}|${gatewayPpid})\\b`, "i");
  if (pidRegex.test(trimmed)) {
    return {
      blocked: true,
      reason: `Blocked kill command targeting gateway process (PID: ${gatewayPid}, PPID: ${gatewayPpid}).`,
    };
  }

  // 2. Check process killers targeting bun / node / bot.ts / pi-telegram-gateway / run.sh
  const patternKillers = [
    /\bpkill\s+(-[a-zA-Z0-9_-]+\s+)*(bun|node|tsx)\b/i,
    /\bkillall\s+(-[a-zA-Z0-9_-]+\s+)*(bun|node)\b/i,
    /\bpkill\s+.*(bot\.ts|pi-telegram-gateway|run\.sh|cron-scheduler)/i,
    /\bkill\s+.*\$\(pgrep.*(bun|bot|gateway)/i,
    /\bkill\s+.*\`pgrep.*(bun|bot|gateway)/i,
  ];

  for (const pattern of patternKillers) {
    if (pattern.test(trimmed)) {
      return {
        blocked: true,
        reason: `Blocked process killer command that would terminate the active Telegram gateway.`,
      };
    }
  }

  // 3. Check destructive deletion or modification targeting gateway codebase or session storage
  const dangerousDeletions = [
    /\brm\s+(-[a-zA-Z0-9_-]*r[a-zA-Z0-9_-]*\s+|--recursive\s+).*pi-telegram-gateway/i,
    /\brm\s+(-[a-zA-Z0-9_-]*r[a-zA-Z0-9_-]*\s+|--recursive\s+).*telegram-sessions/i,
    /\brm\s+.*pi-telegram-gateway\/\.env/i,
    /\b(sed\s+-i|tee|cp|mv|cat\s*>|echo\s*>).*pi-telegram-gateway\/(src|scripts)/i,
  ];

  for (const pattern of dangerousDeletions) {
    if (pattern.test(trimmed)) {
      return {
        blocked: true,
        reason: `Blocked file modification/deletion targeting active gateway codebase or session database.`,
      };
    }
  }

  return { blocked: false };
}

/**
 * Pi Extension Factory that protects the Gateway from being killed or modified destructively,
 * and guarantees that no bash execution can hang indefinitely.
 */
export function gatewaySafetyExtension(pi: ExtensionAPI) {
  // 1. Inject safety instructions into system prompt
  pi.on("before_agent_start", async (event) => {
    const safetyNotice = [
      "",
      "CRITICAL GATEWAY HOST PROTECTION RULES:",
      `- You are operating through the Pi Telegram Gateway daemon (PID: ${gatewayPid}).`,
      "- NEVER kill, terminate, or pkill the 'bun'/'node' process hosting this gateway.",
      `- NEVER delete or destructively modify '${gatewayDir}' or '${sessionsDir}'.`,
      "- If user requests to kill background processes, ONLY kill specific child task PIDs, never the gateway.",
      "",
    ].join("\n");

    return {
      systemPrompt: (event.systemPrompt || "") + safetyNotice,
    };
  });

  // 2. Intercept and override bash tool execution using Pi's native createBashTool
  const nativeBashTool = createBashTool(config.defaultCwd);

  pi.registerTool({
    ...nativeBashTool,
    name: "bash",
    label: "bash (gateway-protected)",
    description: "Execute a bash command with active protection for the host Telegram gateway daemon.",
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const cmd = params?.command || "";
      const check = isDangerousCommand(cmd);

      if (check.blocked) {
        console.warn(`🛡️ [Safety Guard] Intercepted dangerous command: "${cmd}" -> ${check.reason}`);
        return {
          content: [
            {
              type: "text",
              text: `🛡️ [Pi Gateway Safety Guard Error]: ${check.reason}\nThe gateway prevented this command to protect itself from being killed or corrupted.`,
            },
          ],
          details: { blocked: true, reason: check.reason },
        };
      }

      // Enforce a default 60s timeout so no command can hang the bot forever
      const paramsWithTimeout = {
        timeout: 60,
        ...params,
      };

      try {
        const toolToUse = ctx?.cwd ? createBashTool(ctx.cwd) : nativeBashTool;
        return await toolToUse.execute(toolCallId, paramsWithTimeout, signal, onUpdate);
      } catch (err: any) {
        console.error(`⚠️ [Bash Tool Error]:`, err.message);
        return {
          content: [{ type: "text", text: `Error executing bash: ${err.message}` }],
          details: { error: true, message: err.message },
        };
      }
    },
  });

  // 3. Intercept and override edit tool with active gateway codebase protection
  const nativeEditTool = createEditTool(config.defaultCwd);
  pi.registerTool({
    ...nativeEditTool,
    name: "edit",
    label: "edit (gateway-protected)",
    description: "Edit a file with active protection for the host gateway codebase.",
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const targetPath = path.resolve(ctx?.cwd || config.defaultCwd, params?.path || "");
      if (
        targetPath.startsWith(path.join(gatewayDir, "src")) ||
        targetPath.startsWith(path.join(gatewayDir, "scripts")) ||
        targetPath === path.join(gatewayDir, "package.json")
      ) {
        const reason = `Blocked edit targeting host gateway codebase (${targetPath}). Modifying the gateway source code from inside its own session is prohibited to prevent daemon crashes.`;
        console.warn(`🛡️ [Safety Guard] Intercepted edit: ${reason}`);
        return {
          content: [{ type: "text", text: `🛡️ [Pi Gateway Safety Guard Error]: ${reason}` }],
          details: { blocked: true, reason },
        };
      }
      const toolToUse = ctx?.cwd ? createEditTool(ctx.cwd) : nativeEditTool;
      return await toolToUse.execute(toolCallId, params, signal, onUpdate);
    },
  });

  // 4. Intercept and override write tool with active gateway codebase protection
  const nativeWriteTool = createWriteTool(config.defaultCwd);
  pi.registerTool({
    ...nativeWriteTool,
    name: "write",
    label: "write (gateway-protected)",
    description: "Write a file with active protection for the host gateway codebase.",
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const targetPath = path.resolve(ctx?.cwd || config.defaultCwd, params?.path || "");
      if (
        targetPath.startsWith(path.join(gatewayDir, "src")) ||
        targetPath.startsWith(path.join(gatewayDir, "scripts")) ||
        targetPath === path.join(gatewayDir, "package.json")
      ) {
        const reason = `Blocked write targeting host gateway codebase (${targetPath}). Modifying the gateway source code from inside its own session is prohibited to prevent daemon crashes.`;
        console.warn(`🛡️ [Safety Guard] Intercepted write: ${reason}`);
        return {
          content: [{ type: "text", text: `🛡️ [Pi Gateway Safety Guard Error]: ${reason}` }],
          details: { blocked: true, reason },
        };
      }
      const toolToUse = ctx?.cwd ? createWriteTool(ctx.cwd) : nativeWriteTool;
      return await toolToUse.execute(toolCallId, params, signal, onUpdate);
    },
  });
}
