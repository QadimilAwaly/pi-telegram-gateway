import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import { CronScheduler, isValidCronExpression } from "../src/cron-scheduler";
import { config } from "../src/config";

describe("Cron Validation & Expression Parser", () => {
  test("validates 5-token standard cron expressions", () => {
    expect(isValidCronExpression("0 8 * * *")).toBe(true);
    expect(isValidCronExpression("*/15 * * * *")).toBe(true);
    expect(isValidCronExpression("0 9 * * 1-5")).toBe(true);
    expect(isValidCronExpression("30 4 1,15 * *")).toBe(true);
  });

  test("validates 6-token cron expressions with seconds", () => {
    expect(isValidCronExpression("0 0 8 * * *")).toBe(true);
    expect(isValidCronExpression("30 15 10 * * *")).toBe(true);
  });

  test("validates cron nicknames", () => {
    expect(isValidCronExpression("@daily")).toBe(true);
    expect(isValidCronExpression("@hourly")).toBe(true);
    expect(isValidCronExpression("@weekly")).toBe(true);
    expect(isValidCronExpression("@monthly")).toBe(true);
    expect(isValidCronExpression("@yearly")).toBe(true);
  });

  test("rejects invalid expressions", () => {
    expect(isValidCronExpression("")).toBe(false);
    expect(isValidCronExpression("0")).toBe(false);
    expect(isValidCronExpression("not a cron")).toBe(false);
    expect(isValidCronExpression("99 99 * * *")).toBe(false);
  });
});

describe("Cron Scheduler Engine", () => {
  let scheduler: CronScheduler;
  let testSessionsDir: string;

  beforeEach(() => {
    testSessionsDir = path.join(os.tmpdir(), `test_pi_cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(testSessionsDir, { recursive: true });
    // Point config.sessionsDir to test dir
    config.sessionsDir = testSessionsDir;

    scheduler = new CronScheduler();
    scheduler.init(null);
  });

  afterEach(() => {
    scheduler.destroy();
    try {
      fs.rmSync(testSessionsDir, { recursive: true, force: true });
    } catch {}
  });

  test("addJob adds a job and prevents duplicates", () => {
    const res1 = scheduler.addJob({
      id: "my_task",
      cronExpression: "0 8 * * *",
      prompt: "echo 'hello'",
      chatId: 12345,
      noAgent: true,
    });
    expect(res1.ok).toBe(true);
    expect(res1.job?.id).toBe("my_task");

    // Case-insensitive duplicate check
    const resDuplicate = scheduler.addJob({
      id: "MY_TASK",
      cronExpression: "0 9 * * *",
      prompt: "echo 'world'",
      chatId: 12345,
      noAgent: true,
    });
    expect(resDuplicate.ok).toBe(false);
    expect(resDuplicate.error).toContain("already exists");
  });

  test("case-insensitive lookups and mutations", () => {
    scheduler.addJob({
      id: "daily_briefing",
      cronExpression: "0 8 * * *",
      prompt: "echo 'briefing'",
      chatId: 12345,
      noAgent: true,
    });

    // Lookup with mixed case
    const job = scheduler.getJob("Daily_Briefing");
    expect(job).toBeDefined();
    expect(job?.id).toBe("daily_briefing");

    // Pause with mixed case
    const pauseOk = scheduler.pauseJob("DAILY_BRIEFING");
    expect(pauseOk).toBe(true);
    expect(scheduler.getJob("daily_briefing")?.enabled).toBe(false);

    // Resume with mixed case
    const resumeOk = scheduler.resumeJob("Daily_Briefing");
    expect(resumeOk).toBe(true);
    expect(scheduler.getJob("daily_briefing")?.enabled).toBe(true);

    // Remove with mixed case
    const removeOk = scheduler.removeJob("DAILY_briefing");
    expect(removeOk).toBe(true);
    expect(scheduler.getJob("daily_briefing")).toBeUndefined();
  });

  test("editJob updates cron expression containing hyphens without corruption", () => {
    scheduler.addJob({
      id: "work_report",
      cronExpression: "0 9 * * *",
      prompt: "generate report",
      chatId: 12345,
    });

    const editRes = scheduler.editJob("work_report", {
      cronExpression: "0 9 * * 1-5", // Range with hyphen
      name: "Updated Work Report",
    });

    expect(editRes.ok).toBe(true);
    expect(editRes.job?.cronExpression).toBe("0 9 * * 1-5");
    expect(editRes.job?.name).toBe("Updated Work Report");
    expect(editRes.changes?.length).toBeGreaterThan(0);
  });

  test("executeJob in script mode executes bash command and preserves quotes", async () => {
    scheduler.addJob({
      id: "test_script_quotes",
      cronExpression: "* * * * *",
      prompt: 'echo "hello \\"world\\""',
      chatId: 12345,
      noAgent: true,
    });

    const output = await scheduler.executeJob("test_script_quotes", true);
    expect(output).toContain('hello "world"');

    const logs = scheduler.getLogs("test_script_quotes", 1);
    expect(logs.length).toBe(1);
    expect(logs[0]?.logs[0]?.status).toBe("success");
    expect(logs[0]?.logs[0]?.isManual).toBe(true);
  });

  test("executeJob in script mode handles script failure and records error", async () => {
    scheduler.addJob({
      id: "test_failing_script",
      cronExpression: "* * * * *",
      prompt: "exit 42",
      chatId: 12345,
      noAgent: true,
    });

    let threw = false;
    try {
      await scheduler.executeJob("test_failing_script", false);
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain("42");
    }
    expect(threw).toBe(true);

    const logs = scheduler.getLogs("test_failing_script", 1);
    expect(logs.length).toBe(1);
    expect(logs[0]?.logs[0]?.status).toBe("error");
    expect(logs[0]?.logs[0]?.error).toContain("42");
    expect(logs[0]?.logs[0]?.isManual).toBe(false);
  });

  test("atomic persistence and backup file creation", () => {
    scheduler.addJob({
      id: "persist_job",
      cronExpression: "0 8 * * *",
      prompt: "test persistence",
      chatId: 12345,
    });

    const storageFile = path.join(testSessionsDir, "cron-jobs.json");
    const backupFile = path.join(testSessionsDir, "cron-jobs.json.bak");

    expect(fs.existsSync(storageFile)).toBe(true);
    expect(fs.existsSync(backupFile)).toBe(true);

    const content = JSON.parse(fs.readFileSync(storageFile, "utf-8"));
    expect(content.some((j: any) => j.id === "persist_job")).toBe(true);
  });

  test("listJobs is pure in-memory read without stopping instances", () => {
    scheduler.addJob({
      id: "timer_job",
      cronExpression: "0 8 * * *",
      prompt: "echo timer",
      chatId: 12345,
    });

    const jobs1 = scheduler.listJobs();
    expect(jobs1.length).toBe(1);
    expect(jobs1[0]?.nextRun).toBeDefined();

    // Calling listJobs multiple times shouldn't disrupt nextRun
    const jobs2 = scheduler.listJobs();
    expect(jobs2[0]?.nextRun).toBe(jobs1[0]?.nextRun);
  });
});
