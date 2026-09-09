import fs from "fs";
import path from "path";
import { config } from "./config";
import { stripAnsi } from "./telegram-utils";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

export interface LogEntry {
  timestamp: number;
  timeStr: string;
  level: LogLevel;
  message: string;
}

export class GatewayLogger {
  private logFile: string;
  private maxFileSizeBytes: number = 3 * 1024 * 1024; // 3MB per file
  private ringBuffer: LogEntry[] = [];
  private maxRingBufferSize: number = 200;
  private originalConsole: {
    log: typeof console.log;
    info: typeof console.info;
    warn: typeof console.warn;
    error: typeof console.error;
  } | null = null;
  private isInitialized: boolean = false;

  // Duplicate suppression state
  private lastMessage: string = "";
  private lastLevel: LogLevel = "INFO";
  private repeatCount: number = 0;
  private lastRepeatReported: number = 0;
  private lastLogTimestamp: number = 0;

  constructor() {
    this.logFile = path.join(config.sessionsDir, "gateway.log");
  }

  init() {
    if (this.isInitialized) return;
    this.isInitialized = true;

    if (!fs.existsSync(config.sessionsDir)) {
      fs.mkdirSync(config.sessionsDir, { recursive: true });
    }

    // Save original console functions
    this.originalConsole = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };

    // Hook console functions
    console.log = (...args: any[]) => {
      this.originalConsole?.log(...args);
      this.write("INFO", args);
    };

    console.info = (...args: any[]) => {
      this.originalConsole?.info(...args);
      this.write("INFO", args);
    };

    console.warn = (...args: any[]) => {
      this.originalConsole?.warn(...args);
      this.write("WARN", args);
    };

    console.error = (...args: any[]) => {
      this.originalConsole?.error(...args);
      this.write("ERROR", args);
    };

    // Load existing recent logs from disk on startup
    this.loadExistingLogsFromFile();

    this.info("GatewayLogger initialized. Capturing stdout & stderr to " + this.logFile);
  }

  private loadExistingLogsFromFile(maxLines: number = 200) {
    try {
      if (!fs.existsSync(this.logFile)) return;
      const content = fs.readFileSync(this.logFile, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      const recentLines = lines.slice(-maxLines);

      for (const line of recentLines) {
        const match = line.match(/^\[(.*?)\]\s+\[(INFO|WARN|ERROR|DEBUG)\]\s+(.*)$/);
        if (match) {
          this.ringBuffer.push({
            timestamp: Date.now(),
            timeStr: match[1] || "",
            level: (match[2] as LogLevel) || "INFO",
            message: match[3] || "",
          });
        } else {
          this.ringBuffer.push({
            timestamp: Date.now(),
            timeStr: "",
            level: "INFO",
            message: line,
          });
        }
      }

      // Keep within maxRingBufferSize
      if (this.ringBuffer.length > this.maxRingBufferSize) {
        this.ringBuffer = this.ringBuffer.slice(-this.maxRingBufferSize);
      }
    } catch {}
  }

  private formatArgs(args: any[]): string {
    return args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        if (arg instanceof Error) return `${arg.message}\n${arg.stack || ""}`;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(" ");
  }

  private rotateIfNecessary() {
    try {
      if (fs.existsSync(this.logFile)) {
        const stat = fs.statSync(this.logFile);
        if (stat.size > this.maxFileSizeBytes) {
          const oldFile = `${this.logFile}.old`;
          if (fs.existsSync(oldFile)) {
            fs.unlinkSync(oldFile);
          }
          fs.renameSync(this.logFile, oldFile);
        }
      }
    } catch {}
  }

  private commitEntry(level: LogLevel, cleanMsg: string, now: Date = new Date()) {
    const timeStr = now.toLocaleString("id-ID", {
      timeZone: "Asia/Makassar",
      dateStyle: "short",
      timeStyle: "medium",
    });

    const entry: LogEntry = {
      timestamp: now.getTime(),
      timeStr,
      level,
      message: cleanMsg,
    };

    // 1. In-Memory Ring Buffer
    this.ringBuffer.push(entry);
    if (this.ringBuffer.length > this.maxRingBufferSize) {
      this.ringBuffer.shift();
    }

    // 2. Persistent Rotating Log File
    try {
      this.rotateIfNecessary();
      const line = `[${timeStr}] [${level}] ${cleanMsg}\n`;
      fs.appendFileSync(this.logFile, line, "utf-8");
    } catch {}
  }

  private flushDuplicates(now: Date = new Date()) {
    if (this.repeatCount === 1) {
      // Natural 2-time occurrences are logged as is without noisy suppress notices
      this.commitEntry(this.lastLevel, this.lastMessage, now);
    } else if (this.repeatCount > 1) {
      const msg = `⚠️ [Suppressed] (Previous ${this.lastLevel} message repeated ${this.repeatCount} times)`;
      this.commitEntry(this.lastLevel, msg, now);
    }
    this.repeatCount = 0;
    this.lastRepeatReported = 0;
  }

  private write(level: LogLevel, args: any[]) {
    const rawMsg = this.formatArgs(args);
    const cleanMsg = stripAnsi(rawMsg).trim();
    if (!cleanMsg) return;

    const now = new Date();

    // Check for consecutive duplicate
    if (cleanMsg === this.lastMessage && level === this.lastLevel) {
      this.repeatCount++;

      // If it repeats extensively, emit an update periodically
      const nowMs = now.getTime();
      const shouldReportMilestone =
        (this.repeatCount === 10 && this.lastRepeatReported < 10) ||
        (this.repeatCount === 50 && this.lastRepeatReported < 50) ||
        (this.repeatCount === 100 && this.lastRepeatReported < 100) ||
        (this.repeatCount % 500 === 0 && this.repeatCount > this.lastRepeatReported) ||
        (nowMs - this.lastLogTimestamp >= 60000 && this.repeatCount > this.lastRepeatReported);

      if (shouldReportMilestone) {
        const msg = `⚠️ [Suppressed] (Message repeated ${this.repeatCount} times so far...)`;
        this.commitEntry(level, msg, now);
        this.lastRepeatReported = this.repeatCount;
        this.lastLogTimestamp = nowMs;
      }
      return;
    }

    // A different message arrived -> flush pending suppressed duplicates
    this.flushDuplicates(now);

    this.lastMessage = cleanMsg;
    this.lastLevel = level;
    this.lastLogTimestamp = now.getTime();
    this.commitEntry(level, cleanMsg, now);
  }

  info(...args: any[]) {
    if (this.originalConsole) {
      this.originalConsole.info(...args);
    } else {
      console.info(...args);
    }
  }

  warn(...args: any[]) {
    if (this.originalConsole) {
      this.originalConsole.warn(...args);
    } else {
      console.warn(...args);
    }
  }

  error(...args: any[]) {
    if (this.originalConsole) {
      this.originalConsole.error(...args);
    } else {
      console.error(...args);
    }
  }

  /**
   * Get recent log entries for display or inspection
   */
  getRecentLogs(options: { limit?: number; level?: LogLevel | "ALL" } = {}): LogEntry[] {
    if (this.repeatCount > 0) {
      this.flushDuplicates();
    }
    const limit = Math.min(options.limit || 20, 100);
    const level = options.level || "ALL";

    // If buffer has fewer items than requested, reload from persistent log file
    if (this.ringBuffer.length < limit && fs.existsSync(this.logFile)) {
      this.ringBuffer = [];
      this.loadExistingLogsFromFile(Math.max(limit * 2, 200));
    }

    let filtered = this.ringBuffer;
    if (level !== "ALL") {
      filtered = filtered.filter((e) => e.level === level);
    }

    return filtered.slice(-limit);
  }

  /**
   * Clear the log file and in-memory buffer
   */
  clearLogs(): boolean {
    this.ringBuffer = [];
    this.lastMessage = "";
    this.repeatCount = 0;
    this.lastRepeatReported = 0;
    try {
      if (fs.existsSync(this.logFile)) {
        fs.writeFileSync(this.logFile, "", "utf-8");
      }
      const oldFile = `${this.logFile}.old`;
      if (fs.existsSync(oldFile)) {
        fs.unlinkSync(oldFile);
      }
      return true;
    } catch {
      return false;
    }
  }

  getLogFilePath(): string {
    return this.logFile;
  }

  getLogFileSizeKb(): number {
    try {
      if (fs.existsSync(this.logFile)) {
        return Math.round(fs.statSync(this.logFile).size / 1024);
      }
    } catch {}
    return 0;
  }
}

export const gatewayLogger = new GatewayLogger();
