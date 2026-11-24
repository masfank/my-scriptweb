'use strict';

/**
 * utils/loaderTemplate.js — satu sumber kebenaran untuk loader yang diunduh buyer.
 *
 * Sumber aslinya `loader.lua` di root repo. Generator panel tidak menyimpan salinan
 * logika sendiri: ia hanya mengganti blok `local CFG = { … }` dengan konfigurasi
 * buyer (baseUrl, token/secret, script). Dengan begitu loader yang diunduh dari
 * panel selalu identik dengan loader yang diuji di repo — tidak ada versi kedua
 * yang bisa basi.
 */

const fs = require('fs');
const path = require('path');

const SOURCE_FILE = path.join(__dirname, '..', 'loader.lua');
const CFG_RE = /local CFG = \{[\s\S]*?\n\}/;
const TOKEN_RE = /^[a-f0-9]{64}$/i;
const BASE_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/;
const SCRIPT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PLACEHOLDER = 'TOKEN_DARI_PANEL_ADMIN';

function luaString(value) {
  // JSON string literal valid di Lua (escape " dan \ sama).
  return JSON.stringify(String(value));
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

function xorBytes(value, key) {
  const bytes = Array.from(Buffer.from(String(value), 'utf8'));
  return '_0xD({' + bytes.map((b, i) => b ^ key[i % key.length]).join(',') + '})';
}

function cfgBlock({ baseUrl, token, secret, script, obfuscated }) {
  const key = obfuscated ? deterministicKey(baseUrl) : null;
  const lit = (value) => (obfuscated ? xorBytes(value, key) : luaString(value));
  const lines = ['local CFG = {'];

  lines.push(`    baseUrl = ${lit(baseUrl)},`);
  if (secret) {
    lines.push('    token   = "",');
    lines.push(`    secret  = ${lit(secret)},`);
  } else {
    lines.push(`    token   = ${lit(token || PLACEHOLDER)},`);
    lines.push('    secret  = "",');
  }
  lines.push(`    script  = ${lit(script)},`);
  lines.push('    timeout = 10000,');
  lines.push('    quiet   = false,');
  lines.push('    debug   = false,');
  lines.push('    report  = true,');
  lines.push('    legacy  = true,');
  lines.push('}');

  if (!obfuscated) return lines.join('\n');

  return [
    '-- DONT EDIT',
    'local _0xK={' + key.join(',') + '}',
    'local function _0xD(t) local r={} for i=1,#t do r[i]=string.char(t[i]~_0xK[((i-1)%#_0xK)+1]) end return table.concat(r) end',
    ...lines,
  ].join('\n');
}

function templateSource() {
  const raw = fs.readFileSync(SOURCE_FILE, 'utf8');
  if (!CFG_RE.test(raw)) {
    throw new Error('blok "local CFG = { … }" tidak ditemukan di loader.lua');
  }
  return raw.replace(/\r\n/g, '\n');
}

/**
 * renderLoader({ mode, baseUrl, token, secret, script })
 *   mode: 'full' (default) | 'cfg' | 'obf'
 * Throws on invalid input so callers can turn it into HTTP 400.
 */
function renderLoader(options) {
  const mode = ['full', 'cfg', 'obf'].includes(options.mode) ? options.mode : 'full';
  const baseUrl = String(options.baseUrl || '').trim().replace(/\/+$/, '');
  if (!BASE_RE.test(baseUrl)) throw new Error('baseUrl tidak valid');

  const script = String(options.script || 'auto').trim() || 'auto';
  if (script !== 'auto' && !SCRIPT_RE.test(script)) throw new Error('nama script tidak valid');

  const token = String(options.token || '').trim();
  if (token && !TOKEN_RE.test(token)) throw new Error('token harus 64 hex');

  const secret = String(options.secret || '').trim();
  if (secret && !TOKEN_RE.test(secret)) throw new Error('secret harus 64 hex');

  if (mode === 'cfg') {
    return cfgBlock({ baseUrl, token, secret, script, obfuscated: false }) + '\n';
  }

  const block = cfgBlock({ baseUrl, token, secret, script, obfuscated: mode === 'obf' });
  return templateSource().replace(CFG_RE, block);
}

module.exports = { renderLoader, PLACEHOLDER };
