-- loader.lua — CGT (CreativeGrowtopia) UID license loader
-- Flow: ambil UID -> GET /api/verify (X-Buyer-Token) -> RunThread(source).
-- CGT v1.5.1+: MakeRequest & RunThread tidak tersedia di dalam hook/callback,
-- jadi pemanggilan pertama harus dari script utama (root), bukan dari AddHook.
--
-- Token dibuat per buyer di panel /admin/tokens dan mengunci ke satu UID pada
-- verifikasi pertama. Token hanya dikirim via HTTPS.

local CFG = {
    -- Domains without a scheme are treated as https://.
    baseUrl = "https://domainmu.com",
    token   = "TOKEN_DARI_PANEL_ADMIN",   -- X-Buyer-Token (isi "" kalau pakai secret)
    secret  = "",                         -- X-App-Secret (opsional, dipakai jika token kosong)
    script  = "auto",                     -- "auto" = cek daftar script UID (auto-run jika 1, menu jika >1)
    timeout = 10000,                      -- 1..60000 ms
    quiet   = false,                      -- true = jangan cetak pesan sukses
}

local PREFIX = "`9[lisensi]`w "

local function say(text, color)
    local c = color or "`w"
    pcall(LogToConsole, PREFIX .. c .. tostring(text) .. "`0")
end

-- Token di header dikirim lewat HTTPS (atau http://localhost untuk tes lokal).
local function assertBaseUrl(base)
    local b = base:gsub("/+$", "")
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
        local okS, st = pcall(Client.GetLocalState)
        if okS and type(st) == "table" and st.name and st.name ~= "" then
            raw = st.name
        end
    end
    if (not raw or raw == "") and me.netid and me.netid ~= -1 and type(GetPlayer) == "function" then
        local okP, p = pcall(GetPlayer, me.netid)
        if okP and type(p) == "table" and p.name and p.name ~= "" then
            raw = p.name
        end
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

local function makePayload(uid, scriptName, charName)
    local timeVal = os.time()
    math.randomseed(timeVal + (tonumber(uid) or 0))
    local nonceVal = tostring(math.random(1000, 9999))
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

-- Argumen wajib sesuai dokumentasi CGT:
--   MakeRequest(url, method, headers, content, timeout_ms)
local function httpGet(url)
    local ok, res = pcall(MakeRequest, url, "GET", authHeaders(), "", CFG.timeout)

    if not ok then
        return nil, "MakeRequest gagal di konteks ini: " .. tostring(res), nil
    end
    if type(res) ~= "table" then
        return nil, "respons bukan tabel: " .. tostring(res), nil
    end
    if res.error then
        return nil, string.format("HTTP %s %s", tostring(res.status), tostring(res.errorMessage)), res.status
    end
    if res.status ~= 200 then
        return nil, "status tak terduga: " .. tostring(res.status), res.status
    end

    local body = res.content or ""
    if body:sub(1, 6) == "ERROR:" then
        return nil, body, res.status
    end
    if body == "" then
        return nil, "server mengirim body kosong", res.status
    end
    return body, nil, res.status
end

local function fetchScripts(uid, charName)
    local url, keySecret, timeVal, nonceVal = buildScriptsUrl(uid, charName)
    local body, err, status = httpGet(url)
    if not body then return nil, err, status end
    if body:sub(1, 4) == "ENC:" then
        body = decryptPayload(body:sub(5), keySecret, timeVal, nonceVal)
    end
    if not body or body:sub(1, 3) ~= "OK:" then
        return nil, "format daftar script tidak valid: " .. tostring(body), status
    end
    local list = {}
    for item in body:sub(4):gmatch("([^,]+)") do
        local trimmed = item:match("^%s*(.-)%s*$")
        if trimmed ~= "" then list[#list + 1] = trimmed end
    end
    if #list == 0 then
        return nil, "ERROR:no_scripts", status
    end
    return list, nil, status
end

local function fetchSource(uid, charName, scriptName)
    local url, keySecret, timeVal, nonceVal = buildUrl(uid, charName, scriptName)
    local body, err, status = httpGet(url)
    if not body then return nil, err, status end
    if body:sub(1, 4) == "ENC:" then
        body = decryptPayload(body:sub(5), keySecret, timeVal, nonceVal)
    end
    if not body or body == "" or body:sub(1, 6) == "ERROR:" then
        return nil, body or "gagal memuat script", status
    end
    return body, nil, status
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

local targetScript = CFG.script
if not targetScript or targetScript == "" or targetScript == "auto" then
    local list, listErr, listStatus = fetchScripts(uid, charName)
    if not list then
        say("ditolak (" .. tostring(listStatus or "-") .. "): " .. tostring(listErr), "`4")
        return
    end
    if #list == 1 then
        targetScript = list[1]
    else
        local picked, pickErr = pickScriptDialog(uid, list)
        if not picked then
            say(pickErr, "`4")
            return
        end
        targetScript = picked
    end
end

local source, err, status = fetchSource(uid, charName, targetScript)

if not source then
    -- Untuk debugging: tampilkan alasan mentah dari server (ERROR:not_found, dsb).
    say("ditolak (" .. tostring(status or "-") .. "): " .. tostring(err), "`4")
    return
end

if not CFG.quiet then
    say("ok — " .. #source .. " byte untuk " .. targetScript .. " (UID " .. uid .. ")", "`2")
end

runSource(source, uid, charName, targetScript)
