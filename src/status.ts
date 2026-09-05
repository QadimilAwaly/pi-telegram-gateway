import fs from "fs";
import path from "path";
import os from "os";

const defaultHome = os.homedir();
const sessionsDir =
  process.env.SESSIONS_DIR || path.join(defaultHome, ".pi", "telegram-sessions");
const healthFile = path.join(sessionsDir, "gateway-health.json");

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

function checkProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

  const isAlive = state?.pid ? checkProcessAlive(state.pid) : false;

  console.log("\n=======================================================");
  console.log("             🤖 PI TELEGRAM GATEWAY STATUS             ");
  console.log("=======================================================\n");

  if (!state || !isAlive) {
    console.log("🔴 STATUS:             \x1b[31mOFFLINE (Not Running)\x1b[0m");
    console.log("📁 Sessions Dir:       " + sessionsDir);
    console.log("\n💡 \x1b[33mTo start the gateway:\x1b[0m");
    console.log("   cd ~/pi-telegram-gateway && npm run daemon\n");
    console.log("=======================================================\n");
    process.exit(0);
  }

  const timeSinceHeartbeat = Math.floor((Date.now() - state.lastHeartbeat) / 1000);
  const isHeartbeatHealthy = timeSinceHeartbeat < 15;

  console.log(
    `🟢 STATUS:             \x1b[32mONLINE (Active)\x1b[0m ${
      isHeartbeatHealthy ? "⚡" : "\x1b[33m(Heartbeat Delayed)\x1b[0m"
    }`
  );
  console.log(`🆔 PID:                ${state.pid}`);
  console.log(`⏱️  Uptime:             ${formatUptime(state.uptimeSeconds)}`);
  console.log(`🤖 Bot Handle:         @${state.botUsername} (ID: ${state.botId})`);
  console.log(
    `🔒 Access Control:      ${
      state.allowedUsersCount > 0
        ? `\x1b[32mWhitelist Active (${state.allowedUsersCount} user(s))\x1b[0m`
        : "\x1b[33mPublic (No Whitelist)\x1b[0m"
    }`
  );
  console.log(`🧠 Active Model:       \x1b[36m${state.defaultModel}\x1b[0m`);
  console.log(
    `💾 Memory Footprint:   RSS: \x1b[35m${state.memoryUsageMb.rss} MB\x1b[0m | Heap: ${state.memoryUsageMb.heapUsed} MB / ${state.memoryUsageMb.heapTotal} MB`
  );
  console.log(
    `📂 Sessions:           RAM: \x1b[32m${state.activeMemorySessions} active\x1b[0m | Disk: ${state.totalDiskSessions} persisted`
  );
  const logFile = path.join(sessionsDir, "gateway.log");
  const logSizeKb = fs.existsSync(logFile) ? Math.round(fs.statSync(logFile).size / 1024) : 0;
  console.log(`📑 Live Logs:          ${logFile} (${logSizeKb} KB)`);
  console.log(
    `⏰ Scheduled Cron:     \x1b[36m${state.activeCronJobs} active job(s)\x1b[0m`
  );
  console.log(`🩺 Health API:         http://127.0.0.1:4080/health`);
  console.log(`📁 Storage Path:       ${sessionsDir}`);
  console.log("\n=======================================================\n");
}

main().catch((err) => {
  console.error("Error checking status:", err);
});
