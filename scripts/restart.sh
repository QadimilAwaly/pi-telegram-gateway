#!/data/data/com.termux/files/usr/bin/bash
# ==============================================================================
# Pi Telegram Gateway Restart Utility
# ==============================================================================

DIR="/data/data/com.termux/files/home/pi-telegram-gateway"
HEALTH_FILE="/data/data/com.termux/files/home/.pi/telegram-sessions/gateway-health.json"

cd "$DIR" || exit 1

echo "🔄 Restarting Pi Telegram Gateway..."

# 1. Look for active PID from health file or process table
PID=""
if [ -f "$HEALTH_FILE" ]; then
  PID=$(grep -o '"pid": *[0-9]*' "$HEALTH_FILE" | grep -o '[0-9]*' | head -n 1)
fi

if [ -z "$PID" ]; then
  PID=$(pgrep -f "bun.*src/bot.ts" | head -n 1)
fi

# 2. Stop running process
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  echo "🛑 Stopping active gateway process (PID: $PID)..."
  kill "$PID" 2>/dev/null

  # Wait up to 5 seconds for clean shutdown
  for i in {1..5}; do
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  # Force kill if still lingering
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" 2>/dev/null
  fi
  echo "✅ Process stopped."
else
  echo "ℹ️ No running gateway process found."
fi

# 3. If running inside tmux session "pi-tg", let tmux know or start background daemon
if tmux has-session -t pi-tg 2>/dev/null; then
  echo "📱 Found tmux session 'pi-tg'. Launching inside tmux..."
  tmux send-keys -t pi-tg C-c
  sleep 1
  tmux send-keys -t pi-tg "npm run daemon" C-m
else
  echo "🚀 Starting new daemon in background..."
  nohup ./scripts/run.sh > /dev/null 2>&1 &
fi

sleep 2
echo ""
bun run src/status.ts
