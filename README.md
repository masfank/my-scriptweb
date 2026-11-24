# Lisensi UID — Web License Server untuk Script Lua CGT

Server lisensi berbasis UID: buyer menjalankan loader sekali, server mengembalikan source Lua kalau UID ada di whitelist, atau `ERROR:<alasan>` kalau tidak. Admin mengelola whitelist, script, dan secret lewat panel web.

## Fitur

- `GET /api/verify` — validasi sekali di awal script, balasan **plain text** (Lua CGT tidak punya parser JSON).
- **Token per buyer** (`X-Buyer-Token`) yang mengunci ke satu UID; source Lua hanya dikirim ke UID `active` dengan script yang benar.
- Statistik per UID: `last_check` dan `check_count`; statistik per token: `last_used` dan `use_count`.
- Panel admin server-rendered (EJS): login, tambah UID, ban/unban tanpa reload, hapus, kelola script, kelola token (buat/unlock/revoke/hapus), rotasi `X-App-Secret` warisan.
- Rate limit 20 request/menit per IP untuk endpoint buyer, 10 percobaan login/15 menit.
- Data disimpan sebagai file: `data/db.json` + `data/scripts/*.lua` — bisa diedit tangan, tanpa database.

## Arsitektur

```
loader Lua (CGT)
      │  GET /api/verify?uid=…&script=…   + header X-Buyer-Token
      ▼
   Express
      ├─ data/db.json          → whitelist, tokens (hash), metadata script, admin, settings
      └─ data/scripts/<name>.lua → source yang dikirim ke buyer
```

Kenapa bukan PostgreSQL/SQLite: dataset kecil (ratusan–ribuan UID), harus bisa diedit tangan, dan deploy tanpa service tambahan. Konsekuensi yang mengikat:

- **Satu instance saja.** Dua proses menulis `db.json` bersamaan akan saling menimpa.
- **Disk harus persisten.** Tanpa volume, data hilang setiap redeploy/restart platform.

Karena tidak ada database, `DATABASE_URL` tidak dipakai. Penggantinya `DATA_DIR`.

## Struktur folder

```
server.js              # bootstrap express, session, CSP, error handler
db/store.js            # satu-satunya akses ke db.json + scripts/*.lua
db/init.js             # buat data/ + db.json default
db/seed.js             # buat admin pertama + api_token
routes/                # public.js, auth.js, admin.js
controllers/           # verify, auth, whitelist, script, settings, token
middleware/            # requireAdmin, safeEqual, rateLimit, asyncHandler
views/                 # EJS: login, dashboard, scripts, script_form, tokens, token_fresh, secret, error
public/css/admin.css   # tema gelap, tanpa CDN
public/js/admin.js     # fetch untuk ban/unban/hapus + unlock/revoke/hapus token
data/                  # runtime, gitignored
```

## Environment variables

|Nama|Wajib|Default|Keterangan|
|---|---|---|---|
|`APP_SECRET`|tidak|—|Hanya **bootstrap**: dipakai kalau `settings.app_secret` di `db.json` masih kosong. Setelah rotasi dari panel, nilai ini diabaikan.|
|`SESSION_SECRET`|ya|—|Kunci tanda tangan cookie session. Acak 64 hex; ganti = semua admin logout.|
|`PORT`|tidak|`3000`|Port HTTP.|
|`NODE_ENV`|tidak|—|`production` mengaktifkan cookie `secure`.|
|`TRUST_PROXY`|tidak|`1`|Jumlah hop reverse proxy. `1` untuk Railway/Render/nginx. `0` untuk akses langsung.|
|`DATA_DIR`|tidak|`./data`|Lokasi `db.json` dan `scripts/`. Di platform dengan volume, arahkan ke mount volume.|
|`LEGACY_PLAINTEXT`|tidak|`0`|Fallback saja. Saklar utamanya ada di panel: **Secret → Jendela Plaintext untuk Loader Lama** (`settings.legacy_plaintext`). Env hanya dipakai kalau pengaturan itu belum pernah disimpan.|

Generate secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```


### Migrasi loader lama

Panel versi ini hanya menerima payload terenkripsi (`?d=&t=&n=`). Loader lama (plaintext
`?uid=`) akan ditolak dengan `ERROR:encrypted_payload_required`, dan setiap percobaan tetap
tercatat lengkap dengan UID-nya di `/admin/logs` — itu daftar buyer yang belum ganti file.

Urutan yang aman:

1. Edarkan `loader.lua` v2.0. Loader ini sudah dual-mode: sebelum deploy ia jatuh ke
   plaintext sendiri (`CFG.legacy`), sesudah deploy ia memakai payload terenkripsi.
2. Deploy panel. Buyer yang belum ganti file muncul sebagai `encrypted_payload_required`.
3. Kalau ada yang perlu tetap online sebelum sempat ganti file, nyalakan **Secret → Jendela
   Plaintext untuk Loader Lama** (atau `LEGACY_PLAINTEXT=1` sebagai fallback). Jalur plaintext
   kembali hidup persis seperti panel lama (butuh secret global yang cocok), dan log
   suksesnya ditandai `detail: legacy_plaintext`.
4. Setelah semua buyer pindah, hapus flag itu lagi.

## Setup lokal

```bash
npm install
cp .env.example .env                          # isi SESSION_SECRET + APP_SECRET dulu
npm run init                                  # buat data/db.json + data/scripts/
node db/seed.js admin 'PasswordKuat123'       # catat api_token yang dicetak
npm start
```

Buka `http://localhost:3000/login`, masuk dengan `admin` / `PasswordKuat123`.

`npm run seed -- admin 'PasswordKuat123'` juga bisa; `--force` menimpa admin yang sudah ada (token lama ikut berganti).

## Menambah / mengedit UID manual

Server membaca ulang `data/db.json` setiap request (berbasis `mtime`), jadi edit tangan langsung terlihat tanpa restart. Jangan mengedit saat rotasi secret atau ban berjalan bersamaan.

```json
"whitelist": {
  "976115": {
    "status": "active",
    "scripts": ["autofind", "PNB"],
    "note": "Budi 2026-11",
    "created_at": "2026-11-13T07:12:00.000Z",
    "last_check": null,
    "check_count": 0
  }
}
```

Aturan: key = UID numerik (1–19 digit), `status` hanya `active` atau `banned`, dan `scripts` adalah **daftar** nama file di `data/scripts/<name>.lua` — satu UID boleh memakai beberapa script sekaligus. Format lama `"script_name": "x"` masih dibaca dan otomatis dimigrasi ke `["x"]` saat server memuat `db.json`. `check_count` dan `last_check` boleh dihilangkan (diisi otomatis `0` / `null`). Setiap penulisan dari aplikasi menyimpan salinan terakhir di `data/db.json.bak`.

Kalau JSON rusak, server **menolak melayani** (`ERROR:server` / halaman 500) alih-alih memakai data lama — supaya UID yang sudah di-ban tidak lolos.

Token disimpan di koleksi terpisah. **Jangan menulis token mentah di sini** — hanya hash:

```json
"tokens": {
  "d15db53277b39610": {
    "hash": "987e1b90…64 hex…",
    "label": "Budi",
    "note": "Invoice #12",
    "uid": "976115",
    "active": true,
    "bundle": null,
    "created_at": "2026-11-14T04:14:30.896Z",
    "locked_at": "2026-11-14T04:14:30.896Z",
    "last_used": null,
    "use_count": 0
  }
}
```

Token tanpa `uid` (`null`) akan mengunci ke UID pertama yang berhasil verify. Untuk membatasi
UID mana saja yang boleh dipakai sebelum terkunci, tambahkan `"allowed_uids": ["976115", "435802"]`
di entri whitelist — kalau ada, daftar ini menggantikan aturan minimal 4 digit.

## Token buyer (cara utama)

Satu token per buyer, dibuat dari `/admin/tokens`. Token mengunci dirinya ke satu UID
pada verifikasi sukses pertama, jadi token yang bocor tidak bisa dipakai di akun lain.

```
GET /api/verify?uid=976115&script=autofind
Header: X-Buyer-Token: <token 64 hex dari panel>
```

Kenapa token, bukan satu secret global:

- Secret global yang sama untuk semua buyer ikut terkirim di setiap loader, jadi sekali
  satu buyer membongkar scriptnya, semua buyer lain memakai secret yang sama.
- Revoke satu token tidak mengganggu buyer lain; rotasi secret global menghentikan semua.
- Token mengunci UID: dipakai di UID lain → `ERROR:uid_locked`.

Yang disimpan di `db.json` hanya `sha256(token)`, bukan token aslinya. Token mentah
ditampilkan **sekali** saat dibuat (disimpan di session, lalu dihapus saat halaman dibuka).
Kalau hilang: buat token baru, revoke yang lama.

Aturan kunci UID:

- Token boleh dibuat dengan UID yang sudah ditentukan (harus sudah ada di whitelist),
  atau tanpa UID — UID terkunci saat verify sukses pertama.
- Kunci pertama hanya menerima UID **4 digit atau lebih**. UID 1–3 digit khas akun internal.
- Admin bisa **Unlock** untuk memindahkan token ke UID lain, atau **Revoke** untuk
  menghentikan pemakaian, tanpa menghapus riwayat.

Selalu `Content-Type: text/plain; charset=utf-8`, `Cache-Control: no-store`. Hasil bisnis tetap HTTP 200:

|Body|Arti|
|---|---|
|`ERROR:invalid_secret`|Token tidak dikenal/nonaktif, dan `X-App-Secret` (kalau dikirim) salah atau kosong|
|`ERROR:bad_request`|`uid` bukan angka 1–19 digit, atau `script` bukan `[A-Za-z0-9_-]{1,64}`|
|`ERROR:not_found`|UID tidak ada di whitelist|
|`ERROR:banned`|UID ada tapi statusnya `banned`|
|`ERROR:uid_locked`|Token sudah terkunci ke UID lain|
|`ERROR:uid_not_allowed`|Token belum terkunci tapi UID ini tidak boleh (1–3 digit, atau di luar `allowed_uids`)|
|`ERROR:script_mismatch`|Script yang diminta tidak ada di daftar scripts milik UID|
|`ERROR:script_missing`|File `data/scripts/<script>.lua` tidak ada|
|`ERROR:token_revoked`|Token dinonaktifkan tepat saat request berjalan|
|`ERROR:encrypted_payload_required`|Request plaintext `?uid=` — panel versi ini hanya menerima payload terenkripsi `?d=&t=&n=`|
|`ERROR:payload_expired`|Timestamp payload lebih dari 90 detik dari jam server (cek jam device buyer)|
|`ERROR:replay_detected`|Kombinasi uid+timestamp+nonce sudah dipakai; loader harus membuat nonce baru|
|`ERROR:tampered_math_uid`|`mathUid` di payload tidak cocok dengan uid+timestamp|
|`ERROR:decryption_failed` / `ERROR:malformed_payload`|Kunci payload tidak cocok (token/secret beda) atau isi payload rusak|
|`ERROR:rate_limited`|Lebih dari 20 request/menit dari IP yang sama (HTTP 429)|
|`ERROR:server`|Kesalahan server / `db.json` rusak (HTTP 500)|
|*(source Lua)*|UID aktif, script cocok, file ada, token sah|

Contoh:

```bash
curl -s -H 'X-Buyer-Token: TOKEN' 'https://domainmu.com/api/verify?uid=976115&script=autofind'
# print('hello from whitelist')

curl -s -H 'X-Buyer-Token: TOKEN' 'https://domainmu.com/api/verify?uid=435802&script=autofind'
# ERROR:uid_locked
```

### Secret global (warisan)

`X-App-Secret` masih diterima agar loader lama tetap jalan, tetapi **tidak** mengunci UID.
Kalau `X-Buyer-Token` dikirim dan tidak dikenal, request tidak jatuh ke secret — langsung
`ERROR:invalid_secret`. Pindahkan semua buyer ke token, lalu kosongkan secret.

**Jangan pernah kirim token lewat `http://`.** Loader menolak `baseUrl` non-HTTPS kecuali
`CFG.dev = true` dan hostnya `localhost`/`127.0.0.1`.

### Laporan gagal dari sisi buyer

Kegagalan koneksi (status 0) tidak pernah sampai ke `/api/verify`, jadi loader juga
mengirim ringkasan ke `GET /api/report?stage=…&status=…&detail=…&uid=…&char=…`.
Endpoint ini membatasi input (stage whitelist, detail ≤180 karakter), menulis log
dengan hasil `client_<stage>`, dan meneruskan embed "Loader Gagal di Sisi Buyer" ke
webhook Discord. Tanpa ini, kasus DNS/TLS/timeout tidak meninggalkan jejak apa pun.

## Contoh loader Lua

Pakai `loader.lua` yang ada di repo — sudah memuat guard HTTPS, fallback `RunThread`, dan
pemilihan header token/secret. Inti bagian yang perlu diganti per buyer hanya `CFG`:

```lua
local CFG = {
    baseUrl = "https://domainmu.com",     -- skema http:// ditolak kecuali CFG.dev
    token   = "TOKEN_DARI_PANEL_ADMIN",   -- X-Buyer-Token, 64 hex
    script  = "autofind",
    timeout = 10000,
}
```

Kolom tambahan untuk diagnosis:

|Field|Default|Arti|
|---|---|---|
|`debug`|`false`|Cetak `kind`/`status`/`code` mentah tiap kegagalan|
|`report`|`true`|Kirim ringkasan gagal ke `/api/report` (best-effort, gagal pun diabaikan)|
|`legacy`|`true`|Fallback plaintext sekali kalau panel masih versi lama (`ERROR:bad_request`)|

Loader mencetak alasan yang bisa dibaca, misalnya
`ditolak (200) [verify]: ERROR:uid_locked — token sudah terkunci ke UID lain`, dan untuk
gagal konek menambahkan `timeout`, tahap, plus hasil probe `/healthz` supaya jelas apakah
panel hidup tapi request buyer tidak sampai.

Versi minimum tanpa fallback:

```lua
local TOKEN  = "TOKEN_DARI_PANEL_ADMIN"
local SCRIPT = "autofind"
local BASE   = "https://domainmu.com"

local uid = tostring(GetLocal().userid)
local url = BASE .. "/api/verify?uid=" .. uid .. "&script=" .. SCRIPT

local ok, res = pcall(MakeRequest, url, "GET", { ["X-Buyer-Token"] = TOKEN }, "", 10000)
if not ok or type(res) ~= "table" or res.status ~= 200 then
    print("[lisensi] server tidak bisa dihubungi")
    return
end
if string.sub(res.content or "", 1, 6) == "ERROR:" then
    print("[lisensi] ditolak: " .. res.content)   -- ERROR:uid_locked / not_found / banned / ...
    return
end
RunThread(res.content, SCRIPT)
```

Urutan argumen `MakeRequest` berbeda antar build CGT. Sesuaikan pemanggilannya; server hanya
peduli pada URL dan header `X-Buyer-Token`.

## Bot Discord & kuota per role

Mapping **Role → Script** di `/admin/bot` menyimpan `max_uids` (default 1): batas UID per buyer
untuk role tersebut. Admin bisa meng-override nilai itu untuk satu buyer lewat tabel
**Kuota UID Buyer** atau command:

```
!setmax @buyer PNB 2      # buyer ini boleh 2 UID dengan script PNB
!setmax @buyer PTHT 1     # PTHT tetap 1 UID
```

- `!add <uid> [role]` — daftar UID. Role wajib dicantumkan kalau buyer punya lebih dari satu
  role buyer; buyer harus benar-benar memegang role itu (termasuk Admin). Script dari role yang
  masih dipegang bisa menempel di UID yang sama; script role yang sudah tidak dipegang dibersihkan.
- `!myuid` — lihat daftar UID dan kuota per role yang masih dipegang, lengkap dengan UID yang dihitung di tiap role.
- `!addrole` / `!delrole` — beri/cabut role buyer. `!delrole` juga mencabut script role itu dari
  UID buyer, kecuali script tersebut masih diberikan role lain atau default script.

Contoh: buyer dengan PNB 2 + PTHT 1 bisa mendaftarkan 2 UID `PNB` dan 1 UID `autofind`.
UID PTHT berikutnya ditolak dengan `quota_exceeded`, walaupun kuota PNB masih ada.
`buyers[discord_id].max_uids` (format lama) kini hanya jadi fallback **Umum** bila tidak ada
mapping role yang cocok.

```json
"settings": {
  "bot_config": {
    "role_scripts": [
      { "role_id": "1570428127346298920", "label": "PNB", "scripts": ["PNB"], "max_uids": 2 }
    ]
  }
},
"buyers": {
  "412345678901234567": {
    "max_uids": 1,
    "roles": {
      "1570428127346298920": { "max_uids": 2, "note": "PNB", "updated_at": "2026-11-21T00:00:00.000Z" }
    }
  }
}
```

## Panel admin

- **Login** — `/login`. Cookie session 8 jam; logout lewat tombol di kanan atas.
- **Dashboard** — kartu Total / Aktif / Banned, form tambah UID dengan **checkbox script (boleh lebih dari satu)** + note, filter `q` (UID, note, atau nama script) dan status, tabel dengan tombol **Edit**, **Ban/Unban**, dan **Hapus** (dua terakhir tanpa reload).
- **Edit UID** — `/admin/whitelist/<uid>`: ubah daftar script, status, dan note; menampilkan jumlah check, tanggal dibuat, dan check terakhir.
- **Scripts** — daftar script + jumlah UID pemakai; buat baru, edit source Lua di textarea besar, hapus. Hapus ditolak selama masih ada UID yang memakai script itu (pindahkan/ban dulu).
- **Token** — `/admin/tokens`: buat token (label, UID opsional, note), salin token sekali, **Unlock**, **Revoke/Aktifkan**, **Hapus**. Menampilkan UID terkunci, waktu kunci, pemakaian terakhir, dan jumlah pemakaian.
- **Secret** — halaman warisan: secret global + tombol rotasi. Tidak mengunci UID; pakai hanya selama migrasi ke token.
- Semua route admin juga menerima `Authorization: Bearer <api_token>` untuk otomasi:

```bash
curl -X POST https://domainmu.com/admin/whitelist \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "uid=976115" --data-urlencode "scripts=autofind" --data-urlencode "scripts=PNB" \
  --data-urlencode "note=Budi"
```

## Rotasi secret

1. `/admin/secret` → **Generate secret baru** → copy.
2. Update konstanta `SECRET` di loader.
3. Kirim ulang loader ke buyer.

Secret lama langsung mati: verify dengan secret lama menghasilkan `ERROR:invalid_secret`.

## Deploy

Start command: `npm start`. Healthcheck: `GET /healthz` → `ok`.

### Railway

1. Buat project/service baru di Railway dari repo ini (`railway.json` sudah mengonfigurasi builder Nixpacks, start command `npm start`, dan healthcheck `/healthz`).
2. Tambahkan **Volume** dan mount ke `/data`.
3. Set **Variables** di service Railway:
   - `SESSION_SECRET`: string acak 64 hex (wajib)
   - `DATA_DIR=/data`
   - `NODE_ENV=production`
   - `TRUST_PROXY=1`
   - `ADMIN_USERNAME=admin`
   - `ADMIN_PASSWORD`: password admin awal minimal 10 karakter (otomatis dibuat saat start pertama; setelah berhasil login bisa dihapus atau dibiarkan)
   - `APP_SECRET`: *(opsional)* jika dikosongkan, server otomatis membuat `settings.app_secret` acak saat pertama kali start.
4. Deploy. Tanpa volume `/data`, `db.json` dan script `.lua` akan hilang setiap redeploy. Alternatif tanpa `ADMIN_PASSWORD`, jalankan manual via shell Railway: `node db/seed.js admin 'PasswordKuat123'`.

### Render

1. Web Service, start command `npm start`, healthcheck `/healthz`.
2. **Disk**: mount ke `/data`, set `DATA_DIR=/data` (disk gratis dibatasi ukurannya — cukup untuk JSON + script).
3. Seed admin via Shell: `node db/seed.js admin 'PasswordKuat123'`.

### VPS (pm2/systemd + nginx)

```bash
npm ci
npm run init
node db/seed.js admin 'PasswordKuat123'
pm2 start server.js --name lisensi && pm2 save
```

Nginx:

```nginx
server {
    listen 80;
    server_name domainmu.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`TRUST_PROXY=1` supaya rate limit memakai IP buyer, bukan IP nginx.

## Backup

Copy folder `data/` (`db.json` + `scripts/`) ke luar server:

```bash
tar czf lisensi-$(date +%F).tar.gz data/
```

Backup harian sudah cukup; `data/db.json.bak` adalah salinan tulisan terakhir dari aplikasi, bukan pengganti backup.
Backup versi lama (tanpa `max_uids` di `role_scripts` dan `roles` di `buyers`) tetap bisa
diimpor: keduanya diisi default `1` / `{}`. Backup dari versi ini menyimpan kedua field tersebut,
jadi kuota per role ikut terbawa saat restore/update.

## Keamanan

- `X-App-Secret` ikut terkirim di loader, jadi bisa dibaca buyer yang membongkar script. Ini bukan rahasia sejati — gerbang sebenarnya adalah whitelist UID. Rotasi secret hanya menutup pemakaian loader lama, bukan buyer yang punya UID valid.
- Rate limit 20/menit per IP bisa menahan banyak buyer sekaligus di belakang NAT/CGNAT yang sama. Naikkan `limit` di `middleware/rateLimit.js` kalau perlu.
- Jangan pernah menjalankan lebih dari satu instance/replica: penulisan `db.json` tidak terkoordinasi antar proses.
- Password admin di-hash dengan bcrypt cost 12; `api_token` 64 hex; perbandingan secret memakai `timingSafeEqual`.
- Token disimpan sebagai hash SHA-256, jadi `db.json` (dan `db.json.bak`) tidak bisa dipakai ulang sebagai kredensial. Tetap perlakukan `data/` sebagai rahasia: `api_token` admin tidak di-hash.
- Header token dikirim di setiap request loader, jadi HTTPS wajib — `loader.lua` menolak `baseUrl` non-HTTPS kecuali `CFG.dev = true` pada localhost.
- CSP `'self'` — tidak ada CDN, tidak ada inline script/style.

## Troubleshooting

|Gejala|Penyebab / solusi|
|---|---|
|`db.json tidak valid: …` di console, buyer dapat `ERROR:server`|JSON rusak setelah edit tangan. Perbaiki, atau restore `data/db.json.bak`.|
|`ERROR:server` padahal db.json benar|Cek console: error tak tertangani (file permission, disk penuh).|
|`ERROR:invalid_secret` untuk semua buyer|Secret aktif sudah dirotasi. Update loader dengan secret dari `/admin/secret`.|
|`ERROR:script_missing`|File `data/scripts/<name>.lua` terhapus / belum dibuat di server yang benar.|
|Login gagal padahal password benar|Admin belum di-seed di server itu, atau `SESSION_SECRET` berubah (cookie lama tidak valid). Seed ulang dengan `--force`.|
|Semua data hilang setelah redeploy|Tidak ada volume persisten. Set `DATA_DIR` ke mount volume.|
|Buyer kena `ERROR:rate_limited`|Lebih dari 20 verify/menit dari IP yang sama (bisa karena NAT). Naikkan limit atau minta buyer pakai IP lain.|
