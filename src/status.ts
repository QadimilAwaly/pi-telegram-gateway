import fs from "fs";
import path from "path";
import { config } from "./config";

const projectRoot = path.resolve(import.meta.dir, "..");
const healthFile = path.join(config.sessionsDir, "gateway-health.json");

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function checkGatewayProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  try {
    const cmdlinePath = `/proc/${pid}/cmdline`;
    if (fs.existsSync(cmdlinePath)) {
      const raw = fs.readFileSync(cmdlinePath, "utf8");
      const args = raw.split("\0").filter(Boolean);
      const binaryName = path.basename(args[0] || "").toLowerCase();
      const isNodeOrBun = binaryName === "bun" || binaryName === "node";
      const hasBotScript = args.slice(1).some((a) => a === "src/bot.ts" || a.endsWith("/bot.ts"));
      return isNodeOrBun && hasBotScript;
    }
  } catch {
    return true;
  }

  return true;
}

function checkTunnelProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  try {
    const commPath = `/proc/${pid}/comm`;
    if (fs.existsSync(commPath)) {
      const comm = fs.readFileSync(commPath, "utf8").trim().toLowerCase();
      if (comm === "cloudflared" || comm.includes("cloudflared")) return true;
    }

    const cmdlinePath = `/proc/${pid}/cmdline`;
    if (fs.existsSync(cmdlinePath)) {
      const raw = fs.readFileSync(cmdlinePath, "utf8");
      const args = raw.split("\0").filter(Boolean);
      const binaryName = path.basename(args[0] || "").toLowerCase();
      return binaryName === "cloudflared" || binaryName.includes("cloudflared");
    }
  } catch {
    return true;
  }

  return false;
}

async function fetchFromHttp(): Promise<any | null> {
  try {
    const res = await fetch("http://127.0.0.1:4080/health", {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // Fallback to file
  }
  return null;
}

async function main() {
  let state: any = await fetchFromHttp();

  if (!state && fs.existsSync(healthFile)) {
    try {
      const raw = fs.readFileSync(healthFile, "utf-8");
      state = JSON.parse(raw);
    } catch {
      // Ignore
    }
  }

  const isAlive = state?.pid ? checkGatewayProcess(state.pid) : false;

  console.log("\n=======================================================");
  console.log("             🤖 PI TELEGRAM GATEWAY STATUS             ");
  console.log("=======================================================\n");

  if (!state || !isAlive) {
    console.log("🔴 STATUS:             \x1b[31mOFFLINE (Not Running)\x1b[0m");
    console.log("📁 Sessions Dir:       " + config.sessionsDir);
    console.log("📂 Default CWD:        " + config.defaultCwd);
    console.log(`\n💡 \x1b[33mTo start the gateway:\x1b[0m`);
    console.log(`   cd ${projectRoot} && npm run daemon\n`);
    console.log("=======================================================\n");
    process.exit(0);
  }

  console.log(`⚡ STATUS:             \x1b[32mONLINE (Active)\x1b[0m ⚡`);
  console.log(`🆔 PID:                ${state.pid}`);
  console.log(`⏱️  Uptime:             ${formatUptime(state.uptimeSeconds)}`);
  if (config.mode === "discord") {
    console.log(`📱 Telegram Bot:    \x1b[90mDisabled (GATEWAY_MODE=discord)\x1b[0m`);
  } else {
    console.log(`📱 Telegram Bot:    @${state.botUsername} (ID: ${state.botId})`);
  }
  if (config.discordBotToken) {
    console.log(`🎮 Discord Bot:     Hermes_maid_bot (Connected ⚡)`);
  }
  console.log(
    `🔒 Access Control:      ${
      state.allowedUsersCount > 0
        ? `\x1b[32mWhitelist Active (${state.allowedUsersCount} user(s))\x1b[0m`
        : "\x1b[33mPublic (No Whitelist)\x1b[0m"
    }`
  );
  console.log(`🧠 Active Model:       \x1b[36m${state.defaultModel}\x1b[0m`);
  console.log(`📂 Default CWD:        \x1b[36m${state.defaultCwd || config.defaultCwd}\x1b[0m`);
  console.log(
    `💾 Memory Footprint:   RSS: \x1b[35m${state.memoryUsageMb.rss} MB\x1b[0m | Heap: ${state.memoryUsageMb.heapUsed} MB / ${state.memoryUsageMb.heapTotal} MB`
  );
  console.log(
    `📂 Sessions:           RAM: \x1b[32m${state.activeMemorySessions} active\x1b[0m | Disk: ${state.totalDiskSessions} persisted`
  );
  const logFile = path.join(config.sessionsDir, "gateway.log");
  const logSizeKb = fs.existsSync(logFile) ? Math.round(fs.statSync(logFile).size / 1024) : 0;
  console.log(`📑 Live Logs:          ${logFile} (${logSizeKb} KB)`);
  // Check upstream Telegram Cloud sync health
  let syncStatus = "\x1b[90mChecking...\x1b[0m";
  if (config.mode === "discord") {
    syncStatus = "\x1b[32mBypassed (Discord-Only Active)\x1b[0m";
  } else {
    try {
      const tgRes = await fetch(
        `https://api.telegram.org/bot${config.botToken}/getWebhookInfo`,
        { signal: AbortSignal.timeout(2000) }
      );
      if (tgRes.ok) {
        const tgData = ((await tgRes.json()) as any)?.result;
        const syncErr = tgData?.last_synchronization_error_date;
        if (!syncErr) {
          syncStatus = "\x1b[32mHealthy (Synchronized)\x1b[0m";
        } else {
          const diff = Math.max(0, Math.floor(Date.now() / 1000 - syncErr));
          if (diff > 120) {
            syncStatus = `\x1b[32mRecovered (last glitch ${diff}s ago)\x1b[0m`;
          } else {
            syncStatus = `\x1b[31mDegraded Upstream DC (Telegram DC error ${diff}s ago)\x1b[0m`;
          }
        }
      }
    } catch {
      syncStatus = "\x1b[33mUnreachable / Timeout\x1b[0m";
    }
  }

  console.log(`🌐 Cloud Sync Status: ${syncStatus}`);
  const tunnelPidFile = path.join(projectRoot, "tunnel.pid");
  const tunnelUrlFile = path.join(projectRoot, "tunnel_url.txt");
  let tunnelStatus = "\x1b[90mInactive\x1b[0m";
  if (fs.existsSync(tunnelPidFile)) {
    try {
      const tPid = parseInt(fs.readFileSync(tunnelPidFile, "utf8").trim(), 10);
      if (tPid && checkTunnelProcess(tPid)) {
        let tUrl = "";
        if (fs.existsSync(tunnelUrlFile)) {
          tUrl = fs.readFileSync(tunnelUrlFile, "utf8").trim();
        }
        tunnelStatus = `\x1b[32mActive (PID: ${tPid})\x1b[0m ${tUrl ? `\x1b[36m${tUrl}\x1b[0m` : ""}`;
      }
    } catch {}
  }
  console.log(`🔌 SSH Tunnel:         ${tunnelStatus}`);
  console.log(`⏰ Scheduled Cron:     \x1b[36m${state.activeCronJobs} active job(s)\x1b[0m`);
  console.log(`🩺 Health API:         http://127.0.0.1:4080/health`);
  console.log(`📁 Storage Path:       ${config.sessionsDir}`);
  console.log("\n=======================================================\n");
}

main().catch((err) => {
  console.error("Error checking status:", err);
});
