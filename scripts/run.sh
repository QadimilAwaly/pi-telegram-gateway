#!/data/data/com.termux/files/usr/bin/bash
# ==============================================================================
# Pi Telegram Gateway Daemon Runner for Termux
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SESSIONS_DIR="${SESSIONS_DIR:-$HOME/.pi/telegram-sessions}"
LOCK_FILE="$SESSIONS_DIR/gateway.lock"

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PATH="$HOME/.bun/bin:$PREFIX/bin:$PATH"

cd "$DIR" || exit 1

# 1. Check if an instance is already running before starting
if [ -f "$LOCK_FILE" ]; then
  EXISTING_PID=$(cat "$LOCK_FILE" 2>/dev/null | tr -dc '0-9')
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo ""
    echo "======================================================="
    echo "⚠️  PI TELEGRAM GATEWAY IS ALREADY RUNNING!"
    echo "🆔 Active Process PID: $EXISTING_PID"
    echo "======================================================="
    echo "💡 Commands:"
    echo "   • Check live metrics: npm run status"
    echo "   • Restart gateway:    npm run restart"
    echo "   • Stop gateway:       kill $EXISTING_PID"
    echo ""
    exit 0
  fi
fi

export RUNNER_ACTIVE="1"

# 2. Acquire Termux Wake Lock to prevent CPU sleep on Android
if command -v termux-wake-lock >/dev/null 2>&1; then
  echo "🔒 Acquiring Termux wake lock..."
  termux-wake-lock
fi

echo "🚀 Starting Pi Telegram Gateway..."

# 3. Resilient loop: restarts immediately on code 42, or after 3s on error
while true; do
  bun run src/bot.ts
  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 42 ]; then
    echo "🔄 Gateway restart requested. Restarting immediately..."
    sleep 1
  elif [ $EXIT_CODE -eq 0 ]; then
    echo "🛑 Gateway exited normally."
    break
  else
    echo "⚠️ Gateway exited with code $EXIT_CODE. Restarting in 3 seconds..."
    sleep 3
  fi
done
