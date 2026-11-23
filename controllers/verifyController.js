'use strict';

/**
 * controllers/verifyController.js — endpoint buyer.
 * Semua hasil bisnis = HTTP 200 text/plain: source Lua, atau ERROR:<alasan>.
 * Urutan cek mengikat: kredensial → format → lookup → status → bottom-4 UID →
 * script → file → lock UID.
 *
 * Kredensial:
 *   X-Buyer-Token: <token per buyer>   ← utama, mengunci ke satu UID
 *   X-App-Secret:  <secret global>     ← warisan, tidak mengunci UID
 */

const store = require('../db/store');
const safeEqual = require('../middleware/safeEqual');
const asyncHandler = require('../middleware/asyncHandler');
const discordWebhook = require('../utils/discordWebhook');
const cryptoPayload = require('../utils/cryptoPayload');

const UID_RE = /^\d{1,19}$/;

/* UID yang boleh diterima kalau token belum terkunci: 4 digit atau lebih.
 * UID 1-3 digit khas ID internal (tester/staff) dan gampang ditebak. */
const MIN_FIRST_LOCK_DIGITS = 4;

function normalizeIp(raw) {
  return String(raw || '')
    .trim()
    .replace(/^::ffff:/i, '');
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true; // CGNAT / Railway internal
  if (/^fc00:|^fd[0-9a-f]{2}:|^fe80:/i.test(ip)) return true;
  return false;
}

function clientIp(req) {
  const cfIp = normalizeIp(req.get('cf-connecting-ip'));
  if (cfIp && !isPrivateIp(cfIp)) return cfIp;

  const trueIp = normalizeIp(req.get('true-client-ip'));
  if (trueIp && !isPrivateIp(trueIp)) return trueIp;

  const realIp = normalizeIp(req.get('x-real-ip'));
  if (realIp && !isPrivateIp(realIp)) return realIp;

  const xff = req.get('x-forwarded-for');
  if (typeof xff === 'string' && xff.trim()) {
    const parts = xff.split(',').map(normalizeIp).filter(Boolean);
    const publicIp = parts.find((ip) => !isPrivateIp(ip));
    if (publicIp) return publicIp;
    if (parts[0]) return parts[0];
  }

  return normalizeIp(req.ip);
}

function cleanCharName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/`./g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 64);
}

function logResult(uid, script, result, via) {
  console.log(`[verify] via=${via || '-'} uid=${uid || '-'} script=${script || '-'} result=${result}`);
}

function tokenAllowedUids(token) {
  if (!token) return [];
  if (Array.isArray(token.uids) && token.uids.length > 0) {
    return token.uids.map(String);
  }
  if (token.uid !== null && token.uid !== undefined && String(token.uid) !== '') {
    return [String(token.uid)];
  }
  return [];
}

async function emitFailure(req, { uid, charName, script, result, via, token, webhookUrl, discordId }) {
  logResult(uid, script, result, via);
  const ip = clientIp(req);
  const at = new Date().toISOString();
  try {
    await store.recordLog({
      at,
      uid,
      char_name: charName || '',
      script,
      result,
      via,
      token_id: token ? token.id : '',
      token_label: token ? token.label : '',
      ip,
    });
  } catch (err) {
    console.warn('[verify] gagal simpan log:', err.message);
  }
  if (result !== 'invalid_secret' && result !== 'bad_request') {
    discordWebhook.sendVerifyLog(webhookUrl, {
      at,
      uid,
      char_name: charName || '',
      script,
      result,
      via,
      token_label: token ? token.label : '',
      discord_id: discordId || '',
      ip,
    });
  }
}

function uidAllowed(entry, uid) {
  if (Array.isArray(entry.allowed_uids) && entry.allowed_uids.length > 0) {
    return entry.allowed_uids.includes(uid);
  }
  return UID_RE.test(uid) && uid.length >= MIN_FIRST_LOCK_DIGITS;
}

async function authenticateAndCheckUid(req, data, { scriptForLog }) {
  const rawToken = req.get('x-buyer-token');
  const token = rawToken ? store.findToken(data, rawToken) : null;
  const via = token ? 'token' : 'secret';
  const webhookUrl = data.settings.discord_webhook || process.env.DISCORD_WEBHOOK_URL || '';
  const secret = data.settings.app_secret || process.env.APP_SECRET || '';
  const secretKey = token ? token.token : secret;

  // Cek apakah request menggunakan encrypted dynamic payload (?d=...&t=...&n=...)
  const hex = typeof req.query.d === 'string' ? req.query.d.trim() : (typeof req.query.p === 'string' ? req.query.p.trim() : '');
  let uid = '';
  let script = scriptForLog;
  let charName = '';
  let timeVal = '';
  let nonceVal = '';
  let isEncrypted = false;

  if (hex) {
    timeVal = typeof req.query.t === 'string' ? req.query.t.trim() : '';
    nonceVal = typeof req.query.n === 'string' ? req.query.n.trim() : '';

    if (!secretKey) {
      return {
        ok: false,
        result: 'invalid_secret',
        via,
        token,
        webhookUrl,
        charName: '',
        uid: '',
        script: scriptForLog,
        discordId: '',
      };
    }

    const unpacked = cryptoPayload.verifyAndUnpackPayload({ hex, timeVal, nonceVal, secretKey });
    if (!unpacked.ok) {
      return {
        ok: false,
        result: unpacked.error,
        via,
        token,
        webhookUrl,
        charName: '',
        uid: '',
        script: scriptForLog,
        discordId: '',
      };
    }

    uid = unpacked.uid;
    if (scriptForLog !== '_list') {
      script = unpacked.script;
    }
    charName = cleanCharName(unpacked.charName || req.query.name);
    isEncrypted = true;
  } else {
    // Jika tidak ada encrypted payload, cek apakah mencoba menembak dengan plaintext ?uid=
    if (req.query.uid) {
      return {
        ok: false,
        result: 'encrypted_payload_required',
        via,
        token,
        webhookUrl,
        charName: cleanCharName(req.query.name),
        uid: typeof req.query.uid === 'string' ? req.query.uid.trim() : '',
        script: scriptForLog,
        discordId: '',
      };
    }
    return {
      ok: false,
      result: 'bad_request',
      via,
      token,
      webhookUrl,
      charName: '',
      uid: '',
      script: scriptForLog,
      discordId: '',
    };
  }

  if (!token) {
    const provided = req.get('x-app-secret');
    if (!secret || !safeEqual(provided, secret)) {
      return {
        ok: false,
        result: 'invalid_secret',
        via: rawToken ? 'token' : 'secret',
        token: null,
        webhookUrl,
        charName,
        uid,
        script,
        discordId: '',
      };
    }
  }

  if (!UID_RE.test(uid)) {
    return {
      ok: false,
      result: 'bad_request',
      via,
      token,
      webhookUrl,
      charName,
      uid,
      script,
      discordId: '',
    };
  }

  const entry = data.whitelist[uid];
  const discordId = (entry && entry.discord_id) || '';
  if (!entry) {
    return { ok: false, result: 'not_found', via, token, webhookUrl, charName, uid, script, discordId };
  }
  if (entry.status !== 'active') {
    return { ok: false, result: 'banned', via, token, webhookUrl, charName, uid, script, discordId };
  }

  /* token sudah terkunci ke UID lain: tolak sebelum menyentuh script/file */
  const allowedUids = tokenAllowedUids(token);
  if (token && allowedUids.length > 0 && !allowedUids.includes(uid)) {
    return { ok: false, result: 'uid_locked', via, token, webhookUrl, charName, uid, script, discordId };
  }
  if (token && allowedUids.length === 0 && !uidAllowed(entry, uid)) {
    return { ok: false, result: 'uid_not_allowed', via, token, webhookUrl, charName, uid, script, discordId };
  }

  return { ok: true, entry, token, via, webhookUrl, charName, uid, script, discordId, isEncrypted, secretKey, timeVal, nonceVal };
}

exports.listScripts = asyncHandler(async (req, res) => {
  res.type('text/plain');
  res.set('Cache-Control', 'no-store');

  const data = await store.read();
  const auth = await authenticateAndCheckUid(req, data, { scriptForLog: '_list' });

  if (!auth.ok) {
    await emitFailure(req, auth);
    return res.send(`ERROR:${auth.result}`);
  }

  const list = Array.isArray(auth.entry.scripts) ? auth.entry.scripts.filter((s) => store.isSafeName(s)) : [];
  if (list.length === 0) {
    await emitFailure(req, {
      uid: auth.uid,
      charName: auth.charName,
      script: '_list',
      result: 'no_scripts',
      via: auth.via,
      token: auth.token,
      webhookUrl: auth.webhookUrl,
      discordId: auth.discordId,
    });
    return res.send('ERROR:no_scripts');
  }

  if (auth.isEncrypted) {
    const encList = cryptoPayload.encryptPayload(`OK:${list.join(',')}`, auth.secretKey, auth.timeVal, auth.nonceVal);
    return res.send(`ENC:${encList}`);
  }

  return res.send(`OK:${list.join(',')}`);
});

exports.verify = asyncHandler(async (req, res) => {
  res.type('text/plain');
  res.set('Cache-Control', 'no-store');

  const data = await store.read();
  const auth = await authenticateAndCheckUid(req, data, {
    scriptForLog: typeof req.query.script === 'string' ? req.query.script.trim() : '_verify',
  });
  if (!auth.ok) {
    await emitFailure(req, auth);
    return res.send(`ERROR:${auth.result}`);
  }

  const { entry, token, via, webhookUrl, charName, discordId, uid, script, isEncrypted, secretKey, timeVal, nonceVal } = auth;

  if (!store.isSafeName(script)) {
    await emitFailure(req, { uid, charName, script, result: 'bad_request', via, token, webhookUrl, discordId });
    return res.send('ERROR:bad_request');
  }

  if (!entry.scripts.includes(script)) {
    await emitFailure(req, { uid, charName, script, result: 'script_mismatch', via, token, webhookUrl, discordId });
    return res.send('ERROR:script_mismatch');
  }

  const source = await store.readScript(script);
  if (source === null) {
    await emitFailure(req, { uid, charName, script, result: 'script_missing', via, token, webhookUrl, discordId });
    return res.send('ERROR:script_missing');
  }

  /* statistik + lock UID + log aktivitas ditulis bersamaan; pada verdict direvalidasi ulang */
  let verdict = 'ok';
  let liveDiscordId = discordId;
  const ip = clientIp(req);
  const now = new Date().toISOString();
  await store.update((db) => {
    const current = db.whitelist[uid];
    if (current && current.discord_id) liveDiscordId = current.discord_id;
    if (!current) {
      verdict = 'not_found';
    } else if (current.status !== 'active') {
      verdict = 'banned';
    } else if (token) {
      const live = db.tokens[token.id];
      const liveAllowed = tokenAllowedUids(live);
      if (!live || live.active !== true) {
        verdict = 'token_revoked';
      } else if (liveAllowed.length > 0 && !liveAllowed.includes(uid)) {
        verdict = 'uid_locked';
      } else {
        if (liveAllowed.length === 0) {
          live.uid = uid;
          live.uids = [uid];
          live.locked_at = now;
        }
        live.last_used = now;
        live.use_count = (live.use_count || 0) + 1;
      }
    }

    if (verdict === 'ok' && current) {
      current.last_check = now;
      current.check_count = (current.check_count || 0) + 1;
    }
  });

  try {
    await store.recordLog({
      at: now,
      uid,
      char_name: charName,
      script,
      result: verdict,
      via,
      token_id: token ? token.id : '',
      token_label: token ? token.label : '',
      ip,
    });
  } catch (err) {
    console.warn('[verify] gagal simpan log:', err.message);
  }

  discordWebhook.sendVerifyLog(webhookUrl, {
    at: now,
    uid,
    char_name: charName,
    script,
    result: verdict,
    via,
    token_label: token ? token.label : '',
    discord_id: liveDiscordId,
    ip,
  });

  if (verdict !== 'ok') {
    logResult(uid, script, verdict, via);
    return res.send(`ERROR:${verdict}`);
  }

  logResult(uid, script, 'ok', via);
  if (isEncrypted) {
    const encSource = cryptoPayload.encryptPayload(source, secretKey, timeVal, nonceVal);
    return res.send(`ENC:${encSource}`);
  }
  return res.send(source);
});
