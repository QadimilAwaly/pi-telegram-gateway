import { getActiveTunnelInfo, startTunnel, stopTunnel, type TunnelInfo } from "./tunnel-manager";
import path from "path";
import fs from "fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Bot, Context, InlineKeyboard } from "grammy";
import { run, type RunnerHandle } from "@grammyjs/runner";

const execFileAsync = promisify(execFile);
import { config } from "./config";
import { sessionPool } from "./session-pool";
import { cronScheduler, isValidCronExpression } from "./cron-scheduler";
import { healthMonitor } from "./health-monitor";
import { sessionArchiver } from "./session-archiver";
import { SingleInstanceGuard } from "./single-instance-lock";
import { discordClient } from "./discord-bot";
import {
  splitMessage,
  formatToolStatus,
  markdownToTelegramHtml,
  escapeHtml,
} from "./telegram-utils";

import { gatewayLogger } from "./logger";
gatewayLogger.init();

if (!config.botToken) {
  console.error("❌ ERROR: TELEGRAM_BOT_TOKEN is not defined in environment or .env!");
  console.error("Please create a .env file with your Telegram Bot Token.");
  process.exit(1);
}

const bot = new Bot(config.botToken, {
  client: {
    timeoutSeconds: 55,
  },
});

// Network Outage & Recovery Monitor for Telegram Long-Polling
let isNetworkDown = false;
let networkDownSince = 0;
let failedPollAttempts = 0;

bot.api.config.use(async (prev, method, payload, signal) => {
  try {
    const res = await prev(method, payload, signal);
    if (method === "getUpdates" && isNetworkDown) {
      const downtimeSec = Math.round((Date.now() - networkDownSince) / 1000);
      console.log(
        `🌐 [Network Restored] Telegram connection recovered after ${downtimeSec}s (${failedPollAttempts} retries). Long-polling resumed.`
      );
      isNetworkDown = false;
      failedPollAttempts = 0;
    }
    return res;
  } catch (err: any) {
    if (method === "getUpdates") {
      failedPollAttempts++;
      if (!isNetworkDown) {
        isNetworkDown = true;
        networkDownSince = Date.now();
        console.warn(
          `⚠️ [Network Outage] Telegram getUpdates unreachable (${err.message || "Network request failed"}). Gateway entering quiet auto-retry mode...`
        );
      }
    }
    throw err;
  }
});

// Middleware: Access Control Whitelist
bot.use(async (ctx, next) => {
  const updateType = Object.keys(ctx.update).filter((k) => k !== "update_id").join(",");
  console.log(`📩 [Raw Update]: #${ctx.update.update_id} (${updateType}) from ${ctx.from?.id} (@${ctx.from?.username || "no_user"})`);

  const userId = ctx.from?.id;
  if (!userId) return;

  if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(userId)) {
    await ctx.reply(
      `⛔ <b>Access Denied</b>\nYour Telegram User ID is <code>${userId}</code>.\nTo grant access, add this ID to <code>ALLOWED_USERS</code> in your gateway <code>.env</code> file.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  await next();
});

// Command: /start
bot.command("start", async (ctx) => {
  const welcome = [
    "🤖 <b>Welcome to Pi Coding Agent on Telegram!</b>",
    "",
    "Pi is a minimalist, tool-augmented coding assistant running directly on your host/device.",
    "",
    "<b>Commands:</b>",
    "• <code>/help</code> — Show command guide",
    "• <code>/new</code> or <code>/reset</code> — Start a fresh conversation session",
    "• <code>/resume</code> — Switch or restore a previous session",
    "• <code>/status</code> — View current model and session info",
    "• <code>/model [name]</code> — View or switch model",
    "• <code>/thinking [level]</code> — View or switch reasoning level (off, low, medium, high, max)",
    "• <code>/steer &lt;text&gt;</code> — Steer/redirect active agent execution",
    "• <code>/cron</code> — Manage scheduled cron tasks",
    "• <code>/logs</code> — View recent gateway logs and errors live",
    "• <code>/archive</code> — Manage session archives & Mnemosyne consolidation",
    "• <code>/compact</code> — Compact conversation context",
    "• <code>/restart</code> — Restart the gateway process remotely",
    "• <code>/abort</code> — Stop the active prompt execution",
    "",
    "Just send any message or coding task to get started!",
  ].join("\n");

  await ctx.reply(welcome, { parse_mode: "HTML" });
});

// Command: /help
bot.command("help", async (ctx) => {
  const helpText = [
    "📖 <b>Pi Telegram Gateway Commands & Features</b>",
    "",
    "• <b>Chatting:</b> Simply type your prompt. Pi executes bash commands, edits files, and uses installed skills.",
    "• <b>Follow-up Queueing:</b> If you send a message while Pi is busy, it is automatically queued as a follow-up task!",
    "• <code>/steer &lt;instruction&gt;</code> — Redirect or modify the active agent's plan mid-flight.",
    "• <code>/new</code> or <code>/reset</code> — Clear current session and start fresh.",
    "• <code>/resume</code> or <code>/sessions</code> — Browse and switch back to previous sessions.",
    "• <code>/status</code> — Check current session ID, model, and message count.",
    "• <code>/model</code> — Show active model and available alternatives.",
    "• <code>/model &lt;provider/name&gt;</code> — Switch active model for this chat (supports :thinking suffix).",
    "• <code>/thinking</code> — Show current thinking level and available options.",
    "• <code>/thinking &lt;level&gt;</code> — Set reasoning effort (off, low, medium, high, max) or /thinking next.",
    "• <code>/cron</code> — Manage scheduled background jobs and recurring tasks.",
    "• <code>/logs</code> — View live gateway execution logs, tool calls, and errors.",
    "• <code>/archive</code> — View storage stats, compress old sessions (.gz), and export transcripts.",
    "• <code>/compact</code> — Summarize and compact conversation history.",
    "• <code>/restart</code> — Reboot and re-initialize the gateway daemon.",
    "• <code>/abort</code> — Abort the currently running operation.",
  ].join("\n");

  await ctx.reply(helpText, { parse_mode: "HTML" });
});

// Command: /new or /reset
const handleReset = async (ctx: Context) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  await ctx.replyWithChatAction("typing");
  try {
    const session = await sessionPool.resetSession(chatId);
    await ctx.reply(
      `✨ <b>Session Reset!</b> Started a new session:\n<code>${escapeHtml(session.sessionId)}</code>`,
      { parse_mode: "HTML" }
    );
  } catch (err: any) {
    await ctx.reply(`⚠️ Failed to reset session: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
  }
};
bot.command("new", handleReset);
bot.command("reset", handleReset);

// Command: /resume & /sessions
const handleResume = async (ctx: Context) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || "";
  const rawArg = text.replace(/^\/(?:resume|sessions|session)\s*/i, "").trim();

  // If specific session identifier or index provided (e.g. /resume 2 or /resume 01a069ea)
  if (rawArg) {
    await ctx.replyWithChatAction("typing");
    try {
      const res = await sessionPool.resumeSession(chatId, rawArg);
      if (res.alreadyActive) {
        await ctx.reply(
          `ℹ️ Session <code>${escapeHtml(res.session.sessionId)}</code> is already the active session.\n• <b>Messages:</b> ${res.messageCount}\n• <b>Topic:</b> <i>${escapeHtml(res.summary)}</i>`,
          { parse_mode: "HTML" }
        );
        return;
      }
      const reply = [
        `🔄 <b>Session Resumed!</b>`,
        `• <b>Session ID:</b> <code>${escapeHtml(res.session.sessionId)}</code>`,
        `• <b>Restored:</b> <code>${res.messageCount}</code> messages`,
        `• <b>Topic:</b> <i>${escapeHtml(res.summary)}</i>`,
        "",
        "You can now continue this conversation seamlessly!",
      ].join("\n");
      await ctx.reply(reply, { parse_mode: "HTML" });
    } catch (err: any) {
      await ctx.reply(`⚠️ Failed to resume session: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
    }
    return;
  }

  // Interactive picker without argument
  await ctx.replyWithChatAction("typing");
  try {
    const sessions = await sessionPool.listSessions(chatId);
    if (sessions.length === 0) {
      await ctx.reply("ℹ️ No previous sessions found for this chat. Start chatting or use <code>/new</code>.", {
        parse_mode: "HTML",
      });
      return;
    }

    let msg = "🔄 <b>Session Switcher & History</b>\n\n";
    const keyboard = new InlineKeyboard();

    const maxDisplay = Math.min(sessions.length, 6);
    for (let i = 0; i < maxDisplay; i++) {
      const s = sessions[i];
      if (!s) continue;
      const num = i + 1;
      const statusBadge = s.isActive
        ? "🟢 <b>[Active]</b>"
        : s.isArchived
        ? "📦 <i>[Archived]</i>"
        : "⚪ <i>[Idle]</i>";

      const dateStr = new Date(s.mtime).toLocaleDateString("id-ID", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Makassar",
      });

      msg += `${num}. ${statusBadge} <code>${escapeHtml(s.shortId)}</code> (${dateStr})\n`;
      msg += `   ↳ <i>${escapeHtml(s.summary)}</i>\n`;
      msg += `   ↳ <code>${s.messageCount} msgs</code> • <code>${(s.size / 1024).toFixed(1)} KB</code>\n\n`;

      if (!s.isActive) {
        keyboard.text(`▶️ Resume #${num} (${s.shortId})`, `resume:${s.id}`).row();
      }
    }

    if (sessions.length > maxDisplay) {
      msg += `<i>...and ${sessions.length - maxDisplay} older sessions in storage</i>\n\n`;
    }

    msg += "<b>Usage:</b>\n";
    msg += "• Tap a button below to switch, OR\n";
    msg += "• Type <code>/resume &lt;number|id&gt;</code> (e.g. <code>/resume 2</code>)";

    await ctx.reply(msg, {
      parse_mode: "HTML",
      reply_markup: keyboard.inline_keyboard.length > 0 ? keyboard : undefined,
    });
  } catch (err: any) {
    await ctx.reply(`⚠️ Failed to list sessions: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
  }
};

bot.command(["resume", "sessions", "session"], handleResume);

// Callback Query Handler for Inline Resume Buttons: resume:<sessionId>
bot.callbackQuery(/^resume:(.+)$/, async (ctx) => {
  const chatId = ctx.chat?.id;
  const targetId = ctx.match ? ctx.match[1] : undefined;
  if (!chatId || !targetId) return;

  await ctx.answerCallbackQuery({ text: "Switching session..." });

  try {
    const res = await sessionPool.resumeSession(chatId, targetId);
    if (res.alreadyActive) {
      await ctx.reply(`ℹ️ Session <code>${escapeHtml(res.session.sessionId)}</code> is already the active session.`, {
        parse_mode: "HTML",
      });
      return;
    }

    const reply = [
      `🔄 <b>Session Resumed!</b>`,
      `• <b>Session ID:</b> <code>${escapeHtml(res.session.sessionId)}</code>`,
      `• <b>Restored:</b> <code>${res.messageCount}</code> messages`,
      `• <b>Topic:</b> <i>${escapeHtml(res.summary)}</i>`,
      "",
      "You can now continue this conversation seamlessly!",
    ].join("\n");
    await ctx.reply(reply, { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`⚠️ Failed to resume session: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
  }
});

// Command: /restart (Remote Gateway Reboot)
bot.command("restart", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  await ctx.reply(
    "🔄 <b>Restarting Pi Telegram Gateway...</b>\nRe-initializing extensions, skills, and model sessions. Back online in ~2 seconds!",
    { parse_mode: "HTML" }
  );

  console.log(`🔄 Remote /restart requested via Telegram by user ${ctx.from?.id}`);

  // Clean shutdown & trigger runner restart
  setTimeout(async () => {
    try {
      healthMonitor.destroy();
      cronScheduler.destroy();
      sessionPool.destroy();
      await bot.stop();
    } catch {}

    const isUnderRunner = process.env.RUNNER_ACTIVE === "1";
    if (!isUnderRunner) {
      try {
        Bun.spawn(["bash", "-c", "nohup ./scripts/run.sh > /dev/null 2>&1 &"], {
          cwd: path.resolve(__dirname, ".."),
        });
      } catch {}
    }

    process.exit(42);
  }, 500);
});

// Helper: Fetch Termux Battery Status
async function getDeviceBatteryStatus(): Promise<string | null> {
  try {
    const termuxPrefix = process.env.PREFIX || (fs.existsSync("/data/data/com.termux/files/usr") ? "/data/data/com.termux/files/usr" : "/usr");
    const binPath = path.join(termuxPrefix, "bin", "termux-battery-status");
    const binDir = path.join(termuxPrefix, "bin");
    const { stdout } = await execFileAsync(binPath, [], {
      timeout: 2000,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH || ""}` },
    });
    const data = JSON.parse(stdout);
    const pct = data.percentage ?? data.level;
    const status = data.status || (data.plugged !== "UNPLUGGED" ? "CHARGING" : "DISCHARGING");
    const icon = status === "CHARGING" ? "⚡" : pct <= 20 ? "🪫" : "🔋";
    return `${icon} ${pct}% (${status})`;
  } catch {
    return null;
  }
}

function formatNumber(num: number): string {
  return new Intl.NumberFormat("en-US").format(num);
}

function formatCompactTokens(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}k`;
  }
  return String(num);
}

const handleTunnelOpen = async (ctx: Context) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || "";
  const force = /\b(force|new|reset|restart)\b/i.test(text);

  const statusMsg = await ctx.reply(
    "⏳ <b>Menghubungkan SSH tunnel ke Cloudflare...</b>\nMohon tunggu...",
    { parse_mode: "HTML" }
  );

  const res = await startTunnel(force);
  const keyboard = res.alreadyActive
    ? new InlineKeyboard().text("🔄 Restart Tunnel", "tunnel:restart").text("🛑 Tutup Tunnel", "tunnel:close")
    : new InlineKeyboard().text("🛑 Tutup Tunnel", "tunnel:close");
  try {
    await ctx.api.editMessageText(chatId, statusMsg.message_id, res.message, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } catch {
    await ctx.reply(res.message, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  }
};

const handleTunnelClose = async (ctx: Context) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  await ctx.replyWithChatAction("typing");
  const res = await stopTunnel();
  await ctx.reply(res.message, { parse_mode: "HTML" });
};

// Command: /tunnel-open, /tunnel_open
bot.hears(/^\/tunnel[-_]?open(?:@\w+)?(?:\s+.*)?$/i, handleTunnelOpen);
bot.command(["tunnel_open", "tunnelopen"], handleTunnelOpen);

// Command: /tunnel-close, /tunnel_close, /tunnel-stop, /tunnel_stop
bot.hears(/^\/tunnel[-_]?(?:close|stop)(?:@\w+)?(?:\s+.*)?$/i, handleTunnelClose);
bot.command(["tunnel_close", "tunnelclose", "tunnel_stop", "tunnelstop"], handleTunnelClose);

// Command: /tunnel (status or toggle)
bot.hears(/^\/tunnel(?:@\w+)?(?:\s+(.*))?$/i, async (ctx) => {
  const match = ctx.match as RegExpMatchArray | undefined;
  const arg = (match && match[1] ? match[1] : "").trim().toLowerCase();
  if (arg === "open" || arg === "start") {
    return handleTunnelOpen(ctx);
  }
  if (arg === "close" || arg === "stop") {
    return handleTunnelClose(ctx);
  }
  const info = getActiveTunnelInfo();
  if (info.active && info.url) {
    return handleTunnelOpen(ctx);
  } else {
    const keyboard = new InlineKeyboard().text("🚀 Buka Tunnel", "tunnel:restart");
    await ctx.reply(
      "⚪ <b>Cloudflare SSH Tunnel saat ini INAKTIF.</b>\nKetik <code>/tunnel-open</code> untuk mengaktifkan akses SSH remote.",
      { parse_mode: "HTML", reply_markup: keyboard }
    );
  }
});
bot.command("tunnel", async (ctx) => {
  const text = ctx.message?.text || "";
  const parts = text.split(/\s+/);
  const arg = (parts[1] || "").toLowerCase();
  if (arg === "open" || arg === "start") {
    return handleTunnelOpen(ctx);
  }
  if (arg === "close" || arg === "stop") {
    return handleTunnelClose(ctx);
  }
  const info = getActiveTunnelInfo();
  if (info.active && info.url) {
    return handleTunnelOpen(ctx);
  } else {
    const keyboard = new InlineKeyboard().text("🚀 Buka Tunnel", "tunnel:restart");
    await ctx.reply(
      "⚪ <b>Cloudflare SSH Tunnel saat ini INAKTIF.</b>\nKetik <code>/tunnel-open</code> untuk mengaktifkan akses SSH remote.",
      { parse_mode: "HTML", reply_markup: keyboard }
    );
  }
});

// Inline Callbacks for Tunnel Management
bot.callbackQuery("tunnel:close", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Menutup tunnel..." });
  const res = await stopTunnel();
  if (ctx.callbackQuery.message) {
    try {
      await ctx.editMessageText(res.message, { parse_mode: "HTML" });
      return;
    } catch {}
  }
  await ctx.reply(res.message, { parse_mode: "HTML" });
});

bot.callbackQuery("tunnel:restart", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Memulai / merestart tunnel..." });
  if (ctx.callbackQuery.message) {
    try {
      await ctx.editMessageText("⏳ <b>Menghubungkan SSH tunnel ke Cloudflare...</b>\nMohon tunggu...", { parse_mode: "HTML" });
    } catch {}
  }
  const res = await startTunnel(true);
  const keyboard = new InlineKeyboard().text("🛑 Tutup Tunnel", "tunnel:close");
  if (ctx.callbackQuery.message) {
    try {
      await ctx.editMessageText(res.message, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      return;
    } catch {}
  }
  await ctx.reply(res.message, {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
});

// Command: /status
bot.command("status", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  try {
    const entry = await sessionPool.getSession(chatId);
    const session = entry.session;
    const model = session.model;
    const messageCount = session.messages.length;

    // Retrieve rich session stats & context usage
    const stats: any = session.getSessionStats ? session.getSessionStats() : null;
    const usedContextTokens = stats?.contextUsage?.tokens ?? 0;
    const maxContextTokens = model?.contextWindow ?? stats?.contextUsage?.contextWindow ?? 1_048_576;
    const contextPercent = maxContextTokens > 0 ? ((usedContextTokens / maxContextTokens) * 100).toFixed(1) : "0.0";

    const batteryInfo = await getDeviceBatteryStatus();
    const tunnelInfo = getActiveTunnelInfo();
    const tunnelStatusStr = tunnelInfo.active && tunnelInfo.url
      ? `🟢 Aktif (<code>${escapeHtml(tunnelInfo.host || tunnelInfo.url)}</code>)`
      : "⚪ Inaktif";

    const statusMsg = [
      "📊 <b>Pi Session Status</b>",
      `• <b>Session ID:</b> <code>${escapeHtml(session.sessionId)}</code>`,
      `• <b>Model:</b> <code>${escapeHtml(model ? `${model.provider}/${model.id}` : "default")}</code>`,
      `• <b>Thinking Level:</b> <code>${escapeHtml(session.thinkingLevel || "off")}</code>`,
      `• <b>SSH Tunnel:</b> ${tunnelStatusStr}`,
      `• <b>Context Window:</b> <code>${formatNumber(usedContextTokens)} / ${formatNumber(maxContextTokens)} tokens (${contextPercent}%)</code>`,
    ];

    if (stats?.tokens?.total) {
      const totalFormatted = formatCompactTokens(stats.tokens.total);
      const cacheNote = stats.tokens.cacheRead ? ` <i>(Cached: ${formatCompactTokens(stats.tokens.cacheRead)})</i>` : "";
      statusMsg.push(`• <b>Session Tokens:</b> <code>${totalFormatted} total</code>${cacheNote}`);
    }

    statusMsg.push(`• <b>Messages:</b> ${messageCount}`);

    if (batteryInfo) {
      statusMsg.push(`• <b>Device Battery:</b> ${batteryInfo}`);
    }

    statusMsg.push(`• <b>Working Dir:</b> <code>${escapeHtml(config.defaultCwd)}</code>`);
    statusMsg.push(`• <b>Processing:</b> ${entry.isProcessing ? "⏳ Yes" : "✅ Idle"}`);

    await ctx.reply(statusMsg.join("\n"), { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`⚠️ Failed to get status: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
  }
});

// Command: /compact
bot.command("compact", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  await ctx.reply("⏳ Compacting context...");
  try {
    const result = await sessionPool.compactSession(chatId);
    await ctx.reply(`✅ <b>${escapeHtml(result)}</b>`, { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`⚠️ Compaction failed: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
  }
});

// Command: /abort & /stop
const handleAbort = async (ctx: Context) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const aborted = await sessionPool.abortPrompt(chatId);
  if (aborted) {
    await ctx.reply("🛑 <b>Operation Aborted!</b> Stopped active execution immediately.", {
      parse_mode: "HTML",
    });
  } else {
    await ctx.reply("ℹ️ No active prompt was running to abort.", {
      parse_mode: "HTML",
    });
  }
};
bot.command("abort", handleAbort);
bot.command("stop", handleAbort);

// Command: /steer
bot.command("steer", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || "";
  const steerText = text.replace(/^\/steer\s*/i, "").trim();

  if (!steerText) {
    await ctx.reply("⚠️ Usage: <code>/steer &lt;instructions&gt;</code>\nExample: <code>/steer Stop editing file A, use file B instead</code>", {
      parse_mode: "HTML",
    });
    return;
  }

  const entry = await sessionPool.getSession(chatId);
  if (!entry.isProcessing && !entry.session.isStreaming) {
    await ctx.reply("ℹ️ No active prompt is currently running to steer. You can send it as a regular message instead.", {
      parse_mode: "HTML",
    });
    return;
  }

  try {
    await entry.session.steer(steerText);
    await ctx.reply(`🧭 <b>Steering Injected:</b> <i>"${escapeHtml(steerText)}"</i>\nPi will adjust its course on the next step.`, {
      parse_mode: "HTML",
    });
  } catch (err: any) {
    await ctx.reply(`⚠️ Failed to steer: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
  }
});

// Command: /archive
bot.command("archive", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || "";
  const rawArgs = text.replace(/^\/archive\s*/i, "").trim();

  // 1. Status & Overview (default)
  if (!rawArgs || rawArgs === "status" || rawArgs === "list") {
    const stats = sessionArchiver.getStorageStats(chatId);
    const archives = sessionArchiver.listArchived(chatId);

    const activeKb = (stats.activeBytes / 1024).toFixed(1);
    const archOrigKb = (stats.archivedOriginalBytes / 1024).toFixed(1);
    const archCompKb = (stats.archivedCompressedBytes / 1024).toFixed(1);

    const msg = [
      "📚 <b>Hermes-Style Session Librarian & Storage Stats</b>",
      "",
      `• <b>Active Sessions:</b> ${stats.activeSessionCount} file(s) (<code>${activeKb} KB</code>)`,
      `• <b>Archived Sessions:</b> ${stats.archivedSessionCount} file(s)`,
      `• <b>Storage Saved:</b> <code>${archOrigKb} KB</code> ➔ <code>${archCompKb} KB</code> (<b>${stats.totalSavingsPercentage.toFixed(1)}% Saved</b>)`,
      "",
    ];

    if (archives.length > 0) {
      msg.push("<b>Recent Archives (Compressed .jsonl.gz):</b>");
      for (const item of archives.slice(0, 5)) {
        const dateStr = new Date(item.archivedAt).toLocaleDateString("id-ID", {
          timeZone: "Asia/Makassar",
        });
        const ratio = ((1 - item.compressedSize / item.originalSize) * 100).toFixed(0);
        msg.push(`• 📦 <code>${item.archiveId}</code> (${dateStr})`);
        msg.push(`  ↳ <i>${escapeHtml(item.summary || item.originalFileName)}</i>`);
        msg.push(`  ↳ <code>${(item.originalSize / 1024).toFixed(1)}KB</code> ➔ <code>${(item.compressedSize / 1024).toFixed(1)}KB</code> (-${ratio}%)`);
      }
      if (archives.length > 5) {
        msg.push(`<i>...and ${archives.length - 5} more archived sessions</i>`);
      }
      msg.push("");
    }

    msg.push("<b>Commands:</b>");
    msg.push("• <code>/archive now</code> — Soft-archive & compress all inactive sessions");
    msg.push("• <code>/archive export</code> — Export active session as Markdown (.md)");
    msg.push("• <code>/archive restore &lt;id&gt;</code> — Decompress & restore an archived session");
    msg.push("• <code>/archive help</code> — Full documentation");

    await ctx.reply(msg.join("\n"), { parse_mode: "HTML" });
    return;
  }

  // 2. Help
  if (rawArgs === "help") {
    const helpMsg = [
      "📚 <b>Session Archiver & Mnemosyne Consolidation Guide</b>",
      "",
      "Non-destructive 3-tier session archiving inspired by Hermes Agent:",
      "",
      "1. <b>Tier 1: Active Context:</b> Active session stays fast and clean.",
      "2. <b>Tier 2: Mnemosyne Distillation:</b> Key facts and decisions are extracted and saved to shared memory before archival.",
      "3. <b>Tier 3: Gzip Soft-Archive:</b> Inactive session files are compressed (.jsonl.gz), saving 90%+ disk space with <b>zero data loss</b>.",
      "",
      "<b>Subcommands:</b>",
      "• <code>/archive</code> — View storage stats and archive list",
      "• <code>/archive now</code> — Force archive all inactive sessions now",
      "• <code>/archive export</code> — Export current transcript to readable Markdown",
      "• <code>/archive restore &lt;archive_id&gt;</code> — Restore an archived session",
    ].join("\n");
    await ctx.reply(helpMsg, { parse_mode: "HTML" });
    return;
  }

  // 3. Force Archive Now
  if (rawArgs === "now") {
    await ctx.reply("⏳ Consolidating to Mnemosyne and compressing inactive sessions...");
    try {
      const entry = await sessionPool.getSession(chatId);
      const activeFile = entry.session.sessionFile;
      const res = await sessionArchiver.archiveInactiveSessions(chatId, {
        keepLatest: 1,
        exportMarkdown: true,
        activeSessionFile: activeFile,
      });

      if (res.archivedCount === 0) {
        await ctx.reply("ℹ️ All inactive sessions are already archived. Active session is current.");
      } else {
        const savedKb = (res.savedBytes / 1024).toFixed(1);
        const reportMsg = [
          `✅ <b>Archival Complete!</b>`,
          `• <b>Archived:</b> ${res.archivedCount} session file(s)`,
          `• <b>Disk Saved:</b> <code>${savedKb} KB</code>`,
          `• <b>Knowledge Distilled:</b> Saved highlights to Mnemosyne (<code>mnemosyne.db</code>)`,
          "",
          ...res.reports,
        ].join("\n");
        await ctx.reply(reportMsg, { parse_mode: "HTML" });
      }
    } catch (err: any) {
      await ctx.reply(`⚠️ Archival error: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
    }
    return;
  }

  // 4. Export Current Session to Markdown
  if (rawArgs === "export") {
    try {
      const entry = await sessionPool.getSession(chatId);
      const activeFile = entry.session.sessionFile;
      if (!activeFile || !fs.existsSync(activeFile)) {
        await ctx.reply("⚠️ Active session file not found on disk.");
        return;
      }

      const { markdown, summary } = sessionArchiver.exportToMarkdown(activeFile);
      const exportDir = path.join(config.defaultCwd, "Downloads", "Pi-Exports");
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }

      const exportFileName = `pi_session_${new Date().toISOString().slice(0, 10)}_${entry.session.sessionId.slice(0, 8)}.md`;
      const exportFilePath = path.join(exportDir, exportFileName);
      fs.writeFileSync(exportFilePath, markdown, "utf-8");

      const replyMsg = [
        "📄 <b>Session Exported to Markdown!</b>",
        `• <b>Summary:</b> <i>${escapeHtml(summary)}</i>`,
        `• <b>File:</b> <code>${escapeHtml(exportFilePath)}</code>`,
        `• <b>Size:</b> <code>${(markdown.length / 1024).toFixed(1)} KB</code>`,
        "",
        "You can open or sync this Markdown file in Obsidian / Docs directly.",
      ].join("\n");

      await ctx.reply(replyMsg, { parse_mode: "HTML" });
    } catch (err: any) {
      await ctx.reply(`⚠️ Export error: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
    }
    return;
  }

  // 5. Restore Archived Session
  if (rawArgs.startsWith("restore")) {
    const targetId = rawArgs.replace(/^restore\s*/i, "").trim();
    if (!targetId) {
      await ctx.reply("⚠️ Usage: <code>/archive restore &lt;archive_id&gt;</code>", { parse_mode: "HTML" });
      return;
    }

    const res = sessionArchiver.restoreSession(chatId, targetId);
    if (res.ok) {
      await ctx.reply(`✅ <b>Restored:</b> <code>${escapeHtml(res.restoredFile || targetId)}</code> has been decompressed and returned to the active session folder.`, {
        parse_mode: "HTML",
      });
    } else {
      await ctx.reply(`⚠️ Failed to restore: ${escapeHtml(res.error || "Unknown error")}`, { parse_mode: "HTML" });
    }
    return;
  }

  await ctx.reply(`⚠️ Unknown archive command. Use <code>/archive help</code> to view available commands.`, { parse_mode: "HTML" });
});

// Command: /logs & /log
bot.command(["logs", "log"], async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || "";
  const rawArgs = text.replace(/^\/(logs|log)\s*/i, "").trim().toLowerCase();

  // Clear logs
  if (rawArgs === "clear") {
    const success = gatewayLogger.clearLogs();
    if (success) {
      await ctx.reply("🧹 <b>Gateway logs cleared successfully.</b>", { parse_mode: "HTML" });
    } else {
      await ctx.reply("⚠️ Failed to clear gateway logs.", { parse_mode: "HTML" });
    }
    return;
  }

  // Filter errors or custom count
  const isErrorFilter = rawArgs === "error" || rawArgs === "errors" || rawArgs === "warn";
  const numArg = parseInt(rawArgs, 10);
  const limit = !isNaN(numArg) && numArg > 0 ? Math.min(numArg, 50) : isErrorFilter ? 25 : 15;

  const entries = gatewayLogger.getRecentLogs({
    limit,
    level: isErrorFilter ? (rawArgs.includes("warn") ? "WARN" : "ERROR") : "ALL",
  });

  if (entries.length === 0) {
    await ctx.reply(`📋 <b>No logs recorded matching criteria.</b>\nFile: <code>${gatewayLogger.getLogFilePath()}</code>`, {
      parse_mode: "HTML",
    });
    return;
  }

  const logLines = entries
    .map((e) => {
      const lvlIcon = e.level === "ERROR" ? "❌" : e.level === "WARN" ? "⚠️" : "ℹ️";
      const timeOnly = e.timeStr.includes(",") ? e.timeStr.split(",")[1]?.trim() : e.timeStr;
      return `${timeOnly} ${lvlIcon} [${e.level}] ${e.message}`;
    })
    .join("\n");

  const fileSize = gatewayLogger.getLogFileSizeKb();
  const title = `📋 <b>Pi Gateway Logs (${entries.length} recent, file: ${fileSize} KB):</b>\n\n`;
  const codeBlock = `<pre>${escapeHtml(logLines)}</pre>\n\n<i>Filter: <code>/logs error</code> | Count: <code>/logs 30</code> | Clear: <code>/logs clear</code></i>`;

  const totalMessage = title + codeBlock;
  const chunks = splitMessage(totalMessage);
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch {
      await ctx.reply(chunk.replace(/<[^>]*>/g, ""));
    }
  }
});

function stripOuterQuotes(s: string): string {
  const trimmed = s.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseAddScheduleAndPrompt(input: string): { id?: string; cronExpression: string; prompt: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // 1. Quoted cron (with optional ID): [id] "cron" [prompt] or [id] 'cron' [prompt]
  const doubleQuoted = trimmed.match(/^(?:([a-zA-Z0-9_-]+)\s+)?"([^"]+)"(?:\s+(.*))?$/s);
  if (doubleQuoted && isValidCronExpression(doubleQuoted[2]!)) {
    return {
      id: doubleQuoted[1],
      cronExpression: doubleQuoted[2]!.trim(),
      prompt: stripOuterQuotes(doubleQuoted[3] || ""),
    };
  }
  const singleQuoted = trimmed.match(/^(?:([a-zA-Z0-9_-]+)\s+)?'([^']+)'(?:\s+(.*))?$/s);
  if (singleQuoted && isValidCronExpression(singleQuoted[2]!)) {
    return {
      id: singleQuoted[1],
      cronExpression: singleQuoted[2]!.trim(),
      prompt: stripOuterQuotes(singleQuoted[3] || ""),
    };
  }

  // 2. Nicknames: [id] @daily [prompt]
  const nickMatch = trimmed.match(/^(?:([a-zA-Z0-9_-]+)\s+)?(@[a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
  if (nickMatch && isValidCronExpression(nickMatch[2]!)) {
    return {
      id: nickMatch[1],
      cronExpression: nickMatch[2]!.trim(),
      prompt: stripOuterQuotes(nickMatch[3] || ""),
    };
  }

  // 3. Unquoted parts: 5 or 6 token cron
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 5) {
    const expr5 = parts.slice(0, 5).join(" ");
    if (isValidCronExpression(expr5)) {
      return {
        id: undefined,
        cronExpression: expr5,
        prompt: stripOuterQuotes(parts.slice(5).join(" ")),
      };
    }
  }
  if (parts.length >= 6) {
    const expr6 = parts.slice(0, 6).join(" ");
    if (isValidCronExpression(expr6)) {
      return {
        id: undefined,
        cronExpression: expr6,
        prompt: stripOuterQuotes(parts.slice(6).join(" ")),
      };
    }
    const withId5 = parts.slice(1, 6).join(" ");
    if (isValidCronExpression(withId5)) {
      return {
        id: parts[0],
        cronExpression: withId5,
        prompt: stripOuterQuotes(parts.slice(6).join(" ")),
      };
    }
  }
  if (parts.length >= 7) {
    const withId6 = parts.slice(1, 7).join(" ");
    if (isValidCronExpression(withId6)) {
      return {
        id: parts[0],
        cronExpression: withId6,
        prompt: stripOuterQuotes(parts.slice(7).join(" ")),
      };
    }
  }

  return null;
}

// Command: /cron
bot.command("cron", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || "";
  const rawArgs = text.replace(/^\/cron\s*/i, "").trim();

  // 1. List or default
  if (!rawArgs || rawArgs === "list") {
    const jobs = cronScheduler.listJobs();
    if (jobs.length === 0) {
      const emptyMsg = [
        "⏰ <b>No Scheduled Cron Jobs Found</b>",
        "",
        "You can schedule recurring Pi tasks with:",
        '• <code>/cron add "0 8 * * *" Cek baterai dan cuaca</code>',
        '• <code>/cron add morning "0 8 * * *" Buat daily briefing</code>',
        "",
        "Use <code>/cron help</code> for full syntax and examples.",
      ].join("\n");
      await ctx.reply(emptyMsg, { parse_mode: "HTML" });
      return;
    }

    let msg = `⏰ <b>Scheduled Cron Jobs (${jobs.length}):</b>\n\n`;
    for (const job of jobs) {
      const statusIcon = job.enabled ? "🟢" : "⏸️";
      const lastStatusIcon =
        job.lastStatus === "success"
          ? "✅"
          : job.lastStatus === "error"
          ? "❌"
          : "⏳";
      const modeBadge = job.noAgent ? "⚡ <i>Script Direct</i>" : "🤖 <i>Agent</i>";
      msg += `${statusIcon} <b>${escapeHtml(job.name || job.id)}</b> [${modeBadge}] (<code>${escapeHtml(job.id)}</code>)\n`;
      msg += `  • <b>Schedule:</b> <code>${escapeHtml(job.cronExpression)}</code>\n`;
      msg += `  • <b>Next Run:</b> <code>${escapeHtml(job.nextRun || "N/A")}</code>\n`;
      if (job.lastRun) {
        const lastRunStr = new Date(job.lastRun).toLocaleString("id-ID", {
          timeZone: job.timezone || config.defaultTimezone,
          dateStyle: "short",
          timeStyle: "short",
        });
        const durationStr = job.lastDurationMs ? ` (${(job.lastDurationMs / 1000).toFixed(2)}s)` : "";
        msg += `  • <b>Last Run:</b> ${lastStatusIcon} ${escapeHtml(lastRunStr)}${durationStr}\n`;
        if (job.lastError) {
          msg += `  • <b>Error:</b> <code>${escapeHtml(job.lastError.slice(0, 60))}</code>\n`;
        }
      }
      const promptPreview = escapeHtml(
        job.prompt.slice(0, 80) + (job.prompt.length > 80 ? "..." : "")
      );
      msg += `  • <b>${job.noAgent ? "Command:" : "Prompt:"}</b> <i>${promptPreview}</i>\n\n`;
    }

    msg += `Commands: <code>/cron add</code>, <code>/cron edit</code>, <code>/cron script</code>, <code>/cron logs &lt;id&gt;</code>, <code>/cron run &lt;id&gt;</code>, <code>/cron pause &lt;id&gt;</code>, <code>/cron rm &lt;id&gt;</code>`;
    await ctx.reply(msg, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    return;
  }

  // 2. Help
  if (rawArgs === "help") {
    const helpMsg = [
      "⏰ <b>Pi Cron Scheduler Guide</b>",
      "",
      "Schedule autonomous tasks or direct shell scripts.",
      "",
      "<b>Commands:</b>",
      "• <code>/cron</code> or <code>/cron list</code> — List all scheduled tasks",
      '• <code>/cron add "&lt;cron&gt;" &lt;prompt&gt;</code> — Add Agent task (with reasoning & tools)',
      '• <code>/cron edit &lt;id&gt; [options]</code> — Edit schedule, prompt, name, or mode',
      '• <code>/cron script "&lt;cron&gt;" &lt;command&gt;</code> — Add Direct Script task (0 LLM tokens, fast & exact)',
      "• <code>/cron logs [id]</code> — View execution logs and runtime durations",
      "• <code>/cron run &lt;id&gt;</code> — Execute job immediately for testing",
      "• <code>/cron pause &lt;id&gt;</code> — Temporarily pause a job",
      "• <code>/cron resume &lt;id&gt;</code> — Resume a paused job",
      "• <code>/cron rm &lt;id&gt;</code> — Delete a job",
      "",
      "<b>Examples:</b>",
      '• Agent: <code>/cron add "0 8 * * *" Berikan ringkasan berita AI terbaru</code>',
      '• Script: <code>/cron script "0 */2 * * *" termux-battery-status</code>',
      '• Script: <code>/cron script "*/30 * * *" python3 ~/check_aqi.py</code>',
    ].join("\n");
    await ctx.reply(helpMsg, { parse_mode: "HTML" });
    return;
  }

  // 3. Subcommands: run, pause, resume, rm, remove, delete, add
  const firstSpace = rawArgs.indexOf(" ");
  const sub = (firstSpace === -1 ? rawArgs : rawArgs.substring(0, firstSpace)).toLowerCase();
  const rest = (firstSpace === -1 ? "" : rawArgs.substring(firstSpace + 1)).trim();

  if (["rm", "remove", "delete"].includes(sub)) {
    if (!rest) {
      await ctx.reply("⚠️ Please provide a job ID: <code>/cron rm &lt;id&gt;</code>", { parse_mode: "HTML" });
      return;
    }
    const success = cronScheduler.removeJob(rest);
    if (success) {
      await ctx.reply(`🗑️ Job <code>${escapeHtml(rest)}</code> removed successfully.`, { parse_mode: "HTML" });
    } else {
      await ctx.reply(`⚠️ Job <code>${escapeHtml(rest)}</code> not found.`, { parse_mode: "HTML" });
    }
    return;
  }

  if (sub === "edit") {
    if (!rest) {
      await ctx.reply(
        "⚠️ Usage: <code>/cron edit &lt;id&gt; [options]</code>\n\n" +
        "<b>Examples:</b>\n" +
        '• Ganti jadwal: <code>/cron edit my_job "0 8 * * *"</code>\n' +
        '• Ganti jadwal (unquoted): <code>/cron edit my_job 0 8 * * *</code>\n' +
        '• Ganti jadwal & prompt: <code>/cron edit my_job "0 8 * * *" Cek berita AI</code>\n' +
        '• Pakai flags: <code>/cron edit my_job --cron "0 9 * * 1-5" --name "New Title"</code>\n' +
        '• Ganti mode: <code>/cron edit my_job --mode script</code> atau <code>--mode agent</code>',
        { parse_mode: "HTML" }
      );
      return;
    }

    const parts = rest.split(/\s+/);
    const id = parts[0] || "";
    const editArgs = rest.substring(id.length).trim();

    const existingJob = cronScheduler.getJob(id);
    if (!existingJob) {
      await ctx.reply(`⚠️ Job with ID <code>${escapeHtml(id)}</code> not found.`, { parse_mode: "HTML" });
      return;
    }

    if (!editArgs) {
      const currentNext = cronScheduler.getNextRun(existingJob.id);
      const modeStr = existingJob.noAgent ? "⚡ Direct Script (0 LLM Tokens)" : "🧠 Agent Reasoning";
      const infoMsg = [
        `📋 <b>Edit Cron Job:</b> <code>${escapeHtml(existingJob.id)}</code>`,
        `• <b>Name:</b> <code>${escapeHtml(existingJob.name || existingJob.id)}</code>`,
        `• <b>Schedule:</b> <code>${escapeHtml(existingJob.cronExpression)}</code>`,
        `• <b>Next Run:</b> <code>${escapeHtml(currentNext || "N/A")}</code>`,
        `• <b>Mode:</b> ${modeStr}`,
        `• <b>${existingJob.noAgent ? "Command:" : "Prompt:"}</b> <i>${escapeHtml(existingJob.prompt)}</i>`,
        "",
        "<b>How to edit:</b>",
        `• Ganti jadwal: <code>/cron edit ${existingJob.id} "0 8 * * *"</code>`,
        `• Ganti prompt: <code>/cron edit ${existingJob.id} --prompt "Prompt baru"</code>`,
        `• Ganti nama: <code>/cron edit ${existingJob.id} --name "Nama baru"</code>`,
        `• Ganti mode: <code>/cron edit ${existingJob.id} --mode script</code>`,
      ].join("\n");
      await ctx.reply(infoMsg, { parse_mode: "HTML" });
      return;
    }

    let newCron: string | undefined;
    let newPrompt: string | undefined;
    let newName: string | undefined;
    let newTz: string | undefined;
    let newNoAgent: boolean | undefined;

    // Parse flags if present (--cron, --prompt, --name, --tz, --mode)
    const hasFlags = /--[a-zA-Z0-9_-]+/.test(editArgs);
    if (hasFlags) {
      const flagRegex = /--([a-zA-Z0-9_-]+)(?:\s+(?:"([^"]*)"|'([^']*)'|((?:(?! --).)+?))(?=\s+--|$))?/gs;
      let match: RegExpExecArray | null;
      while ((match = flagRegex.exec(editArgs)) !== null) {
        const key = match[1]!.toLowerCase();
        const val = (match[2] ?? match[3] ?? match[4] ?? "true").trim();
        if (key === "cron") newCron = val;
        else if (key === "prompt") newPrompt = val;
        else if (key === "name") newName = val;
        else if (key === "tz" || key === "timezone") newTz = val;
        else if (key === "mode") {
          if (val.toLowerCase() === "script") newNoAgent = true;
          if (val.toLowerCase() === "agent") newNoAgent = false;
        } else if (key === "script") newNoAgent = true;
        else if (key === "agent") newNoAgent = false;
      }
    } else {
      // Positional edit arguments: test for quoted or unquoted cron
      const parsedPositional = parseAddScheduleAndPrompt(editArgs);
      if (parsedPositional) {
        newCron = parsedPositional.cronExpression;
        if (parsedPositional.prompt) {
          newPrompt = parsedPositional.prompt;
        }
      } else {
        // If not a cron expression, treat entire editArgs as the new prompt
        newPrompt = stripOuterQuotes(editArgs);
      }
    }

    const res = cronScheduler.editJob(existingJob.id, {
      cronExpression: newCron,
      prompt: newPrompt,
      name: newName,
      timezone: newTz,
      noAgent: newNoAgent,
    });

    if (!res.ok || !res.job) {
      await ctx.reply(`⚠️ Failed to edit cron job: ${escapeHtml(res.error || "Unknown error")}`, { parse_mode: "HTML" });
      return;
    }

    const nextRun = cronScheduler.getNextRun(res.job.id);
    const replyMsg = [
      `✅ <b>Cron Job Updated Successfully!</b>`,
      `• <b>ID:</b> <code>${escapeHtml(res.job.id)}</code>`,
      `• <b>Schedule:</b> <code>${escapeHtml(res.job.cronExpression)}</code>`,
      `• <b>Next Run:</b> <code>${escapeHtml(nextRun || "N/A")}</code>`,
      "",
      "<b>Changes Applied:</b>",
      ...(res.changes || []).map((c) => `• ${c}`),
      "",
      `Test now with: <code>/cron run ${escapeHtml(res.job.id)}</code>`,
    ].join("\n");

    await ctx.reply(replyMsg, { parse_mode: "HTML" });
    return;
  }

  if (sub === "pause") {
    if (!rest) {
      await ctx.reply("⚠️ Please provide a job ID: <code>/cron pause &lt;id&gt;</code>", { parse_mode: "HTML" });
      return;
    }
    const success = cronScheduler.pauseJob(rest);
    if (success) {
      await ctx.reply(`⏸️ Job <code>${escapeHtml(rest)}</code> paused.`, { parse_mode: "HTML" });
    } else {
      await ctx.reply(`⚠️ Job <code>${escapeHtml(rest)}</code> not found.`, { parse_mode: "HTML" });
    }
    return;
  }

  if (["resume", "unpause", "enable"].includes(sub)) {
    if (!rest) {
      await ctx.reply("⚠️ Please provide a job ID: <code>/cron resume &lt;id&gt;</code>", { parse_mode: "HTML" });
      return;
    }
    const success = cronScheduler.resumeJob(rest);
    if (success) {
      await ctx.reply(
        `▶️ Job <code>${escapeHtml(rest)}</code> resumed. Next run: <code>${escapeHtml(cronScheduler.getNextRun(rest) || "N/A")}</code>`,
        { parse_mode: "HTML" }
      );
    } else {
      await ctx.reply(`⚠️ Job <code>${escapeHtml(rest)}</code> not found.`, { parse_mode: "HTML" });
    }
    return;
  }

  if (sub === "run") {
    if (!rest) {
      await ctx.reply("⚠️ Please provide a job ID: <code>/cron run &lt;id&gt;</code>", { parse_mode: "HTML" });
      return;
    }
    const job = cronScheduler.getJob(rest);
    if (!job) {
      await ctx.reply(`⚠️ Job <code>${escapeHtml(rest)}</code> not found.`, { parse_mode: "HTML" });
      return;
    }

    await ctx.reply(`⏳ Executing scheduled job <code>${escapeHtml(job.name || job.id)}</code> now...`, { parse_mode: "HTML" });
    try {
      await cronScheduler.executeJob(job.id, true);
      await ctx.reply(`✅ Job <code>${escapeHtml(job.name || job.id)}</code> finished executing.`, { parse_mode: "HTML" });
    } catch (err: any) {
      console.error("Manual execution error:", err);
      const safeErr = err.message && err.message.length > 2000 ? err.message.slice(0, 1950) + "\n...[truncated]" : (err.message || "Unknown error");
      await ctx.reply(`❌ Manual execution failed for <code>${escapeHtml(job.name || job.id)}</code>:\n<pre>${escapeHtml(safeErr)}</pre>`, { parse_mode: "HTML" });
    }
    return;
  }

  if (["logs", "log", "history"].includes(sub)) {
    if (rest) {
      const specificJob = cronScheduler.getJob(rest);
      if (!specificJob) {
        await ctx.reply(`⚠️ Job <code>${escapeHtml(rest)}</code> not found.`, { parse_mode: "HTML" });
        return;
      }
    }

    const jobLogs = cronScheduler.getLogs(rest || undefined, 5);
    if (jobLogs.length === 0 || jobLogs.every((j) => j.logs.length === 0)) {
      await ctx.reply("⏰ <b>No execution logs recorded yet.</b>\nLogs will appear after cron jobs execute.", {
        parse_mode: "HTML",
      });
      return;
    }

    let msg = `📜 <b>Cron Execution History:</b>\n\n`;
    for (const { job, logs } of jobLogs) {
      if (logs.length === 0) continue;
      const modeTag = job.noAgent ? "⚡ <i>Script</i>" : "🤖 <i>Agent</i>";
      msg += `▪️ <b>${escapeHtml(job.name || job.id)}</b> [${modeTag}] (<code>${escapeHtml(job.id)}</code>):\n`;

      for (const entry of logs.slice(-5).reverse()) {
        const timeStr = new Date(entry.runAt).toLocaleString("id-ID", {
          timeZone: job.timezone || config.defaultTimezone,
          dateStyle: "short",
          timeStyle: "medium",
        });
        const statusIcon = entry.status === "success" ? "✅" : "❌";
        const durationStr = `${(entry.durationMs / 1000).toFixed(2)}s`;
        const runTag = entry.isManual ? " <i>(manual)</i>" : "";

        msg += `  ${statusIcon} <code>${escapeHtml(timeStr)}</code> (${durationStr})${runTag}\n`;
        if (entry.error) {
          msg += `     <i>Error:</i> <code>${escapeHtml(entry.error.slice(0, 80))}</code>\n`;
        } else if (entry.outputSnippet) {
          const preview = escapeHtml(entry.outputSnippet.replace(/\n+/g, " ").slice(0, 60));
          msg += `     <i>Result:</i> <code>${preview}...</code>\n`;
        }
      }
      msg += "\n";
    }

    await ctx.reply(msg, { parse_mode: "HTML" });
    return;
  }

  if (sub === "script" || sub === "add") {
    const isExplicitScript = sub === "script" || rest.startsWith("--script ");
    const cleanRest = rest.replace(/^--script\s+/, "").trim();

    if (!cleanRest) {
      await ctx.reply(
        sub === "script"
          ? '⚠️ Usage: <code>/cron script "&lt;cron_pattern&gt;" &lt;bash_command&gt;</code>\nExample: <code>/cron script "0 */2 * * *" termux-battery-status</code>'
          : '⚠️ Usage: <code>/cron add "&lt;cron_pattern&gt;" &lt;prompt&gt;</code>\nExample: <code>/cron add "0 8 * * *" Check battery and news</code>',
        { parse_mode: "HTML" }
      );
      return;
    }

    const parsed = parseAddScheduleAndPrompt(cleanRest);
    if (!parsed || !parsed.cronExpression || !parsed.prompt) {
      await ctx.reply(
        '⚠️ Invalid format. Usage:\n' +
        '• <code>/cron add "&lt;cron&gt;" &lt;prompt&gt;</code>\n' +
        '• <code>/cron add &lt;id&gt; "&lt;cron&gt;" &lt;prompt&gt;</code>\n' +
        '• <code>/cron add 0 8 * * * &lt;prompt&gt;</code>\n' +
        '• <code>/cron script "&lt;cron&gt;" &lt;command&gt;</code>',
        { parse_mode: "HTML" }
      );
      return;
    }

    const result = cronScheduler.addJob({
      id: parsed.id,
      cronExpression: parsed.cronExpression,
      prompt: parsed.prompt,
      chatId,
      noAgent: isExplicitScript,
    });

    if (!result.ok || !result.job) {
      await ctx.reply(`⚠️ Failed to add cron job: ${escapeHtml(result.error || "Unknown error")}`, { parse_mode: "HTML" });
      return;
    }

    const nextRun = cronScheduler.getNextRun(result.job.id);
    const modeBadge = isExplicitScript ? "⚡ <b>Direct Script (No LLM Tokens)</b>" : "🤖 <b>Agent Reasoning</b>";
    const successMsg = [
      `✅ <b>Cron Job Added Successfully!</b>`,
      `• <b>ID:</b> <code>${escapeHtml(result.job.id)}</code>`,
      `• <b>Mode:</b> ${modeBadge}`,
      `• <b>Schedule:</b> <code>${escapeHtml(result.job.cronExpression)}</code>`,
      `• <b>Next Run:</b> <code>${escapeHtml(nextRun || "N/A")}</code>`,
      `• <b>${isExplicitScript ? "Command:" : "Prompt:"}</b> <i>${escapeHtml(result.job.prompt)}</i>`,
      "",
      `Test immediately with: <code>/cron run ${escapeHtml(result.job.id)}</code>`,
    ].join("\n");

    await ctx.reply(successMsg, { parse_mode: "HTML" });
    return;
  }

  await ctx.reply(`⚠️ Unknown cron subcommand: <code>${escapeHtml(sub)}</code>.\nUse <code>/cron help</code> to see available commands.`, { parse_mode: "HTML" });
});

// Command: /model
bot.command("model", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || "";
  const parts = text.split(" ").slice(1);
  const targetModel = parts.join(" ").trim();

  if (targetModel) {
    // Switch model
    try {
      const switched = await sessionPool.setModel(chatId, targetModel);
      if (switched) {
        const thinkingNote = switched.thinkingLevel ? `\n🧠 <b>Thinking Level:</b> <code>${escapeHtml(switched.thinkingLevel)}</code>` : "";
        await ctx.reply(`✅ Switched model to: <code>${escapeHtml(`${switched.model.provider}/${switched.model.id}`)}</code>${thinkingNote}`, {
          parse_mode: "HTML",
        });
      } else {
        await ctx.reply(
          `⚠️ Could not find model: <code>${escapeHtml(targetModel)}</code>. Use <code>/model</code> to view available models.`,
          { parse_mode: "HTML" }
        );
      }
    } catch (err: any) {
      await ctx.reply(`⚠️ Error switching model: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
    }
    return;
  }

  // List models
  try {
    const entry = await sessionPool.getSession(chatId);
    const currentModel = entry.session.model;
    const currentThinking = entry.session.thinkingLevel || "off";
    const services = sessionPool.getServices();
    const modelRuntime = services?.modelRuntime;
    const available = modelRuntime ? await modelRuntime.getAvailable() : [];

    let msg = `🤖 <b>Current Model:</b> <code>${escapeHtml(currentModel ? `${currentModel.provider}/${currentModel.id}` : "default")}</code>\n`;
    msg += `🧠 <b>Thinking Level:</b> <code>${escapeHtml(currentThinking)}</code>\n\n`;

    if (available.length > 0) {
      msg += `<b>Available Models (${available.length} total):</b>\n`;
      for (const m of available.slice(0, 10)) {
        msg += `• <code>${escapeHtml(`${m.provider}/${m.id}`)}</code>\n`;
      }
      if (available.length > 10) {
        msg += `<i>...and ${available.length - 10} more</i>\n`;
      }
      msg += `\nSwitch with: <code>/model &lt;provider/model-id&gt;</code>\nOr with thinking: <code>/model &lt;provider/model-id&gt;:&lt;level&gt;</code>\nChange thinking only: <code>/thinking &lt;level&gt;</code>`;
    } else {
      msg += `<i>No configured models found.</i>`;
    }

    await ctx.reply(msg, { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`⚠️ Error fetching models: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
  }
});

// Command: /thinking
bot.command("thinking", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const text = ctx.message?.text || "";
  const parts = text.split(" ").slice(1);
  const targetLevel = parts.join(" ").trim().toLowerCase();

  if (targetLevel === "next" || targetLevel === "cycle") {
    try {
      const result = await sessionPool.cycleThinkingLevel(chatId);
      await ctx.reply(
        `🧠 Thinking level cycled to: <code>${escapeHtml(result.level)}</code> (previous: <code>${escapeHtml(result.previous)}</code>)`,
        { parse_mode: "HTML" }
      );
    } catch (err: any) {
      await ctx.reply(`⚠️ Error cycling thinking level: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
    }
    return;
  }

  if (targetLevel) {
    try {
      const result = await sessionPool.setThinkingLevel(chatId, targetLevel);
      await ctx.reply(
        `🧠 Thinking level set to: <code>${escapeHtml(result.level)}</code> (previous: <code>${escapeHtml(result.previous)}</code>)`,
        { parse_mode: "HTML" }
      );
    } catch (err: any) {
      await ctx.reply(`⚠️ Error setting thinking level: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
    }
    return;
  }

  // Show current thinking info & available levels
  try {
    const info = await sessionPool.getThinkingInfo(chatId);
    let msg = `🧠 <b>Current Thinking Level:</b> <code>${escapeHtml(info.current)}</code>\n`;
    msg += `• <b>Model Supports Reasoning:</b> ${info.supportsThinking ? "✅ Yes" : "❌ No"}\n\n`;

    msg += `<b>Available Levels:</b>\n`;
    for (const lvl of info.available) {
      const indicator = lvl.toLowerCase() === info.current.toLowerCase() ? "👉 " : "• ";
      msg += `${indicator}<code>${escapeHtml(lvl)}</code>\n`;
    }

    msg += `\n<b>Usage:</b>\n`;
    msg += `• <code>/thinking &lt;level&gt;</code> (e.g. <code>/thinking high</code> or <code>/thinking off</code>)\n`;
    msg += `• <code>/thinking next</code> to cycle through levels`;

    await ctx.reply(msg, { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`⚠️ Error fetching thinking info: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
  }
});

// Helper: Download and extract images/files from Telegram messages
interface ExtractedUserInput {
  text: string;
  images: Array<{ type: "image"; mimeType: string; data: string }>;
  savedPaths: string[];
}

async function extractUserInput(ctx: Context): Promise<ExtractedUserInput> {
  const images: Array<{ type: "image"; mimeType: string; data: string }> = [];
  const savedPaths: string[] = [];
  let text = ctx.message?.text || ctx.message?.caption || "";

  // 1. Photo (Compressed Telegram Image)
  if (ctx.message?.photo && ctx.message.photo.length > 0) {
    try {
      const photos = ctx.message.photo;
      const photo = photos[photos.length - 1];
      if (photo?.file_id) {
        const file = await ctx.api.getFile(photo.file_id);
        if (file.file_path) {
          const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
          const res = await fetch(fileUrl);
          if (res.ok) {
            const buffer = Buffer.from(await res.arrayBuffer());
            const ext = path.extname(file.file_path) || ".jpg";
            const mimeType = ext.toLowerCase() === ".png" ? "image/png" : ext.toLowerCase() === ".webp" ? "image/webp" : "image/jpeg";

            images.push({
              type: "image",
              mimeType,
              data: buffer.toString("base64"),
            });

            const imgDir = path.join(config.sessionsDir, "images");
            if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
            const localPath = path.join(imgDir, `photo_${Date.now()}_${photo.file_id.slice(0, 8)}${ext}`);
            fs.writeFileSync(localPath, buffer);
            savedPaths.push(localPath);
          }
        }
      }
    } catch (err: any) {
      console.error("Error downloading photo from Telegram:", err.message);
    }
  }

  // 2. Document (Uncompressed Image)
  if (ctx.message?.document) {
    const doc = ctx.message.document;
    const mime = doc.mime_type || "";
    if (mime.startsWith("image/")) {
      try {
        const file = await ctx.api.getFile(doc.file_id);
        if (file.file_path) {
          const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
          const res = await fetch(fileUrl);
          if (res.ok) {
            const buffer = Buffer.from(await res.arrayBuffer());
            const ext = path.extname(doc.file_name || file.file_path) || (mime === "image/png" ? ".png" : ".jpg");

            images.push({
              type: "image",
              mimeType: mime,
              data: buffer.toString("base64"),
            });

            const imgDir = path.join(config.sessionsDir, "images");
            if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
            const localPath = path.join(imgDir, `doc_${Date.now()}_${doc.file_name || "image" + ext}`);
            fs.writeFileSync(localPath, buffer);
            savedPaths.push(localPath);
          }
        }
      } catch (err: any) {
        console.error("Error downloading document image from Telegram:", err.message);
      }
    }
  }

  if (!text.trim() && images.length > 0) {
    text = "Tolong periksa dan analisis gambar ini, jelaskan isi atau jawab detail terkait gambar tersebut.";
  }

  if (savedPaths.length > 0 && text.trim()) {
    const pathsNote = savedPaths.map((p) => `[File gambar disimpan di: ${p}]`).join("\n");
    text = `${text}\n\n${pathsNote}`;
  }

  return { text, images, savedPaths };
}

// Main Message Handler (with Follow-Up Queueing & Multi-turn streaming)
bot.on(["message:text", "message:photo", "message:document"], async (ctx) => {
  const chatId = ctx.chat.id;
  const input = await extractUserInput(ctx);
  if (!input.text.trim() && input.images.length === 0) return;
  const userText = input.text;

  // Ignore commands handled above
  if (userText.startsWith("/")) return;

  const entry = await sessionPool.getSession(chatId);

  // 1. If agent is ALREADY busy processing: Queue as Follow-Up!
  if (entry.isProcessing || entry.session.isStreaming) {
    try {
      await entry.session.followUp(
        input.text,
        input.images.length > 0 ? (input.images as any) : undefined
      );
      const preview = escapeHtml(userText.length > 80 ? userText.slice(0, 77) + "..." : userText);
      await ctx.reply(
        `📥 <b>Queued Follow-up:</b> <i>"${preview}"</i>\nPi will execute this automatically as soon as the current task finishes.`,
        { parse_mode: "HTML" }
      );
    } catch (err: any) {
      await ctx.reply(`⚠️ Could not queue follow-up: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
    }
    return;
  }

  // 2. Start a fresh prompt turn
  entry.isProcessing = true;
  entry.aborted = false;
  const turnStartTime = Date.now();

  console.log(`📩 [Telegram] Prompt from ${ctx.from?.id}: "${input.text.slice(0, 60)}"${input.images.length > 0 ? ` (+${input.images.length} images)` : ""}`);

  // Keep sending typing action every 4 seconds while running
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);
  ctx.replyWithChatAction("typing").catch(() => {});

  let fullResponse = "";
  let modelErrorMessage: string | null = null;
  let statusMessageId: number | null = null;
  let intermediateDelivered = false;
  const conversationalResponses: string[] = [];
  const toolLog: string[] = [];

  // Helper to safely send a completed turn message to Telegram
  const sendTurnResponse = async (text: string) => {
    if (!text || !text.trim()) return;
    if (statusMessageId) {
      const msgIdToDelete = statusMessageId;
      statusMessageId = null;
      await ctx.api.deleteMessage(chatId, msgIdToDelete).catch(() => {});
    }
    const htmlContent = markdownToTelegramHtml(text);
    const chunks = splitMessage(htmlContent);
    for (const chunk of chunks) {
      try {
        await ctx.reply(chunk, { parse_mode: "HTML" });
      } catch (tgErr: any) {
        console.error("HTML send error, falling back to plain text:", tgErr.message);
        await ctx.reply(chunk.replace(/<[^>]*>/g, ""));
      }
    }
  };

  // Throttled tool status updates (avoids Telegram 429 Flood Control)
  let lastStatusEdit = 0;
  let pendingStatusTimer: any = null;

  const flushStatusUpdate = async () => {
    if (pendingStatusTimer) {
      clearTimeout(pendingStatusTimer);
      pendingStatusTimer = null;
    }
    const preview = toolLog.slice(-3).join("\n");
    const statusHtml = `⚙️ <b>Executing Tools:</b>\n${preview}`;
    try {
      if (!statusMessageId) {
        const sent = await ctx.reply(statusHtml, { parse_mode: "HTML" });
        statusMessageId = sent.message_id;
      } else {
        await ctx.api.editMessageText(chatId, statusMessageId, statusHtml, { parse_mode: "HTML" });
      }
      lastStatusEdit = Date.now();
    } catch {
      // Ignore intermediate UI edit errors
    }
  };

  const scheduleStatusUpdate = () => {
    const now = Date.now();
    if (now - lastStatusEdit >= 1500) {
      flushStatusUpdate();
    } else if (!pendingStatusTimer) {
      pendingStatusTimer = setTimeout(flushStatusUpdate, 1500 - (now - lastStatusEdit));
    }
  };

  const unsubscribe = entry.session.subscribe(async (event) => {
    try {
      if (event.type === "message_update") {
        if (event.assistantMessageEvent.type === "text_delta") {
          fullResponse += event.assistantMessageEvent.delta;
        }
      } else if (event.type === "message_end") {
        if (event.message?.role === "assistant") {
          if (event.message.errorMessage) {
            modelErrorMessage = event.message.errorMessage;
          }
          const content = (event.message as any).content;
          const hasToolCalls = Array.isArray(content) && content.some((c: any) => c.type === "toolCall");
          const text = Array.isArray(content)
            ? content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim()
            : "";
          if (text) {
            // Set synchronously before any await so the turn-end loop sees it
            // (prevents double-delivery race with async subscribe handler).
            intermediateDelivered = true;
            sendTurnResponse(text).catch(() => {});
          }
        }
      } else if (event.type === "agent_end") {
        const lastMsg = event.messages?.[event.messages.length - 1];
        if (lastMsg?.role === "assistant" && lastMsg.errorMessage) {
          modelErrorMessage = lastMsg.errorMessage;
        }
      } else if (event.type === "tool_execution_start") {
        const line = formatToolStatus(event.toolName, event.args);
        console.log(`⚙️ [Tool Call] ${event.toolName}: ${JSON.stringify(event.args || {})}`);
        toolLog.push(line);
        scheduleStatusUpdate();
      }
    } catch {
      // Ignore intermediate streaming errors
    }
  });

  const isTransientNetworkError = (msg: string | null | undefined): boolean => {
    if (!msg) return false;
    const lower = msg.toLowerCase();
    return (
      lower.includes("socket connection was closed") ||
      lower.includes("fetch failed") ||
      lower.includes("econnreset") ||
      lower.includes("etimedout") ||
      lower.includes("socket hang up") ||
      lower.includes("network error") ||
      lower.includes("terminated")
    );
  };

  try {
    let retryCount = 0;
    const maxRetries = 1;

    while (retryCount <= maxRetries) {
    try {
      await entry.session.prompt(input.text, { images: input.images.length > 0 ? (input.images as any) : undefined });

      // If aborted mid-flight, immediately exit cleanly
      if (entry.aborted) {
        if (statusMessageId) {
          const msgIdToDelete = statusMessageId;
          statusMessageId = null;
          await ctx.api.deleteMessage(chatId, msgIdToDelete).catch(() => {});
        }
        return;
      }

      // Check if transient network drop happened on model stream
      if (modelErrorMessage && isTransientNetworkError(modelErrorMessage) && retryCount < maxRetries) {
        console.warn(
          `⚠️ Transient socket drop: "${modelErrorMessage}". Auto-retrying prompt in 2.5s (attempt ${retryCount + 1}/${maxRetries})...`
        );
        retryCount++;
        modelErrorMessage = null;
        fullResponse = "";
        conversationalResponses.length = 0;
        await new Promise((resolve) => setTimeout(resolve, 2500));
        continue;
      }

      // Clean up status message if exists
      if (statusMessageId) {
        const msgIdToDelete = statusMessageId;
        statusMessageId = null;
        await ctx.api.deleteMessage(chatId, msgIdToDelete).catch(() => {});
      }

      if (modelErrorMessage) {
        await ctx.reply(`❌ <b>Model Error:</b>\n<pre>${escapeHtml(modelErrorMessage)}</pre>`, {
          parse_mode: "HTML",
        });
        return;
      }

      // Deliver all completed conversational responses deterministically (prevents duplicate sends)
      // Skip final delivery if intermediate reply was already delivered immediately
      if (!intermediateDelivered) {
        if (conversationalResponses.length > 0) {
          for (const resp of conversationalResponses) {
            await sendTurnResponse(resp);
          }
        } else if (fullResponse && fullResponse.trim()) {
          await sendTurnResponse(fullResponse);
        } else {
          await sendTurnResponse("*(Completed with no text output)*");
        }
      }

      const elapsedSec = ((Date.now() - turnStartTime) / 1000).toFixed(2);
      console.log(`✅ [Prompt Turn Complete] Finished in ${elapsedSec}s.`);
      break;
    } catch (err: any) {
      if (isTransientNetworkError(err?.message) && retryCount < maxRetries) {
        console.warn(`⚠️ Transient socket error caught: "${err.message}". Auto-retrying in 2.5s...`);
        retryCount++;
        modelErrorMessage = null;
        fullResponse = "";
        conversationalResponses.length = 0;
        await new Promise((resolve) => setTimeout(resolve, 2500));
        continue;
      }

      if (statusMessageId) {
        await ctx.api.deleteMessage(chatId, statusMessageId).catch(() => {});
      }
      if (!entry.aborted) {
        await ctx.reply(`❌ <b>Execution Error:</b>\n<pre>${escapeHtml(err.message)}</pre>`, {
          parse_mode: "HTML",
        });
      }
      break;
    }
  }
} finally {
    clearInterval(typingInterval);
    if (pendingStatusTimer) clearTimeout(pendingStatusTimer);
    unsubscribe();
    entry.isProcessing = false;
  }
});

// Global Error handling
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`[Telegram Error] on update ${ctx?.update?.update_id}:`, err.error);
});

// Launch Gateway with auto-reconnecting resilience
async function main() {
  // Check if an instance is already running
  const lock = SingleInstanceGuard.acquire();
  if (!lock.acquired) {
    console.log("\n=======================================================");
    console.log("⚠️  PI TELEGRAM GATEWAY IS ALREADY RUNNING!");
    console.log(`🆔 Active Process PID: ${lock.existingPid}`);
    console.log("=======================================================");
    console.log("💡 Useful commands:");
    console.log("   • View live metrics: npm run status");
    console.log("   • Restart gateway:   npm run restart");
    console.log(`   • Stop gateway:      kill ${lock.existingPid}\n`);
    process.exit(0);
  }

  console.log("Initializing Pi Session Services (extensions, skills, models)...");
  await sessionPool.init();

  const runTelegram = config.mode === "dual" || config.mode === "telegram";
  const runDiscord = (config.mode === "dual" || config.mode === "discord") && !!config.discordBotToken;

  console.log("Initializing Cron Scheduler...");
  cronScheduler.init(runTelegram ? bot : null);

  // Initialize Discord Gateway if enabled
  if (runDiscord) {
    try {
      console.log("Starting Discord Gateway client...");
      await discordClient.login(config.discordBotToken);
    } catch (dErr: any) {
      console.error("⚠️ Failed to initialize Discord Gateway:", dErr.message);
    }
  }

  if (runTelegram) {
    console.log("Starting Pi Telegram Gateway with Concurrent Runner...");

  let runner: RunnerHandle | null = null;
  let retryDelay = 2000;
  while (true) {
    try {
      await bot.api.deleteWebhook({ drop_pending_updates: false });
      await bot.init();
      const botInfo = bot.botInfo;
      healthMonitor.init(botInfo);
      console.log(`🚀 Pi Telegram Gateway active as @${botInfo.username}`);
      console.log(`📂 Working Directory: ${config.defaultCwd}`);
      console.log(`💾 Sessions Directory: ${config.sessionsDir}`);
      if (config.allowedUsers.length > 0) {
        console.log(`🔐 Allowed User IDs: ${config.allowedUsers.join(", ")}`);
      } else {
        console.log("⚠️ No ALLOWED_USERS configured (open to any Telegram user)");
      }

      // Hardened long-polling runner:
      // - 41s fetch timeout matched with Discord WebSocket heartbeat (41.25s) and 55s client timeout
      // - Fixed 2000ms retryInterval (prevents unbounded exponential backoff lockup during Android sleep/network drops)
      // - silent: true suppresses repetitive runner stack trace dumping during network drops
      runner = run(bot, {
        runner: {
          fetch: {
            timeout: 41,
          },
          retryInterval: 2000,
          silent: true,
        },
      });

      // Graceful shutdown handling
      const shutdown = async () => {
        console.log("\n🛑 Stopping Pi Telegram Gateway...");
        SingleInstanceGuard.release();
        healthMonitor.destroy();
        cronScheduler.destroy();
        sessionPool.destroy();
        try {
          if (discordClient.isReady()) {
            await discordClient.destroy();
          }
        } catch {}
        try {
          if (runner && runner.isRunning()) {
            await runner.stop();
          }
        } catch {}
        process.exit(0);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);

      await runner.task();
      break;
    } catch (err: any) {
      console.error(`⚠️ Network / Runner error (${err.message}). Auto-reconnecting in ${retryDelay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retryDelay = Math.min(retryDelay * 1.5, 30000);
    }
  }
  } else {
    // Standalone Discord Mode
    healthMonitor.init({ username: "Hermes_maid_bot", id: 1534861950390112277 });
    console.log("🎮 Standalone Discord Gateway active! (Telegram mode disabled)");
    await new Promise(() => {});
  }
}

// Global Process Exception Protection (Prevents daemon crashes on transient network drops)
process.on("unhandledRejection", (reason: any) => {
  console.error("⚠️ [Process Unhandled Rejection]:", reason?.message || reason);
});

process.on("uncaughtException", (err: Error) => {
  console.error("⚠️ [Process Uncaught Exception]:", err.message, err.stack);
});

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
