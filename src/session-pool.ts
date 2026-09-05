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

  async setModel(chatId: number, providerOrModelStr: string): Promise<Model | null> {
    const entry = await this.getSession(chatId);
    if (!this.services?.modelRuntime) return null;

    const runtime = this.services.modelRuntime;
    const parts = providerOrModelStr.split("/");
    let model: Model | undefined;

    if (parts.length === 2) {
      model = runtime.getModel(parts[0], parts[1]);
    } else {
      const available = await runtime.getAvailable();
      model = available.find(
        (m: Model) =>
          m.id.toLowerCase() === providerOrModelStr.toLowerCase() ||
          `${m.provider}/${m.id}`.toLowerCase() === providerOrModelStr.toLowerCase()
      );
    }

    if (model) {
      await entry.session.setModel(model);
      return model;
    }
    return null;
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
