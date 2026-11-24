'use strict';

/**
 * utils/clientIp.js — IP buyer asli di belakang Cloudflare/Railway/nginx.
 * Header proxy hanya dipercaya kalau isinya IP publik; IP privat/lokal jatuh
 * kembali ke req.ip supaya log tidak menampilkan alamat internal Railway.
 */

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

module.exports = { normalizeIp, isPrivateIp, clientIp };
