import fs from "fs";
import path from "path";
import os from "os";
import { config } from "./config";
import { sessionPool } from "./session-pool";
import { cronScheduler } from "./cron-scheduler";

export interface GatewayHealthState {
  pid: number;
  startTime: number;
  uptimeSeconds: number;
  botUsername: string;
  botId: number;
  allowedUsersCount: number;
  activeMemorySessions: number;
  totalDiskSessions: number;
  activeCronJobs: number;
  defaultModel: string;
  defaultCwd: string;
  memoryUsageMb: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
  lastHeartbeat: number;
}

export class HealthMonitor {
  private healthFile: string;
  private startTime: number = Date.now();
  private botInfo: { username: string; id: number } | null = null;
  private httpServer: any = null;

  constructor() {
    this.healthFile = path.join(config.sessionsDir, "gateway-health.json");
  }

  init(botInfo: { username: string; id: number }, port: number = 4080) {
    this.botInfo = botInfo;
    this.startTime = Date.now();

    // 1. Initial snapshot on boot (0 periodic timers, 0 disk I/O when idle)
    this.updateSnapshot();

    // 2. Local loopback HTTP health server on 127.0.0.1:4080
    try {
      if (typeof Bun !== "undefined") {
        this.httpServer = Bun.serve({
          port,
          hostname: "127.0.0.1",
          fetch: (req) => {
            const url = new URL(req.url);
            if (url.pathname === "/health" || url.pathname === "/status") {
              const state = this.getHealthState();
              // Refresh disk snapshot on-demand so manual checks always see real-time data
              try {
                fs.writeFileSync(this.healthFile, JSON.stringify(state, null, 2), "utf-8");
              } catch {}
              return new Response(JSON.stringify(state, null, 2), {
                headers: { "Content-Type": "application/json" },
              });
            }
            return new Response("Pi Telegram Gateway OK\n", { status: 200 });
          },
        });
        console.log(`🩺 Health endpoint active on http://127.0.0.1:${port}/health`);
      }
    } catch (err: any) {
      console.warn("Could not bind health HTTP server (port may be in use):", err.message);
    }
  }

  private countDiskSessions(): number {
    try {
      if (!fs.existsSync(config.sessionsDir)) return 0;
      const entries = fs.readdirSync(config.sessionsDir);
      return entries.filter((name) => name.startsWith("chat_") || name.startsWith("cron_")).length;
    } catch {
      return 0;
    }
  }

  getHealthState(): GatewayHealthState {
    const mem = process.memoryUsage();
    const services = sessionPool.getServices();
    const activeModel =
      config.defaultModel ||
      (services?.modelRuntime ? "antigravity/gemini-3.7-flash" : "default");

    return {
      pid: process.pid,
      startTime: this.startTime,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      botUsername: this.botInfo?.username || "unknown",
      botId: this.botInfo?.id || 0,
      allowedUsersCount: config.allowedUsers.length,
      activeMemorySessions: (sessionPool as any).sessions?.size || 0,
      totalDiskSessions: this.countDiskSessions(),
      activeCronJobs: cronScheduler.listJobs().filter((j) => j.enabled).length,
      defaultModel: activeModel,
      defaultCwd: config.defaultCwd,
      memoryUsageMb: {
        rss: +(mem.rss / (1024 * 1024)).toFixed(1),
        heapUsed: +(mem.heapUsed / (1024 * 1024)).toFixed(1),
        heapTotal: +(mem.heapTotal / (1024 * 1024)).toFixed(1),
      },
      lastHeartbeat: Date.now(),
    };
  }

  updateSnapshot() {
    try {
      if (!fs.existsSync(config.sessionsDir)) {
        fs.mkdirSync(config.sessionsDir, { recursive: true });
      }
      const state = this.getHealthState();
      fs.writeFileSync(this.healthFile, JSON.stringify(state, null, 2), "utf-8");
    } catch (err) {
      // Ignore disk write hiccups
    }
  }

  destroy() {
    if (this.httpServer) {
      try {
        this.httpServer.stop();
      } catch {}
    }
    try {
      if (fs.existsSync(this.healthFile)) {
        fs.unlinkSync(this.healthFile);
      }
    } catch {}
  }
}

export const healthMonitor = new HealthMonitor();
