import fs from "fs";
import path from "path";
import { Cron } from "croner";
import { Bot } from "grammy";
import {
  createAgentSessionFromServices,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { config } from "./config";
import { sessionPool, type Model } from "./session-pool";
import { sessionArchiver } from "./session-archiver";
import { splitMessage, markdownToTelegramHtml, escapeHtml } from "./telegram-utils";

export interface CronRunLog {
  runAt: number;
  durationMs: number;
  status: "success" | "error";
  error?: string;
  outputSnippet?: string;
  isNoAgent?: boolean;
}

export interface CronJobConfig {
  id: string;
  name?: string;
  cronExpression: string;
  prompt: string;
  chatId: number;
  enabled: boolean;
  noAgent?: boolean;
  timezone?: string;
  createdAt: number;
  lastRun?: number;
  lastDurationMs?: number;
  lastStatus?: "success" | "error";
  lastError?: string;
  history?: CronRunLog[];
}

export class CronScheduler {
  private jobs = new Map<string, CronJobConfig>();
  private cronInstances = new Map<string, Cron>();
  private runningJobs = new Set<string>();
  private bot: Bot | null = null;
  private storageFile: string;
  private defaultTimezone: string;
  private fileWatcher: fs.FSWatcher | null = null;
  private isSaving = false;

  constructor() {
    this.storageFile = path.join(config.sessionsDir, "cron-jobs.json");
    const sysTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.defaultTimezone =
      process.env.TZ ||
      (sysTz && sysTz !== "UTC" ? sysTz : "Asia/Jakarta");
  }

  init(bot: Bot) {
    this.bot = bot;
    this.loadJobs();
    this.scheduleAll();
    this.startWatcher();
    console.log(`⏰ CronScheduler initialized with ${this.jobs.size} job(s). Default timezone: ${this.defaultTimezone}`);
  }

  destroy() {
    if (this.fileWatcher) {
      try {
        this.fileWatcher.close();
      } catch {}
      this.fileWatcher = null;
    }
    for (const [, instance] of this.cronInstances) {
      try {
        instance.stop();
      } catch {}
    }
    this.cronInstances.clear();
    this.runningJobs.clear();
  }

  private startWatcher() {
    try {
      if (this.fileWatcher) {
        this.fileWatcher.close();
        this.fileWatcher = null;
      }
      let debounceTimer: any = null;
      this.fileWatcher = fs.watch(config.sessionsDir, (eventType, filename) => {
        if (this.isSaving) return;
        if (filename === "cron-jobs.json" || !filename) {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            console.log("⏰ [CronScheduler] Detected external change in cron-jobs.json. Auto-syncing...");
            this.loadJobs();
            this.scheduleAll();
          }, 300);
        }
      });
      this.fileWatcher.on("error", (err: any) => {
        console.error("Cron file watcher error:", err.message);
      });
    } catch (err) {
      console.error("Failed to attach file watcher on cron-jobs.json:", err);
    }
  }

  public reload() {
    this.loadJobs();
    this.scheduleAll();
    console.log(`⏰ CronScheduler reloaded from disk. Total jobs: ${this.jobs.size}`);
  }

  private loadJobs() {
    try {
      if (!fs.existsSync(config.sessionsDir)) {
        fs.mkdirSync(config.sessionsDir, { recursive: true });
      }
      if (fs.existsSync(this.storageFile)) {
        const raw = fs.readFileSync(this.storageFile, "utf-8");
        const list: CronJobConfig[] = JSON.parse(raw);
        this.jobs.clear();
        for (const item of list) {
          if (!item.history) item.history = [];
          this.jobs.set(item.id, item);
        }
      }
    } catch (err) {
      console.error("Failed to load cron-jobs.json:", err);
    }
  }

  private saveJobs(mergeWithDisk: boolean = true) {
    try {
      this.isSaving = true;
      if (mergeWithDisk) {
        let diskJobs: CronJobConfig[] = [];
        if (fs.existsSync(this.storageFile)) {
          try {
            diskJobs = JSON.parse(fs.readFileSync(this.storageFile, "utf-8"));
          } catch {}
        }

        const merged = new Map<string, CronJobConfig>();
        for (const dj of diskJobs) {
          merged.set(dj.id, dj);
        }
        for (const [id, memJob] of this.jobs) {
          merged.set(id, memJob);
        }
        this.jobs = merged;
      }

      const list = Array.from(this.jobs.values());
      fs.writeFileSync(this.storageFile, JSON.stringify(list, null, 2), "utf-8");
    } catch (err) {
      console.error("Failed to save cron-jobs.json:", err);
    } finally {
      setTimeout(() => {
        this.isSaving = false;
      }, 500);
    }
  }

  private scheduleAll() {
    for (const [, instance] of this.cronInstances) {
      instance.stop();
    }
    this.cronInstances.clear();

    for (const job of this.jobs.values()) {
      if (job.enabled) {
        this.scheduleJob(job);
      }
    }
  }

  private scheduleJob(job: CronJobConfig) {
    try {
      const existing = this.cronInstances.get(job.id);
      if (existing) {
        existing.stop();
      }

      const instance = new Cron(
        job.cronExpression,
        {
          timezone: job.timezone || this.defaultTimezone,
          catch: (err) => {
            console.error(`Cron error on job ${job.id}:`, err);
          },
        },
        async () => {
          await this.executeJob(job.id);
        }
      );

      this.cronInstances.set(job.id, instance);
    } catch (err: any) {
      console.error(`Failed to schedule cron job ${job.id} (${job.cronExpression}):`, err.message);
    }
  }

  getNextRun(id: string): string | null {
    const instance = this.cronInstances.get(id);
    if (!instance) return null;
    const nextDate = instance.nextRun();
    if (!nextDate) return null;
    return nextDate.toLocaleString("id-ID", {
      timeZone: this.jobs.get(id)?.timezone || this.defaultTimezone,
      dateStyle: "short",
      timeStyle: "short",
    });
  }

  listJobs(): Array<CronJobConfig & { nextRun?: string | null }> {
    this.loadJobs();
    this.scheduleAll();
    return Array.from(this.jobs.values()).map((j) => ({
      ...j,
      nextRun: j.enabled ? this.getNextRun(j.id) : "Paused",
    }));
  }

  getJob(id: string): CronJobConfig | undefined {
    this.loadJobs();
    return this.jobs.get(id);
  }

  getLogs(id?: string, limit: number = 5): Array<{ job: CronJobConfig; logs: CronRunLog[] }> {
    if (id) {
      const job = this.jobs.get(id);
      if (!job) return [];
      return [{ job, logs: (job.history || []).slice(-limit) }];
    }

    return Array.from(this.jobs.values()).map((job) => ({
      job,
      logs: (job.history || []).slice(-limit),
    }));
  }

  private appendHistory(
    job: CronJobConfig,
    entry: {
      durationMs: number;
      status: "success" | "error";
      error?: string;
      outputSnippet?: string;
      isNoAgent?: boolean;
    }
  ) {
    if (!job.history) job.history = [];
    job.lastRun = Date.now();
    job.lastDurationMs = entry.durationMs;
    job.lastStatus = entry.status;
    job.lastError = entry.error;

    job.history.push({
      runAt: Date.now(),
      ...entry,
    });

    // Keep only last 10 entries per job
    if (job.history.length > 10) {
      job.history = job.history.slice(-10);
    }

    this.saveJobs();
  }

  addJob(options: {
    id?: string;
    name?: string;
    cronExpression: string;
    prompt: string;
    chatId: number;
    noAgent?: boolean;
    timezone?: string;
  }): { ok: boolean; job?: CronJobConfig; error?: string } {
    try {
      new Cron(options.cronExpression, { timezone: options.timezone || this.defaultTimezone });
    } catch (err: any) {
      return { ok: false, error: `Invalid cron expression: ${err.message}` };
    }

    const id = (options.id || `job_${Date.now().toString(36)}`).toLowerCase().replace(/[^a-z0-9_-]/g, "_");

    const job: CronJobConfig = {
      id,
      name: options.name || options.prompt.slice(0, 30),
      cronExpression: options.cronExpression,
      prompt: options.prompt,
      chatId: options.chatId,
      enabled: true,
      noAgent: options.noAgent || false,
      timezone: options.timezone || this.defaultTimezone,
      createdAt: Date.now(),
      history: [],
    };

    this.jobs.set(id, job);
    this.saveJobs();
    this.scheduleJob(job);

    return { ok: true, job };
  }

  editJob(
    id: string,
    updates: {
      name?: string;
      cronExpression?: string;
      prompt?: string;
      timezone?: string;
      noAgent?: boolean;
      enabled?: boolean;
    }
  ): { ok: boolean; job?: CronJobConfig; error?: string; changes?: string[] } {
    this.loadJobs();
    const job = this.jobs.get(id);
    if (!job) {
      return { ok: false, error: `Job with ID '${id}' not found.` };
    }

    const changes: string[] = [];

    // Validate new cron expression if provided
    if (updates.cronExpression) {
      try {
        const testCron = new Cron(updates.cronExpression, { timezone: updates.timezone || job.timezone || this.defaultTimezone });
        testCron.stop();
        if (job.cronExpression !== updates.cronExpression) {
          changes.push(`Schedule: <code>${escapeHtml(job.cronExpression)}</code> ➔ <code>${escapeHtml(updates.cronExpression)}</code>`);
          job.cronExpression = updates.cronExpression;
        }
      } catch (err: any) {
        return { ok: false, error: `Invalid cron expression: ${err.message}` };
      }
    }

    if (updates.name && updates.name !== job.name) {
      changes.push(`Name: <b>${escapeHtml(job.name || job.id)}</b> ➔ <b>${escapeHtml(updates.name)}</b>`);
      job.name = updates.name;
    }

    if (updates.prompt && updates.prompt !== job.prompt) {
      changes.push(`Prompt/Command updated.`);
      job.prompt = updates.prompt;
    }

    if (updates.timezone && updates.timezone !== job.timezone) {
      changes.push(`Timezone: <code>${escapeHtml(job.timezone || "default")}</code> ➔ <code>${escapeHtml(updates.timezone)}</code>`);
      job.timezone = updates.timezone;
    }

    if (updates.noAgent !== undefined && updates.noAgent !== job.noAgent) {
      const modeStr = updates.noAgent ? "⚡ Direct Script" : "🧠 Agent Reasoning";
      changes.push(`Mode: <b>${modeStr}</b>`);
      job.noAgent = updates.noAgent;
    }

    if (updates.enabled !== undefined && updates.enabled !== job.enabled) {
      changes.push(`Status: <b>${updates.enabled ? "Enabled" : "Paused"}</b>`);
      job.enabled = updates.enabled;
    }

    if (changes.length === 0) {
      return { ok: false, error: "No changes detected or provided." };
    }

    this.saveJobs();
    if (job.enabled) {
      this.scheduleJob(job);
    } else {
      const existing = this.cronInstances.get(job.id);
      if (existing) {
        existing.stop();
        this.cronInstances.delete(job.id);
      }
    }

    return { ok: true, job, changes };
  }

  removeJob(id: string): boolean {
    const instance = this.cronInstances.get(id);
    if (instance) {
      instance.stop();
      this.cronInstances.delete(id);
    }
    const existed = this.jobs.delete(id);
    if (existed) {
      this.saveJobs(false);
    }
    return existed;
  }

  pauseJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.enabled = false;
    const instance = this.cronInstances.get(id);
    if (instance) {
      instance.stop();
      this.cronInstances.delete(id);
    }
    this.saveJobs();
    return true;
  }

  resumeJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.enabled = true;
    this.saveJobs();
    this.scheduleJob(job);
    return true;
  }

  async executeJob(id: string, manual: boolean = false): Promise<string> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job ${id} not found`);

    if (this.runningJobs.has(id)) {
      console.log(`⏰ [Cron] Job "${id}" is already executing, skipping overlapping run.`);
      return "";
    }

    this.runningJobs.add(id);
    const startTime = Date.now();
    const modeTag = job.noAgent ? "⚡ Direct Script" : "🤖 Agent Reasoning";
    console.log(`⏰ [Cron] Executing job "${job.name || job.id}" (${job.cronExpression}) [${modeTag}]...`);

    // =========================================================================
    // BRANCH A: NO_AGENT = TRUE (Pure Script / Bash Execution, 0 LLM Tokens)
    // =========================================================================
    if (job.noAgent) {
      try {
        const proc = Bun.spawn(["bash", "-c", job.prompt], {
          cwd: config.defaultCwd,
          stdout: "pipe",
          stderr: "pipe",
        });

        const timeoutMs = 120_000;
        let timeoutTimer: any = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            try { proc.kill(); } catch {}
            reject(new Error(`Script execution timed out after ${timeoutMs / 1000}s`));
          }, timeoutMs);
        });

        const exitCode = await Promise.race([proc.exited, timeoutPromise]);
        if (timeoutTimer) clearTimeout(timeoutTimer);

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const durationMs = Date.now() - startTime;

        let output = stdout.trim();
        if (!output && stderr.trim()) {
          output = stderr.trim();
        }
        if (!output) {
          output = `(Script executed successfully with exit code ${exitCode})`;
        }

        if (exitCode !== 0) {
          const errMsg = `Script exited with code ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`;
          this.appendHistory(job, {
            durationMs,
            status: "error",
            error: errMsg,
            outputSnippet: output.slice(0, 150),
            isNoAgent: true,
          });

          if (this.bot && job.chatId) {
            const errorMsg = `⚠️ <b>[Scheduled Script Error]</b> <b>${escapeHtml(job.name || job.id)}</b> (⚡ Direct Script)\n⏱️ <i>Duration: ${(durationMs / 1000).toFixed(2)}s</i>\n\n<pre>${escapeHtml(errMsg)}</pre>`;
            await this.bot.api.sendMessage(job.chatId, errorMsg, { parse_mode: "HTML" }).catch(() => {});
          }
          throw new Error(errMsg);
        }

        this.appendHistory(job, {
          durationMs,
          status: "success",
          outputSnippet: output.slice(0, 150),
          isNoAgent: true,
        });

        if (this.bot && job.chatId) {
          const timeStr = new Date().toLocaleString("id-ID", {
            timeZone: job.timezone || this.defaultTimezone,
          });
          const title = `⏰ <b>[Scheduled Task]</b> <b>${escapeHtml(job.name || job.id)}</b> (⚡ Direct Script)\n📅 <i>${escapeHtml(timeStr)}</i> | ⏱️ <i>${(durationMs / 1000).toFixed(2)}s</i>\n\n`;
          const htmlBody = markdownToTelegramHtml(output);
          const totalMessage = title + htmlBody;
          const chunks = splitMessage(totalMessage);

          for (const chunk of chunks) {
            try {
              await this.bot.api.sendMessage(job.chatId, chunk, { parse_mode: "HTML" });
            } catch {
              await this.bot.api.sendMessage(job.chatId, chunk.replace(/<[^>]*>/g, ""));
            }
          }
        }

        return output;
      } catch (err: any) {
        console.error(`❌ [Cron No-Agent] Error running job ${job.id}:`, err.message);
        throw err;
      } finally {
        this.runningJobs.delete(id);
      }
    }

    // =========================================================================
    // BRANCH B: AGENT REASONING MODE (Full Pi SDK, Tools, Skills & Models)
    // =========================================================================
    const services = sessionPool.getServices();
    if (!services) {
      this.runningJobs.delete(id);
      throw new Error("Session pool services not initialized yet");
    }

    let session: AgentSession | null = null;
    try {
      const cronSessionDir = path.join(config.sessionsDir, `cron_${job.id}`);
      if (!fs.existsSync(cronSessionDir)) {
        fs.mkdirSync(cronSessionDir, { recursive: true });
      }

      const res = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.create(config.defaultCwd, cronSessionDir),
      });
      session = res.session;

      let fullResponse = "";
      let modelErrorMessage: string | null = null;

      if (config.defaultModel && services.modelRuntime) {
        const runtime = services.modelRuntime;
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
          await session.setModel(targetModel);
        }
      }
      if (config.defaultThinkingLevel) {
        session.setThinkingLevel(config.defaultThinkingLevel);
      }

      const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_update") {
          if (event.assistantMessageEvent.type === "text_delta") {
            fullResponse += event.assistantMessageEvent.delta;
          }
        } else if (event.type === "message_end") {
          if (event.message?.role === "assistant") {
            if (event.message.errorMessage) {
              modelErrorMessage = event.message.errorMessage;
            }
            if (!fullResponse && event.message.content) {
              const texts = event.message.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("\n");
              if (texts) fullResponse = texts;
            }
          }
        } else if (event.type === "agent_end") {
          const lastMsg = event.messages?.[event.messages.length - 1];
          if (lastMsg?.role === "assistant" && lastMsg.errorMessage) {
            modelErrorMessage = lastMsg.errorMessage;
          }
        }
      });

      const timeoutMs = 420_000; // 7 minutes
      let timeoutTimer: any = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(async () => {
          try {
            await session?.abort();
          } catch {}
          reject(new Error(`Agent execution timed out after ${timeoutMs / 60_000} minutes`));
        }, timeoutMs);
      });

      try {
        await Promise.race([session.prompt(job.prompt), timeoutPromise]);
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        unsubscribe();
      }

      const durationMs = Date.now() - startTime;

      if (modelErrorMessage) {
        throw new Error(modelErrorMessage);
      }

      if (!fullResponse || !fullResponse.trim()) {
        fullResponse = "*(Task completed with no output text)*";
      }

      this.appendHistory(job, {
        durationMs,
        status: "success",
        outputSnippet: fullResponse.slice(0, 150),
        isNoAgent: false,
      });

      if (this.bot && job.chatId) {
        const timeStr = new Date().toLocaleString("id-ID", {
          timeZone: job.timezone || this.defaultTimezone,
        });
        const title = `⏰ <b>[Scheduled Task]</b> <b>${escapeHtml(job.name || job.id)}</b> (🤖 Agent)\n📅 <i>${escapeHtml(timeStr)}</i> | ⏱️ <i>${(durationMs / 1000).toFixed(2)}s</i>\n\n`;
        const htmlBody = markdownToTelegramHtml(fullResponse);
        const totalMessage = title + htmlBody;
        const chunks = splitMessage(totalMessage);

        for (const chunk of chunks) {
          try {
            await this.bot.api.sendMessage(job.chatId, chunk, { parse_mode: "HTML" });
          } catch {
            await this.bot.api.sendMessage(job.chatId, chunk.replace(/<[^>]*>/g, ""));
          }
        }
      }

      return fullResponse;
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      console.error(`❌ [Cron] Error running job ${job.id}:`, err.message);

      this.appendHistory(job, {
        durationMs,
        status: "error",
        error: err.message,
        isNoAgent: false,
      });

      if (this.bot && job.chatId) {
        const errorMsg = `⚠️ <b>[Scheduled Task Error]</b> <b>${escapeHtml(job.name || job.id)}</b> (🤖 Agent)\n⏱️ <i>Duration: ${(durationMs / 1000).toFixed(2)}s</i>\n\n<pre>${escapeHtml(err.message)}</pre>`;
        await this.bot.api.sendMessage(job.chatId, errorMsg, { parse_mode: "HTML" }).catch(() => {});
      }

      throw err;
    } finally {
      this.runningJobs.delete(id);
      if (session) {
        try {
          session.dispose();
        } catch {}
      }
      try {
        sessionArchiver.pruneCronSessions(2);
        sessionArchiver.cleanOldImages(7, 40);
      } catch (e: any) {
        console.error("Error during post-cron maintenance:", e.message);
      }
    }
  }
}

export const cronScheduler = new CronScheduler();
