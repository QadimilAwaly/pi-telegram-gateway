import fs from "fs";
import path from "path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config";

const execFileAsync = promisify(execFile);
const MNEMOSYNE_DATA_DIR = process.env.MNEMOSYNE_DATA_DIR || "/storage/emulated/0/backup/shared_memory";

export interface ArchivedSessionMeta {
  archiveId: string;
  originalFileName: string;
  archivedAt: number;
  originalSize: number;
  compressedSize: number;
  messageCount: number;
  summary?: string;
  exportedMarkdownFile?: string;
}

export interface StorageStats {
  activeSessionCount: number;
  activeBytes: number;
  archivedSessionCount: number;
  archivedOriginalBytes: number;
  archivedCompressedBytes: number;
  totalSavingsPercentage: number;
}

export class SessionArchiver {
  private getChatDir(chatId: number): string {
    return path.join(config.sessionsDir, `chat_${chatId}`);
  }

  private getArchiveDir(chatId: number): string {
    const dir = path.join(this.getChatDir(chatId), ".archive");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private getIndexFile(chatId: number): string {
    return path.join(this.getArchiveDir(chatId), "index.json");
  }

  private loadIndex(chatId: number): ArchivedSessionMeta[] {
    const idxFile = this.getIndexFile(chatId);
    if (!fs.existsSync(idxFile)) return [];
    try {
      const raw = fs.readFileSync(idxFile, "utf-8");
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  private saveIndex(chatId: number, list: ArchivedSessionMeta[]) {
    const idxFile = this.getIndexFile(chatId);
    fs.writeFileSync(idxFile, JSON.stringify(list, null, 2), "utf-8");
  }

  /**
   * Parse a JSONL session file to extract basic transcript and message count
   */
  parseSessionFile(filePath: string): { messages: Array<{ role: string; text: string; timestamp?: string }>; count: number } {
    if (!fs.existsSync(filePath)) return { messages: [], count: 0 };
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const messages: Array<{ role: string; text: string; timestamp?: string }> = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" || entry.role) {
          const role = entry.role || entry.message?.role || "unknown";
          let text = "";
          if (typeof entry.content === "string") {
            text = entry.content;
          } else if (Array.isArray(entry.content)) {
            text = entry.content
              .filter((c: any) => c.type === "text" && c.text)
              .map((c: any) => c.text)
              .join("\n");
          } else if (entry.message?.content) {
            const mc = entry.message.content;
            if (typeof mc === "string") text = mc;
            else if (Array.isArray(mc)) {
              text = mc.filter((c: any) => c.type === "text" && c.text).map((c: any) => c.text).join("\n");
            }
          }
          if (text.trim() && (role === "user" || role === "assistant")) {
            messages.push({ role, text: text.trim(), timestamp: entry.timestamp });
          }
        }
      } catch {}
    }

    return { messages, count: messages.length };
  }

  /**
   * Convert a session JSONL file into a clean human-readable Markdown transcript
   */
  exportToMarkdown(filePath: string): { markdown: string; summary: string } {
    const { messages } = this.parseSessionFile(filePath);
    const fileName = path.basename(filePath, path.extname(filePath));
    const title = `Session Transcript — ${fileName}`;
    let md = `# ${title}\n\n*Exported on ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Makassar" })}*\n\n---\n\n`;

    let userQuestions: string[] = [];

    for (const msg of messages) {
      const header = msg.role === "user" ? "### 👤 User" : "### 🤖 Assistant (Pi)";
      md += `${header}\n\n${msg.text}\n\n---\n\n`;
      if (msg.role === "user" && msg.text.length < 100) {
        userQuestions.push(msg.text);
      }
    }

    const summary = userQuestions.length > 0
      ? `Discussed: ${userQuestions.slice(0, 3).join(" | ")}`
      : `Session with ${messages.length} messages`;

    return { markdown: md, summary };
  }

  /**
   * Store extracted session highlights to Mnemosyne shared memory
   */
  async recordToMnemosyne(summary: string, details: string) {
    if (!summary || !summary.trim()) return;
    const pyScript = `
import sys
from mnemosyne import remember
content = sys.argv[1]
try:
    remember(content, source="pi-session-archive", importance=0.7)
    print("OK")
except Exception as e:
    print(f"ERROR: {e}")
`;
    try {
      const fullMemory = `[Archived Session Highlight] ${summary}\n${details.slice(0, 300)}`;
      await execFileAsync("python3", ["-c", pyScript, fullMemory], {
        env: { ...process.env, MNEMOSYNE_DATA_DIR },
      });
    } catch (err) {
      console.error("Failed to record session highlight to Mnemosyne:", err);
    }
  }

  /**
   * Archive inactive session files (Gzip compression + Mnemosyne distillation)
   */
  async archiveInactiveSessions(
    chatId: number,
    options: {
      keepLatest?: number;
      exportMarkdown?: boolean;
      activeSessionFile?: string;
    } = {}
  ): Promise<{ archivedCount: number; savedBytes: number; reports: string[] }> {
    const chatDir = this.getChatDir(chatId);
    const archiveDir = this.getArchiveDir(chatId);
    if (!fs.existsSync(chatDir)) {
      return { archivedCount: 0, savedBytes: 0, reports: [] };
    }

    // List all .json and .jsonl files in chat directory
    const files = fs
      .readdirSync(chatDir)
      .filter((f) => (f.endsWith(".json") || f.endsWith(".jsonl")) && !f.startsWith("."))
      .map((f) => {
        const full = path.join(chatDir, f);
        const stat = fs.statSync(full);
        return { name: f, full, mtime: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first

    const keepLatest = options.keepLatest ?? 1;
    const activeFileBase = options.activeSessionFile ? path.basename(options.activeSessionFile) : null;

    const candidates = files.filter((f, idx) => {
      // Never archive the currently active session file
      if (activeFileBase && f.name === activeFileBase) return false;
      // Keep the newest N sessions
      return idx >= keepLatest;
    });

    if (candidates.length === 0) {
      return { archivedCount: 0, savedBytes: 0, reports: [] };
    }

    const index = this.loadIndex(chatId);
    let totalSaved = 0;
    const reports: string[] = [];

    for (const item of candidates) {
      try {
        const rawBuffer = fs.readFileSync(item.full);
        const originalSize = rawBuffer.length;
        if (originalSize === 0) {
          fs.unlinkSync(item.full);
          continue;
        }

        // 1. Export transcript & distillation
        const { markdown, summary } = this.exportToMarkdown(item.full);
        const { count } = this.parseSessionFile(item.full);

        let exportedMdFile: string | undefined;
        if (options.exportMarkdown) {
          exportedMdFile = path.join(archiveDir, `${item.name}.md`);
          fs.writeFileSync(exportedMdFile, markdown, "utf-8");
        }

        // 2. Compress via Gzip
        const compressed = zlib.gzipSync(rawBuffer, { level: 9 });
        const compressedSize = compressed.length;
        const archiveFileName = `${item.name}.gz`;
        const archiveFullPath = path.join(archiveDir, archiveFileName);

        fs.writeFileSync(archiveFullPath, compressed);

        // 3. Remove original uncompressed file from active dir
        fs.unlinkSync(item.full);

        // 4. Record to Mnemosyne shared memory
        await this.recordToMnemosyne(summary, `Session had ${count} messages, saved to ${archiveFileName}`);

        const saved = originalSize - compressedSize;
        totalSaved += saved;

        const archiveId = `arc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const meta: ArchivedSessionMeta = {
          archiveId,
          originalFileName: item.name,
          archivedAt: Date.now(),
          originalSize,
          compressedSize,
          messageCount: count,
          summary,
          exportedMarkdownFile: exportedMdFile,
        };

        index.unshift(meta);
        const ratio = ((1 - compressedSize / originalSize) * 100).toFixed(1);
        reports.push(`📦 <code>${item.name}</code>: ${(originalSize / 1024).toFixed(1)}KB ➔ ${(compressedSize / 1024).toFixed(1)}KB (Hemat ${ratio}%)`);
      } catch (err: any) {
        console.error(`Error archiving session ${item.name}:`, err);
      }
    }

    this.saveIndex(chatId, index);
    return { archivedCount: reports.length, savedBytes: totalSaved, reports };
  }

  /**
   * Restore an archived session back into the active directory
   */
  restoreSession(chatId: number, archiveId: string): { ok: boolean; restoredFile?: string; error?: string } {
    const index = this.loadIndex(chatId);
    const metaIdx = index.findIndex((m) => m.archiveId === archiveId || m.originalFileName.includes(archiveId));
    if (metaIdx === -1) {
      return { ok: false, error: `Archive "${archiveId}" not found in index.` };
    }

    const meta = index[metaIdx];
    if (!meta) {
      return { ok: false, error: `Archive metadata not found.` };
    }
    const archiveDir = this.getArchiveDir(chatId);
    const chatDir = this.getChatDir(chatId);
    const archiveFilePath = path.join(archiveDir, `${meta.originalFileName}.gz`);

    if (!fs.existsSync(archiveFilePath)) {
      return { ok: false, error: `Archive file ${meta.originalFileName}.gz does not exist on disk.` };
    }

    try {
      const compressedBuffer = fs.readFileSync(archiveFilePath);
      const decompressed = zlib.gunzipSync(compressedBuffer);
      const restoredPath = path.join(chatDir, meta.originalFileName);

      fs.writeFileSync(restoredPath, decompressed);
      fs.unlinkSync(archiveFilePath);

      index.splice(metaIdx, 1);
      this.saveIndex(chatId, index);

      return { ok: true, restoredFile: meta.originalFileName };
    } catch (err: any) {
      return { ok: false, error: `Decompression failed: ${err.message}` };
    }
  }

  /**
   * Get comprehensive storage statistics
   */
  getStorageStats(chatId: number): StorageStats {
    const chatDir = this.getChatDir(chatId);
    const archiveDir = this.getArchiveDir(chatId);

    let activeCount = 0;
    let activeBytes = 0;

    if (fs.existsSync(chatDir)) {
      const files = fs.readdirSync(chatDir).filter((f) => !f.startsWith("."));
      for (const f of files) {
        const stat = fs.statSync(path.join(chatDir, f));
        if (stat.isFile()) {
          activeCount++;
          activeBytes += stat.size;
        }
      }
    }

    const index = this.loadIndex(chatId);
    let archOrig = 0;
    let archComp = 0;

    for (const item of index) {
      archOrig += item.originalSize;
      archComp += item.compressedSize;
    }

    const totalSavings = archOrig > 0 ? ((1 - archComp / archOrig) * 100) : 0;

    return {
      activeSessionCount: activeCount,
      activeBytes,
      archivedSessionCount: index.length,
      archivedOriginalBytes: archOrig,
      archivedCompressedBytes: archComp,
      totalSavingsPercentage: Math.max(0, totalSavings),
    };
  }

  /**
   * List all archived sessions
   */
  listArchived(chatId: number): ArchivedSessionMeta[] {
    return this.loadIndex(chatId);
  }

  /**
   * Automatically prune old images from ~/.pi/telegram-sessions/images/
   * Keeps images from the last `maxAgeDays` or up to `maxCount` latest files.
   */
  cleanOldImages(maxAgeDays: number = 7, maxCount: number = 40): { removedCount: number; freedBytes: number } {
    const imgDir = path.join(config.sessionsDir, "images");
    if (!fs.existsSync(imgDir)) return { removedCount: 0, freedBytes: 0 };

    try {
      const files = fs.readdirSync(imgDir).filter((f) => !f.startsWith("."));
      const fileStats = files
        .map((f) => {
          const fullPath = path.join(imgDir, f);
          try {
            const stat = fs.statSync(fullPath);
            return { name: f, fullPath, mtime: stat.mtimeMs, size: stat.size };
          } catch {
            return null;
          }
        })
        .filter((item): item is { name: string; fullPath: string; mtime: number; size: number } => item !== null)
        .sort((a, b) => b.mtime - a.mtime); // newest first

      let removedCount = 0;
      let freedBytes = 0;
      const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
      const now = Date.now();

      fileStats.forEach((item, index) => {
        const isTooOld = now - item.mtime > maxAgeMs;
        const isExcess = index >= maxCount;

        if (isTooOld || isExcess) {
          try {
            fs.unlinkSync(item.fullPath);
            removedCount++;
            freedBytes += item.size;
          } catch {}
        }
      });

      return { removedCount, freedBytes };
    } catch (err: any) {
      console.error("Error during image cleanup:", err.message);
      return { removedCount: 0, freedBytes: 0 };
    }
  }

  /**
   * Prune temporary cron session directories (~/.pi/telegram-sessions/cron_<id>/)
   * Keeps only the latest `maxKeep` runs per cron job to prevent disk bloat.
   */
  pruneCronSessions(maxKeep: number = 2): { cleanedDirs: number; removedFiles: number; freedBytes: number } {
    if (!fs.existsSync(config.sessionsDir)) return { cleanedDirs: 0, removedFiles: 0, freedBytes: 0 };

    try {
      const dirs = fs.readdirSync(config.sessionsDir).filter((d) => d.startsWith("cron_"));
      let cleanedDirs = 0;
      let removedFiles = 0;
      let freedBytes = 0;

      for (const d of dirs) {
        const fullDir = path.join(config.sessionsDir, d);
        try {
          const stat = fs.statSync(fullDir);
          if (!stat.isDirectory()) continue;

          const sessionFiles = fs
            .readdirSync(fullDir)
            .filter((f) => (f.endsWith(".json") || f.endsWith(".jsonl")) && !f.startsWith("."))
            .map((f) => {
              const fPath = path.join(fullDir, f);
              const fStat = fs.statSync(fPath);
              return { fPath, mtime: fStat.mtimeMs, size: fStat.size };
            })
            .sort((a, b) => b.mtime - a.mtime);

          if (sessionFiles.length > maxKeep) {
            cleanedDirs++;
            const toDelete = sessionFiles.slice(maxKeep);
            for (const item of toDelete) {
              try {
                fs.unlinkSync(item.fPath);
                removedFiles++;
                freedBytes += item.size;
              } catch {}
            }
          }
        } catch {}
      }

      return { cleanedDirs, removedFiles, freedBytes };
    } catch (err: any) {
      console.error("Error during cron sessions pruning:", err.message);
      return { cleanedDirs: 0, removedFiles: 0, freedBytes: 0 };
    }
  }
}

export const sessionArchiver = new SessionArchiver();
