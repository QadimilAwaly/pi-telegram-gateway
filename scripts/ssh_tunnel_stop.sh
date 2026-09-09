#!/bin/bash
PID_FILE="$HOME/pi-telegram-gateway/tunnel.pid"
URL_FILE="$HOME/pi-telegram-gateway/tunnel_url.txt"

stopped=0
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" 2>/dev/null && echo "Tunnel dihentikan (PID $PID)."
    stopped=1
  fi
  rm -f "$PID_FILE"
fi

if [ "$stopped" -eq 0 ]; then
  CPID=$(pgrep -x cloudflared)
  if [ -n "$CPID" ]; then
    kill -9 "$CPID" 2>/dev/null && echo "Cloudflared dihentikan (PID $CPID)."
    stopped=1
  fi
fi

[ "$stopped" -eq 0 ] && echo "Tidak ada tunnel berjalan."

rm -f "$URL_FILE"
echo "Selesai."
