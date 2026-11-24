'use strict';

/**
 * controllers/reportController.js — laporan gagal dari loader di sisi buyer.
 *
 * Loader memanggil GET /api/report?stage=…&status=…&detail=…&uid=…&char=… ketika
 * verifikasi gagal (termasuk gagal konek, yang tidak pernah sampai ke /api/verify).
 * Endpoint ini tidak pernah mengembalikan verdict lisensi, hanya menyimpan bukti
 * supaya operator bisa melihat kenapa satu buyer tidak bisa jalan.
 *
 * Tanpa autentikasi: isinya diagnostik, bukan rahasia. Yang disimpan dibatasi
 * (whitelist stage, detail ≤180 char, UID numerik) dan laju request dibatasi
 * reportLimiter supaya tidak bisa dipakai membanjiri log.
 */

const store = require('../db/store');
const asyncHandler = require('../middleware/asyncHandler');
const discordWebhook = require('../utils/discordWebhook');
const { clientIp } = require('../utils/clientIp');

const STAGES = new Set(['list', 'verify', 'run', 'init']);
const UID_RE = /^\d{1,19}$/;
const STATUS_RE = /^\d{1,3}$/;

function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[`\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

exports.report = asyncHandler(async (req, res) => {
  res.type('text/plain');
  res.set('Cache-Control', 'no-store');

  const stageRaw = cleanText(req.query.stage, 16).toLowerCase();
  const stage = STAGES.has(stageRaw) ? stageRaw : 'unknown';
  const statusRaw = cleanText(req.query.status, 4);
  const status = STATUS_RE.test(statusRaw) ? statusRaw : '0';
  const detail = cleanText(req.query.detail, 180);
  const uidRaw = cleanText(req.query.uid, 19);
  const uid = UID_RE.test(uidRaw) ? uidRaw : '';
  const charName = cleanText(req.query.char, 64);
  const ip = clientIp(req);
  const at = new Date().toISOString();

  const data = await store.read();
  const tokenRaw = req.get('x-buyer-token') || '';
  const token = tokenRaw ? store.findToken(data, tokenRaw) : null;
  const webhookUrl = data.settings.discord_webhook || process.env.DISCORD_WEBHOOK_URL || '';

  const result = `client_${stage}`;

  try {
    await store.recordLog({
      at,
      uid,
      char_name: charName,
      script: '_report',
      result,
      via: token ? 'token' : 'secret',
      token_id: token ? token.id : '',
      token_label: token ? token.label : '',
      ip,
      detail: `${status}${detail ? ' ' + detail : ''}`,
    });
  } catch (err) {
    console.warn('[report] gagal simpan log:', err.message);
  }

  console.log(`[report] stage=${stage} status=${status} uid=${uid || '-'} ip=${ip} detail=${detail || '-'}`);
  discordWebhook.sendClientError(webhookUrl, {
    at,
    stage,
    status,
    detail,
    uid,
    charName,
    ip,
    tokenLabel: token ? token.label : '',
  });

  res.send('OK:reported');
});
