import path from "path";
import fs from "fs";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { config } from "./config";
import { gatewaySafetyExtension } from "./safety-guard";
import { sessionArchiver } from "./session-archiver";

export type Model = Parameters<AgentSession["setModel"]>[0];

export interface SessionInfo {
  id: string;
  shortId: string;
  fileName: string;
  filePath: string;
  mtime: number;
  size: number;
  messageCount: number;
  summary: string;
  isActive: boolean;
  isArchived: boolean;
}

interface ActiveSessionEntry {
  session: AgentSession;
  chatId: number;
  lastActive: number;
  isProcessing: boolean;
  aborted?: boolean;
}

export class SessionPool {
  private sessions = new Map<number, ActiveSessionEntry>();
  private services: any = null;
  private cleanupInterval: any = null;

  async init() {
    if (!fs.existsSync(config.sessionsDir)) {
      fs.mkdirSync(config.sessionsDir, { recursive: true });
    }

    // Initialize services with safety guard, extensions, skills, settings, antigravity & models
    this.services = await createAgentSessionServices({
      cwd: config.defaultCwd,
      resourceLoaderOptions: {
        extensionFactories: [gatewaySafetyExtension],
      },
    });

    // Periodic memory cleanup: evict sessions idle for > 30 minutes
    if (!this.cleanupInterval) {
      this.cleanupInterval = setInterval(() => {
        this.evictIdleSessions(30 * 60 * 1000);
      }, 10 * 60 * 1000);
      if (this.cleanupInterval?.unref) {
        this.cleanupInterval.unref();
      }
    }
  }

  getServices() {
    return this.services;
  }

  private getChatSessionDir(chatId: number): string {
    const dir = path.join(config.sessionsDir, `chat_${chatId}`);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private applyConfiguredDefaults(session: AgentSession) {
    if (!this.services?.modelRuntime) return;

    if (config.defaultModel) {
      const runtime = this.services.modelRuntime;
      let targetModel: Model | undefined;

      if (config.defaultProvider) {
        targetModel = runtime.getModel(config.defaultProvider, config.defaultModel);
      } else {
        const parts = config.defaultModel.split("/");
        if (parts.length === 2) {
          targetModel = runtime.getModel(parts[0], parts[1]);
        }
      }

      if (targetModel) {
        session.setModel(targetModel).catch((e) => console.error("Error setting configured model:", e));
      }
    }

    if (config.defaultThinkingLevel) {
      session.setThinkingLevel(config.defaultThinkingLevel);
    }
  }

  async getSession(chatId: number): Promise<ActiveSessionEntry> {
    const existing = this.sessions.get(chatId);
    if (existing) {
      existing.lastActive = Date.now();
      return existing;
    }

    if (!this.services) {
      await this.init();
    }

    const chatDir = this.getChatSessionDir(chatId);

    // Continue recent session for this chat if exists, or create new
    const { session } = await createAgentSessionFromServices({
      services: this.services,
      sessionManager: SessionManager.continueRecent(config.defaultCwd, chatDir),
    });

    this.applyConfiguredDefaults(session);

    const entry: ActiveSessionEntry = {
      session,
      chatId,
      lastActive: Date.now(),
      isProcessing: false,
    };

    this.sessions.set(chatId, entry);
    return entry;
  }

  async resetSession(chatId: number): Promise<AgentSession> {
    const existing = this.sessions.get(chatId);
    if (existing) {
      try {
        existing.session.dispose();
      } catch (err) {
        console.error("Error disposing session:", err);
      }
      this.sessions.delete(chatId);
    }

    if (!this.services) {
      await this.init();
    }

    const chatDir = this.getChatSessionDir(chatId);
    const { session } = await createAgentSessionFromServices({
      services: this.services,
      sessionManager: SessionManager.create(config.defaultCwd, chatDir),
    });

    this.applyConfiguredDefaults(session);

    const entry: ActiveSessionEntry = {
      session,
      chatId,
      lastActive: Date.now(),
      isProcessing: false,
    };

    this.sessions.set(chatId, entry);

    // Soft-archive older sessions in background with Gzip compression & Mnemosyne extraction
    sessionArchiver.archiveInactiveSessions(chatId, {
      keepLatest: 1,
      exportMarkdown: true,
      activeSessionFile: session.sessionFile,
    }).catch((err) => console.error("Auto-archival error on reset:", err));

    return session;
  }

  async listSessions(chatId: number): Promise<SessionInfo[]> {
    const chatDir = this.getChatSessionDir(chatId);
    const archiveDir = path.join(chatDir, ".archive");
    const activeEntry = this.sessions.get(chatId);
    const activeFile = activeEntry?.session?.sessionFile ? path.basename(activeEntry.session.sessionFile) : null;

    const results: SessionInfo[] = [];

    // 1. Active & uncompressed sessions in chat directory
    if (fs.existsSync(chatDir)) {
      const files = fs
        .readdirSync(chatDir)
        .filter((f) => (f.endsWith(".json") || f.endsWith(".jsonl")) && !f.startsWith("."))
        .map((f) => {
          const full = path.join(chatDir, f);
          const stat = fs.statSync(full);
          return { name: f, full, mtime: stat.mtimeMs, size: stat.size };
        })
        .sort((a, b) => b.mtime - a.mtime);

      for (const item of files) {
        const base = item.name.replace(/\.(jsonl?)$/, "");
        const parts = base.split("_");
        const lastPart = parts[parts.length - 1];
        const id = (parts.length > 1 && lastPart) ? lastPart : base;
        const shortId = id.slice(0, 8);

        const { count, messages } = sessionArchiver.parseSessionFile(item.full);
        const firstUser = messages.find((m) => m.role === "user");
        const summary = firstUser
          ? firstUser.text.slice(0, 70).replace(/\s+/g, " ")
          : `Session (${count} messages)`;

        results.push({
          id,
          shortId,
          fileName: item.name,
          filePath: item.full,
          mtime: item.mtime,
          size: item.size,
          messageCount: count,
          summary,
          isActive: activeFile ? item.name === activeFile : results.length === 0,
          isArchived: false,
        });
      }
    }

    // 2. Archived sessions (.gz)
    const archivedList = sessionArchiver.listArchived(chatId);
    for (const arch of archivedList) {
      const base = arch.originalFileName.replace(/\.(jsonl?)$/, "");
      const parts = base.split("_");
      const lastPart = parts[parts.length - 1];
      const id = (parts.length > 1 && lastPart) ? lastPart : base;
      const shortId = id.slice(0, 8);

      if (results.some((r) => r.id === id || r.fileName === arch.originalFileName)) {
        continue;
      }

      results.push({
        id: arch.archiveId || id,
        shortId,
        fileName: arch.originalFileName,
        filePath: path.join(archiveDir, `${arch.originalFileName}.gz`),
        mtime: arch.archivedAt,
        size: arch.compressedSize,
        messageCount: arch.messageCount,
        summary: arch.summary || `Archived session`,
        isActive: false,
        isArchived: true,
      });
    }

    // 3. Ensure active in-memory session is listed even if not yet flushed to disk
    if (activeEntry?.session) {
      const actId = activeEntry.session.sessionId;
      const actFile = activeEntry.session.sessionFile ? path.basename(activeEntry.session.sessionFile) : `${actId}.jsonl`;
      const alreadyInList = results.some((r) => r.id === actId || (activeFile && r.fileName === activeFile));
      if (!alreadyInList) {
        results.unshift({
          id: actId,
          shortId: actId.slice(0, 8),
          fileName: actFile,
          filePath: activeEntry.session.sessionFile || "",
          mtime: activeEntry.lastActive || Date.now(),
          size: 0,
          messageCount: activeEntry.session.messages.length,
          summary: "Current active session",
          isActive: true,
          isArchived: false,
        });
      }
    }

    return results.sort((a, b) => b.mtime - a.mtime);
  }

  async resumeSession(
    chatId: number,
    targetIdOrPrefix: string
  ): Promise<{ session: AgentSession; previousId?: string; summary: string; messageCount: number; alreadyActive?: boolean }> {
    const activeEntry = this.sessions.get(chatId);
    if (activeEntry && (activeEntry.isProcessing || activeEntry.session.isStreaming)) {
      throw new Error("Cannot resume session while an agent prompt is actively running. Use /abort first.");
    }

    const previousId = activeEntry?.session?.sessionId;
    const query = targetIdOrPrefix.trim().toLowerCase();
    const chatDir = this.getChatSessionDir(chatId);

    const allSessions = await this.listSessions(chatId);
    const num = parseInt(query, 10);
    let matchedSession: SessionInfo | undefined;

    if (!isNaN(num) && num >= 1 && num <= allSessions.length && query === String(num)) {
      matchedSession = allSessions[num - 1];
    } else {
      matchedSession = allSessions.find(
        (s) =>
          s.id.toLowerCase() === query ||
          s.shortId.toLowerCase() === query ||
          s.id.toLowerCase().startsWith(query) ||
          s.fileName.toLowerCase().includes(query)
      );
    }

    if (!matchedSession) {
      throw new Error(`Session matching "${targetIdOrPrefix}" not found.`);
    }

    // If session is already active, no need to reload
    if (activeEntry && matchedSession.isActive) {
      return {
        session: activeEntry.session,
        previousId,
        summary: matchedSession.summary,
        messageCount: matchedSession.messageCount,
        alreadyActive: true,
      };
    }

    let targetFilePath = matchedSession.filePath;

    // If it's archived (.gz), restore/decompress it first
    if (matchedSession.isArchived) {
      const restoreRes = sessionArchiver.restoreSession(chatId, matchedSession.id);
      if (!restoreRes.ok || !restoreRes.restoredFile) {
        throw new Error(`Failed to restore archived session: ${restoreRes.error || "Unknown error"}`);
      }
      targetFilePath = path.join(chatDir, restoreRes.restoredFile);
    }

    if (!fs.existsSync(targetFilePath)) {
      throw new Error(`Session file not found on disk: ${path.basename(targetFilePath)}`);
    }

    // Dispose active session in memory
    if (activeEntry) {
      try {
        activeEntry.session.dispose();
      } catch (err) {
        console.error("Error disposing session on resume:", err);
      }
      this.sessions.delete(chatId);
    }

    if (!this.services) {
      await this.init();
    }

    const sm = SessionManager.open(targetFilePath);
    const { session } = await createAgentSessionFromServices({
      services: this.services,
      sessionManager: sm,
    });

    this.applyConfiguredDefaults(session);

    const entry: ActiveSessionEntry = {
      session,
      chatId,
      lastActive: Date.now(),
      isProcessing: false,
    };

    this.sessions.set(chatId, entry);

    return {
      session,
      previousId,
      summary: matchedSession.summary,
      messageCount: matchedSession.messageCount,
    };
  }

  async setModel(chatId: number, providerOrModelStr: string): Promise<{ model: Model; thinkingLevel?: string } | null> {
    const entry = await this.getSession(chatId);
    if (!this.services?.modelRuntime) return null;

    let rawModelStr = providerOrModelStr.trim();
    let requestedThinking: string | undefined;

    if (rawModelStr.includes(":")) {
      const colonIdx = rawModelStr.lastIndexOf(":");
      const possibleLevel = rawModelStr.slice(colonIdx + 1).trim().toLowerCase();
      const validLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
      if (validLevels.includes(possibleLevel)) {
        requestedThinking = possibleLevel;
        rawModelStr = rawModelStr.slice(0, colonIdx).trim();
      }
    }

    const runtime = this.services.modelRuntime;
    const parts = rawModelStr.split("/");
    let model: Model | undefined;

    if (parts.length === 2) {
      model = runtime.getModel(parts[0], parts[1]);
    } else {
      const available = await runtime.getAvailable();
      model = available.find(
        (m: Model) =>
          m.id.toLowerCase() === rawModelStr.toLowerCase() ||
          `${m.provider}/${m.id}`.toLowerCase() === rawModelStr.toLowerCase()
      );
    }

    if (model) {
      await entry.session.setModel(model);
      if (requestedThinking) {
        entry.session.setThinkingLevel(requestedThinking as any);
      }
      return {
        model,
        thinkingLevel: entry.session.thinkingLevel,
      };
    }
    return null;
  }

  async setThinkingLevel(chatId: number, level: string): Promise<{ level: string; previous: string }> {
    const entry = await this.getSession(chatId);
    const previous = entry.session.thinkingLevel || "off";
    entry.session.setThinkingLevel(level as any);
    const effective = entry.session.thinkingLevel || level;
    return { level: effective, previous };
  }

  async cycleThinkingLevel(chatId: number): Promise<{ level: string; previous: string }> {
    const entry = await this.getSession(chatId);
    const previous = entry.session.thinkingLevel || "off";
    const next = entry.session.cycleThinkingLevel ? entry.session.cycleThinkingLevel() : undefined;
    const effective = next || entry.session.thinkingLevel || previous;
    return { level: effective, previous };
  }

  async getThinkingInfo(chatId: number): Promise<{
    current: string;
    available: string[];
    supportsThinking: boolean;
  }> {
    const entry = await this.getSession(chatId);
    const current = entry.session.thinkingLevel || "off";
    const available = entry.session.getAvailableThinkingLevels
      ? entry.session.getAvailableThinkingLevels()
      : ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    const supportsThinking = entry.session.supportsThinking ? entry.session.supportsThinking() : false;
    return {
      current,
      available,
      supportsThinking,
    };
  }

  async compactSession(chatId: number): Promise<string> {
    const entry = await this.getSession(chatId);
    const result: any = await entry.session.compact();
    const tokensBefore = result?.tokensBefore ?? result?.originalTokens ?? "context";
    return `Compacted session successfully (tokens before: ${tokensBefore})`;
  }

  async abortPrompt(chatId: number): Promise<boolean> {
    const entry = this.sessions.get(chatId);
    if (entry && (entry.isProcessing || entry.session.isStreaming)) {
      entry.aborted = true;
      try {
        await entry.session.abort();
      } catch (err) {
        console.error("Error during session.abort():", err);
      }
      entry.isProcessing = false;
      return true;
    }
    return false;
  }

  evictIdleSessions(maxIdleAgeMs: number = 30 * 60 * 1000) {
    const now = Date.now();
    for (const [chatId, entry] of this.sessions.entries()) {
      if (!entry.isProcessing && now - entry.lastActive > maxIdleAgeMs) {
        try {
          entry.session.dispose();
        } catch {
          // Ignore disposal errors
        }
        this.sessions.delete(chatId);
      }
    }
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    for (const [, entry] of this.sessions) {
      try {
        entry.session.dispose();
      } catch {
        // Ignore
      }
    }
    this.sessions.clear();
  }
}

export const sessionPool = new SessionPool();
