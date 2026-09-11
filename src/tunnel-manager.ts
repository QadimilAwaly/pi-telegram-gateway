import path from "path";
import fs from "fs";
import os from "os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function getUsername(): string {
  if (process.env.USER) return process.env.USER;
  if (process.env.LOGNAME) return process.env.LOGNAME;
  try {
    const info = os.userInfo();
    if (info?.username) return info.username;
  } catch {}
  return "user";
}

function getTermuxPrefix(): string {
  if (process.env.PREFIX && fs.existsSync(process.env.PREFIX)) {
    return process.env.PREFIX;
  }
  const relativePrefix = path.resolve(os.homedir(), "../usr");
  if (fs.existsSync(relativePrefix)) {
    return relativePrefix;
  }
  return "/usr";
}

function getBashPath(): string {
  const prefix = getTermuxPrefix();
  const prefixBash = path.join(prefix, "bin", "bash");
  if (fs.existsSync(prefixBash)) {
    return prefixBash;
  }
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) {
    return process.env.SHELL;
  }
  if (fs.existsSync("/bin/bash")) {
    return "/bin/bash";
  }
  if (fs.existsSync("/usr/bin/bash")) {
    return "/usr/bin/bash";
  }
  return "bash";
}

function getTunnelEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME || os.homedir();
  const prefix = getTermuxPrefix();
  const binDir = path.join(prefix, "bin");
  const pathEnv = process.env.PATH ? `${binDir}:${process.env.PATH}` : binDir;

  return {
    ...process.env,
    PATH: pathEnv,
    HOME: home,
  };
}

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

export function isProcessMatching(pid: number, expectedBinary: RegExp | string): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  // Guard against PID reuse by inspecting procfs executable identity
  try {
    const commPath = `/proc/${pid}/comm`;
    if (fs.existsSync(commPath)) {
      const comm = fs.readFileSync(commPath, "utf8").trim().toLowerCase();
      if (typeof expectedBinary === "string") {
        if (comm === expectedBinary.toLowerCase() || comm.includes(expectedBinary.toLowerCase())) {
          return true;
        }
      } else if (expectedBinary.test(comm)) {
        return true;
      }
    }

    const cmdlinePath = `/proc/${pid}/cmdline`;
    if (fs.existsSync(cmdlinePath)) {
      const raw = fs.readFileSync(cmdlinePath, "utf8");
      const args = raw.split("\0").filter(Boolean);
      const binaryName = path.basename(args[0] || "").toLowerCase();
      if (typeof expectedBinary === "string") {
        return binaryName === expectedBinary.toLowerCase() || binaryName.includes(expectedBinary.toLowerCase());
      }
      return expectedBinary.test(binaryName);
    }
  } catch {
    // Fallback for non-Linux or restricted procfs
    return true;
  }

  return false;
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

    if (!isProcessMatching(pid, "cloudflared")) {
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
    const username = getUsername();
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
    const { stdout, stderr } = await execFileAsync(getBashPath(), [TUNNEL_START_SCRIPT], {
      timeout: 30000,
      env: getTunnelEnv(),
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
    const username = getUsername();
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
    const { stdout, stderr } = await execFileAsync(getBashPath(), [TUNNEL_STOP_SCRIPT], {
      timeout: 15000,
      env: getTunnelEnv(),
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
