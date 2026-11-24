'use strict';

/**
 * utils/cryptoPayload.js — Dynamic mathematical cipher & anti-replay security.
 * Mencegah Postman & bot memanggil /api/verify dan /api/scripts secara telanjang.
 */

const usedNonces = new Map();

// Bersihkan nonce lama setiap 5 menit
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of usedNonces.entries()) {
    if (now - ts > 180000) {
      usedNonces.delete(k);
    }
  }
}, 300000).unref();

function deriveKey(seedStr, len = 32) {
  let h = 5381n;
  for (let i = 0; i < seedStr.length; i++) {
    h = (h * 33n + BigInt(seedStr.charCodeAt(i))) % 2147483647n;
  }
  const key = [];
  let s = h;
  for (let i = 0; i < len; i++) {
    s = (s * 1103515245n + 12345n) % 2147483647n;
    key.push(Number((s / 65536n) % 256n));
  }
  return key;
}

function calcMathUid(uidStr, timeVal) {
  const clean = String(uidStr || '0').replace(/\D/g, '') || '0';
  const u = BigInt(clean);
  const t = BigInt((Number(timeVal) % 1000) + 7);
  return String(u * 31n + 648321n + (t * 17n));
}

function encryptPayload(text, secret, timeVal, nonceVal) {
  const seed = String(secret) + ':' + String(timeVal) + ':' + String(nonceVal);
  const key = deriveKey(seed, 32);
  const buf = Buffer.from(String(text), 'utf8');
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const k = key[i % key.length];
    const b = (buf[i] + k + ((i + 1) * 13)) % 256;
    out.push(b.toString(16).padStart(2, '0'));
  }
  return out.join('');
}

function decryptPayload(hex, secret, timeVal, nonceVal) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) return null;
  const seed = String(secret) + ':' + String(timeVal) + ':' + String(nonceVal);
  const key = deriveKey(seed, 32);
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    const b = parseInt(hex.substr(i, 2), 16);
    if (Number.isNaN(b)) return null;
    bytes.push(b);
  }
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const k = key[i % key.length];
    let b = (bytes[i] - k - ((i + 1) * 13)) % 256;
    if (b < 0) b += 256;
    out[i] = b;
  }
  return out.toString('utf8');
}

/**
 * Validasi dan dekripsi payload dari client.
 * Returns { ok: true, uid, script, charName, timeVal, nonceVal } atau { ok: false, error }
 */
function verifyAndUnpackPayload({ hex, timeVal, nonceVal, secretKey }) {
  if (!hex || !timeVal || !nonceVal) {
    return { ok: false, error: 'missing_payload_params' };
  }

  const timeNum = Number(timeVal);
  if (!Number.isFinite(timeNum)) {
    return { ok: false, error: 'invalid_timestamp' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timeNum) > 90) {
    return { ok: false, error: 'payload_expired' };
  }

  const decrypted = decryptPayload(hex, secretKey, timeVal, nonceVal);
  if (!decrypted) {
    return { ok: false, error: 'decryption_failed' };
  }

  const parts = decrypted.split(':');
  if (parts.length < 5) {
    return { ok: false, error: 'malformed_payload' };
  }

  const [uid, script, payloadTime, payloadNonce, mathUid, ...rest] = parts;
  const charName = rest.join(':');

  if (String(payloadTime) !== String(timeVal) || String(payloadNonce) !== String(nonceVal)) {
    return { ok: false, error: 'payload_mismatch' };
  }

  /* Anti-replay memakai payload itu sendiri, bukan uid+timestamp+nonce.
   * Nonce dipilih client, jadi dua request sah dalam detik yang sama (list lalu
   * verify, atau dua run beruntun) bisa kebetulan sama dan dulu ikut ditolak.
   * Yang perlu diblokir cuma pemakaian ulang URL yang persis sama. */
  const replayKey = hex;
  if (usedNonces.has(replayKey)) {
    return { ok: false, error: 'replay_detected' };
  }
  usedNonces.set(replayKey, Date.now());

  return {
    ok: true,
    uid,
    script,
    charName,
    timeVal,
    nonceVal,
  };
}

module.exports = {
  deriveKey,
  calcMathUid,
  encryptPayload,
  decryptPayload,
  verifyAndUnpackPayload,
};
