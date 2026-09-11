import os from "os";
import fs from "fs";
import path from "path";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Message,
  ChatInputCommandInteraction,
} from "discord.js";
import { config } from "./config";
import { sessionPool, type Model } from "./session-pool";
import { cronScheduler } from "./cron-scheduler";
import { splitDiscordMessage, formatDiscordToolStatus } from "./discord-utils";
import { getActiveTunnelInfo, startTunnel, stopTunnel } from "./tunnel-manager";
import { gatewayLogger } from "./logger";

gatewayLogger.init();

if (!config.discordBotToken) {
  console.error("❌ ERROR: DISCORD_BOT_TOKEN is not defined in environment or .env!");
  process.exit(1);
}

export const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// Track default channel for cron broadcasts with persistence
const homeChannelFile = path.join(config.sessionsDir, "discord-home-channel.txt");
let defaultBroadcastChannelId: string | null = null;
try {
  if (fs.existsSync(homeChannelFile)) {
    const saved = fs.readFileSync(homeChannelFile, "utf-8").trim();
    if (saved) defaultBroadcastChannelId = saved;
  }
} catch {}

discordClient.once("ready", (client) => {
  console.log(`🤖 Discord Gateway active as ${client.user.tag} (ID: ${client.user.id})`);
  console.log(`📁 Working Directory: ${config.defaultCwd}`);
  console.log(`💾 Sessions Directory: ${config.sessionsDir}`);
  if (defaultBroadcastChannelId) {
    console.log(`🏠 Discord Cron Home Channel: ${defaultBroadcastChannelId}`);
  }
  if (config.discordAllowedUsers.length > 0) {
    console.log(`🔐 Allowed Discord User IDs: ${config.discordAllowedUsers.join(", ")}`);
  } else {
    console.log("ℹ️ No DISCORD_ALLOWED_USERS configured (open access)");
  }

  // Register cron dual-broadcasting handler
  cronScheduler.setDiscordSender(async (title: string, rawText: string) => {
    if (!defaultBroadcastChannelId) return;
    try {
      const channel = await client.channels.fetch(defaultBroadcastChannelId);
      if (channel && channel.isTextBased()) {
        const full = `${title}\n${rawText}`;
        const chunks = splitDiscordMessage(full);
        for (const chunk of chunks) {
          await (channel as any).send(chunk);
        }
      }
    } catch (e: any) {
      console.error("[Discord Cron Broadcast Error]:", e.message);
    }
  });
});

// Helper to check user authorization
function isUserAllowed(userId: string): boolean {
  if (!config.discordAllowedUsers || config.discordAllowedUsers.length === 0) {
    return true; // Open if not specified
  }
  return config.discordAllowedUsers.includes(userId);
}

/**
 * Shared command executor for both Slash Commands (interactionCreate) and prefix chat messages
 */
async function executeDiscordCommand(
  commandName: string,
  args: string[],
  channelId: string,
  reply: (text: string) => Promise<any>
): Promise<boolean> {
  const sessionKey = `discord_${channelId}`;

  // /help or /start
  if (commandName === "start" || commandName === "help") {
    const help = [
      "🤖 **Pi Coding Agent Discord Gateway**",
      "",
      "Pi is a minimalist, tool-augmented coding assistant running directly on your host/Termux device.",
      "",
      "**Available Commands:**",
      "• `/status` — View active session info, model, and context window",
      "• `/model [name]` — Switch or view available LLM models (`antigravity/gemini-3.7-flash`)",
      "• `/thinking [level]` — View or switch reasoning level (`off`, `low`, `medium`, `high`, `max`)",
      "• `/steer <instruction>` — Redirect or modify active agent execution mid-flight",
      "• `/cron` — View or manage scheduled background tasks (inherited from Telegram)",
      "• `/cron run <id>` — Trigger and execute a scheduled cron task immediately",
      "• `/set-home` — Set current channel as the permanent destination for cron reports",
      "• `/logs [count|error|clear]` — View live gateway execution logs and errors",
      "• `/new` or `/reset` — Clear active context and start a fresh session",
      "• `/compact` — Compact and summarize current conversation history",
      "• `/abort` or `/stop` — Instantly terminate currently running agent turn",
      "",
      "Simply type any coding task or question to get started!",
    ].join("\n");
    await reply(help);
    return true;
  }

  // /logs or /log
  if (commandName === "logs" || commandName === "log") {
    const rawArgs = args.join(" ").trim().toLowerCase();

    // Clear logs
    if (rawArgs === "clear") {
      const success = gatewayLogger.clearLogs();
      await reply(success ? "🗑️ **Gateway logs cleared successfully.**" : "⚠️ Failed to clear gateway logs.");
      return true;
    }

    // Filter errors or custom count
    const isErrorFilter = rawArgs === "error" || rawArgs === "errors" || rawArgs === "warn";
    const numArg = parseInt(rawArgs, 10);
    const limit = !isNaN(numArg) && numArg > 0 ? Math.min(numArg, 40) : isErrorFilter ? 20 : 15;

    const entries = gatewayLogger.getRecentLogs({
      limit,
      level: isErrorFilter ? (rawArgs.includes("warn") ? "WARN" : "ERROR") : "ALL",
    });

    if (entries.length === 0) {
      await reply(`🪵 **No logs recorded matching criteria.**\nFile: \`${gatewayLogger.getLogFilePath()}\``);
      return true;
    }

    const logLines = entries
      .map((e) => {
        const lvlIcon = e.level === "ERROR" ? "❌" : e.level === "WARN" ? "⚠️" : "ℹ️";
        const timeOnly = e.timeStr.includes(",") ? e.timeStr.split(",")[1]?.trim() : e.timeStr;
        return `${timeOnly} ${lvlIcon} [${e.level}] ${e.message}`;
      })
      .join("\n");

    const fileSize = gatewayLogger.getLogFileSizeKb();
    const title = `🪵 **Pi Gateway Logs** (${entries.length} recent, file: ${fileSize} KB):\n\n`;
    const codeBlock = `\`\`\`text\n${logLines.slice(-1800)}\n\`\`\`\n*Filter:* \`/logs error\` | *Count:* \`/logs 30\` | *Clear:* \`/logs clear\``;

    await reply(title + codeBlock);
    return true;
  }

  // /status
  if (commandName === "status") {
    try {
      const entry = await sessionPool.getSession(sessionKey);
      const session = entry.session;
      const model = session.model;
      const thinking = (session as any).thinkingLevel || "off";
      const usedContextTokens = (session as any).usedTokens || 0;
      const maxContextTokens = (session as any).maxTokens || 1_000_000;
      const percent = Math.min(100, Math.round((usedContextTokens / maxContextTokens) * 100));

      const msg = [
        "📊 **Pi Session Status (Discord)**",
        `• **Session ID:** \`${session.sessionId}\``,
        `• **Model:** \`${model ? `${model.provider}/${model.id}` : "default"}\``,
        `• **Thinking Level:** \`${thinking}\``,
        `• **Context Window:** ${usedContextTokens.toLocaleString()} / ${maxContextTokens.toLocaleString()} tokens (${percent}%)`,
        `• **Active Processing:** ${entry.isProcessing ? "⚡ Busy" : "✅ Idle"}`,
      ].join("\n");
      await reply(msg);
    } catch (err: any) {
      await reply(`⚠️ Failed to fetch status: ${err.message}`);
    }
    return true;
  }

  // /model
  if (commandName === "model") {
    const targetModel = args.join(" ").trim();
    if (targetModel) {
      try {
        const switched = await sessionPool.setModel(sessionKey, targetModel);
        if (switched) {
          const thinkNote = switched.thinkingLevel ? `\n🧠 **Thinking Level:** \`${switched.thinkingLevel}\`` : "";
          await reply(`✅ Switched model to: \`${switched.model.provider}/${switched.model.id}\`${thinkNote}`);
        } else {
          await reply(`⚠️ Model not found: \`${targetModel}\``);
        }
      } catch (err: any) {
        await reply(`⚠️ Error setting model: ${err.message}`);
      }
      return true;
    }

    try {
      const entry = await sessionPool.getSession(sessionKey);
      const current = entry.session.model;
      const services = sessionPool.getServices();
      const available = services?.modelRuntime ? await services.modelRuntime.getAvailable() : [];
      let text = `🤖 **Current Model:** \`${current ? `${current.provider}/${current.id}` : "default"}\`\n\n`;
      if (available.length > 0) {
        text += `**Available Models (${available.length}):**\n`;
        for (const m of available.slice(0, 10)) {
          text += `• \`${m.provider}/${m.id}\`\n`;
        }
        if (available.length > 10) text += `*...and ${available.length - 10} more*\n`;
        text += `\nSwitch with: \`/model <provider/model-id>\` or with thinking \`/model <name>:<level>\``;
      }
      await reply(text);
    } catch (err: any) {
      await reply(`⚠️ Error: ${err.message}`);
    }
    return true;
  }

  // /thinking
  if (commandName === "thinking") {
    const targetLevel = args.join(" ").trim().toLowerCase();
    if (targetLevel === "next" || targetLevel === "cycle") {
      try {
        const res = await sessionPool.cycleThinkingLevel(sessionKey);
        await reply(`🧠 Thinking level cycled to: \`${res.level}\` (previous: \`${res.previous}\`)`);
      } catch (e: any) {
        await reply(`⚠️ Error cycling thinking: ${e.message}`);
      }
      return true;
    }
    if (targetLevel) {
      try {
        const res = await sessionPool.setThinkingLevel(sessionKey, targetLevel);
        await reply(`🧠 Thinking level set to: \`${res.level}\` (previous: \`${res.previous}\`)`);
      } catch (e: any) {
        await reply(`⚠️ Error setting thinking: ${e.message}`);
      }
      return true;
    }
    try {
      const info = await sessionPool.getThinkingInfo(sessionKey);
      let msg = `🧠 **Current Thinking Level:** \`${info.current}\`\n`;
      msg += `• Supports Reasoning: ${info.supportsThinking ? "✅ Yes" : "❌ No"}\n\n`;
      msg += `**Available Levels:**\n`;
      for (const l of info.available) {
        const mark = l.toLowerCase() === info.current.toLowerCase() ? "👉 " : "• ";
        msg += `${mark}\`${l}\`\n`;
      }
      msg += `\nUse \`/thinking <level>\` or \`/thinking next\`.`;
      await reply(msg);
    } catch (e: any) {
      await reply(`⚠️ Error: ${e.message}`);
    }
    return true;
  }

  // /cron [run|pause|resume|logs]
  if (commandName === "cron") {
    const sub = args[0]?.toLowerCase();
    const targetId = args[1]?.trim();

    // 1. Manual run trigger: /cron run <id>
    if (sub === "run") {
      if (!targetId) {
        await reply("⚠️ Mohon cantumkan ID cron job: `/cron run <id>`\nContoh: `/cron run pengingat_jadwal_harian`");
        return true;
      }
      const job = cronScheduler.getJob(targetId);
      if (!job) {
        await reply(`⚠️ Job dengan ID \`${targetId}\` tidak ditemukan. Ketik \`/cron\` untuk melihat daftar ID yang valid.`);
        return true;
      }
      await reply(`⏳ Menjalankan scheduled job **${job.name || job.id}** (\`${job.id}\`) sekarang...`);
      try {
        await cronScheduler.executeJob(job.id, true);
        await reply(`✅ Eksekusi manual **${job.name || job.id}** selesai! Laporan telah dikirimkan.`);
      } catch (err: any) {
        await reply(`❌ Eksekusi manual gagal: ${err.message}`);
      }
      return true;
    }

    // 2. Pause / Resume
    if (sub === "pause" || sub === "resume" || sub === "toggle") {
      if (!targetId) {
        await reply(`⚠️ Mohon cantumkan ID: \`/cron ${sub} <id>\``);
        return true;
      }
      if (sub === "pause") {
        const ok = cronScheduler.pauseJob(targetId);
        await reply(ok ? `⏸️ Job \`${targetId}\` dinonaktifkan.` : `⚠️ Job tidak ditemukan.`);
        return true;
      }
      if (sub === "resume") {
        const ok = cronScheduler.resumeJob(targetId);
        await reply(ok ? `▶️ Job \`${targetId}\` diaktifkan kembali.` : `⚠️ Job tidak ditemukan.`);
        return true;
      }
    }

    // 3. View Logs
    if (sub === "logs" || sub === "history") {
      if (targetId) {
        const specificJob = cronScheduler.getJob(targetId);
        if (!specificJob) {
          await reply(`⚠️ Job dengan ID \`${targetId}\` tidak ditemukan.`);
          return true;
        }
      }

      const jobLogs = cronScheduler.getLogs(targetId || undefined, 5);
      if (jobLogs.length === 0 || jobLogs.every((j) => j.logs.length === 0)) {
        await reply("ℹ️ Belum ada catatan riwayat eksekusi cron.");
        return true;
      }
      let logMsg = "📋 **Cron Execution History:**\n\n";
      for (const { job, logs } of jobLogs) {
        if (logs.length === 0) continue;
        const mode = job.noAgent ? "⚡ Script" : "🧠 Agent";
        logMsg += `• **${job.name || job.id}** [${mode}] (\`${job.id}\`):\n`;
        for (const e of logs.slice(-5).reverse()) {
          const time = new Date(e.runAt).toLocaleString("id-ID", {
            timeZone: job.timezone || config.defaultTimezone,
          });
          const icon = e.status === "success" ? "✅" : "❌";
          const dur = ((e.durationMs || 0) / 1000).toFixed(2) + "s";
          const runTag = e.isManual ? " *(manual)*" : "";
          const preview = (e.outputSnippet || e.error || "Done").replace(/\n+/g, " ").slice(0, 60);
          logMsg += `  ${icon} ${time} (${dur})${runTag} -> ${preview}\n`;
        }
        logMsg += "\n";
      }
      await reply(logMsg);
      return true;
    }

    // 4. Default: List jobs with clear visible IDs
    try {
      const jobs = cronScheduler.listJobs();
      if (jobs.length === 0) {
        await reply("ℹ️ Tidak ada scheduled cron jobs yang terdaftar.");
        return true;
      }
      let report = `⏰ **Scheduled Cron Jobs (${jobs.length} total):**\n\n`;
      for (const job of jobs) {
        const mode = job.noAgent ? "⚡ Script" : "🧠 Agent";
        const status = job.enabled ? "✅ Active" : "⏸️ Paused";
        report += `• **${job.name || job.id}** [${mode}] — ${status}\n`;
        report += `  • **ID:** \`${job.id}\`\n`;
        report += `  • **Schedule:** \`${job.cronExpression}\` | Timezone: \`${job.timezone || config.defaultTimezone}\`\n`;
        report += `  • **Next Run:** \`${job.nextRun || "N/A"}\`\n`;
        if (job.lastRun) {
          const timeStr = new Date(job.lastRun).toLocaleString("id-ID", {
            timeZone: job.timezone || config.defaultTimezone,
          });
          report += `  • **Last Run:** ${job.lastStatus === "success" ? "✅" : "❌"} ${timeStr} (${((job.lastDurationMs || 0) / 1000).toFixed(2)}s)\n`;
        }
        report += "\n";
      }
      report += `💡 **Commands:**\n• \`/cron run <id>\` — Jalankan job secara manual sekarang\n• \`/cron logs [id]\` — Lihat log eksekusi\n• \`/cron pause <id>\` / \`/cron resume <id>\` — Jeda/lanjutkan jadwal\n• \`/set-home\` — Kunci kanal ini sebagai target siaran cron`;
      await reply(report);
    } catch (err: any) {
      await reply(`⚠️ Gagal mengambil cron jobs: ${err.message}`);
    }
    return true;
  }

  // /tunnel, /tunnel-open, /tunnel-close
  if (commandName === "tunnel" || commandName === "tunnel-open" || commandName === "tunnel-close") {
    const sub = args[0]?.toLowerCase();
    if (commandName === "tunnel-close" || sub === "close" || sub === "stop") {
      const res = await stopTunnel();
      await reply(res.message.replace(/<[^>]*>/g, ""));
      return true;
    }
    if (commandName === "tunnel-open" || sub === "open" || sub === "start" || sub === "restart") {
      await reply("⏳ **Menghubungkan SSH tunnel ke Cloudflare...** Mohon tunggu...");
      const res = await startTunnel(sub === "restart");
      await reply(res.message.replace(/<[^>]*>/g, ""));
      return true;
    }
    const info = getActiveTunnelInfo();
    if (info.active && info.url) {
      const username = process.env.USER || process.env.LOGNAME || os.userInfo()?.username || "user";
      const sshCmd = `ssh -p 8022 -o ProxyCommand='cloudflared access ssh --hostname %h' ${username}@${info.host}`;
      await reply(
        `🟢 **SSH Cloudflare Tunnel Aktif!**\n• **URL:** \`${info.url}\`\n• **Host:** \`${info.host}\`\n• **PID:** \`${info.pid}\`\n\n**Perintah SSH:**\n\`${sshCmd}\``
      );
    } else {
      await reply("⚪ **Cloudflare SSH Tunnel saat ini INAKTIF.**\nKetik `/tunnel-open` untuk membuka akses remote.");
    }
    return true;
  }

  // /set-home or /sethome
  if (commandName === "set-home" || commandName === "sethome") {
    defaultBroadcastChannelId = channelId;
    try {
      fs.writeFileSync(homeChannelFile, channelId, "utf-8");
      await reply(
        `🏠 **Home Channel Berhasil Disetel!**\nKanal ini (<#${channelId}>) sekarang dikunci sebagai target siaran laporan otomatis (**Cron Broadcast Target**).\nSeluruh jadwal pengingat mengajar dan briefing berita akan otomatis mendarat di sini secara persisten.`
      );
    } catch (err: any) {
      await reply(`⚠️ Gagal menyimpan home channel ke disk: ${err.message}`);
    }
    return true;
  }

  // /new or /reset
  if (commandName === "new" || commandName === "reset") {
    try {
      const session = await sessionPool.resetSession(sessionKey);
      await reply(`✨ **Session Reset!** Started fresh session:\n\`${session.sessionId}\``);
    } catch (err: any) {
      await reply(`⚠️ Reset failed: ${err.message}`);
    }
    return true;
  }

  // /compact or /compress
  if (commandName === "compact" || commandName === "compress") {
    try {
      const result = await sessionPool.compactSession(sessionKey);
      await reply(`🗜️ **Context Compacted**: ${result}`);
    } catch (err: any) {
      await reply(`⚠️ Compact failed: ${err.message}`);
    }
    return true;
  }

  // /abort or /stop
  if (commandName === "abort" || commandName === "stop") {
    try {
      const aborted = await sessionPool.abortPrompt(sessionKey);
      if (aborted) {
        await reply("🛑 **Active execution aborted immediately.**");
      } else {
        await reply("ℹ️ No execution is currently active in this channel.");
      }
    } catch (err: any) {
      await reply(`⚠️ Abort failed: ${err.message}`);
    }
    return true;
  }

  // /steer
  if (commandName === "steer") {
    const instruction = args.join(" ").trim();
    if (!instruction) {
      await reply("⚠️ Usage: `/steer <instruction to redirect agent plan>`");
      return true;
    }
    try {
      const entry = await sessionPool.getSession(sessionKey);
      if (entry.isProcessing || entry.session.isStreaming) {
        await (entry.session as any).steer(instruction);
        await reply(`🎯 **Agent Steered**: \`"${instruction}"\``);
      } else {
        await reply("ℹ️ No active turn to steer. Send as a regular prompt instead.");
      }
    } catch (err: any) {
      await reply(`⚠️ Steer failed: ${err.message}`);
    }
    return true;
  }

  // Informative fallback for other legacy Hermes slash commands
  if (["whoami", "profile", "version", "diff"].includes(commandName)) {
    await reply(`ℹ️ **Hermes Pi Gateway**: \`/${commandName}\` is active. Model: \`${config.defaultModel || "antigravity/gemini-3.7-flash"}\`. Type \`/status\` or ask any task.`);
    return true;
  }

  return false;
}

// 1. Handle Native Discord Slash Commands (interactionCreate)
discordClient.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const userId = interaction.user.id;
  const channelId = interaction.channelId;
  defaultBroadcastChannelId = channelId;

  // Crucial: Defer reply immediately (<3s SLA) to prevent "The application did not respond"
  await interaction.deferReply().catch(() => {});

  if (!isUserAllowed(userId)) {
    await interaction.editReply(`⛔ **Access Denied**: Your Discord User ID is \`${userId}\`. Add this ID to \`DISCORD_ALLOWED_USERS\` in \`.env\`.`).catch(() => {});
    return;
  }

  const cmdName = interaction.commandName.toLowerCase();
  const args: string[] = [];
  for (const opt of interaction.options.data) {
    if (opt.value !== undefined) {
      args.push(String(opt.value));
    }
  }

  const handled = await executeDiscordCommand(cmdName, args, channelId, async (text) => {
    const chunks = splitDiscordMessage(text);
    if (chunks.length > 0 && chunks[0]) {
      await interaction.editReply(chunks[0]).catch(() => {});
      for (let i = 1; i < chunks.length; i++) {
        if (chunks[i]) {
          await interaction.followUp(chunks[i]!).catch(() => {});
        }
      }
    }
  });

  if (!handled) {
    await interaction.editReply(`ℹ️ Slash command \`/${cmdName}\` received. Use \`/help\` for available Pi Agent commands.`).catch(() => {});
  }
});

// 2. Handle Text Messages & Prefix Commands (messageCreate)
discordClient.on("messageCreate", async (message: Message) => {
  if (message.author.bot) return;

  const userId = message.author.id;
  const channelId = message.channel.id;
  defaultBroadcastChannelId = channelId;

  if (!isUserAllowed(userId)) {
    await message.reply(`⛔ **Access Denied**: Your Discord User ID is \`${userId}\`. Add this ID to \`DISCORD_ALLOWED_USERS\` in \`.env\`.`);
    return;
  }

  const rawContent = message.content.trim();
  const sessionKey = `discord_${channelId}`;

  // Prefix / Slash commands typed as text
  if (rawContent.startsWith("/") || rawContent.startsWith("!")) {
    const withoutPrefix = rawContent.slice(1).trim();
    const [cmd, ...args] = withoutPrefix.split(/\s+/);
    if (!cmd) return;
    const commandName = cmd.toLowerCase();

    const handled = await executeDiscordCommand(commandName, args, channelId, async (text) => {
      const chunks = splitDiscordMessage(text);
      for (const c of chunks) {
        await message.reply(c);
      }
    });

    if (handled) return;
  }

  // Conversational Message Execution
  let promptText = rawContent;
  const imageAttachments: any[] = [];

  if (message.attachments.size > 0) {
    for (const [, att] of message.attachments) {
      if (att.contentType?.startsWith("image/")) {
        imageAttachments.push({
          type: "image",
          data: att.url,
          mimeType: att.contentType,
        });
      }
    }
  }

  if (!promptText && imageAttachments.length === 0) return;

  const entry = await sessionPool.getSession(sessionKey);

  // If already busy: Queue as Follow-up!
  if (entry.isProcessing || entry.session.isStreaming) {
    try {
      await entry.session.followUp(promptText, imageAttachments.length > 0 ? (imageAttachments as any) : undefined);
      const preview = promptText.length > 80 ? promptText.slice(0, 77) + "..." : promptText;
      await message.reply(`📥 **Queued Follow-up:** *"${preview}"*\nPi will execute this automatically once the current task completes.`);
    } catch (err: any) {
      await message.reply(`⚠️ Could not queue follow-up: ${err.message}`);
    }
    return;
  }

  // Fresh Turn Execution
  entry.isProcessing = true;
  entry.aborted = false;
  const turnStartTime = Date.now();

  console.log(`💬 [Discord] Prompt from ${message.author.tag} (${userId}): "${promptText.slice(0, 60)}"`);

  // Periodic typing indicator
  const typingInterval = setInterval(() => {
    (message.channel as any).sendTyping().catch(() => {});
  }, 4000);
  (message.channel as any).sendTyping().catch(() => {});

  // Immediate progressive status message
  let statusMsg: Message | null = null;
  try {
    statusMsg = await message.reply("🧠 *Thinking...*");
  } catch (err: any) {
    console.error("Failed to send initial thinking message:", err.message);
  }

  let fullResponse = "";
  let lastEditTime = 0;
  let pendingEditTimer: any = null;
  let currentToolStatus = "";
  const toolHistory: string[] = [];

  const updateDiscordStatus = async (text: string) => {
    if (!statusMsg) return;
    try {
      await (statusMsg as any).edit(text.slice(0, 1950));
    } catch {}
  };

  const scheduleProgressUpdate = () => {
    const now = Date.now();
    if (now - lastEditTime >= 1200) {
      lastEditTime = now;
      if (pendingEditTimer) {
        clearTimeout(pendingEditTimer);
        pendingEditTimer = null;
      }
      let display = "";
      if (currentToolStatus) {
        display = currentToolStatus;
        if (toolHistory.length > 0) {
          const prev = toolHistory.slice(-2).join("\n");
          display = `${prev}\n${currentToolStatus}`;
        }
      } else if (fullResponse.trim()) {
        display = fullResponse.length > 1800 ? fullResponse.slice(0, 1800) + "..." : fullResponse + " ▌";
      } else {
        display = "🧠 *Thinking...*";
      }
      updateDiscordStatus(display);
    } else if (!pendingEditTimer) {
      pendingEditTimer = setTimeout(() => {
        pendingEditTimer = null;
        lastEditTime = Date.now();
        let display = "";
        if (currentToolStatus) {
          display = currentToolStatus;
          if (toolHistory.length > 0) {
            const prev = toolHistory.slice(-2).join("\n");
            display = `${prev}\n${currentToolStatus}`;
          }
        } else if (fullResponse.trim()) {
          display = fullResponse.length > 1800 ? fullResponse.slice(0, 1800) + "..." : fullResponse + " ▌";
        } else {
          display = "🧠 *Thinking...*";
        }
        updateDiscordStatus(display);
      }, 1200 - (now - lastEditTime));
    }
  };

  try {
    const unsub = entry.session.subscribe(async (event: any) => {
      // 1. Tool execution start
      if (event.type === "tool_execution_start") {
        currentToolStatus = formatDiscordToolStatus(event.toolName, event.args);
        console.log(`⚙️ [Discord Tool Call] ${event.toolName}: ${JSON.stringify(event.args || {})}`);
        scheduleProgressUpdate();
      }

      // 2. Tool execution end
      if (event.type === "tool_execution_end") {
        const icon = event.isError ? "❌" : "✅";
        const doneLine = `${icon} \`${event.toolName}\``;
        toolHistory.push(doneLine);
        if (toolHistory.length > 3) toolHistory.shift();
        currentToolStatus = "";
        scheduleProgressUpdate();
      }

      // 3. Assistant text streaming
      if (event.type === "message_update") {
        if (event.assistantMessageEvent?.type === "text_delta") {
          fullResponse += event.assistantMessageEvent.delta;
          if (!currentToolStatus) {
            scheduleProgressUpdate();
          }
        }
      }

      // 4. Turn end
      if (event.type === "turn_end") {
        clearInterval(typingInterval);
        if (pendingEditTimer) {
          clearTimeout(pendingEditTimer);
          pendingEditTimer = null;
        }
      }
    });

    await entry.session.prompt(promptText, imageAttachments.length > 0 ? (imageAttachments as any) : undefined);
    unsub();

    // Finalize response
    clearInterval(typingInterval);
    if (pendingEditTimer) {
      clearTimeout(pendingEditTimer);
      pendingEditTimer = null;
    }

    const duration = ((Date.now() - turnStartTime) / 1000).toFixed(2);
    console.log(`✅ [Discord Turn Complete] Finished in ${duration}s.`);

    // Delete temporary progressive status message cleanly so final reply is a FRESH message
    if (statusMsg) {
      await (statusMsg as any).delete().catch(() => {});
      statusMsg = null;
    }

    if (!fullResponse.trim()) {
      await message.reply("✅ *Done.*").catch(() => {});
      return;
    }

    // Send final response as fresh reply -> TRIGGERS DISCORD PUSH NOTIFICATION & SOUND!
    const chunks = splitDiscordMessage(fullResponse);
    for (const chunk of chunks) {
      await message.reply(chunk).catch(() => {});
    }
  } catch (err: any) {
    clearInterval(typingInterval);
    if (pendingEditTimer) clearTimeout(pendingEditTimer);
    console.error("❌ [Discord Prompt Error]:", err.message);
    if (statusMsg) {
      await (statusMsg as any).edit(`⚠️ **Execution Error**: ${err.message}`).catch(() => {});
    } else {
      await message.reply(`⚠️ **Execution Error**: ${err.message}`).catch(() => {});
    }
  } finally {
    clearInterval(typingInterval);
    if (pendingEditTimer) clearTimeout(pendingEditTimer);
    entry.isProcessing = false;
  }
});

// Run Discord Gateway
export async function startDiscordGateway() {
  await sessionPool.init();
  await discordClient.login(config.discordBotToken);
}

if (import.meta.main) {
  startDiscordGateway().catch((err) => {
    console.error("Fatal Discord Gateway error:", err);
    process.exit(1);
  });
}
