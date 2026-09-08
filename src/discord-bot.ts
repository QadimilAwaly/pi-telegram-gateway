import {
  Client,
  GatewayIntentBits,
  Partials,
  Message,
  TextChannel,
  DMChannel,
  NewsChannel,
  ThreadChannel,
} from "discord.js";
import { config } from "./config";
import { sessionPool, type Model } from "./session-pool";
import { cronScheduler } from "./cron-scheduler";
import { splitDiscordMessage, formatDiscordToolStatus } from "./discord-utils";
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

// Track default channel for cron broadcasts
let defaultBroadcastChannelId: string | null = null;

discordClient.once("ready", (client) => {
  console.log(`🤖 Discord Gateway active as ${client.user.tag} (ID: ${client.user.id})`);
  console.log(`📁 Working Directory: ${config.defaultCwd}`);
  console.log(`💾 Sessions Directory: ${config.sessionsDir}`);
  if (config.discordAllowedUsers.length > 0) {
    console.log(`🔐 Allowed Discord User IDs: ${config.discordAllowedUsers.join(", ")}`);
  } else {
    console.log("ℹ️ No DISCORD_ALLOWED_USERS configured (open or auto-whitelisting)");
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

discordClient.on("messageCreate", async (message: Message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  const userId = message.author.id;
  const channelId = message.channel.id;
  defaultBroadcastChannelId = channelId;

  // Authorization check
  if (!isUserAllowed(userId)) {
    await message.reply(`⛔ **Access Denied**: Your Discord User ID is \`${userId}\`. Add this ID to \`DISCORD_ALLOWED_USERS\` in \`.env\`.`);
    return;
  }

  const rawContent = message.content.trim();
  const sessionKey = `discord_${channelId}`;

  // 1. Handle Slash / Prefix Commands
  if (rawContent.startsWith("/") || rawContent.startsWith("!")) {
    const withoutPrefix = rawContent.slice(1).trim();
    const [cmd, ...args] = withoutPrefix.split(/\s+/);
    if (!cmd) return;
    const commandName = cmd.toLowerCase();

    // Command: /start or /help
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
        "• `/new` or `/reset` — Clear active context and start a fresh session",
        "• `/compact` — Compact and summarize current conversation history",
        "• `/abort` — Instantly terminate currently running agent turn",
        "",
        "Simply type any coding task or question to get started!",
      ].join("\n");
      await message.reply(help);
      return;
    }

    // Command: /status
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
        await message.reply(msg);
      } catch (err: any) {
        await message.reply(`⚠️ Failed to fetch status: ${err.message}`);
      }
      return;
    }

    // Command: /model
    if (commandName === "model") {
      const targetModel = args.join(" ").trim();
      if (targetModel) {
        try {
          const switched = await sessionPool.setModel(sessionKey, targetModel);
          if (switched) {
            const thinkNote = switched.thinkingLevel ? `\n🧠 **Thinking Level:** \`${switched.thinkingLevel}\`` : "";
            await message.reply(`✅ Switched model to: \`${switched.model.provider}/${switched.model.id}\`${thinkNote}`);
          } else {
            await message.reply(`⚠️ Model not found: \`${targetModel}\``);
          }
        } catch (err: any) {
          await message.reply(`⚠️ Error setting model: ${err.message}`);
        }
        return;
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
        await message.reply(text);
      } catch (err: any) {
        await message.reply(`⚠️ Error: ${err.message}`);
      }
      return;
    }

    // Command: /thinking
    if (commandName === "thinking") {
      const targetLevel = args.join(" ").trim().toLowerCase();
      if (targetLevel === "next" || targetLevel === "cycle") {
        try {
          const res = await sessionPool.cycleThinkingLevel(sessionKey);
          await message.reply(`🧠 Thinking level cycled to: \`${res.level}\` (previous: \`${res.previous}\`)`);
        } catch (e: any) {
          await message.reply(`⚠️ Error cycling thinking: ${e.message}`);
        }
        return;
      }
      if (targetLevel) {
        try {
          const res = await sessionPool.setThinkingLevel(sessionKey, targetLevel);
          await message.reply(`🧠 Thinking level set to: \`${res.level}\` (previous: \`${res.previous}\`)`);
        } catch (e: any) {
          await message.reply(`⚠️ Error setting thinking: ${e.message}`);
        }
        return;
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
        await message.reply(msg);
      } catch (e: any) {
        await message.reply(`⚠️ Error: ${e.message}`);
      }
      return;
    }

    // Command: /cron
    if (commandName === "cron") {
      try {
        const jobs = cronScheduler.listJobs();
        if (jobs.length === 0) {
          await message.reply("ℹ️ No scheduled cron jobs configured.");
          return;
        }
        let reply = `⏰ **Scheduled Cron Jobs (${jobs.length} total):**\n\n`;
        for (const job of jobs) {
          const mode = job.noAgent ? "⚡ Script" : "🧠 Agent";
          const status = job.enabled ? "✅ Active" : "⏸️ Disabled";
          reply += `• **${job.name || job.id}** [${mode}] — ${status}\n`;
          reply += `  Schedule: \`${job.cronExpression}\` | Timezone: \`${job.timezone || "Default"}\`\n`;
          if (job.lastRun) {
            const timeStr = new Date(job.lastRun).toLocaleString("id-ID");
            reply += `  Last Run: ${timeStr} (${job.lastStatus === "success" ? "✅" : "❌"} ${(job.lastDurationMs || 0) / 1000}s)\n`;
          }
          reply += "\n";
        }
        const chunks = splitDiscordMessage(reply);
        for (const c of chunks) await message.reply(c);
      } catch (err: any) {
        await message.reply(`⚠️ Error fetching cron jobs: ${err.message}`);
      }
      return;
    }

    // Command: /new or /reset
    if (commandName === "new" || commandName === "reset") {
      try {
        const session = await sessionPool.resetSession(sessionKey);
        await message.reply(`✨ **Session Reset!** Started a fresh context:\n\`${session.sessionId}\``);
      } catch (err: any) {
        await message.reply(`⚠️ Reset failed: ${err.message}`);
      }
      return;
    }

    // Command: /compact
    if (commandName === "compact") {
      try {
        const result = await sessionPool.compactSession(sessionKey);
        await message.reply(`🗜️ **Context Compacted**: ${result}`);
      } catch (err: any) {
        await message.reply(`⚠️ Compact failed: ${err.message}`);
      }
      return;
    }

    // Command: /abort
    if (commandName === "abort") {
      try {
        const aborted = await sessionPool.abortPrompt(sessionKey);
        if (aborted) {
          await message.reply("🛑 **Active execution aborted immediately.**");
        } else {
          await message.reply("ℹ️ No execution is currently active in this channel.");
        }
      } catch (err: any) {
        await message.reply(`⚠️ Abort failed: ${err.message}`);
      }
      return;
    }

    // Command: /steer <text>
    if (commandName === "steer") {
      const instruction = args.join(" ").trim();
      if (!instruction) {
        await message.reply("⚠️ Usage: `/steer <instruction to redirect agent plan>`");
        return;
      }
      try {
        const entry = await sessionPool.getSession(sessionKey);
        if (entry.isProcessing || entry.session.isStreaming) {
          await (entry.session as any).steer(instruction);
          await message.reply(`🎯 **Agent Steered**: \`"${instruction}"\``);
        } else {
          await message.reply("ℹ️ No active turn to steer. Send as a regular prompt instead.");
        }
      } catch (err: any) {
        await message.reply(`⚠️ Steer failed: ${err.message}`);
      }
      return;
    }
  }

  // 2. Conversational Message Execution
  let promptText = rawContent;
  const imageAttachments: any[] = [];

  // Extract attached images/files
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

  let statusMsg: Message | null = null;
  let fullResponse = "";

  // Helper to send final turn response chunks
  const sendFinalResponse = async (text: string) => {
    if (!text || !text.trim()) return;
    if (statusMsg) {
      await statusMsg.delete().catch(() => {});
      statusMsg = null;
    }
    const chunks = splitDiscordMessage(text);
    for (const chunk of chunks) {
      await message.reply(chunk);
    }
  };

  try {
    const unsub = entry.session.subscribe(async (event: any) => {
      // 1. Tool execution progress
      if (event.type === "tool_start") {
        const toolStatus = formatDiscordToolStatus(event.name, JSON.stringify(event.input || {}));
        if (!statusMsg) {
          statusMsg = await message.reply(toolStatus).catch(() => null);
        } else {
          await statusMsg.edit(toolStatus).catch(() => {});
        }
      }

      // 2. Stream tokens / turn finish
      if (event.type === "message_update" && event.message?.content) {
        for (const part of event.message.content) {
          if (part.type === "text" && part.text) {
            fullResponse = part.text;
          }
        }
      }

      if (event.type === "turn_end") {
        clearInterval(typingInterval);
        const duration = ((Date.now() - turnStartTime) / 1000).toFixed(2);
        console.log(`✅ [Discord Turn Complete] Finished in ${duration}s.`);
        await sendFinalResponse(fullResponse);
      }
    });

    await entry.session.prompt(promptText, imageAttachments.length > 0 ? (imageAttachments as any) : undefined);
    unsub();
  } catch (err: any) {
    clearInterval(typingInterval);
    console.error("❌ [Discord Prompt Error]:", err.message);
    if (statusMsg) await (statusMsg as any).delete().catch(() => {});
    await message.reply(`⚠️ **Execution Error**: ${err.message}`);
  } finally {
    clearInterval(typingInterval);
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
