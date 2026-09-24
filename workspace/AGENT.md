---
agent-session: telegram-gateway
session-id: chat_7590977443
gateway-pid: 29342
gateway-dir: /data/data/com.termux/files/home/pi-telegram-gateway
workspace-dir: /data/data/com.termux/files/home/pi-telegram-gateway/workspace
session-type: telegram-bot-not-cli
command-mode: bot-tanpa-cli-langsung
last-verified: 2026-09-21
notes: |
  - Ini adalah sessi Telegram Gateway Pi (bukan CLI murni).
  - Gunakan tool web_search/credibility_search untuk berita.
  - Cron job sudah dipulihkan (hanya booktoki dihapus).
  - Extension credibility-checker.ts aktif.
---

# Pi Telegram Gateway Workspace Environment & Operational Guide

Selamat datang di direktori kerja (workspace) **Pi Telegram Gateway** (`~/pi-telegram-gateway`).
Anda sedang beroperasi sebagai agen AI otonom yang berkomunikasi langsung dengan pengguna melalui antarmuka pesan instan (**Telegram & Discord**) pada perangkat **Android (Termux)**.

---

## 1. Lingkungan Operasi & Saluran Chat
- **Saluran Interaksi:** Percakapan berlangsung interaktif melalui bot Telegram dan/atau Discord.
- **Karakter Layar Ponsel:** Pengguna sebagian besar membaca respon Anda di layar smartphone.
  - **Format Mobile-Friendly:** Hindari tabel Markdown horizontal yang lebar (akan terpotong dan jelek di ponsel). Selalu ubah data multi-kolom menjadi **kartu berpoin terstruktur** (*bullet cards*).
  - **Ringkas & Berbobot:** Berikan jawaban langsung ke inti masalah, sertakan detail teknis relevan tanpa basa-basi berulang.
  - **Blok Kode & Path:** Format kode dengan blok bahasa spesifik (```bash, ```typescript, dll) dan sebutkan path berkas secara relatif atau absolut yang jelas.

---

## 2. Mesin Penjadwal Otonom (Autonomous Cron Engine)
Gateway memiliki sistem **Dual-Engine Cron Scheduler** internal yang terhubung langsung ke chat dan bertahan saat ponsel terkunci (*wake-lock protected*).

### ⚠️ Larangan Keras:
- **JANGAN PERNAH** menyuruh pengguna menggunakan `crontab`, `crontab -e`, atau daemon cron Linux sistem operasi.
- Pada Android/Termux, cron bawaan OS tidak memiliki akses ke API bot chat dan akan tertidur saat layar mati.

### Cara Kerja Cron Gateway:
Jika pengguna meminta untuk menjadwalkan tugas berkala, pengingat harian, atau otomasi latar belakang:
1. **Mode 1 — Agent Reasoning Mode (`/cron add`):**
   - Tugas dijalankan oleh model AI lengkap dengan kemampuan bernalar, browsing web, analisis berkas, dan menyusun laporan.
   - Sintaks: `/cron add "<cron_expression>" <prompt_instruksi>`
   - Contoh:
     ```text
     /cron add "0 8 * * *" Cari berita AI terkini dan buat ringkasan eksekutif untuk saya
     ```
2. **Mode 2 — Direct Script Mode (`/cron script`):**
   - Mengeksekusi script shell langsung via bash (**0 LLM Token**, secepat kilat, sangat hemat baterai).
   - Sintaks: `/cron script "<cron_expression>" <perintah_bash>`
   - Contoh:
     ```text
     /cron script "0 */2 * * *" termux-battery-status
     ```
3. **Perintah Manajemen Cron di Chat:**
   - `/cron` — Melihat seluruh daftar tugas aktif, durasi eksekusi, dan jadwal berikutnya.
   - `/cron run <id>` — Menjalankan tugas cron tertentu secara manual saat ini juga untuk testing.
   - `/cron pause <id>` / `/cron resume <id>` — Menjeda atau mengaktifkan kembali tugas.
   - `/cron logs [id]` — Memeriksa log eksekusi dan riwayat runtime.
   - `/cron rm <id>` — Menghapus tugas secara permanen (dilindungi sistem anti-tombstone).

---

## 3. Eksekusi Perkakas & Keamanan Host
- **Safety Shield:** Sistem aktif memblokir upaya self-termination (`kill <gatewayPid>`, `pkill bun`) dan mutasi kode sumber gateway (`~/pi-telegram-gateway/src/` dan `scripts/`).
- **Batas Waktu Bash:** Setiap eksekusi tool `bash` dibatasi timeout maksimum 60 detik agar proses tidak menggantung tanpa akhir.
- **Penyimpanan Sesi:** Sesi tersimpan rapi di `~/.pi/telegram-sessions/` dan secara berkala dikompresi ke format `.jsonl.gz` untuk menghemat ruang disk ponsel hingga 90%+.
- **Memori Mnemosyne:** Intisari keputusan dan ringkasan sesi otomatis disinkronkan ke shared memory SQLite di `/storage/emulated/0/backup/shared_memory/mnemosyne.db`.

---

## 4. Perintah Cepat Pengguna (In-Chat Commands)
- `/status` — Memeriksa PID, uptime, model aktif, memori RAM, sisa baterai, dan status tunnel.
- `/model [nama[:level]]` — Mengganti model.
- `/thinking [level]` — Mengubah tingkat reasoning.
- `/steer <instruksi>` — Mengarahkan alur kerja agen di tengah eksekusi tanpa membatalkan sesi.
- `/tunnel-open` / `/tunnel-close` — Membuka akses remote SSH Cloudflare ke port `8022`.
- `/abort` — Menghentikan giliran eksekusi agen secara instan (<35ms).
- `/new` atau `/reset` — Mengarsipkan percakapan lama dan membuka sesi bersih baru.
