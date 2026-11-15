'use strict';

const csrfMeta = document.querySelector('meta[name="csrf-token"]');
const CSRF_TOKEN = csrfMeta ? csrfMeta.content : '';

if (CSRF_TOKEN) {
  for (const form of document.querySelectorAll('form[method="post"], form[method="POST"]')) {
    if (!form.querySelector('input[name="_csrf"]')) {
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = '_csrf';
      hidden.value = CSRF_TOKEN;
      form.appendChild(hidden);
    }
  }
}

/* ------------------------------------------------------------------ Toast */
function toastHost() {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  return host;
}

function toast(message, kind) {
  const node = document.createElement('div');
  node.className = 'toast' + (kind ? ' toast-' + kind : '');
  node.textContent = message;
  toastHost().appendChild(node);
  setTimeout(() => {
    node.classList.add('is-out');
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 400);
  }, 3200);
}

/* ---------------------------------------------------------- Banner Dismiss */
for (const btn of document.querySelectorAll('[data-dismiss-banner]')) {
  btn.addEventListener('click', () => {
    const banner = btn.closest('.banner');
    if (banner) banner.remove();
  });
}

/* --------------------------------------------------------- Sidebar Drawer */
const sidebar = document.getElementById('app-sidebar');
const sidebarBackdrop = document.querySelector('.sidebar-backdrop');

function toggleSidebar(force) {
  if (!sidebar) return;
  const open = typeof force === 'boolean' ? force : !sidebar.classList.contains('is-open');
  sidebar.classList.toggle('is-open', open);
  if (sidebarBackdrop) sidebarBackdrop.hidden = !open;
}

for (const btn of document.querySelectorAll('[data-sidebar-toggle]')) {
  btn.addEventListener('click', () => toggleSidebar());
}

/* --------------------------------------------------------- Modal Manager */
function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  const firstInput = modal.querySelector('input:not([type="hidden"]):not([readonly]), select, textarea, button');
  if (firstInput) setTimeout(() => firstInput.focus(), 40);
}

function closeModal(modal) {
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
}

for (const trigger of document.querySelectorAll('[data-open-modal]')) {
  trigger.addEventListener('click', () => {
    toggleSidebar(false);
    openModal(trigger.dataset.openModal);
  });
}

for (const closeBtn of document.querySelectorAll('[data-close-modal]')) {
  closeBtn.addEventListener('click', () => {
    closeModal(closeBtn.closest('.modal-backdrop'));
  });
}

for (const backdrop of document.querySelectorAll('.modal-backdrop')) {
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop && backdrop.id !== 'modal-confirm') {
      closeModal(backdrop);
    }
  });
}

/* ------------------------------------------ Custom Glass Confirm Dialog */
let confirmResolver = null;
const confirmModal = document.getElementById('modal-confirm');
const confirmTitleEl = document.getElementById('confirm-title');
const confirmDescEl = document.getElementById('confirm-desc');
const confirmOkBtn = document.getElementById('confirm-ok-btn');

function askConfirm({ title = 'Konfirmasi Tindakan', message = 'Apakah kamu yakin?', okText = 'Ya, Lanjutkan' }) {
  if (!confirmModal) return Promise.resolve(window.confirm(message));
  if (confirmTitleEl) confirmTitleEl.textContent = title;
  if (confirmDescEl) confirmDescEl.textContent = message;
  if (confirmOkBtn) confirmOkBtn.textContent = okText;

  openModal('modal-confirm');
  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

function resolveConfirm(answer) {
  if (confirmModal) closeModal(confirmModal);
  if (confirmResolver) {
    const r = confirmResolver;
    confirmResolver = null;
    r(answer);
  }
}

for (const btn of document.querySelectorAll('[data-confirm-cancel]')) {
  btn.addEventListener('click', () => resolveConfirm(false));
}
for (const btn of document.querySelectorAll('[data-confirm-ok]')) {
  btn.addEventListener('click', () => resolveConfirm(true));
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (confirmModal && !confirmModal.hidden) {
      resolveConfirm(false);
      return;
    }
    for (const openBackdrop of document.querySelectorAll('.modal-backdrop:not([hidden])')) {
      closeModal(openBackdrop);
    }
    const shell = document.getElementById('lua-editor-shell');
    if (shell && shell.classList.contains('is-fullscreen')) {
      shell.classList.remove('is-fullscreen');
    }
  }
  if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((document.activeElement || {}).tagName)) {
    const searchInput = document.querySelector('[data-filter-input]');
    if (searchInput) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  }
});

/* --------------------------------------------------------------- Requests */
async function postJson(url) {
  const headers = { Accept: 'application/json' };
  if (CSRF_TOKEN) headers['X-CSRF-Token'] = CSRF_TOKEN;
  const res = await fetch(url, { method: 'POST', headers });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || !data || data.ok !== true) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data;
}

function busy(button, on) {
  if (on) {
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
  } else {
    button.removeAttribute('aria-busy');
    button.disabled = false;
  }
}

function uidRows(uid) {
  return document.querySelectorAll(`[data-uid="${CSS.escape(uid)}"]`);
}

function applyStats(stats) {
  if (!stats) return;
  const map = { 'stat-total': stats.total, 'stat-active': stats.active, 'stat-banned': stats.banned };
  for (const [id, value] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
  }
}

function setStatus(uid, status) {
  for (const row of uidRows(uid)) {
    const badge = row.querySelector('.js-status');
    if (badge) {
      badge.textContent = status;
      badge.classList.toggle('badge-active', status === 'active');
      badge.classList.toggle('badge-banned', status === 'banned');
    }
    for (const btn of row.querySelectorAll('[data-action="toggle"]')) {
      btn.dataset.status = status;
      btn.textContent = status === 'active' ? 'Ban' : 'Unban';
    }
  }
}

/* -------------------------------------------------------------- Whitelist */
function bindToggle(button) {
  button.addEventListener('click', async () => {
    const uid = button.dataset.uid;
    busy(button, true);
    try {
      const data = await postJson(`/admin/whitelist/${encodeURIComponent(uid)}/toggle`);
      setStatus(uid, data.status);
      applyStats(data.stats);
      toast(`UID ${uid} → ${data.status}`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      busy(button, false);
    }
  });
}

function bindDelete(button) {
  button.addEventListener('click', async () => {
    const uid = button.dataset.uid;
    const ok = await askConfirm({
      title: 'Hapus UID dari Whitelist',
      message: `Hapus UID ${uid} dari daftar akses? Buyer dengan UID ini tidak akan bisa menjalankan script lagi.`,
      okText: 'Hapus UID',
    });
    if (!ok) return;
    busy(button, true);
    try {
      const data = await postJson(`/admin/whitelist/${encodeURIComponent(uid)}/delete`);
      for (const row of uidRows(uid)) row.remove();
      applyStats(data.stats);
      toast(`UID ${uid} dihapus`, 'ok');
      refreshFilter();
    } catch (err) {
      toast(err.message, 'err');
      busy(button, false);
    }
  });
}

/* ------------------------------------------------------------------- Token */
function bindTokenToggle(button) {
  button.addEventListener('click', async () => {
    const id = button.dataset.id;
    busy(button, true);
    try {
      const data = await postJson(`/admin/tokens/${encodeURIComponent(id)}/toggle`);
      const row = button.closest('tr');
      const badge = row && row.querySelector('.js-token-status');
      if (badge) {
        badge.textContent = data.active ? 'active' : 'revoked';
        badge.classList.toggle('badge-active', data.active);
        badge.classList.toggle('badge-banned', !data.active);
      }
      button.textContent = data.active ? 'Revoke' : 'Aktifkan';
      button.removeAttribute('aria-busy');
      button.disabled = false;
      toast(data.active ? 'Token diaktifkan' : 'Token di-revoke', 'ok');
    } catch (err) {
      busy(button, false);
      toast(err.message, 'err');
    }
  });
}

function bindTokenUnlock(button) {
  button.addEventListener('click', async () => {
    const id = button.dataset.id;
    const ok = await askConfirm({
      title: 'Lepas Kunci UID Token',
      message: 'Lepas kunci UID pada token ini? Token akan mengunci ulang ke UID baru saat digunakan pertama kali.',
      okText: 'Unlock UID',
    });
    if (!ok) return;
    busy(button, true);
    try {
      const data = await postJson(`/admin/tokens/${encodeURIComponent(id)}/unlock`);
      const row = button.closest('tr');
      if (row) {
        const locked = row.querySelector('.js-locked');
        const uses = row.querySelector('.js-uses');
        if (locked) locked.innerHTML = '<span class="muted">Belum terkunci</span>';
        if (uses) uses.textContent = '0';
      }
      toast(`Kunci dilepas dari UID ${data.unlocked_from || '-'}`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
      busy(button, false);
    }
  });
}

function bindTokenDelete(button) {
  button.addEventListener('click', async () => {
    const id = button.dataset.id;
    const ok = await askConfirm({
      title: 'Hapus Token Permanen',
      message: 'Hapus token buyer ini secara permanen? Loader yang memakai token ini akan langsung ditolak.',
      okText: 'Hapus Token',
    });
    if (!ok) return;
    busy(button, true);
    try {
      await postJson(`/admin/tokens/${encodeURIComponent(id)}/delete`);
      const row = button.closest('tr');
      if (row) row.remove();
      toast('Token dihapus', 'ok');
    } catch (err) {
      toast(err.message, 'err');
      busy(button, false);
    }
  });
}

/* ------------------------------------------------------------------ Filter */
const input = document.querySelector('[data-filter-input]');
const emptyHint = document.querySelector('[data-filter-empty]');
const rowCount = document.getElementById('row-count');
const mirror = document.querySelector('[data-filter-mirror]');

function countTarget() {
  return document.querySelectorAll('.uid-table tbody tr[data-search]').length
    ? '.uid-table tbody tr[data-search]'
    : '[data-filterable] [data-search]';
}

function refreshFilter() {
  if (!input) return;
  const q = input.value.trim().toLowerCase();
  const matches = (row) => !q || row.dataset.search.includes(q);

  for (const row of document.querySelectorAll('[data-filterable] [data-search]')) {
    row.hidden = !matches(row);
  }

  const primary = [...document.querySelectorAll(countTarget())];
  const shown = primary.filter(matches).length;
  if (emptyHint) emptyHint.hidden = shown > 0 || primary.length === 0;
  if (rowCount) {
    rowCount.textContent = q
      ? `${shown} dari ${primary.length} baris`
      : `${primary.length} baris`;
  }
}

if (input) {
  input.addEventListener('input', () => {
    if (mirror) mirror.value = input.value;
    refreshFilter();
  });
}

/* -------------------------------------------------------------- Clipboard */
async function copyText(value) {
  await navigator.clipboard.writeText(value);
}

function bindCopy(button) {
  button.addEventListener('click', async () => {
    const value = button.dataset.copy || '';
    try {
      await copyText(value);
      toast('Disalin ke clipboard', 'ok');
    } catch {
      const field = button.parentElement && button.parentElement.querySelector('input');
      if (field) {
        field.removeAttribute('readonly');
        field.select();
        toast('Salin manual: Ctrl+C (Clipboard butuh HTTPS)', 'err');
        return;
      }
      toast('Gagal menyalin — salin manual.', 'err');
    }
  });
}

/* ---------------------------------------------- Loader Snippet Generator */
const genBaseUrl = document.getElementById('gen-base-url');
const genScript = document.getElementById('gen-script');
const genTokenSelect = document.getElementById('gen-token-select');
const genToken = document.getElementById('gen-token');
const genMode = document.getElementById('gen-mode');
const genOutput = document.getElementById('gen-output');
const genCopyBtn = document.getElementById('gen-copy-btn');
const genDownloadBtn = document.getElementById('gen-download-btn');
const genContextBar = document.getElementById('gen-context-bar');
const genContextText = document.getElementById('gen-context-text');
const genRotateBtn = document.getElementById('gen-rotate-btn');

function cleanBaseOrigin(raw) {
  const trimmed = String(raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) return window.location.origin;
  return trimmed.replace(/\/(admin|api|login)(\/.*)?$/i, '');
}

function deterministicKey(seed) {
  let h = 2166136261;
  const s = String(seed || 'cgt');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const key = [];
  for (let i = 0; i < 8; i++) {
    h ^= h >>> 13;
    h = Math.imul(h, 1274126177);
    key.push(((h >>> 0) % 190) + 31);
  }
  return key;
}

function buildObfuscatedLoader({ origin, tokenVal, scriptName }) {
  const key = deterministicKey(origin);
  const enc = (str) => {
    const bytes = Array.from(new TextEncoder().encode(String(str)));
    return '_0xD({' + bytes.map((b, i) => b ^ key[i % key.length]).join(',') + '})';
  };

  return [
    'local CFG = {',
    `    token   = "${tokenVal}",`,
    `    script  = "${scriptName}",`,
    '    timeout = 10000,',
    '    quiet   = false,',
    '}',
    '',
    '-- DONT EDIT',
    'local _0xK={' + key.join(',') + '}',
    'local function _0xD(t) local r={} for i=1,#t do r[i]=string.char(t[i]~_0xK[((i-1)%#_0xK)+1]) end return table.concat(r) end',
    `local _0xB=${enc(origin)}`,
    `local _0xP=${enc('`9[lisensi]`w ')}`,
    'local function _0xSay(m,c) pcall(LogToConsole,_0xP..(c or "`w")..tostring(m).."`0") end',
    'local _0xT=tostring(CFG.token or ""):gsub("%s+","")',
    'if not _0xT:match("^[a-fA-F0-9]+$") or #_0xT~=64 then _0xSay("Isi token dari admin ke CFG.token dulu","`4") return end',
    'local function _0xEnc(s) return tostring(s or ""):gsub("([^%w%-_%.~])",function(c) return string.format("%%%02X",string.byte(c)) end) end',
    'local function _0xNm(me) local w=me.name if (not w or w=="") and type(Client)=="table" and type(Client.GetLocalState)=="function" then local o,st=pcall(Client.GetLocalState) if o and type(st)=="table" and st.name and st.name~="" then w=st.name end end if (not w or w=="") and me.netid and me.netid~=-1 and type(GetPlayer)=="function" then local o,p=pcall(GetPlayer,me.netid) if o and type(p)=="table" and p.name and p.name~="" then w=p.name end end return tostring(w or ""):gsub("`.",""):gsub("^%s*(.-)%s*$","%1") end',
    'local _0xOk,_0xMe=pcall(GetLocal)',
    'if not _0xOk or type(_0xMe)~="table" then _0xSay("GetLocal gagal","`4") return end',
    'local _0xU=tostring(_0xMe.userid or _0xMe.userID or -1)',
    'if _0xU=="-1" or not _0xU:match("^%d+$") then _0xSay("UID tidak terbaca (masuk world dulu)","`4") return end',
    'local _0xC=_0xNm(_0xMe)',
    `local _0xUrl=_0xB..${enc('/api/verify?uid=')}.._0xU..${enc('&script=')}..tostring(CFG.script)`,
    `if _0xC~="" then _0xUrl=_0xUrl..${enc('&name=')}.._0xEnc(_0xC) end`,
    `local _0xH={[${enc('X-Buyer-Token')}]=_0xT,[${enc('User-Agent')}]=${enc('CGT-License-Loader')}}`,
    'local _0xRq,_0xRs=pcall(MakeRequest,_0xUrl,"GET",_0xH,"",CFG.timeout or 10000)',
    'if not _0xRq or type(_0xRs)~="table" or _0xRs.error or _0xRs.status~=200 then _0xSay("Verifikasi gagal ("..tostring(_0xRs and _0xRs.status or "-")..")","`4") return end',
    'local _0xBd=_0xRs.content or ""',
    `if _0xBd=="" or _0xBd:sub(1,6)==${enc('ERROR:')} then _0xSay("Ditolak: "..tostring(_0xBd),"\`4") return end`,
    'if not CFG.quiet then _0xSay("Lisensi OK — memuat "..tostring(CFG.script).." (UID ".._0xU..")","`2") end',
    'LICENSE_UID,LICENSE_SCRIPT=_0xU,CFG.script',
    'if type(RunThread)=="function" then RunThread(_0xBd,CFG.script) else _0xSay("RunThread butuh CGT v1.5.1+","`4") end',
  ].join('\n');
}

function buildLoaderCode() {
  if (!genOutput) return '';
  const origin = cleanBaseOrigin(genBaseUrl && genBaseUrl.value);
  const scriptName = (genScript && genScript.value.trim()) || 'autofind';
  const tokenVal = (genToken && genToken.value.trim()) || 'TOKEN-DARI-TIKET-YANG-DIKASIH-ADMIN';
  const mode = (genMode && genMode.value) || 'full';

  if (mode === 'obf') {
    const obfCode = buildObfuscatedLoader({ origin, tokenVal, scriptName });
    genOutput.textContent = obfCode;
    return obfCode;
  }

  const cfgBlock = [
    'local CFG = {',
    `    baseUrl = "${origin}",`,
    `    token   = "${tokenVal}",`,
    `    script  = "${scriptName}",`,
    '    timeout = 10000,',
    '    quiet   = false,',
    '}',
  ].join('\n');

  if (mode === 'cfg') {
    genOutput.textContent = cfgBlock;
    return cfgBlock;
  }

  const fullCode = `${cfgBlock}

local PREFIX = "\`9[lisensi]\`w "
local function say(text, color)
    local c = color or "\`w"
    pcall(LogToConsole, PREFIX .. c .. tostring(text) .. "\`0")
end

local function assertBaseUrl(base)
    local b = base:gsub("/+$", "")
    if not b:match("^%a[%w+.-]*://") then b = "https://" .. b end
    if b:match("^https://") then return b end
    if b:match("^http://localhost[:/]") or b:match("^http://localhost$")
        or b:match("^http://127%.0%.0%.1[:/]") or b:match("^http://127%.0%.0%.1$") then
        return b
    end
    error("baseUrl wajib menggunakan https://", 0)
end

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
    return tostring(raw or ""):gsub("\`.", ""):gsub("^%s*(.-)%s*$", "%1")
end

local function currentPlayer()
    local ok, me = pcall(GetLocal)
    if not ok or type(me) ~= "table" then return nil, nil, "GetLocal gagal" end
    local uid = tostring(me.userid or me.userID or -1)
    if uid == "-1" or not uid:match("^%d+$") then return nil, nil, "UID tidak terbaca (masuk world dulu)" end
    return uid, getCharName(me), nil
end

local okBase, BASE = pcall(assertBaseUrl, CFG.baseUrl)
if not okBase then say(BASE, "\`4") return end

local uid, charName, uidErr = currentPlayer()
if not uid then say(uidErr, "\`4") return end

local url = BASE .. "/api/verify?uid=" .. uid .. "&script=" .. CFG.script
if charName ~= "" then url = url .. "&name=" .. urlEncode(charName) end
local headers = { ["X-Buyer-Token"] = CFG.token, ["User-Agent"] = "CGT-License-Loader" }
local ok, res = pcall(MakeRequest, url, "GET", headers, "", CFG.timeout)

if not ok or type(res) ~= "table" then
    say("MakeRequest gagal: " .. tostring(res), "\`4")
    return
end
if res.error or res.status ~= 200 then
    local detail = res.errorMessage and (" - " .. tostring(res.errorMessage)) or ""
    say("Verifikasi gagal (" .. tostring(res.status or "-") .. ")" .. detail, "\`4")
    return
end

local body = res.content or ""
if body == "" or body:sub(1, 6) == "ERROR:" then
    say("Ditolak: " .. tostring(body), "\`4")
    return
end

if not CFG.quiet then
    say("Lisensi OK — memuat " .. CFG.script .. " (UID " .. uid .. ")", "\`2")
end
LICENSE_UID, LICENSE_SCRIPT = uid, CFG.script
if type(RunThread) == "function" then
    RunThread(body, CFG.script)
else
    say("RunThread membutuhkan CGT v1.5.1+", "\`4")
end`;

  genOutput.textContent = fullCode;
  return fullCode;
}

if (genBaseUrl && !genBaseUrl.value) {
  const savedBase = localStorage.getItem('lisensi_loader_base_url');
  genBaseUrl.value = savedBase || window.location.origin;
}
if (genBaseUrl) {
  genBaseUrl.addEventListener('input', () => {
    const v = genBaseUrl.value.trim();
    if (v) localStorage.setItem('lisensi_loader_base_url', cleanBaseOrigin(v));
  });
}
for (const el of document.querySelectorAll('[data-gen-input]')) {
  el.addEventListener('input', buildLoaderCode);
  el.addEventListener('change', buildLoaderCode);
}
if (genTokenSelect) {
  genTokenSelect.addEventListener('change', () => {
    const opt = genTokenSelect.options[genTokenSelect.selectedIndex];
    const val = genTokenSelect.value || '';
    if (genToken) genToken.value = val;
    if (opt && opt.dataset.bundle && genScript) {
      genScript.value = opt.dataset.bundle;
    }
    if (genContextBar && genContextText) {
      if (val && opt) {
        const parts = [];
        if (opt.dataset.label) parts.push(`Buyer: ${opt.dataset.label}`);
        parts.push(opt.dataset.uids ? `UID: ${opt.dataset.uids}` : 'UID: Belum terkunci');
        genContextText.textContent = parts.join(' · ');
        genContextBar.hidden = false;
      } else {
        genContextText.textContent = '';
        genContextBar.hidden = true;
      }
    }
    if (genRotateBtn) {
      genRotateBtn.dataset.tokenId = '';
      genRotateBtn.hidden = true;
    }
    buildLoaderCode();
  });
}
if (genToken && genTokenSelect) {
  genToken.addEventListener('input', () => {
    const v = genToken.value.trim();
    const match = Array.from(genTokenSelect.options).some((o) => o.value === v);
    genTokenSelect.value = match ? v : '';
  });
}
buildLoaderCode();

for (const btn of document.querySelectorAll('[data-open-loader-token], [data-open-loader-script], [data-open-loader-id]')) {
  btn.addEventListener('click', () => {
    const tokenId = btn.dataset.openLoaderId || '';
    const tokenVal = btn.dataset.openLoaderToken || '';
    const label = btn.dataset.openLoaderLabel || '';
    const uid = btn.dataset.openLoaderUid || '';

    if (genToken) {
      genToken.value = tokenVal;
    }
    if (genTokenSelect) {
      const match = tokenVal && Array.from(genTokenSelect.options).some((o) => o.value === tokenVal);
      genTokenSelect.value = match ? tokenVal : '';
    }
    if (btn.dataset.openLoaderScript && genScript) {
      genScript.value = btn.dataset.openLoaderScript;
    }

    if (genContextBar && genContextText) {
      if (label || uid || tokenId) {
        const parts = [];
        if (label) parts.push(`Buyer: ${label}`);
        if (uid) parts.push(`UID: ${uid}`);
        else if (tokenId) parts.push('UID: Belum terkunci');
        if (tokenId && !tokenVal) parts.push('Token lama tersimpan sebagai hash — klik Rotate jika butuh token baru');
        genContextText.textContent = parts.join(' · ');
        genContextBar.hidden = false;
      } else {
        genContextText.textContent = '';
        genContextBar.hidden = true;
      }
    }

    if (genRotateBtn) {
      if (tokenId && !tokenVal) {
        genRotateBtn.dataset.tokenId = tokenId;
        genRotateBtn.hidden = false;
      } else {
        genRotateBtn.dataset.tokenId = '';
        genRotateBtn.hidden = true;
      }
    }

    buildLoaderCode();
    openModal('modal-loader-gen');
  });
}

if (genRotateBtn) {
  genRotateBtn.addEventListener('click', async () => {
    const id = genRotateBtn.dataset.tokenId;
    if (!id) return;
    const ok = await askConfirm({
      title: 'Rotate Token Buyer',
      message: 'Buat token baru untuk buyer ini? Token lama akan langsung tidak berlaku.',
      okText: 'Rotate Token',
      danger: true,
    });
    if (!ok) return;

    genRotateBtn.disabled = true;
    try {
      const data = await postJson(`/admin/tokens/${encodeURIComponent(id)}/rotate`);
      if (genToken) genToken.value = data.raw;
      if (data.bundle && genScript) genScript.value = data.bundle;
      genRotateBtn.hidden = true;
      if (genContextText) {
        const parts = [];
        if (data.label) parts.push(`Buyer: ${data.label}`);
        parts.push(data.uid ? `UID: ${data.uid}` : 'UID: Belum terkunci');
        parts.push('Token baru aktif & siap disalin');
        genContextText.textContent = parts.join(' · ');
      }
      buildLoaderCode();
      toast('Token baru dibuat dan dimasukkan ke loader', 'ok');
    } catch (err) {
      toast('Gagal rotate token: ' + err.message, 'err');
    } finally {
      genRotateBtn.disabled = false;
    }
  });
}

/* ------------------------------------------- Whitelist UID Multi-Picker */
function initUidPicker({ searchEl, listEl, countEl, clearEl, checkboxSelector }) {
  const updateCount = () => {
    if (!countEl || !listEl) return;
    const n = listEl.querySelectorAll(`${checkboxSelector}:checked`).length;
    countEl.textContent = n === 0 ? '0 dipilih (auto-lock)' : `${n} UID dipilih`;
  };

  if (listEl) {
    listEl.addEventListener('change', (e) => {
      if (e.target && e.target.matches(checkboxSelector)) updateCount();
    });
    updateCount();
  }

  if (searchEl && listEl) {
    searchEl.addEventListener('input', () => {
      const q = searchEl.value.trim().toLowerCase();
      for (const item of listEl.querySelectorAll('.uid-pick-item')) {
        const hay = item.dataset.search || '';
        item.hidden = Boolean(q && !hay.includes(q));
      }
    });
  }

  if (clearEl && listEl) {
    clearEl.addEventListener('click', () => {
      for (const cb of listEl.querySelectorAll(`${checkboxSelector}:checked`)) {
        cb.checked = false;
      }
      updateCount();
    });
  }

  return updateCount;
}

initUidPicker({
  searchEl: document.getElementById('token-uid-search'),
  listEl: document.getElementById('token-uid-list'),
  countEl: document.getElementById('token-uid-count'),
  clearEl: document.getElementById('token-uid-clear'),
  checkboxSelector: 'input[data-uid-pick]',
});

const editTokenUidList = document.getElementById('edit-token-uid-list');
const editTokenUidSearch = document.getElementById('edit-token-uid-search');
const updateEditTokenUidCount = initUidPicker({
  searchEl: editTokenUidSearch,
  listEl: editTokenUidList,
  countEl: document.getElementById('edit-token-uid-count'),
  clearEl: document.getElementById('edit-token-uid-clear'),
  checkboxSelector: 'input[data-edit-uid-pick]',
});

const formEditTokenUids = document.getElementById('form-edit-token-uids');
const editTokenOwner = document.getElementById('edit-token-uids-owner');
for (const btn of document.querySelectorAll('[data-edit-token-uids]')) {
  btn.addEventListener('click', () => {
    const id = btn.dataset.editTokenUids;
    const label = btn.dataset.tokenLabel || '';
    const current = new Set(
      String(btn.dataset.tokenUids || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
    if (formEditTokenUids) {
      formEditTokenUids.action = `/admin/tokens/${encodeURIComponent(id)}/uids`;
    }
    if (editTokenOwner) {
      editTokenOwner.textContent = label
        ? `UID Whitelist untuk "${label}" (token buyer tetap sama)`
        : 'Pilih UID Whitelist untuk token ini (token buyer tetap sama)';
    }
    if (editTokenUidSearch) {
      editTokenUidSearch.value = '';
    }
    if (editTokenUidList) {
      for (const item of editTokenUidList.querySelectorAll('.uid-pick-item')) {
        item.hidden = false;
      }
      for (const cb of editTokenUidList.querySelectorAll('input[data-edit-uid-pick]')) {
        cb.checked = current.has(cb.value);
      }
    }
    updateEditTokenUidCount();
    openModal('modal-edit-token-uids');
  });
}

/* ----------------------------------------------------- Team Password Reset */
const formResetPass = document.getElementById('form-reset-pass');
const resetPassLabel = document.getElementById('reset-pass-label');
const resetPassInput = document.getElementById('reset-pass-input');
for (const btn of document.querySelectorAll('[data-reset-user-pass]')) {
  btn.addEventListener('click', () => {
    const username = btn.dataset.resetUserPass;
    if (formResetPass) {
      formResetPass.action = `/admin/users/${encodeURIComponent(username)}/password`;
    }
    if (resetPassLabel) {
      resetPassLabel.textContent = `Password Baru untuk "${username}"`;
    }
    if (resetPassInput) resetPassInput.value = '';
    openModal('modal-reset-pass');
  });
}

/* ----------------------------------------------------- JSON File Importer */
for (const fileInput of document.querySelectorAll('[data-import-file]')) {
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const form = fileInput.closest('form');
    const target = form ? form.querySelector('[data-import-payload]') : null;
    if (!target) return;
    try {
      target.value = await file.text();
      toast(`File ${file.name} dimuat`, 'ok');
    } catch {
      toast('Gagal membaca file JSON', 'err');
    }
  });
}

if (genCopyBtn) {
  genCopyBtn.addEventListener('click', async () => {
    try {
      await copyText(buildLoaderCode());
      toast('Snippet loader disalin ke clipboard', 'ok');
    } catch {
      toast('Gagal menyalin otomatis', 'err');
    }
  });
}

if (genDownloadBtn) {
  genDownloadBtn.addEventListener('click', () => {
    const code = buildLoaderCode();
    const scriptName = (genScript && genScript.value.trim()) || 'loader';
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `loader-${scriptName}.lua`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`Mengunduh loader-${scriptName}.lua`, 'ok');
  });
}

/* --------------------------------------------------- Lua Studio Code Editor */
const sourceArea = document.getElementById('source-code');
const editorGutter = document.getElementById('editor-gutter');
const statLines = document.getElementById('stat-lines');
const statBytes = document.getElementById('stat-bytes');
const cursorPos = document.getElementById('editor-cursor-pos');
const scriptNameInput = document.getElementById('script-name');
const filenameDisplay = document.getElementById('editor-filename-display');
const editorCopyBtn = document.getElementById('editor-copy-btn');
const editorDownloadBtn = document.getElementById('editor-download-btn');
const editorZenBtn = document.getElementById('editor-zen-btn');
const editorShell = document.getElementById('lua-editor-shell');

function updateEditorMetrics() {
  if (!sourceArea) return;
  const val = sourceArea.value;
  const lines = val.split('\n').length;
  if (editorGutter) {
    const nums = [];
    for (let i = 1; i <= lines; i++) nums.push(i);
    editorGutter.textContent = nums.join('\n');
  }
  if (statLines) statLines.textContent = `${lines} baris`;
  if (statBytes) {
    const kb = (new Blob([val]).size / 1024).toFixed(1);
    statBytes.textContent = `${kb} KB`;
  }
}

function updateCursorPos() {
  if (!sourceArea || !cursorPos) return;
  const upto = sourceArea.value.slice(0, sourceArea.selectionStart || 0);
  const parts = upto.split('\n');
  const ln = parts.length;
  const col = parts[parts.length - 1].length + 1;
  cursorPos.textContent = `Ln ${ln}, Col ${col}`;
}

if (sourceArea) {
  updateEditorMetrics();
  sourceArea.addEventListener('input', () => {
    updateEditorMetrics();
    updateCursorPos();
  });
  sourceArea.addEventListener('click', updateCursorPos);
  sourceArea.addEventListener('keyup', updateCursorPos);
  sourceArea.addEventListener('scroll', () => {
    if (editorGutter) editorGutter.scrollTop = sourceArea.scrollTop;
  });
  sourceArea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = sourceArea.selectionStart;
      const end = sourceArea.selectionEnd;
      sourceArea.value = sourceArea.value.substring(0, start) + '    ' + sourceArea.value.substring(end);
      sourceArea.selectionStart = sourceArea.selectionEnd = start + 4;
      updateEditorMetrics();
      updateCursorPos();
    }
  });
}

if (scriptNameInput && filenameDisplay) {
  scriptNameInput.addEventListener('input', () => {
    const name = scriptNameInput.value.trim() || 'untitled';
    filenameDisplay.textContent = `${name}.lua`;
  });
}

if (editorCopyBtn && sourceArea) {
  editorCopyBtn.addEventListener('click', async () => {
    try {
      await copyText(sourceArea.value);
      toast('Source code Lua disalin', 'ok');
    } catch {
      toast('Gagal menyalin source code', 'err');
    }
  });
}

if (editorDownloadBtn && sourceArea) {
  editorDownloadBtn.addEventListener('click', () => {
    const name = (scriptNameInput && scriptNameInput.value.trim()) || 'script';
    const blob = new Blob([sourceArea.value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.lua`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`Mengunduh ${name}.lua`, 'ok');
  });
}

if (editorZenBtn && editorShell) {
  editorZenBtn.addEventListener('click', () => {
    const full = editorShell.classList.toggle('is-fullscreen');
    const span = editorZenBtn.querySelector('span');
    if (span) span.textContent = full ? 'Keluar Fullscreen' : 'Fullscreen';
  });
}

/* ----------------------------------------------------------------- Wiring */
for (const button of document.querySelectorAll('[data-action="toggle"]')) bindToggle(button);
for (const button of document.querySelectorAll('[data-action="delete"]')) bindDelete(button);
for (const button of document.querySelectorAll('[data-action="token-unlock"]')) bindTokenUnlock(button);
for (const button of document.querySelectorAll('[data-action="token-toggle"]')) bindTokenToggle(button);
for (const button of document.querySelectorAll('[data-action="token-delete"]')) bindTokenDelete(button);
for (const button of document.querySelectorAll('[data-copy]')) bindCopy(button);

for (const form of document.querySelectorAll('form[data-confirm]')) {
  form.addEventListener('submit', async (event) => {
    if (form.dataset.confirmed === 'true') {
      form.dataset.confirmed = '';
      return;
    }
    event.preventDefault();
    const ok = await askConfirm({
      title: form.dataset.confirmTitle || 'Konfirmasi Tindakan',
      message: form.dataset.confirm,
      okText: 'Ya, Lanjutkan',
    });
    if (ok) {
      form.dataset.confirmed = 'true';
      form.submit();
    }
  });
}

/* --------------------------------------------------------- Discord Webhook */
const testWebhookBtn = document.getElementById('btn-test-webhook');
const webhookInput = document.getElementById('webhook-url-input');

if (testWebhookBtn) {
  testWebhookBtn.addEventListener('click', async () => {
    const webhookUrl = webhookInput ? webhookInput.value.trim() : '';
    busy(testWebhookBtn, true);
    try {
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      };
      if (CSRF_TOKEN) headers['X-CSRF-Token'] = CSRF_TOKEN;
      const res = await fetch('/admin/webhook/test', {
        method: 'POST',
        headers,
        body: new URLSearchParams({ webhook_url: webhookUrl }).toString(),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.ok !== true) {
        throw new Error((data && data.error) || `HTTP ${res.status}`);
      }
      toast('Tes webhook berhasil dikirim ke Discord!', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      busy(testWebhookBtn, false);
    }
  });
}

refreshFilter();
