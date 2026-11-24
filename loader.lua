-- loader.lua — CGT (CreativeGrowtopia) UID license loader
-- Flow: ambil UID -> GET /api/verify (X-Buyer-Token) -> RunThread(source).
-- CGT v1.5.1+: MakeRequest & RunThread tidak tersedia di dalam hook/callback,
-- jadi pemanggilan pertama harus dari script utama (root), bukan dari AddHook.
--
-- Token dibuat per buyer di panel /admin/tokens dan mengunci ke satu UID pada
-- verifikasi pertama. Token hanya dikirim via HTTPS.
--
-- Kalau gagal, loader mencetak alasan yang bisa dibaca + mengirim ringkasan ke
-- panel (GET /api/report) supaya operator tahu masalahnya tanpa menebak-nebak.
-- Kegagalan koneksi (status 0) tidak pernah sampai ke /api/verify, jadi hanya
-- jalur laporan ini yang bisa menampakkannya.

local CFG = {
    -- Domains without a scheme are treated as https://.
    baseUrl = "https://domainmu.com",
    token   = "TOKEN_DARI_PANEL_ADMIN",   -- X-Buyer-Token (isi "" kalau pakai secret)
    secret  = "",                         -- X-App-Secret (opsional, dipakai jika token kosong)
    script  = "auto",                     -- "auto" = cek daftar script UID (auto-run jika 1, menu jika >1)
    timeout = 10000,                      -- 1..60000 ms
    quiet   = false,                      -- true = jangan cetak pesan sukses
    debug   = false,                      -- true = cetak status/kind mentah tiap kegagalan
    report  = true,                       -- kirim ringkasan gagal ke panel (/api/report)
    legacy  = true,                       -- fallback plaintext kalau panel masih versi lama
}

local PREFIX = "`9[lisensi]`w "
local LOADER_VERSION = "2.0"

local function say(text, color)
    local c = color or "`w"
    pcall(LogToConsole, PREFIX .. c .. tostring(text) .. "`0")
end

-- Token di header dikirim lewat HTTPS (atau http://localhost untuk tes lokal).
local function assertBaseUrl(base)
    local b = tostring(base or ""):gsub("/+$", "")
    if not b:match("^%a[%w+.-]*://") then b = "https://" .. b end
    if b:match("^https://") then return b end
    if b:match("^http://localhost[:/]") or b:match("^http://localhost$")
        or b:match("^http://127%.0%.0%.1[:/]") or b:match("^http://127%.0%.0%.1$") then
        return b
    end

    error("baseUrl harus menggunakan https://", 0)
end

-- UID & Nama Char: GetLocal() menyediakan userid/userID dan name; tanpa avatar nilainya -1.
local function urlEncode(s)
    return tostring(s or ""):gsub("([^%w%-_%.~])", function(c)
        return string.format("%%%02X", string.byte(c))
    end)
end

local function getCharName(me)
    local raw = me.name
    if (not raw or raw == "") and type(Client) == "table" and type(Client.GetLocalState) == "function" then
        local ok, state = pcall(Client.GetLocalState)
        if ok and type(state) == "table" and state.name and state.name ~= "" then raw = state.name end
    end
    if (not raw or raw == "") and me.netid and me.netid ~= -1 and type(GetPlayer) == "function" then
        local ok, pl = pcall(GetPlayer, me.netid)
        if ok and type(pl) == "table" and pl.name and pl.name ~= "" then raw = pl.name end
    end
    return tostring(raw or ""):gsub("`.", ""):gsub("^%s*(.-)%s*$", "%1")
end

local function currentPlayer()
    local ok, me = pcall(GetLocal)
    if not ok or type(me) ~= "table" then return nil, nil, "GetLocal gagal: " .. tostring(me) end

    local uid = me.userid or me.userID
    if uid == nil or uid == -1 then return nil, nil, "UID tidak terbaca (belum masuk world)" end
    uid = tostring(uid)
    if uid == "-1" or not uid:match("^%d+$") then return nil, nil, "UID tidak valid: " .. uid end

    return uid, getCharName(me), nil
end

local BASE

local function deriveKey(seedStr, len)
    local h = 5381
    for i = 1, #seedStr do
        h = (h * 33 + string.byte(seedStr, i)) % 2147483647
    end
    local key = {}
    local s = h
    for i = 1, len do
        s = (s * 1103515245 + 12345) % 2147483647
        key[i] = math.floor(s / 65536) % 256
    end
    return key
end

local function calcMathUid(uidStr, timeVal)
    local u = tonumber(uidStr) or 0
    local t = (tonumber(timeVal) % 1000) + 7
    return tostring(math.floor(u * 31 + 648321 + (t * 17)))
end

local function encryptPayload(text, secret, timeVal, nonceVal)
    local seed = tostring(secret) .. ':' .. tostring(timeVal) .. ':' .. tostring(nonceVal)
    local key = deriveKey(seed, 32)
    local hex = {}
    for i = 1, #text do
        local b = string.byte(text, i)
        local k = key[((i - 1) % #key) + 1]
        local v = (b + k + (i * 13)) % 256
        hex[#hex + 1] = string.format("%02x", v)
    end
    return table.concat(hex)
end

local function decryptPayload(hex, secret, timeVal, nonceVal)
    local seed = tostring(secret) .. ':' .. tostring(timeVal) .. ':' .. tostring(nonceVal)
    local key = deriveKey(seed, 32)
    local r = {}
    local idx = 1
    for i = 1, #hex, 2 do
        local b = tonumber(hex:sub(i, i + 1), 16)
        if not b then return nil end
        local k = key[((idx - 1) % #key) + 1]
        local v = (b - k - (idx * 13)) % 256
        if v < 0 then v = v + 256 end
        r[#r + 1] = string.char(v)
        idx = idx + 1
    end
    return table.concat(r)
end

local function activeSecret()
    if CFG.token and CFG.token ~= "" and CFG.token ~= "TOKEN_DARI_PANEL_ADMIN" then
        return CFG.token
    end
    return CFG.secret or ""
end

-- Nonce harus unik per payload: server menolak (replay_detected) kalau payload
-- yang persis sama dikirim dua kali. Jangan panggil math.randomseed — seed
-- eksplisit membuat dua run di detik yang sama menghasilkan nonce identik.
-- State RNG bawaan host sudah acak per proses; nomor urut menjaga dua payload
-- dalam satu proses (list lalu verify) tetap berbeda.
local nonceSeq = 0

local function makePayload(uid, scriptName, charName)
    local timeVal = os.time()
    nonceSeq = nonceSeq + 1
    local nonceVal = tostring(math.random(100000, 9999999)) .. tostring(nonceSeq)
    local mathUid = calcMathUid(uid, timeVal)
    local plain = tostring(uid) .. ":" .. tostring(scriptName) .. ":" .. tostring(timeVal) .. ":" .. nonceVal .. ":" .. mathUid .. ":" .. tostring(charName or "")
    local keySecret = activeSecret()
    local hex = encryptPayload(plain, keySecret, timeVal, nonceVal)
    return hex, timeVal, nonceVal, keySecret
end

local function buildUrl(uid, charName, scriptName)
    local hex, timeVal, nonceVal, keySecret = makePayload(uid, scriptName, charName)
    local u = BASE .. "/api/verify?d=" .. hex .. "&t=" .. timeVal .. "&n=" .. nonceVal
    return u, keySecret, timeVal, nonceVal
end

local function buildScriptsUrl(uid, charName)
    local hex, timeVal, nonceVal, keySecret = makePayload(uid, "_list", charName)
    local u = BASE .. "/api/scripts?d=" .. hex .. "&t=" .. timeVal .. "&n=" .. nonceVal
    return u, keySecret, timeVal, nonceVal
end

local function authHeaders()
    local h = { ["User-Agent"] = "CGT-License-Loader" }
    if CFG.token and CFG.token ~= "" and CFG.token ~= "TOKEN_DARI_PANEL_ADMIN" then
        h["X-Buyer-Token"] = CFG.token
    elseif CFG.secret and CFG.secret ~= "" then
        h["X-App-Secret"] = CFG.secret
    else
        h["X-Buyer-Token"] = CFG.token or ""
    end
    return h
end

--[[ ---------------------------------------------------------------------------
 * Diagnostik.
 *
 * Setiap kegagalan dikembalikan sebagai tabel { kind, status, code, detail }
 * supaya bisa dicetak dengan bahasa manusia dan dilaporkan ke panel, bukan
 * cuma "gagal". kind:
 *   call      — MakeRequest tidak bisa dipanggil / error Lua
 *   transport — tidak ada respons HTTP (status 0, DNS/TLS/timeout)
 *   http      — server membalas selain 200
 *   empty     — body kosong
 *   license   — server membalas ERROR:<kode>
 *   crypto    — balasan ENC tidak bisa didekripsi
 *   frame     — format balasan tidak dikenal
---------------------------------------------------------------------------- ]]

local REASONS = {
    invalid_secret = "secret/token tidak cocok atau sudah dirotasi",
    not_found = "UID belum masuk whitelist",
    banned = "UID diblokir (status banned)",
    uid_locked = "token sudah terkunci ke UID lain",
    uid_not_allowed = "UID ini tidak diizinkan untuk token tsb",
    script_mismatch = "script tidak terdaftar untuk UID ini",
    script_missing = "file script hilang di server",
    no_scripts = "UID tidak punya script",
    encrypted_payload_required = "server menolak request plaintext",
    bad_request = "format request tidak dikenali server",
    decryption_failed = "kunci enkripsi tidak cocok",
    payload_expired = "jam device tidak sinkron (selisih >90 detik)",
    replay_detected = "payload duplikat (retry terlalu cepat)",
    tampered_math_uid = "payload rusak / dimodifikasi",
    rate_limited = "kena rate limit (terlalu banyak request per menit)",
    token_revoked = "token sudah dinonaktifkan",
    missing_payload_params = "payload tidak lengkap",
}

local function statusNumber(v)
    return tonumber(v) or 0
end

-- Sukses: body (string). Gagal: nil, err table.
local function httpRequest(url)
    local ok, res = pcall(MakeRequest, url, "GET", authHeaders(), "", CFG.timeout)

    if not ok then
        return nil, { kind = "call", status = 0, detail = tostring(res) }
    end
    if type(res) ~= "table" then
        return nil, { kind = "call", status = 0, detail = "respons bukan tabel: " .. type(res) }
    end

    local status = statusNumber(res.status)
    local body = tostring(res.content or "")

    if status == 0 then
        local msg = res.errorMessage or res.error or "tanpa keterangan"
        return nil, { kind = "transport", status = 0, detail = tostring(msg) }
    end
    if status ~= 200 then
        return nil, { kind = "http", status = status, detail = body ~= "" and body:sub(1, 120) or ("HTTP " .. status) }
    end
    if body == "" then
        return nil, { kind = "empty", status = status, detail = "server mengirim body kosong" }
    end
    if body:sub(1, 6) == "ERROR:" then
        local code = body:sub(7):match("^([%w_]+)") or body:sub(7)
        return nil, { kind = "license", status = status, code = code, detail = body:sub(1, 120) }
    end

    return body
end

local function probeHealth()
    local ok, res = pcall(MakeRequest, BASE .. "/healthz", "GET",
        { ["User-Agent"] = "CGT-License-Loader" }, "", math.min(CFG.timeout, 5000))
    if not ok then return "pcall gagal: " .. tostring(res) end
    if type(res) ~= "table" then return "respons bukan tabel: " .. type(res) end
    return string.format("status=%s body=%s", tostring(res.status), tostring(res.content or ""):sub(1, 24))
end

local function describeError(stage, err)
    local status = statusNumber(err.status)

    if err.kind == "license" then
        local code = err.code or ""
        local why = REASONS[code] or "kode tidak dikenal"
        return string.format("ditolak (%d) [%s]: ERROR:%s — %s", status, stage, code, why)
    end
    if err.kind == "http" then
        return string.format("ditolak (HTTP %d) [%s]: %s", status, stage, tostring(err.detail))
    end
    if err.kind == "crypto" then
        return "balasan server tidak bisa didekripsi — token/secret di loader beda dengan panel"
    end
    if err.kind == "frame" then
        return "format balasan tidak dikenal: " .. tostring(err.detail)
    end
    if err.kind == "empty" then
        return "server membalas kosong — cek log panel"
    end
    return string.format("gagal konek ke %s (status %d) [%s]: %s",
        BASE, status, stage, tostring(err.detail or "-"))
end

local reportedStages = {}

local function reportFailure(stage, err, uid, charName)
    if CFG.report == false then return end
    if reportedStages[stage] then return end
    reportedStages[stage] = true

    local detail = tostring(err.code or err.detail or "-")
    local url = BASE .. "/api/report?stage=" .. urlEncode(stage)
        .. "&status=" .. urlEncode(tostring(statusNumber(err.status)))
        .. "&detail=" .. urlEncode(detail)
        .. "&uid=" .. urlEncode(uid or "")
        .. "&char=" .. urlEncode(charName or "")
    pcall(MakeRequest, url, "GET", authHeaders(), "", 5000)
end

-- Cetak alasan yang bisa dibaca, lalu laporkan ke panel (best-effort).
local function fail(stage, err, uid, charName)
    say(describeError(stage, err), "`4")

    if err.kind == "transport" or err.kind == "call" then
        say("  timeout=" .. tostring(CFG.timeout) .. "ms · tahap=" .. stage, "`8")
        say("  cek: koneksi/DNS/VPN device, lalu /healthz panel", "`8")
        say("  healthz: " .. probeHealth(), "`8")
    end
    if CFG.debug then
        say(string.format("  debug: kind=%s status=%s code=%s detail=%s",
            tostring(err.kind), tostring(err.status), tostring(err.code), tostring(err.detail)), "`8")
    end

    reportFailure(stage, err, uid, charName)
end

--[[ ---------------------------------------------------------------------------
 * Request lisensi.
 *
 * Panel versi lama (sebelum payload terenkripsi) membalas ERROR:bad_request
 * untuk request ber-payload, jadi loader mencoba sekali lagi dengan format
 * plaintext ?uid=… selama CFG.legacy tidak dimatikan. Satu file loader jalan
 * sebelum dan sesudah panel di-upgrade.
---------------------------------------------------------------------------- ]]

local function legacyScriptsUrl(uid, charName)
    local u = BASE .. "/api/scripts?uid=" .. urlEncode(uid)
    if charName ~= "" then u = u .. "&name=" .. urlEncode(charName) end
    return u
end

local function legacyVerifyUrl(uid, charName, scriptName)
    local u = BASE .. "/api/verify?uid=" .. urlEncode(uid) .. "&script=" .. urlEncode(scriptName)
    if charName ~= "" then u = u .. "&name=" .. urlEncode(charName) end
    return u
end

local function legacyNeeded(err)
    return CFG.legacy ~= false and err ~= nil and err.kind == "license" and err.code == "bad_request"
end

local function fetchScripts(uid, charName)
    local url, keySecret, timeVal, nonceVal = buildScriptsUrl(uid, charName)
    local body, err = httpRequest(url)

    if not body and legacyNeeded(err) then
        if CFG.debug then say("panel versi lama terdeteksi, fallback plaintext", "`8") end
        body, err = httpRequest(legacyScriptsUrl(uid, charName))
        keySecret = nil
    end
    if not body then return nil, err end

    if body:sub(1, 4) == "ENC:" then
        local plain = decryptPayload(body:sub(5), keySecret or "", timeVal, nonceVal)
        if not plain then return nil, { kind = "crypto", status = 200, detail = "daftar script" } end
        body = plain
    end
    if body:sub(1, 3) ~= "OK:" then
        return nil, { kind = "frame", status = 200, detail = body:sub(1, 60) }
    end

    local list = {}
    for item in body:sub(4):gmatch("([^,]+)") do
        local trimmed = item:match("^%s*(.-)%s*$")
        if trimmed ~= "" then list[#list + 1] = trimmed end
    end
    if #list == 0 then
        return nil, { kind = "license", status = 200, code = "no_scripts", detail = "ERROR:no_scripts" }
    end
    return list
end

local function fetchSource(uid, charName, scriptName)
    local url, keySecret, timeVal, nonceVal = buildUrl(uid, charName, scriptName)
    local body, err = httpRequest(url)

    if not body and legacyNeeded(err) then
        if CFG.debug then say("panel versi lama terdeteksi, fallback plaintext", "`8") end
        body, err = httpRequest(legacyVerifyUrl(uid, charName, scriptName))
        keySecret = nil
    end
    if not body then return nil, err end

    if body:sub(1, 4) == "ENC:" then
        local plain = decryptPayload(body:sub(5), keySecret or "", timeVal, nonceVal)
        if not plain then return nil, { kind = "crypto", status = 200, detail = scriptName } end
        body = plain
    end
    if body:sub(1, 6) == "ERROR:" then
        local code = body:sub(7):match("^([%w_]+)") or body:sub(7)
        return nil, { kind = "license", status = 200, code = code, detail = body:sub(1, 120) }
    end
    if body == "" then
        return nil, { kind = "empty", status = 200, detail = "source kosong" }
    end
    return body
end

local function pickScriptDialog(uid, list)
    local chosen = nil
    local cancelled = false
    local hookDlg = "cgt_license_picker_dlg"
    local hookPkt = "cgt_license_picker_pkt"

    local function handlePicker(text)
        if chosen or cancelled then return false end
        if type(text) ~= "string" then return false end
        if not text:find("cgt_license_picker", 1, true) then return false end

        local idx = text:match("buttonClicked|pick_(%d+)")
        if idx and list[tonumber(idx)] then
            chosen = list[tonumber(idx)]
        else
            cancelled = true
        end
        return true
    end

    AddHook("OnDialogResult", hookDlg, function(text)
        return handlePicker(text)
    end)
    AddHook("OnSendPacket", hookPkt, function(_, pkt)
        return handlePicker(pkt)
    end)

    local dlg = {
        "set_default_color|`o",
        "add_label_with_icon|big|`wPilih Script|left|32|",
        "add_spacer|small|",
        "add_textbox|`wUID `2" .. uid .. "`w memiliki beberapa script. Pilih salah satu:|left|",
        "add_spacer|small|",
    }
    for i, name in ipairs(list) do
        dlg[#dlg + 1] = "add_button|pick_" .. i .. "|`2" .. name .. "|noflags|0|0|"
    end
    dlg[#dlg + 1] = "add_spacer|small|"
    dlg[#dlg + 1] = "add_button|pick_cancel|`4Batal|noflags|0|0|"
    dlg[#dlg + 1] = "end_dialog|cgt_license_picker|||"

    SendVariantList({ [0] = "OnDialogRequest", [1] = table.concat(dlg, "\n") })

    local waited = 0
    while not chosen and not cancelled and waited < 60000 do
        Sleep(100)
        waited = waited + 100
    end

    if type(RemoveHook) == "function" then
        pcall(RemoveHook, hookDlg)
        pcall(RemoveHook, hookPkt)
    end

    if cancelled then
        return nil, "dibatalkan oleh pengguna"
    end
    if not chosen then
        return nil, "waktu pilih script habis (60 detik)"
    end
    return chosen, nil
end

-- Jalankan source sebagai task terpisah (sandbox sendiri, muncul di tab Scripts).
-- Source text berjalan di sandbox sendiri tanpa akses lokal pemanggil, jadi
-- konfigurasi dikirim sebagai global. Sandbox CGT tidak menyediakan _G.
local function runSource(source, uid, charName, scriptName)
    LICENSE_UID    = uid
    LICENSE_SCRIPT = scriptName

    if type(RunThread) ~= "function" then
        say("`4RunThread tidak tersedia (butuh CGT v1.5.1+)", "`4")
        return false
    end

    -- Jalur 1: source text langsung, dieksekusi engine di sandbox terpisah (≤1 MiB).
    local okq, queued = pcall(RunThread, source, scriptName)
    if okq and queued then return true end

    -- Jalur 2: bila engine menolak source text, kirim function yang menarik ulang
    -- source-nya dari server. Function hanya boleh menangkap nil/boolean/number/string,
    -- jadi URL + kredensial di-inline ke source, bukan di-capture.
    local h = authHeaders()
    local headerLua = {}
    for k, v in pairs(h) do
        headerLua[#headerLua + 1] = string.format("[%q] = %q", k, v)
    end
    local refetch = string.format(
        'local ok, r = pcall(MakeRequest, %q, "GET", {%s}, "", %d)\n' ..
        'if ok and type(r) == "table" and not r.error and r.status == 200 then\n' ..
        '    if r.content and r.content:sub(1, 6) ~= "ERROR:" then RunThread(r.content, %q) end\n' ..
        'end\n',
        buildUrl(uid, charName, scriptName), table.concat(headerLua, ", "), CFG.timeout, scriptName
    )

    local okf, queued2 = pcall(RunThread, refetch, scriptName)
    if okf and queued2 then return true end

    say("`4RunThread menolak task untuk " .. scriptName, "`4")
    return false
end

-- Validasi URL sebelum UID: HTTP polos harus gagal cepat dan jelas, bukan
-- mengirim token lalu ditolak server.
local okBase, baseOrErr = pcall(assertBaseUrl, CFG.baseUrl)
if not okBase then
    say(baseOrErr, "`4")
    return
end
BASE = baseOrErr

local uid, charName, uidErr = currentPlayer()
if not uid then
    say(uidErr, "`4")
    return
end

say("v" .. LOADER_VERSION .. " host=" .. BASE:gsub("^https?://", "") .. " uid=" .. uid, "`8")

local targetScript = CFG.script
if not targetScript or targetScript == "" or targetScript == "auto" then
    local list, listErr = fetchScripts(uid, charName)
    if not list then
        fail("list", listErr, uid, charName)
        return
    end

    if #list == 1 then
        targetScript = list[1]
    else
        local chosen, pickErr = pickScriptDialog(uid, list)
        if not chosen then
            say(pickErr, "`4")
            reportFailure("run", { kind = "frame", status = 200, detail = pickErr }, uid, charName)
            return
        end
        targetScript = chosen
    end
end

local source, err = fetchSource(uid, charName, targetScript)
if not source then
    fail("verify", err, uid, charName)
    return
end

if not CFG.quiet then
    say("ok — " .. #source .. " byte untuk " .. targetScript .. " (UID " .. uid .. ")", "`2")
end

if not runSource(source, uid, charName, targetScript) then
    reportFailure("run", { kind = "frame", status = 200, detail = "RunThread menolak " .. targetScript }, uid, charName)
end
