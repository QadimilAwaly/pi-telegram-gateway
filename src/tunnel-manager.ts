import path from "path";
import fs from "fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TUNNEL_START_SCRIPT = path.resolve(__dirname, "../scripts/ssh_tunnel_start.sh");
const TUNNEL_STOP_SCRIPT = path.resolve(__dirname, "../scripts/ssh_tunnel_stop.sh");
const TUNNEL_URL_FILE = path.resolve(__dirname, "../tunnel_url.txt");
const TUNNEL_PID_FILE = path.resolve(__dirname, "../tunnel.pid");

export interface TunnelInfo {
  active: boolean;
  pid?: number;
  url?: string;
  host?: string;
}

export function getActiveTunnelInfo(): TunnelInfo {
  try {
    if (!fs.existsSync(TUNNEL_PID_FILE)) {
      return { active: false };
    }
    const pidStr = fs.readFileSync(TUNNEL_PID_FILE, "utf8").trim();
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid) || pid <= 0) {
      return { active: false };
    }

    try {
      process.kill(pid, 0);
    } catch {
      return { active: false };
    }

    let url = "";
    if (fs.existsSync(TUNNEL_URL_FILE)) {
      url = fs.readFileSync(TUNNEL_URL_FILE, "utf8").trim();
    }
    const host = url ? url.replace(/^https?:\/\//, "") : "";
    return { active: true, pid, url, host };
  } catch {
    return { active: false };
  }
}

export async function startTunnel(force = false): Promise<{
  success: boolean;
  message: string;
  alreadyActive?: boolean;
  url?: string;
  host?: string;
}> {
  const current = getActiveTunnelInfo();
  if (current.active && current.url && !force) {
    const username = process.env.USER || "u0_a239";
    const host = current.host || "";
    const sshCmd = `ssh -p 8022 -o ProxyCommand='cloudflared access ssh --hostname %h' ${username}@${host}`;
    const scpCmd = `scp -P 8022 -o ProxyCommand='cloudflared access ssh --hostname %h' ${username}@${host}:~/path ./`;

    const text = [
      "ℹ️ <b>Cloudflare SSH Tunnel Sudah Berjalan!</b>",
      "",
      `🔗 <b>URL:</b> <code>${current.url}</code>`,
      `🖥️ <b>Host:</b> <code>${host}</code>`,
      `👤 <b>User:</b> <code>${username}</code>`,
      `🔌 <b>Port:</b> <code>8022</code>`,
      `📦 <b>PID:</b> <code>${current.pid}</code>`,
      "",
      "📋 <b>Perintah SSH:</b>",
      `<code>${sshCmd}</code>`,
      "",
      "📁 <b>Transfer File (SCP):</b>",
      `<code>${scpCmd}</code>`,
      "",
      "💡 <i>Ketik <code>/tunnel-close</code> untuk mematikan tunnel saat selesai.</i>",
    ].join("\n");

    return { success: true, message: text, alreadyActive: true, url: current.url, host };
  }

  try {
    const { stdout, stderr } = await execFileAsync("/data/data/com.termux/files/usr/bin/bash", [TUNNEL_START_SCRIPT], {
      timeout: 30000,
      env: {
        ...process.env,
        PATH: `/data/data/com.termux/files/usr/bin:${process.env.PATH || ""}`,
        HOME: "/data/data/com.termux/files/home",
      },
    });

    const output = (stdout || "").trim();
    let url = "";
    const urlMatch = output.match(/https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com/);
    if (urlMatch) {
      url = urlMatch[0];
    } else if (fs.existsSync(TUNNEL_URL_FILE)) {
      url = fs.readFileSync(TUNNEL_URL_FILE, "utf8").trim();
    }

    if (!url) {
      throw new Error(output || stderr || "URL tunnel tidak ditemukan dalam output script.");
    }

    const host = url.replace(/^https?:\/\//, "");
    const username = process.env.USER || "u0_a239";
    const sshCmd = `ssh -p 8022 -o ProxyCommand='cloudflared access ssh --hostname %h' ${username}@${host}`;
    const scpCmd = `scp -P 8022 -o ProxyCommand='cloudflared access ssh --hostname %h' ${username}@${host}:~/path ./`;

    const text = [
      "🚀 <b>Cloudflare SSH Tunnel Aktif!</b>",
      "",
      `🔗 <b>URL:</b> <code>${url}</code>`,
      `🖥️ <b>Host:</b> <code>${host}</code>`,
      `👤 <b>User:</b> <code>${username}</code>`,
      `🔌 <b>Port:</b> <code>8022</code>`,
      "",
      "📋 <b>Perintah SSH (Salin & Jalankan):</b>",
      `<code>${sshCmd}</code>`,
      "",
      "📁 <b>Transfer File (SCP):</b>",
      `<code>${scpCmd}</code>`,
      "",
      "💡 <i>Ketik <code>/tunnel-close</code> untuk mematikan tunnel saat selesai.</i>",
    ].join("\n");

    return { success: true, message: text, url, host };
  } catch (err: any) {
    const errText = err.stderr || err.stdout || err.message || "Gagal menjalankan tunnel script.";
    return {
      success: false,
      message: `❌ <b>Gagal Membuka Tunnel:</b>\n<pre>${errText}</pre>`,
    };
  }
}

export async function stopTunnel(): Promise<{ success: boolean; message: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("/data/data/com.termux/files/usr/bin/bash", [TUNNEL_STOP_SCRIPT], {
      timeout: 15000,
      env: {
        ...process.env,
        PATH: `/data/data/com.termux/files/usr/bin:${process.env.PATH || ""}`,
        HOME: "/data/data/com.termux/files/home",
      },
    });

    const output = (stdout || stderr || "Tunnel dihentikan.").trim();
    const text = [
      "🛑 <b>Cloudflare SSH Tunnel Ditutup</b>",
      "",
      `<pre>${output}</pre>`,
    ].join("\n");

    return { success: true, message: text };
  } catch (err: any) {
    const errText = err.stderr || err.stdout || err.message || "Gagal menghentikan tunnel.";
    return {
      success: false,
      message: `❌ <b>Gagal Menghentikan Tunnel:</b>\n<pre>${errText}</pre>`,
    };
  }
}
