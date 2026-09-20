import { describe, it, expect, afterAll } from "bun:test";
import { SessionPool } from "../src/session-pool";

describe("SessionPool Thinking Level Methods", () => {
  const pool = new SessionPool();
  const testChatId = 88888888;

  afterAll(() => {
    pool.destroy();
  });

  it("initializes and inspects thinking info", async () => {
    await pool.init();
    const entry = await pool.getSession(testChatId);
    expect(entry).toBeDefined();

    const info = await pool.getThinkingInfo(testChatId);
    expect(info).toHaveProperty("current");
    expect(info).toHaveProperty("available");
    expect(Array.isArray(info.available)).toBe(true);
  }, { timeout: 30000 });

  it("sets and cycles thinking level", async () => {
    const setResult = await pool.setThinkingLevel(testChatId, "high");
    expect(setResult.level).toBe("high");

    const cycleResult = await pool.cycleThinkingLevel(testChatId);
    expect(cycleResult).toHaveProperty("level");
    expect(cycleResult).toHaveProperty("previous");
  }, { timeout: 20000 });
});
