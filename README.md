# Pi Telegram Gateway 🤖⚡

A lightweight, powerful Telegram gateway for **Pi Coding Agent**, built using the official `@earendil-works/pi-coding-agent` SDK, [`grammY`](https://grammy.dev/), and `croner`.

---

## Features

- 🛠 **Full Pi Tool Execution:** Runs `bash`, `read`, `write`, `edit`, and all installed skills/extensions.
- 🔄 **Per-Chat Session Persistence:** Each Telegram chat gets its own persistent conversation history and context management.
- 📥 **Follow-up Queueing:** If you send a message while Pi is busy, it is automatically queued as a follow-up task.
- 🧭 **Mid-Flight Steering:** Send `/steer <instruction>` to adjust or redirect the agent's course while it's executing.
- ⏰ **Scheduled Autonomous Cron Jobs:** Create background tasks (e.g. daily briefings, battery monitors) via `/cron`.
- ⚡ **Real-Time Tool Notifications:** Live throttled status updates when Pi executes bash commands or file modifications.
- 🔒 **User Whitelist Security:** Restrict bot access exclusively to authorized Telegram user IDs.
- ✂️ **Smart Message Chunking:** Safely splits long outputs without breaking Telegram HTML formatting or code blocks.
- 🩺 **Terminal Health & Status Dashboard:** Real-time monitoring of process health, memory, active sessions, and uptime.

---

## Quick Setup

### 1. Get a Bot Token
1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Create a new bot with `/newbot` and copy the API token.

### 2. Configure Environment
```bash
cd ~/pi-telegram-gateway
cp .env.example .env
nano .env
```
Set your `TELEGRAM_BOT_TOKEN` and optional `ALLOWED_USERS`.

### 3. Run the Gateway
```bash
cd ~/pi-telegram-gateway

# Foreground run
bun run start

# Daemon runner (with Termux Wake-Lock & auto-restart)
npm run daemon

# Restart background gateway
npm run restart

# Check live status & health
npm run status
```

---

## Checking Gateway Status & Health

You can check the health and live metrics anytime from your terminal:

```bash
cd ~/pi-telegram-gateway
npm run status
```

Or query the local loopback JSON health endpoint:
```bash
curl http://127.0.0.1:4080/health
```

---

## Interactive Telegram Commands

- `/start` & `/help` — Usage guide
- `/new` or `/reset` — Clear conversation and start a new session
- `/status` — View active session info, tokens, and model
- `/model` & `/model <name>` — List or switch active models
- `/steer <instruction>` — Steer active agent execution mid-flight
- `/cron` or `/cron list` — View all scheduled jobs with mode & last duration
- `/cron add "<cron>" <prompt>` — Add autonomous Agent task (reasoning + tools)
- `/cron script "<cron>" <command>` — Add Direct Script task (0 LLM tokens, instant execution)
- `/cron logs [id]` — View execution history, run durations, and output logs
- `/cron run <id>` — Execute a scheduled job immediately
- `/cron pause <id>` & `/cron resume <id>` — Toggle job state
- `/cron rm <id>` — Remove a scheduled job
- `/compact` — Compress conversation context to save tokens
- `/restart` — Reboot & re-initialize the gateway remotely
- `/abort` — Stop an active running prompt
