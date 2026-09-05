#!/data/data/com.termux/files/usr/bin/bash
DIR="/data/data/com.termux/files/home/pi-telegram-gateway"
cd "$DIR" || exit 1
bun run src/status.ts
