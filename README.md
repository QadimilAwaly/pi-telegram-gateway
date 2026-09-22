# ⚡ Pi Gateway: Autonomous AI Coding Agent & DevOps Daemon

<p align="center">
  <img src="https://img.shields.io/badge/Runtime-Bun%20v1.3+-FBF0DF?style=for-the-badge&logo=bun&logoColor=black" alt="Bun">
  <img src="https://img.shields.io/badge/Engine-Pi%20Coding%20Agent%20SDK-black?style=for-the-badge&logo=anthropic&logoColor=white" alt="Pi SDK">
  <img src="https://img.shields.io/badge/Channels-Telegram%20%7C%20Discord-blue?style=for-the-badge&logo=telegram&logoColor=white" alt="Channels">
  <img src="https://img.shields.io/badge/Platform-Android%20Termux%20%7C%20Linux-green?style=for-the-badge&logo=linux&logoColor=white" alt="Platform">
  <img src="https://img.shields.io/badge/Tunnel-Cloudflare%20SSH-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare">
  <img src="https://img.shields.io/badge/License-Private%20Proprietary-red?style=for-the-badge" alt="License">
</p>

<p align="center">
  <strong>Transformasikan Android (Termux) atau Linux Server Anda Menjadi Agen AI Otonom 24/7 yang Siap Coding, Mengelola Sistem, dan Menjalankan Otomasi Langsung dari Chat Anda.</strong>
</p>

---

## 🌟 Ikhtisar Produk (Executive Overview)

**Pi Gateway** adalah gateway kelas enterprise generasi baru yang menghubungkan kecerdasan **Pi Coding Agent SDK** langsung ke **Telegram** dan **Discord**. Didesain khusus untuk efisiensi ekstrem dan ketahanan tanpa henti (*zero-downtime*), Pi Gateway memungkinkan Anda mengontrol lingkungan komputasi lokal, mengedit berkas kode, mengeksekusi shell script, mengelola Git, hingga memantau perangkat keras secara interaktif tanpa perlu menyentuh terminal fisik.

Baik Anda sedang di jalan, menghadiri rapat, atau bersantai, asisten coding pribadi Anda selalu aktif di saku celana—siap dipanggil kapan pun untuk debugging, deployment, ataupun riset mendalam.

---

## 🚀 Fitur Unggulan & Pilar Kapabilitas

### 1. 🤖 Dual-Channel Unified Bot Matrix (Telegram & Discord)
* **Fleksibilitas Operasional Penuh:** Berjalan dalam 3 mode fleksibel: `dual` (keduanya aktif simultan), `telegram` (fokus Telegram), atau `discord` (fokus Discord).
* **Cross-Platform Synchronization:** Status sesi, model aktif, dan konfigurasi cron tersinkronisasi harmonis di kedua platform chat.
* **Discord Slash Commands & Text Prefix:** Mendukung interaksi modern Discord Slash Commands (`/status`, `/model`, `/cron`, `/tunnel`) serta obrolan natural dengan auto-complete.
* **Persistent Broadcast Channel (`/set-home`):** Kunci kanal Discord tertentu sebagai pusat siaran laporan cron, pengingat, dan analitik secara permanen.

### 2. ⚡ Eksekusi Coding Otonom Berkemampuan Penuh (Pi SDK Core)
* **Native Tool Augmentation:** Memiliki akses langsung ke perkakas sistem operasi: `bash` (shell execution), `read` (membaca file/gambar), `write` (membuat file baru), dan `edit` (patching file presisi).
* **Multi-Modal Vision Inspection:** Kirimkan foto tangkapan layar bug, arsitektur sistem, atau dokumen via Telegram/Discord—agen akan membaca dan mendiagnosisnya secara visual.
* **Follow-Up Queueing Cerdas:** Mengirim pesan saat Pi sedang sibuk bekerja? Gateway secara otomatis memasukkannya ke antrean follow-up tanpa mengacaukan proses yang berjalan.
* **Mid-Flight Execution Steering (`/steer`):** Arahkan atau ubah instruksi agen di tengah-tengah pengerjaan tugas tanpa perlu membatalkan sesi.

### 3. ⏰ Mesin Penjadwal Otonom Dual-Engine (Autonomous Cron)
* **Mode 1 — Agent Reasoning Mode (`/cron add`):** Tugas dieksekusi oleh LLM lengkap dengan kemampuan penalaran, browsing web, analisis file, dan perbaikan mandiri (misal: *“Cari berita AI terkini dan buatkan rangkuman tiap jam 8 pagi”*).
* **Mode 2 — Direct Script Mode (`/cron script`):** Mengeksekusi script shell langsung tanpa memakan 1 pun token LLM (0 LLM Tokens), secepat kilat dan hemat kuota (misal: *“Cek baterai dan kirim status tiap 2 jam”*).
* **Dual Broadcasting:** Hasil eksekusi cron otomatis dikirimkan serentak ke Telegram dan kanal rumah Discord Anda.
* **Resilience Guard:** Dilengkapi proteksi *Tombstone* (mencegah kebangkitan job yang sudah dihapus), auto-backup `cron-jobs.json.bak`, dan atomic disk writer.

### 4. 🌐 Akses Remote Instan via Cloudflare SSH Tunnel
* **Akses Terminal Dari Mana Saja:** Buka remote terminal Android Termux Anda dari belahan dunia mana pun tanpa IP publik, port forwarding, atau VPS perantara.
* **Manajemen 1-Klik (`/tunnel`):** Buka (`/tunnel-open`) atau tutup (`/tunnel-close`) Cloudflare SSH Tunnel langsung dari chat.
* **Siap Pakai untuk SSH & SCP:** Gateway otomatis menghasilkan perintah terminal lengkap dengan port (`8022`) dan flag proxy SSH Cloudflare yang siap disalin-tempel.

### 5. 📚 3-Tier Session Librarian & Integrasi Mnemosyne
* **Manajemen Memori Terstruktur:** Mengadopsi arsitektur 3-tier Hermes Agent untuk efisiensi penyimpanan:
  1. *Tier 1 (Active Context):* Konteks aktif berjalan ringan di RAM dengan pembersihan idle otomatis.
  2. *Tier 2 (Mnemosyne Distillation):* Intisari percakapan dan keputusan penting diekstrak ke database shared memory lintas-agen.
  3. *Tier 3 (Gzip Soft-Archive):* Sesi lama dikompresi menjadi `.jsonl.gz`, menghemat ruang disk hingga **90%+ tanpa kehilangan data sedikit pun**.
* **Ekspor Markdown Instan (`/archive export`):** Ekspor transkrip percakapan ke file `.md` yang rapi dan siap disinkronkan ke Obsidian atau dokumen kerja.

### 6. 🛡️ Hardened Daemon Architecture & Host Protection
* **Host Safety Guard Extension:** Mencegah agen mengeksekusi perintah bunuh diri (`pkill bun`, `killall node`, atau menghapus direktori gateway) yang dapat mematikan daemon dari dalam.
* **Single Instance Lock:** Mencegah tabrakan proses ganda menggunakan file lock PID otomatis.
* **Smart Throttled Streaming:** Menghindari penalti *Telegram 429 Flood Control* dengan buffer pengiriman dinamis dan algoritma balancing tag HTML/Markdown.
* **Duplicate Log Suppression:** Mencegah log spam dari loop jaringan; mencatat ringkasan frekuensi pengulangan secara elegan.

### 7. 📊 Dashboard Diagnostik & Telemetri Real-Time
* **Terminal Status Command (`npm run status`):** Pantau status runtime, memori RSS/Heap, koneksi Cloud Sync Telegram, status bot Discord, PID, dan uptime dalam visual ANSI yang cantik.
* **Loopback Health API:** Endpoint HTTP internal di `http://127.0.0.1:4080/health` untuk integrasi monitoring uptime monitoring external.
* **Device Battery Telemetry:** Terintegrasi langsung dengan `termux-battery-status` untuk memantau sisa baterai ponsel dan status pengisian daya langsung di chat.

---

## 🧭 Panduan Perintah Interaktif (Command Reference)

### 💬 Perintah Inti Sesi & Kontrol Agen
| Perintah | Deskripsi |
| :--- | :--- |
| `/start` / `/help` | Menampilkan panduan ringkas dan dokumentasi interaktif. |
| `/status` | Menampilkan informasi sesi aktif, konsumsi token konteks, model, baterai, dan tunnel. |
| `/new` atau `/reset` | Mengarsipkan sesi lama dan memulai lembar percakapan baru yang segar. |
| `/compact` | Mengompresi riwayat percakapan untuk menghemat batas konteks jendela model. |
| `/abort` atau `/stop` | Menghentikan secara paksa giliran eksekusi agen yang sedang berjalan. |
| `/steer <instruksi>` | Memberikan arahan baru di tengah-tengah agen sedang berpikir/eksekusi. |
| `/restart` | Melakukan reboot gateway daemon secara bersih dari jarak jauh. |

### 🧠 Manajemen Model & Level Penalaran
| Perintah | Deskripsi |
| :--- | :--- |
| `/model` | Melihat model aktif dan daftar seluruh model AI yang tersedia di runtime. |
| `/model <provider/id>` | Beralih model seketika (contoh: `/model antigravity/gemini-3.7-flash`). |
| `/thinking` | Melihat level reasoning/thinking aktif dan ketersediaannya pada model saat ini. |
| `/thinking <level>` | Mengatur level reasoning (`off`, `low`, `medium`, `high`, `max`). |
| `/thinking next` | Melakukan rotasi level reasoning ke tingkat berikutnya secara cepat. |

### ⏰ Manajemen Tugas Otonom (Cron Scheduler)
| Perintah | Deskripsi |
| :--- | :--- |
| `/cron` | Menampilkan seluruh jadwal tugas, mode eksekusi, jadwal berikutnya, dan status terakhir. |
| `/cron add "<pola>" <prompt>` | Mendaftarkan jadwal tugas Agen (memakai nalar LLM & tools). |
| `/cron script "<pola>" <cmd>` | Mendaftarkan jadwal Script Shell langsung (0 LLM Tokens, instan). |
| `/cron edit <id> [options]` | Mengubah jadwal, nama, prompt, atau mode (script/agent) dari tugas yang ada. |
| `/cron run <id>` | Menjalankan tugas cron secara manual saat ini juga untuk pengujian. |
| `/cron pause <id>` | Menjeda jadwal tugas tertentu sementara waktu. |
| `/cron resume <id>` | Mengaktifkan kembali jadwal tugas yang dijeda. |
| `/cron logs [id]` | Melihat riwayat eksekusi, runtime durasi, dan output dari tugas. |
| `/cron rm <id>` | Menghapus jadwal tugas secara permanen dengan proteksi anti-resurrection. |

### 🌐 Jaringan, Arsip, & Pemeliharaan Sistem
| Perintah | Deskripsi |
| :--- | :--- |
| `/tunnel` | Menampilkan status koneksi Cloudflare SSH Tunnel aktif. |
| `/tunnel-open` | Mengaktifkan Cloudflare SSH tunnel dan memberikan instruksi SSH/SCP. |
| `/tunnel-close` | Mematikan Cloudflare SSH tunnel untuk mengamankan port. |
| `/set-home` | *(Discord)* Mengunci kanal saat ini sebagai tujuan utama siaran cron otomatis. |
| `/archive` | Melihat ringkasan penghematan disk dan daftar arsip `.gz`. |
| `/archive now` | Mengompresi seluruh sesi tidak aktif saat ini juga. |
| `/archive export` | Mengekspor sesi aktif menjadi berkas Markdown (`.md`) di folder Downloads. |
| `/archive restore <id>` | Mendekompresi dan mengembalikan sesi lampau ke folder aktif. |
| `/logs [clear\|error\|<n>]` | Melihat log eksekusi gateway secara langsung dari chat. |

---

## 🛠️ Panduan Instalasi Cepat (Quick Start)

### 1. Prasyarat Sistem
* **Runtime:** [Bun](https://bun.sh/) (v1.2+ disarankan)
* **Environment:** Android Termux (disarankan paket `termux-api`) atau Linux x86_64/ARM64.
* **Token Akses:**
  - Token Bot Telegram dari [@BotFather](https://t.me/BotFather).
  - Token Bot Discord dari [Discord Developer Portal](https://discord.com/developers/applications) *(opsional jika hanya memakai Telegram)*.

### 2. Kloning & Instalasi Dependensi
```bash
git clone https://github.com/earendil-works/pi-telegram-gateway.git ~/pi-telegram-gateway
cd ~/pi-telegram-gateway
bun install
```

### 3. Konfigurasi Lingkungan (`.env`)
Salin berkas contoh dan sesuaikan konfigurasi Anda:
```bash
cp .env.example .env
nano .env
```

Isi variabel penting:
```env
# Mode: dual | telegram | discord
GATEWAY_MODE=dual

# Token Bot
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
DISCORD_BOT_TOKEN=MTE5...

# Keamanan Akses (Pisahkan dengan koma)
ALLOWED_USERS=123456789
DISCORD_ALLOWED_USERS=987654321098765432

# Direktori Kerja Default & Zona Waktu
DEFAULT_CWD=/data/data/com.termux/files/home/pi-telegram-gateway/workspace
DEFAULT_TIMEZONE=Asia/Makassar
DEFAULT_MODEL=antigravity/gemini-3.7-flash
```

---

## 🏃 Menjalankan Gateway

### A. Menjalankan di Foreground (Pengujian)
```bash
bun run start
```

### B. Menjalankan Sebagai Background Daemon (Produksi)
Skrip daemon telah dilengkapi dengan pengambil **Termux Wake-Lock** (mencegah Android membunuh CPU saat layar mati) dan loop auto-restart:
```bash
npm run daemon
```

### C. Me-restart Gateway
```bash
npm run restart
```

### D. Memeriksa Status & Diagnostik Sistem
Cek kesehatan gateway, konsumsi RAM, dan status upstream kapan saja:
```bash
npm run status
```

Output tampilan status interaktif:
```text
=======================================================
             ⚡ PI TELEGRAM GATEWAY STATUS             
=======================================================

⚡ STATUS:              ONLINE (Active) ⚡
🆔 PID:                24422
⏱️  Uptime:             2d 8h 47m 11s
📱 Telegram Bot:       @Hermes_maid_bot (ID: 8192538674)
🎮 Discord Bot:        Connected ⚡
🔒 Access Control:     Whitelist Active (1 user(s))
🧠 Active Model:       antigravity/gemini-3.7-flash
📂 Default CWD:        ~/pi-telegram-gateway/workspace
📊 Memory Footprint:   RSS: 114.3 MB | Heap: 46.5 MB / 56.3 MB
💾 Sessions:           RAM: 0 active | Disk: 10 persisted
📜 Live Logs:          ~/.pi/telegram-sessions/gateway.log (2.1 MB)
☁️  Cloud Sync Status:  Healthy (Synchronized)
🌐 SSH Tunnel:         Active (PID: 26914) https://your-domain.trycloudflare.com
⏰ Scheduled Cron:      7 active job(s)
🩺 Health API:         http://127.0.0.1:4080/health
📦 Storage Path:       ~/.pi/telegram-sessions
=======================================================
```

---

## 🏗️ Arsitektur Sistem

```text
               +--------------------------------------------+
               |        User Interaction Channels           |
               |     Telegram App   |    Discord Client     |
               +--------------------+-----------------------+
                                    |
             (Long-Polling / grammY)| (WebSocket / Discord.js)
                                    v
     +-------------------------------------------------------------+
     |                    PI GATEWAY DAEMON CORE                   |
     |                                                             |
     |  +---------------------+   +-----------------------------+  |
     |  |   Security Guard    |   |     Unified Command Router  |  |
     |  | (PID & Code Shield) |   |  (/status, /model, /cron)   |  |
     |  +---------------------+   +-----------------------------+  |
     |  +---------------------+   +-----------------------------+  |
     |  |   Session Manager   |   |   Dual-Engine Cron Scheduler|  |
     |  | (RAM Pool + Mutex)  |   |  (LLM Agent vs Bash Script) |  |
     |  +---------------------+   +-----------------------------+  |
     |  +---------------------+   +-----------------------------+  |
     |  | 3-Tier Archiver     |   |   Cloudflare Tunnel Manager |  |
     |  | (Gzip + Mnemosyne)  |   |   (SSH Remote Access 8022)  |  |
     |  +---------------------+   +-----------------------------+  |
     +-------------------------------------------------------------+
                                    |
                        (Local SDK Integration)
                                    v
     +-------------------------------------------------------------+
     |                 Pi Coding Agent SDK Engine                  |
     |  - Antigravity / Gemini / Claude / OpenRouter Models        |
     |  - Native Tools: bash, edit, write, read, skills            |
     |  - Multi-Modal Image Processor & Vision Pipelines           |
     +-------------------------------------------------------------+
                                    |
                                    v
     +-------------------------------------------------------------+
     |                 Host Environment (Android Termux)           |
     |  - Local Workspace Codebase, Git Repositories, File System  |
     |  - Device Sensors, Hardware Battery APIs, Python, Shell     |
     +-------------------------------------------------------------+
```

---

## 🧪 Pengujian & Verifikasi Kualitas

Repositori ini menerapkan suite pengujian otomatis menyeluruh via `bun test`:

```bash
# Menjalankan seluruh pengujian unit & integrasi
bun test

# Menjalankan type-checking TypeScript tanpa emisi
bun x tsc --noEmit
```

* **Test Suite yang Dicakup:**
  - `test/cron.test.ts`: Validasi pola cron standar (5 & 6 token), isolasi eksekusi bash, proteksi tombstone, dan persistensi atomik.
  - `test/bot-cron-parsing.test.ts`: Pengujian parser argumen perintah Telegram/Discord yang menangani kutipan kompleks dan flag CLI.
  - `test/telegram-utils.test.ts`: Pengujian pembagian pesan cerdas dan penutupan tag HTML otomatis.
  - `test/thinking.test.ts`: Pengujian inspeksi budget reasoning dan penyesuaian level berpikir model.

---

## 🤝 Berkontribusi & Lisensi

Proyek ini dibangun untuk keandalan maksimal komputasi mandiri (*self-hosted autonomous AI*). Seluruh hak cipta dilindungi. Modifikasi dan penyesuaian diperkenankan untuk kebutuhan deployment pribadi dan riset internal.

<p align="center">
  Dibuat dengan ❤️ dan dedikasi tinggi untuk ekosistem <strong>Pi Coding Agent</strong> & <strong>Android Termux Power Users</strong>.
</p>
