import fs from "fs";
import path from "path";
import { config } from "./config";

const lockFile = path.join(config.sessionsDir, "gateway.lock");

export class SingleInstanceGuard {
  /**
   * Acquire a lock. If another instance is running, returns false.
   */
  static acquire(): { acquired: boolean; existingPid?: number } {
    try {
      if (!fs.existsSync(config.sessionsDir)) {
        fs.mkdirSync(config.sessionsDir, { recursive: true });
      }

      if (fs.existsSync(lockFile)) {
        try {
          const content = fs.readFileSync(lockFile, "utf-8").trim();
          const existingPid = parseInt(content, 10);

          if (!isNaN(existingPid) && existingPid > 0) {
            // Check if process is still alive
            try {
              process.kill(existingPid, 0);
              // Process is ALIVE and not ourselves
              if (existingPid !== process.pid) {
                return { acquired: false, existingPid };
              }
            } catch {
              // Process is DEAD -> stale lockfile, safe to overwrite
              console.log(`🧹 Cleaning up stale lockfile from dead PID ${existingPid}`);
            }
          }
        } catch {
          // If unreadable, overwrite
        }
      }

      // Write current PID to lockfile
      fs.writeFileSync(lockFile, String(process.pid), "utf-8");

      // Auto-cleanup lock on normal exit
      process.on("exit", () => {
        SingleInstanceGuard.release();
      });

      return { acquired: true };
    } catch (err: any) {
      console.warn("Could not manage lockfile:", err.message);
      return { acquired: true };
    }
  }

  /**
   * Release the lockfile if it belongs to this process.
   */
  static release() {
    try {
      if (fs.existsSync(lockFile)) {
        const content = fs.readFileSync(lockFile, "utf-8").trim();
        if (content === String(process.pid)) {
          fs.unlinkSync(lockFile);
        }
      }
    } catch {
      // Ignore
    }
  }
}
