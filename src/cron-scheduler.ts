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
  isManual?: boolean;
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

export function isValidCronExpression(expr: string, timezone?: string): boolean {
  if (!expr || typeof expr !== "string") return false;
  try {
    const test = new Cron(expr.trim(), { timezone: timezone || config.defaultTimezone });
    test.stop();
    return true;
  } catch {
    return false;
  }
}

export class CronScheduler {
  private jobs = new Map<string, CronJobConfig>();
  private cronInstances = new Map<string, Cron>();
  private runningJobs = new Set<string>();
  private activeAgentSessions = new Map<string, AgentSession>();
  private activeProcesses = new Map<string, any>();
  private bot: Bot | null = null;
  private storageFile: string;
  private backupFile: string;
  private tombstoneFile: string;
  private tombstones = new Set<string>();
  private defaultTimezone: string;
  private fileWatcher: fs.FSWatcher | null = null;
  private isSaving = false;
  private lastSaveTimeMs = 0;

  private discordSender: ((title: string, rawText: string) => Promise<void>) | null = null;

  setDiscordSender(sender: ((title: string, rawText: string) => Promise<void>) | null) {
    this.discordSender = sender;
  }

  constructor() {
    this.storageFile = path.join(config.sessionsDir, "cron-jobs.json");
    this.backupFile = path.join(config.sessionsDir, "cron-jobs.json.bak");
    this.tombstoneFile = path.join(config.sessionsDir, "cron-tombstones.json");
    this.defaultTimezone = config.defaultTimezone || process.env.TZ || "Asia/Makassar";
  }

  init(bot?: Bot | null) {
    this.bot = bot || null;
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

    // Gracefully terminate active background agent sessions
    for (const [, session] of this.activeAgentSessions) {
      try {
        session.abort().catch(() => {});
        session.dispose();
      } catch {}
    }
    this.activeAgentSessions.clear();

    // Terminate spawned script processes
    for (const [, proc] of this.activeProcesses) {
      try {
        proc.kill(9);
      } catch {}
    }
    this.activeProcesses.clear();
    this.runningJobs.clear();
  }

  /**
   * Safe, case-insensitive lookup helper for job IDs
   */
  private findJobEntry(id: string): [string, CronJobConfig] | [undefined, undefined] {
    if (!id) return [undefined, undefined];
    const normalized = id.toLowerCase().trim();
    for (const [key, job] of this.jobs) {
      if (key.toLowerCase() === normalized || (job.id && job.id.toLowerCase() === normalized)) {
        return [key, job];
      }
    }
    return [undefined, undefined];
  }

  private startWatcher() {
    try {
      if (this.fileWatcher) {
        this.fileWatcher.close();
        this.fileWatcher = null;
      }
      let debounceTimer: any = null;
      this.fileWatcher = fs.watch(config.sessionsDir, (eventType, filename) => {
        // Only react strictly to changes on cron-jobs.json
        if (filename !== "cron-jobs.json") return;
        if (this.isSaving) return;
        if (Date.now() - this.lastSaveTimeMs < 1500) return;

        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          console.log("⏰ [CronScheduler] Detected external change in cron-jobs.json. Auto-syncing...");
          this.loadJobs();
          this.scheduleAll();
        }, 300);
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

  private loadTombstones() {
    try {
      if (fs.existsSync(this.tombstoneFile)) {
        const raw = fs.readFileSync(this.tombstoneFile, "utf-8");
        if (raw.trim()) {
          const arr: string[] = JSON.parse(raw);
          this.tombstones = new Set(arr.map((s) => String(s).toLowerCase().trim()));
        }
      }
    } catch (err) {
      console.error("Failed to load cron-tombstones.json:", err);
    }
  }

  private saveTombstones() {
    try {
      const arr = Array.from(this.tombstones);
      const tmp = `${this.tombstoneFile}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), "utf-8");
      fs.renameSync(tmp, this.tombstoneFile);
    } catch (err) {
      console.error("Failed to save cron-tombstones.json:", err);
    }
  }

  private loadJobs() {
    try {
      if (!fs.existsSync(config.sessionsDir)) {
        fs.mkdirSync(config.sessionsDir, { recursive: true });
      }

      this.loadTombstones();

      let targetFileToRead = this.storageFile;
      if (!fs.existsSync(this.storageFile) && fs.existsSync(this.backupFile)) {
        console.warn("⚠️ cron-jobs.json not found, restoring from backup...");
        targetFileToRead = this.backupFile;
      }

      if (fs.existsSync(targetFileToRead)) {
        const raw = fs.readFileSync(targetFileToRead, "utf-8");
        if (raw.trim()) {
          const list: CronJobConfig[] = JSON.parse(raw);
          this.jobs.clear();
          for (const item of list) {
            if (this.tombstones.has(item.id.toLowerCase())) {
              continue; // Prevent resurrection of deleted job
            }
            if (!item.history) item.history = [];
            this.jobs.set(item.id, item);
          }
          // Maintain a backup copy of valid loaded jobs
          try {
            const cleanList = Array.from(this.jobs.values());
            fs.writeFileSync(this.backupFile, JSON.stringify(cleanList, null, 2), "utf-8");
          } catch {}
        }
      }
    } catch (err) {
      console.error("Failed to load cron-jobs.json:", err);
    }
  }

  private saveJobs(mergeWithDisk: boolean = false) {
    try {
      this.isSaving = true;
      this.lastSaveTimeMs = Date.now();

      if (mergeWithDisk) {
        let diskJobs: CronJobConfig[] = [];
        if (fs.existsSync(this.storageFile)) {
          try {
            diskJobs = JSON.parse(fs.readFileSync(this.storageFile, "utf-8"));
          } catch {}
        }

        const merged = new Map<string, CronJobConfig>();
        for (const dj of diskJobs) {
          if (!this.tombstones.has(dj.id.toLowerCase())) {
            merged.set(dj.id, dj);
          }
        }
        for (const [id, memJob] of this.jobs) {
          if (!this.tombstones.has(id.toLowerCase())) {
            merged.set(id, memJob);
          }
        }
        this.jobs = merged;
      }

      const list = Array.from(this.jobs.values());
      const jsonContent = JSON.stringify(list, null, 2);

      // Atomic write: write to temp file then renameSync
      const tmpFile = `${this.storageFile}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpFile, jsonContent, "utf-8");
      fs.renameSync(tmpFile, this.storageFile);

      // Save backup copy
      try {
        fs.writeFileSync(this.backupFile, jsonContent, "utf-8");
      } catch {}
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
          await this.executeJob(job.id, false);
        }
      );

      this.cronInstances.set(job.id, instance);
    } catch (err: any) {
      console.error(`Failed to schedule cron job ${job.id} (${job.cronExpression}):`, err.message);
    }
  }

  getNextRun(id: string): string | null {
    const [, job] = this.findJobEntry(id);
    if (!job) return null;
    const instance = this.cronInstances.get(job.id);
    if (!instance) return null;
    const nextDate = instance.nextRun();
    if (!nextDate) return null;
    return nextDate.toLocaleString("id-ID", {
      timeZone: job.timezone || this.defaultTimezone,
      dateStyle: "short",
      timeStyle: "short",
    });
  }

  /**
   * Pure in-memory query to avoid timer churn and unwanted I/O
   */
  listJobs(): Array<CronJobConfig & { nextRun?: string | null }> {
    return Array.from(this.jobs.values()).map((j) => ({
      ...j,
      nextRun: j.enabled ? this.getNextRun(j.id) : "Paused",
    }));
  }

  getJob(id: string): CronJobConfig | undefined {
    return this.findJobEntry(id)[1];
  }

  getLogs(id?: string, limit: number = 5): Array<{ job: CronJobConfig; logs: CronRunLog[] }> {
    if (id) {
      const [, job] = this.findJobEntry(id);
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
      isManual?: boolean;
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
      const testCron = new Cron(options.cronExpression, { timezone: options.timezone || this.defaultTimezone });
      testCron.stop();
    } catch (err: any) {
      return { ok: false, error: `Invalid cron expression: ${err.message}` };
    }

    const id = (options.id || `job_${Date.now().toString(36)}`).toLowerCase().replace(/[^a-z0-9_-]/g, "_");

    // Prevent accidental overwrite of existing job
    const existing = this.findJobEntry(id)[1];
    if (existing) {
      return {
        ok: false,
        error: `Job with ID '${id}' already exists. Use '/cron edit ${id}' to modify it or specify a different ID.`,
      };
    }

    // Clear any tombstone if re-creating
    if (this.tombstones.has(id.toLowerCase())) {
      this.tombstones.delete(id.toLowerCase());
      this.saveTombstones();
    }

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
    const [, job] = this.findJobEntry(id);
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
    const [key, job] = this.findJobEntry(id);
    if (!key || !job) return false;

    // Track tombstone to prevent resurrection from disk or backup
    this.tombstones.add(job.id.toLowerCase());
    this.tombstones.add(key.toLowerCase());
    this.saveTombstones();

    const instance = this.cronInstances.get(job.id);
    if (instance) {
      instance.stop();
      this.cronInstances.delete(job.id);
    }
    const existed = this.jobs.delete(key);
    if (existed) {
      this.saveJobs(false);
    }
    return existed;
  }

  pauseJob(id: string): boolean {
    const [, job] = this.findJobEntry(id);
    if (!job) return false;
    job.enabled = false;
    const instance = this.cronInstances.get(job.id);
    if (instance) {
      instance.stop();
      this.cronInstances.delete(job.id);
    }
    this.saveJobs();
    return true;
  }

  resumeJob(id: string): boolean {
    const [, job] = this.findJobEntry(id);
    if (!job) return false;
    job.enabled = true;
    this.saveJobs();
    this.scheduleJob(job);
    return true;
  }

  async executeJob(id: string, manual: boolean = false): Promise<string> {
    const [, job] = this.findJobEntry(id);
    if (!job) throw new Error(`Job '${id}' not found`);

    if (this.runningJobs.has(job.id)) {
      console.log(`⏰ [Cron] Job "${job.id}" is already executing, skipping overlapping run.`);
      return "";
    }

    this.runningJobs.add(job.id);
    const startTime = Date.now();
    const modeTag = job.noAgent ? "⚡ Direct Script" : "🤖 Agent Reasoning";
    const runType = manual ? " [Manual Trigger]" : "";
    console.log(`⏰ [Cron] Executing job "${job.name || job.id}" (${job.cronExpression}) [${modeTag}]${runType}...`);

    // =========================================================================
    // BRANCH A: NO_AGENT = TRUE (Pure Script / Bash Execution, 0 LLM Tokens)
    // =========================================================================
    if (job.noAgent) {
      let proc: any = null;
      try {
        proc = Bun.spawn(["bash", "-c", job.prompt], {
          cwd: config.defaultCwd,
          stdout: "pipe",
          stderr: "pipe",
        });
        this.activeProcesses.set(job.id, proc);

        const timeoutMs = 120_000;
        let timeoutTimer: any = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            try { proc.kill(9); } catch {}
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
            isManual: manual,
          });

          // Safe error truncation to avoid Telegram 4096 character limits
          const safeErrDisplay = errMsg.length > 2500 ? errMsg.slice(0, 2450) + "\n...[truncated]" : errMsg;

          if (this.bot && job.chatId) {
            const errorMsg = `⚠️ <b>[Scheduled Script Error]</b> <b>${escapeHtml(job.name || job.id)}</b> (⚡ Direct Script)\n⏱️ <i>Duration: ${(durationMs / 1000).toFixed(2)}s</i>\n\n<pre>${escapeHtml(safeErrDisplay)}</pre>`;
            await this.bot.api.sendMessage(job.chatId, errorMsg, { parse_mode: "HTML" }).catch(() => {});
          }

          if (this.discordSender) {
            try {
              const title = `⚠️ **[Scheduled Script Error]** **${job.name || job.id}** (⚡ Direct Script)\n⏱️ *Duration: ${(durationMs / 1000).toFixed(2)}s*\n\n`;
              await this.discordSender(title, `\`\`\`text\n${safeErrDisplay.slice(0, 1800)}\n\`\`\``);
            } catch (dErr: any) {
              console.error("❌ [Cron Discord] Error broadcasting script error:", dErr.message);
            }
          }

          throw new Error(errMsg);
        }

        this.appendHistory(job, {
          durationMs,
          status: "success",
          outputSnippet: output.slice(0, 150),
          isNoAgent: true,
          isManual: manual,
        });

        if (this.bot && job.chatId) {
          const timeStr = new Date().toLocaleString("id-ID", {
            timeZone: job.timezone || this.defaultTimezone,
          });
          const triggerNote = manual ? " <i>[Manual Run]</i>" : "";
          const title = `⏰ <b>[Scheduled Task]</b> <b>${escapeHtml(job.name || job.id)}</b> (⚡ Direct Script)${triggerNote}\n📅 <i>${escapeHtml(timeStr)}</i> | ⏱️ <i>${(durationMs / 1000).toFixed(2)}s</i>\n\n`;
          const htmlBody = markdownToTelegramHtml(output);
          const totalMessage = title + htmlBody;
          const chunks = splitMessage(totalMessage);

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]!;
            try {
              await this.bot.api.sendMessage(job.chatId, chunk, { parse_mode: "HTML" });
            } catch {
              await this.bot.api.sendMessage(job.chatId, chunk.replace(/<[^>]*>/g, ""));
            }
            if (i < chunks.length - 1) {
              await new Promise((r) => setTimeout(r, 250));
            }
          }
        }

        if (this.discordSender) {
          try {
            const timeStr = new Date().toLocaleString("id-ID", {
              timeZone: job.timezone || this.defaultTimezone,
            });
            const triggerNote = manual ? " *[Manual Run]*" : "";
            const title = `⏰ **[Scheduled Task]** **${job.name || job.id}** (⚡ Direct Script)${triggerNote}\n📅 *${timeStr}* | ⏱️ *${(durationMs / 1000).toFixed(2)}s*\n\n`;
            await this.discordSender(title, output);
          } catch (err: any) {
            console.error("❌ [Cron Discord] Error sending direct script output:", err.message);
          }
        }

        return output;
      } catch (err: any) {
        console.error(`❌ [Cron No-Agent] Error running job ${job.id}:`, err.message);
        throw err;
      } finally {
        if (proc) this.activeProcesses.delete(job.id);
        this.runningJobs.delete(job.id);
      }
    }

    // =========================================================================
    // BRANCH B: AGENT REASONING MODE (Full Pi SDK, Tools, Skills & Models)
    // =========================================================================
    const services = sessionPool.getServices();
    if (!services) {
      this.runningJobs.delete(job.id);
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
      this.activeAgentSessions.set(job.id, session);

      // Apply consistent configured model defaults
      sessionPool.applyConfiguredDefaults(session);

      let fullResponse = "";
      let modelErrorMessage: string | null = null;

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
        isManual: manual,
      });

      if (this.bot && job.chatId) {
        const timeStr = new Date().toLocaleString("id-ID", {
          timeZone: job.timezone || this.defaultTimezone,
        });
        const triggerNote = manual ? " <i>[Manual Run]</i>" : "";
        const title = `⏰ <b>[Scheduled Task]</b> <b>${escapeHtml(job.name || job.id)}</b> (🤖 Agent)${triggerNote}\n📅 <i>${escapeHtml(timeStr)}</i> | ⏱️ <i>${(durationMs / 1000).toFixed(2)}s</i>\n\n`;
        const htmlBody = markdownToTelegramHtml(fullResponse);
        const totalMessage = title + htmlBody;
        const chunks = splitMessage(totalMessage);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i]!;
          try {
            await this.bot.api.sendMessage(job.chatId, chunk, { parse_mode: "HTML" });
          } catch {
            await this.bot.api.sendMessage(job.chatId, chunk.replace(/<[^>]*>/g, ""));
          }
          if (i < chunks.length - 1) {
            await new Promise((r) => setTimeout(r, 250));
          }
        }
      }

      if (this.discordSender) {
        try {
          const timeStr = new Date().toLocaleString("id-ID", {
            timeZone: job.timezone || this.defaultTimezone,
          });
          const triggerNote = manual ? " *[Manual Run]*" : "";
          const title = `⏰ **[Scheduled Task]** **${job.name || job.id}** (🧠 Agent)${triggerNote}\n📅 *${timeStr}* | ⏱️ *${(durationMs / 1000).toFixed(2)}s*\n\n`;
          await this.discordSender(title, fullResponse);
        } catch (err: any) {
          console.error("❌ [Cron Discord] Error sending agent output:", err.message);
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
        isManual: manual,
      });

      const safeErrDisplay = err.message && err.message.length > 2500 ? err.message.slice(0, 2450) + "\n...[truncated]" : (err.message || "Unknown error");

      if (this.bot && job.chatId) {
        const errorMsg = `⚠️ <b>[Scheduled Task Error]</b> <b>${escapeHtml(job.name || job.id)}</b> (🤖 Agent)\n⏱️ <i>Duration: ${(durationMs / 1000).toFixed(2)}s</i>\n\n<pre>${escapeHtml(safeErrDisplay)}</pre>`;
        await this.bot.api.sendMessage(job.chatId, errorMsg, { parse_mode: "HTML" }).catch(() => {});
      }

      if (this.discordSender) {
        try {
          const title = `⚠️ **[Scheduled Task Error]** **${job.name || job.id}** (🧠 Agent)\n⏱️ *Duration: ${(durationMs / 1000).toFixed(2)}s*\n\n`;
          await this.discordSender(title, `\`\`\`text\n${safeErrDisplay.slice(0, 1800)}\n\`\`\``);
        } catch (dErr: any) {
          console.error("❌ [Cron Discord] Error broadcasting agent error:", dErr.message);
        }
      }

      throw err;
    } finally {
      this.activeAgentSessions.delete(job.id);
      this.runningJobs.delete(job.id);
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
