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
    token   = "TOKEN_DARI_PANEL_ADMIN",   -- X-Buyer-Token, 64 hex
    script  = "autofind",                 -- harus ada di daftar scripts milik UID
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

local function buildUrl(uid, charName)
    local u = BASE .. "/api/verify?uid=" .. uid .. "&script=" .. CFG.script
    if charName and charName ~= "" then
        u = u .. "&name=" .. urlEncode(charName)
    end
    return u
end

local function authHeaders()
    return { ["X-Buyer-Token"] = CFG.token, ["User-Agent"] = "CGT-License-Loader" }
end

-- Argumen wajib sesuai dokumentasi CGT:
--   MakeRequest(url, method, headers, content, timeout_ms)
local function fetchSource(uid, charName)
    local ok, res = pcall(MakeRequest, buildUrl(uid, charName), "GET", authHeaders(), "", CFG.timeout)

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

-- Jalankan source sebagai task terpisah (sandbox sendiri, muncul di tab Scripts).
-- Source text berjalan di sandbox sendiri tanpa akses lokal pemanggil, jadi
-- konfigurasi dikirim sebagai global. Sandbox CGT tidak menyediakan _G.
local function runSource(source, uid, charName)
    LICENSE_UID    = uid
    LICENSE_SCRIPT = CFG.script

    if type(RunThread) ~= "function" then
        say("`4RunThread tidak tersedia (butuh CGT v1.5.1+)", "`4")
        return false
    end

    -- Jalur 1: source text langsung, dieksekusi engine di sandbox terpisah (≤1 MiB).
    local okq, queued = pcall(RunThread, source, CFG.script)
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
        buildUrl(uid, charName), table.concat(headerLua, ", "), CFG.timeout, CFG.script
    )

    local okf, queued2 = pcall(RunThread, refetch, CFG.script)
    if okf and queued2 then return true end

    say("`4RunThread menolak task untuk " .. CFG.script, "`4")
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
local source, err, status = fetchSource(uid, charName)

if not source then
    -- Untuk debugging: tampilkan alasan mentah dari server (ERROR:not_found, dsb).
    say("ditolak (" .. tostring(status or "-") .. "): " .. tostring(err), "`4")
    return
end

if not CFG.quiet then
    say("ok — " .. #source .. " byte untuk " .. CFG.script .. " (UID " .. uid .. ")", "`2")
end

runSource(source, uid, charName)
