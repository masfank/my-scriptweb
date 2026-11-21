'use strict';

/**
 * db/store.js — satu-satunya pintu masuk ke data/db.json + data/scripts/*.lua.
 *
 * Kenapa file, bukan DB: dataset kecil (ratusan–ribuan UID) dan harus bisa
 * diedit tangan. Konsekuensinya: satu proses saja, disk persisten.
 *
 * Kontrak:
 *   paths, ensureDataDir, read, update, readScript, listScripts,
 *   writeScript, deleteScript, isSafeName, StoreError
 */

const fs = require('fs/promises');
const path = require('path');

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

const paths = {
  dataDir,
  dbFile: path.join(dataDir, 'db.json'),
  backupFile: path.join(dataDir, 'db.json.bak'),
  scriptsDir: path.join(dataDir, 'scripts'),
  logsDir: path.join(dataDir, 'logs'),
};

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ROLE_ID_RE = /^\d{15,22}$/;

class StoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreError';
  }
}

function emptyData() {
  return { whitelist: {}, scripts: {}, admins: {}, settings: {}, tokens: {}, buyers: {} };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(detail) {
  throw new StoreError(`db.json tidak valid: ${detail}`);
}

/**
 * Validasi bentuk data dan isi default yang hilang (check_count, last_check).
 * Data hasil edit tangan tetap diterima selama field wajibnya benar.
 */
function validateShape(data) {
  if (!isPlainObject(data)) fail('root bukan object');
  if (!isPlainObject(data.whitelist)) fail('whitelist bukan object');
  if (!isPlainObject(data.scripts)) fail('scripts bukan object');
  if (!isPlainObject(data.admins)) fail('admins bukan object');
  if (!isPlainObject(data.settings)) fail('settings bukan object');

  for (const [uid, entry] of Object.entries(data.whitelist)) {
    if (!/^\d{1,19}$/.test(uid)) fail(`whitelist key "${uid}" bukan UID numerik`);
    if (!isPlainObject(entry)) fail(`whitelist["${uid}"] bukan object`);
    if (entry.status !== 'active' && entry.status !== 'banned') {
      fail(`whitelist["${uid}"].status harus "active" atau "banned"`);
    }
    /* format lama (satu script) dimigrasi ke daftar; satu UID boleh banyak script */
    if (Array.isArray(entry.scripts)) {
      entry.scripts = entry.scripts.filter((name) => typeof name === 'string' && name !== '');
    } else if (typeof entry.script_name === 'string' && entry.script_name !== '') {
      entry.scripts = [entry.script_name];
    } else {
      fail(`whitelist["${uid}"].scripts harus array nama script`);
    }
    delete entry.script_name;
    entry.scripts = Array.from(new Set(entry.scripts));
    if (entry.check_count === undefined) entry.check_count = 0;
    if (!Number.isInteger(entry.check_count) || entry.check_count < 0) {
      fail(`whitelist["${uid}"].check_count harus integer >= 0`);
    }
    if (entry.last_check === undefined) entry.last_check = null;
    if (entry.last_check !== null && typeof entry.last_check !== 'string') {
      fail(`whitelist["${uid}"].last_check harus ISO string atau null`);
    }
    if (entry.note !== undefined && typeof entry.note !== 'string') {
      fail(`whitelist["${uid}"].note harus string`);
    }
    if (entry.discord_id !== undefined && typeof entry.discord_id !== 'string') {
      fail(`whitelist["${uid}"].discord_id harus string`);
    }
  }

  for (const [name, meta] of Object.entries(data.scripts)) {
    if (!NAME_RE.test(name)) fail(`scripts key "${name}" bukan nama script valid`);
    if (!isPlainObject(meta)) fail(`scripts["${name}"] bukan object`);
    if (meta.version !== undefined && typeof meta.version !== 'string') {
      fail(`scripts["${name}"].version harus string`);
    }
  }

  for (const [username, admin] of Object.entries(data.admins)) {
    if (!isPlainObject(admin)) fail(`admins["${username}"] bukan object`);
    if (typeof admin.password_hash !== 'string' || admin.password_hash === '') {
      fail(`admins["${username}"].password_hash wajib`);
    }
    if (typeof admin.api_token !== 'string' || admin.api_token === '') {
      fail(`admins["${username}"].api_token wajib`);
    }
    if (admin.role !== undefined && admin.role !== 'admin' && admin.role !== 'leader') {
      fail(`admins["${username}"].role harus 'admin' atau 'leader'`);
    }
  }

  /* file lama tanpa koleksi tokens: isi default, jangan tolak */
  if (data.tokens === undefined) data.tokens = {};
  if (!isPlainObject(data.tokens)) fail('tokens bukan object');

  for (const [id, token] of Object.entries(data.tokens)) {
    if (!/^[a-f0-9]{16}$/.test(id)) fail(`tokens key "${id}" bukan id hex 16 karakter`);
    if (!isPlainObject(token)) fail(`tokens["${id}"] bukan object`);
    if (typeof token.hash !== 'string' || !/^[a-f0-9]{64}$/.test(token.hash)) {
      fail(`tokens["${id}"].hash harus sha256 hex`);
    }
    if (token.raw !== undefined && token.raw !== null && typeof token.raw !== 'string') {
      fail(`tokens["${id}"].raw harus string`);
    }
    if (typeof token.label !== 'string') fail(`tokens["${id}"].label harus string`);
    if (token.uid !== null && !/^\d{1,19}$/.test(String(token.uid ?? ''))) {
      fail(`tokens["${id}"].uid harus UID numerik atau null`);
    }
    if (token.uid !== null) token.uid = String(token.uid);
    if (token.uids !== undefined) {
      if (!Array.isArray(token.uids)) fail(`tokens["${id}"].uids harus array`);
      token.uids = token.uids.map((u) => {
        const s = String(u ?? '').trim();
        if (!/^\d{1,19}$/.test(s)) fail(`tokens["${id}"].uids berisi UID tidak valid: "${s}"`);
        return s;
      });
    }
    if (typeof token.active !== 'boolean') fail(`tokens["${id}"].active harus boolean`);
    if (token.note !== undefined && typeof token.note !== 'string') {
      fail(`tokens["${id}"].note harus string`);
    }
    if (token.created_at !== undefined && typeof token.created_at !== 'string') {
      fail(`tokens["${id}"].created_at harus string`);
    }
  }

  if (data.settings.app_secret !== undefined && typeof data.settings.app_secret !== 'string') {
    fail('settings.app_secret harus string');
  }
  if (data.settings.session_secret !== undefined && typeof data.settings.session_secret !== 'string') {
    fail('settings.session_secret harus string');
  }
  if (data.settings.discord_webhook !== undefined && typeof data.settings.discord_webhook !== 'string') {
    fail('settings.discord_webhook harus string');
  }
  if (data.settings.bot_config !== undefined && !isPlainObject(data.settings.bot_config)) {
    fail('settings.bot_config harus object');
  }
  if (isPlainObject(data.settings.bot_config) && Array.isArray(data.settings.bot_config.role_scripts)) {
    data.settings.bot_config.role_scripts.forEach((rule, i) => {
      if (!isPlainObject(rule) || !ROLE_ID_RE.test(String(rule.role_id || ''))) {
        fail(`settings.bot_config.role_scripts[${i}].role_id tidak valid`);
      }
      if (rule.label !== undefined && typeof rule.label !== 'string') {
        fail(`settings.bot_config.role_scripts[${i}].label harus string`);
      }
      if (!Array.isArray(rule.scripts) || rule.scripts.some((name) => typeof name !== 'string')) {
        fail(`settings.bot_config.role_scripts[${i}].scripts harus array nama script`);
      }
      if (
        rule.max_uids !== undefined &&
        (!Number.isInteger(rule.max_uids) || rule.max_uids < 1 || rule.max_uids > 100)
      ) {
        fail(`settings.bot_config.role_scripts[${i}].max_uids harus integer 1–100`);
      }
      rule.role_id = String(rule.role_id);
      if (rule.max_uids === undefined) rule.max_uids = 1;
    });
  }

  if (data.buyers === undefined) data.buyers = {};
  if (!isPlainObject(data.buyers)) fail('buyers bukan object');
  for (const [discordId, buyer] of Object.entries(data.buyers)) {
    if (!/^\d{15,22}$/.test(discordId)) fail(`buyers key "${discordId}" bukan Discord ID valid`);
    if (!isPlainObject(buyer)) fail(`buyers["${discordId}"] bukan object`);
    if (!Number.isInteger(buyer.max_uids) || buyer.max_uids < 1) {
      fail(`buyers["${discordId}"].max_uids harus integer >= 1`);
    }
    if (buyer.note !== undefined && typeof buyer.note !== 'string') {
      fail(`buyers["${discordId}"].note harus string`);
    }
    if (buyer.roles === undefined) buyer.roles = {};
    if (!isPlainObject(buyer.roles)) fail(`buyers["${discordId}"].roles harus object`);
    for (const [roleId, quota] of Object.entries(buyer.roles)) {
      if (!ROLE_ID_RE.test(roleId)) fail(`buyers["${discordId}"].roles key "${roleId}" bukan Role ID valid`);
      if (
        !isPlainObject(quota) ||
        !Number.isInteger(quota.max_uids) ||
        quota.max_uids < 1 ||
        quota.max_uids > 100
      ) {
        fail(`buyers["${discordId}"].roles["${roleId}"].max_uids harus integer 1–100`);
      }
      if (quota.note !== undefined && typeof quota.note !== 'string') {
        fail(`buyers["${discordId}"].roles["${roleId}"].note harus string`);
      }
    }
  }

  /* logs dipisah ke data/logs/YYYY-MM-DD.json agar db.json tetap ramping */
  if (data.logs !== undefined) delete data.logs;

  return data;
}

async function readFresh() {
  let raw;
  try {
    raw = await fs.readFile(paths.dbFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      await ensureDataDir();
      raw = await fs.readFile(paths.dbFile, 'utf8');
    } else {
      throw err;
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StoreError(`db.json tidak valid: ${err.message}`);
  }
  return validateShape(parsed);
}

/* cache { data, mtimeMs } — edit tangan langsung terbaca request berikutnya */
let cache = { data: null, mtimeMs: 0 };

async function ensureDataDir() {
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.mkdir(paths.scriptsDir, { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true });
  try {
    await fs.access(paths.dbFile);
  } catch {
    await writeAtomic(emptyData());
  }
}

async function writeAtomic(data) {
  const json = JSON.stringify(data, null, 2) + '\n';
  const tmp = paths.dbFile + '.tmp';
  await fs.writeFile(tmp, json, 'utf8');

  try {
    await fs.copyFile(paths.dbFile, paths.backupFile);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[store] backup gagal:', err.message);
  }

  await fs.rename(tmp, paths.dbFile);
  cache = { data: null, mtimeMs: 0 };
}

async function read() {
  const stat = await fs.stat(paths.dbFile).catch(async (err) => {
    if (err.code !== 'ENOENT') throw err;
    await ensureDataDir();
    return fs.stat(paths.dbFile);
  });

  if (!cache.data || stat.mtimeMs !== cache.mtimeMs) {
    const data = await readFresh();
    cache = { data, mtimeMs: stat.mtimeMs };
  }
  return cache.data;
}

/* antrian serial: ban / rotasi secret / hitung verify tidak saling timpa */
let chain = Promise.resolve();

function update(fn) {
  const run = chain.then(async () => {
    const data = await readFresh();
    const result = await fn(data);
    validateShape(data);
    await writeAtomic(data);
    return result;
  });
  chain = run.catch(() => {});
  return run;
}

function isSafeName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return false;
  const target = path.resolve(paths.scriptsDir, name + '.lua');
  return target.startsWith(path.resolve(paths.scriptsDir) + path.sep);
}

function scriptPath(name) {
  if (!isSafeName(name)) throw new StoreError(`nama script tidak valid: ${name}`);
  return path.join(paths.scriptsDir, name + '.lua');
}

async function readScript(name) {
  if (!isSafeName(name)) throw new StoreError(`nama script tidak valid: ${name}`);
  try {
    return await fs.readFile(scriptPath(name), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeScript(name, source) {
  const target = scriptPath(name);
  const tmp = target + '.tmp';
  await fs.mkdir(paths.scriptsDir, { recursive: true });
  await fs.writeFile(tmp, source, 'utf8');
  await fs.rename(tmp, target);
}

async function deleteScript(name) {
  try {
    await fs.unlink(scriptPath(name));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function listScripts() {
  let entries;
  try {
    entries = await fs.readdir(paths.scriptsDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const out = [];
  for (const file of entries) {
    if (!file.endsWith('.lua')) continue;
    const name = file.slice(0, -4);
    if (!isSafeName(name)) continue;
    const stat = await fs.stat(path.join(paths.scriptsDir, file));
    out.push({ name, size: stat.size, mtime: stat.mtime });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/* ---------------------------------------------------------------------------
 * Token buyer.
 *
 * Token = 64 hex acak (256 bit), hanya hash SHA-256-nya yang disimpan, jadi
 * isi db.json tidak bisa dipakai ulang sebagai kredensial. Hash SHA-256 cukup
 * (bukan bcrypt) karena token bukan password buatan manusia: entropi penuh,
 * tidak bisa ditebak, dan verify harus murah.
 *
 * Setiap token mengunci dirinya ke satu UID saat verifikasi sukses pertama.
 * ------------------------------------------------------------------------- */

const crypto = require('crypto');

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function newToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  return { raw, hash: hashToken(raw), id: crypto.randomBytes(8).toString('hex') };
}

/** Cari token aktif berdasarkan nilai mentah. Null kalau tidak ada / nonaktif. */
function findToken(data, raw) {
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) return null;
  const hash = hashToken(raw);
  for (const [id, token] of Object.entries(data.tokens)) {
    if (safeEqualHex(hash, token.hash)) return { id, ...token };
  }
  return null;
}

/* perbandingan hash hex tanpa membocorkan posisi byte pertama yang beda */
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

const MAX_LOGS = 500;
const MAX_LOG_FILES = 30;
const LOG_FILE_RE = /^\d{4}-\d{2}-\d{2}\.json$/;

let logChain = Promise.resolve();

function normalizeLogEntry(entry) {
  const at = entry.at || new Date().toISOString();
  return {
    id: crypto.randomBytes(6).toString('hex'),
    at,
    uid: entry.uid ? String(entry.uid).slice(0, 32) : '',
    char_name: entry.char_name ? String(entry.char_name).slice(0, 64) : '',
    script: entry.script ? String(entry.script).slice(0, 64) : '',
    result: String(entry.result || 'unknown'),
    via: String(entry.via || '-'),
    token_id: entry.token_id ? String(entry.token_id) : '',
    token_label: entry.token_label ? String(entry.token_label).slice(0, 64) : '',
    ip: entry.ip ? String(entry.ip).slice(0, 64) : '',
  };
}

async function listLogFilesDesc() {
  let entries;
  try {
    entries = await fs.readdir(paths.logsDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter((f) => LOG_FILE_RE.test(f)).sort((a, b) => b.localeCompare(a));
}

function recordLog(entry) {
  const run = logChain.then(async () => {
    const item = normalizeLogEntry(entry);
    const day = /^\d{4}-\d{2}-\d{2}/.test(item.at)
      ? item.at.slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const filePath = path.join(paths.logsDir, `${day}.json`);

    await fs.mkdir(paths.logsDir, { recursive: true });

    let existing = [];
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) existing = parsed;
    } catch {
      existing = [];
    }

    existing.unshift(item);
    if (existing.length > MAX_LOGS) existing.length = MAX_LOGS;

    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, filePath);

    const files = await listLogFilesDesc();
    if (files.length > MAX_LOG_FILES) {
      for (const oldFile of files.slice(MAX_LOG_FILES)) {
        await fs.unlink(path.join(paths.logsDir, oldFile)).catch(() => {});
      }
    }
  });
  logChain = run.catch(() => {});
  return run;
}

async function readLogs(limit = MAX_LOGS) {
  const files = await listLogFilesDesc();
  const out = [];
  for (const file of files) {
    if (out.length >= limit) break;
    try {
      const raw = await fs.readFile(path.join(paths.logsDir, file), 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        out.push(item);
        if (out.length >= limit) break;
      }
    } catch {
      continue;
    }
  }
  return out;
}

function clearLogs() {
  const run = logChain.then(async () => {
    const files = await listLogFilesDesc();
    for (const file of files) {
      await fs.unlink(path.join(paths.logsDir, file)).catch(() => {});
    }
  });
  logChain = run.catch(() => {});
  return run;
}

module.exports = {
  paths,
  ensureDataDir,
  read,
  update,
  readScript,
  listScripts,
  writeScript,
  deleteScript,
  isSafeName,
  hashToken,
  newToken,
  findToken,
  recordLog,
  readLogs,
  clearLogs,
  MAX_LOGS,
  StoreError,
};
