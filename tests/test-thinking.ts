import { SessionPool } from "../src/session-pool";
import { config } from "../src/config";

async function testThinking() {
  console.log("=== Testing Thinking Level Methods in SessionPool ===");
  const pool = new SessionPool();
  await pool.init();

  const testChatId = 88888888;
  const entry = await pool.getSession(testChatId);
  console.log("Active model:", entry.session.model?.id);
  console.log("Initial thinkingLevel:", entry.session.thinkingLevel);

  // Test getThinkingInfo
  const info = await pool.getThinkingInfo(testChatId);
  console.log("getThinkingInfo:", info);

  // Test setThinkingLevel
  const setResult = await pool.setThinkingLevel(testChatId, "high");
  console.log("setThinkingLevel('high'):", setResult);
  if (info.supportsThinking) {
    if (setResult.level !== "high") {
      throw new Error(`Expected level high, got ${setResult.level}`);
    }
  }

  // Test cycleThinkingLevel
  const cycleResult = await pool.cycleThinkingLevel(testChatId);
  console.log("cycleThinkingLevel():", cycleResult);

  // Test setModel with :thinking suffix
  const modelWithSuffix = await pool.setModel(testChatId, "antigravity/gemini-3.7-flash:medium");
  console.log("setModel with suffix:", modelWithSuffix?.model.id, "Thinking:", modelWithSuffix?.thinkingLevel);

  // Clean up
  pool.destroy();
  console.log("✅ All SessionPool thinking level tests passed!");
}

testThinking().catch(err => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
