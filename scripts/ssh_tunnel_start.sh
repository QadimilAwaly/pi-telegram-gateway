#!/bin/bash
# SSH tunnel via Cloudflare (on-demand, darurat)
set -u

SSHD_PORT=8022
URL_FILE="$HOME/pi-telegram-gateway/tunnel_url.txt"
PID_FILE="$HOME/pi-telegram-gateway/tunnel.pid"

# Pastikan sshd jalan
if ! pgrep -x sshd >/dev/null; then
  sshd
  sleep 1
fi

# Wake-lock agar tunnel tidak mati saat layar lock
termux-wake-lock 2>/dev/null || true

# Hentikan tunnel lama jika ada
if [ -f "$PID_FILE" ]; then
  OLD=$(cat "$PID_FILE" 2>/dev/null)
  [ -n "$OLD" ] && kill "$OLD" 2>/dev/null
  rm -f "$PID_FILE"
fi

# Jalankan cloudflared
cloudflared tunnel --url ssh://localhost:$SSHD_PORT --no-autoupdate > "$HOME/pi-telegram-gateway/tunnel.log" 2>&1 &
CF_PID=$!
echo "$CF_PID" > "$PID_FILE"

URL=""
for i in $(seq 1 20); do
  URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$HOME/pi-telegram-gateway/tunnel.log" 2>/dev/null | grep -v '^https://api\.trycloudflare\.com$' | tail -n1)
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "$URL" ]; then
  echo "GAGAL: URL tunnel tidak muncul. Cek $HOME/pi-telegram-gateway/tunnel.log" >&2
  exit 1
fi

echo "$URL" > "$URL_FILE"
HOST="${URL#https://}"
echo "TUNNEL AKTIF"
echo "URL: $URL"
USER_NAME=$(whoami 2>/dev/null || echo "${USER:-${LOGNAME:-user}}")
echo "ssh -p $SSHD_PORT -o ProxyCommand='cloudflared access ssh --hostname %h' ${USER_NAME}@$HOST"
