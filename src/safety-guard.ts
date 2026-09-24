import path from "path";
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
    /\b(bash\s+|sh\s+|\.\/)?.*(restart\.sh|pi-gateway\s+restart|npm\s+run\s+restart)\b/i,
  ];

  for (const pattern of patternKillers) {
    if (pattern.test(trimmed)) {
      return {
        blocked: true,
        reason: `Blocked process killer/restart command that would terminate the active host gateway daemon.`,
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
 * Validates if a target path points to the protected host gateway codebase.
 */
function isProtectedGatewayPath(targetPath: string): boolean {
  const norm = path.resolve(targetPath);
  return (
    norm.startsWith(path.join(gatewayDir, "src")) ||
    norm.startsWith(path.join(gatewayDir, "scripts")) ||
    norm === path.join(gatewayDir, "package.json") ||
    norm === path.join(gatewayDir, ".env") ||
    norm === path.join(gatewayDir, "tsconfig.json")
  );
}

/**
 * Pi Extension Factory that protects the Gateway from being killed or modified destructively,
 * and guarantees that no bash execution can hang indefinitely.
 */
export function gatewaySafetyExtension(pi: ExtensionAPI) {
  // Tool instances cache by cwd to prevent excessive garbage generation
  const bashTools = new Map<string, any>();
  const editTools = new Map<string, any>();
  const writeTools = new Map<string, any>();

  const getBashTool = (cwd?: string) => {
    const dir = cwd || config.defaultCwd;
    let tool = bashTools.get(dir);
    if (!tool) {
      tool = createBashTool(dir);
      bashTools.set(dir, tool);
    }
    return tool;
  };

  const getEditTool = (cwd?: string) => {
    const dir = cwd || config.defaultCwd;
    let tool = editTools.get(dir);
    if (!tool) {
      tool = createEditTool(dir);
      editTools.set(dir, tool);
    }
    return tool;
  };

  const getWriteTool = (cwd?: string) => {
    const dir = cwd || config.defaultCwd;
    let tool = writeTools.get(dir);
    if (!tool) {
      tool = createWriteTool(dir);
      writeTools.set(dir, tool);
    }
    return tool;
  };

  // 2. Intercept and override bash tool execution using Pi's native createBashTool
  const baseBashTool = getBashTool(config.defaultCwd);
  pi.registerTool({
    ...baseBashTool,
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
        const toolToUse = getBashTool(ctx?.cwd);
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
  const baseEditTool = getEditTool(config.defaultCwd);
  pi.registerTool({
    ...baseEditTool,
    name: "edit",
    label: "edit (gateway-protected)",
    description: "Edit a file with active protection for the host gateway codebase.",
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const targetPath = path.resolve(ctx?.cwd || config.defaultCwd, params?.path || "");
      if (isProtectedGatewayPath(targetPath)) {
        const reason = `Blocked edit targeting host gateway codebase (${targetPath}). Modifying the gateway source code from inside its own session is prohibited to prevent daemon crashes.`;
        console.warn(`🛡️ [Safety Guard] Intercepted edit: ${reason}`);
        return {
          content: [{ type: "text", text: `🛡️ [Pi Gateway Safety Guard Error]: ${reason}` }],
          details: { blocked: true, reason },
        };
      }
      const toolToUse = getEditTool(ctx?.cwd);
      return await toolToUse.execute(toolCallId, params, signal, onUpdate);
    },
  });

  // 4. Intercept and override write tool with active gateway codebase protection
  const baseWriteTool = getWriteTool(config.defaultCwd);
  pi.registerTool({
    ...baseWriteTool,
    name: "write",
    label: "write (gateway-protected)",
    description: "Write a file with active protection for the host gateway codebase.",
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const targetPath = path.resolve(ctx?.cwd || config.defaultCwd, params?.path || "");
      if (isProtectedGatewayPath(targetPath)) {
        const reason = `Blocked write targeting host gateway codebase (${targetPath}). Modifying the gateway source code from inside its own session is prohibited to prevent daemon crashes.`;
        console.warn(`🛡️ [Safety Guard] Intercepted write: ${reason}`);
        return {
          content: [{ type: "text", text: `🛡️ [Pi Gateway Safety Guard Error]: ${reason}` }],
          details: { blocked: true, reason },
        };
      }
      const toolToUse = getWriteTool(ctx?.cwd);
      return await toolToUse.execute(toolCallId, params, signal, onUpdate);
    },
  });
}
