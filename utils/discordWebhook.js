'use strict';

/**
 * utils/discordWebhook.js — kirim notifikasi riwayat eksekusi script ke Discord Webhook
 * dengan antrean serial + auto-retry saat terkena rate limit (HTTP 429).
 */

const WEBHOOK_RE = /^https:\/\/(?:canary\.|ptb\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+(?:\?.*)?$/;

const RESULT_TEXT = {
  ok: 'OK · Script Terkirim',
  invalid_secret: 'Ditolak · Token / Secret Salah',
  bad_request: 'Ditolak · Parameter Tidak Valid',
  not_found: 'Ditolak · UID Belum Terdaftar',
  banned: 'Ditolak · UID Banned',
  uid_locked: 'Ditolak · Terkunci ke UID Lain',
  uid_not_allowed: 'Ditolak · UID Tidak Diizinkan',
  script_mismatch: 'Ditolak · Tidak Punya Izin Script',
  script_missing: 'Error · File .lua Tidak Ditemukan',
  token_revoked: 'Ditolak · Token Nonaktif / Dicabut',
};

const MAX_PENDING_QUEUE = 25;
let pendingCount = 0;
let nextAllowedAt = 0;
let webhookChain = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidWebhookUrl(url) {
  if (typeof url !== 'string') return false;
  return WEBHOOK_RE.test(url.trim());
}

async function sendOnce(webhookUrl, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    return await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function postDiscordPayload(webhookUrl, payload) {
  const waitBefore = nextAllowedAt - Date.now();
  if (waitBefore > 0) await sleep(waitBefore);

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await sendOnce(webhookUrl, payload);

    const remaining = res.headers.get('x-ratelimit-remaining');
    const resetAfter = Number(res.headers.get('x-ratelimit-reset-after') || 0);
    if (remaining === '0' && resetAfter > 0) {
      nextAllowedAt = Math.max(nextAllowedAt, Date.now() + Math.ceil(resetAfter * 1000) + 100);
    } else {
      nextAllowedAt = Math.max(nextAllowedAt, Date.now() + 450);
    }

    if (res.ok) return;

    const text = await res.text().catch(() => '');
    if (res.status === 429 && attempt < maxAttempts) {
      let retryMs = 500;
      try {
        const body = JSON.parse(text);
        if (body && typeof body.retry_after === 'number') {
          retryMs = Math.min(5000, Math.ceil(body.retry_after * 1000) + 120);
        }
      } catch {
        const hdr = Number(res.headers.get('retry-after') || 0);
        if (hdr > 0) retryMs = Math.min(5000, Math.ceil(hdr * 1000) + 120);
      }
      nextAllowedAt = Math.max(nextAllowedAt, Date.now() + retryMs);
      await sleep(retryMs);
      continue;
    }

    throw new Error(`Discord HTTP ${res.status}${text ? ': ' + text.slice(0, 120) : ''}`);
  }
}

function enqueueWebhook(webhookUrl, payload) {
  if (pendingCount >= MAX_PENDING_QUEUE) {
    console.warn('[discord-webhook] antrean penuh, notifikasi dilewati.');
    return;
  }
  pendingCount += 1;
  const run = webhookChain.then(async () => {
    try {
      await postDiscordPayload(webhookUrl, payload);
    } finally {
      pendingCount = Math.max(0, pendingCount - 1);
    }
  });
  webhookChain = run.catch((err) => {
    console.warn('[discord-webhook] gagal kirim:', err.message);
  });
}

function formatDiscordBuyer(info) {
  const rawId = info.discord_id ? String(info.discord_id).trim() : '';
  if (/^\d{15,22}$/.test(rawId)) return `<@${rawId}>`;
  if (info.token_label) return String(info.token_label);
  return '—';
}

function sendVerifyLog(webhookUrl, info) {
  if (!isValidWebhookUrl(webhookUrl)) return;

  const isOk = info.result === 'ok';
  const statusLabel = RESULT_TEXT[info.result] || `Ditolak · ${info.result}`;
  const discordBuyer = formatDiscordBuyer(info);
  const credText =
    info.via === 'token'
      ? info.token_label
        ? `Token: ${info.token_label}`
        : 'Token Buyer'
      : 'Legacy Secret';

  const payload = {
    embeds: [
      {
        title: isOk ? 'Script Loader Dijalankan' : 'Percobaan Loader Ditolak',
        color: isOk ? 0x10b981 : 0xef4444,
        fields: [
          { name: 'Discord Buyer', value: String(discordBuyer), inline: true },
          { name: 'ID (UID)', value: `\`${info.uid || '—'}\``, inline: true },
          { name: 'Nama Char', value: info.char_name ? `\`${info.char_name}\`` : '`—`', inline: true },
          { name: 'Script', value: info.script ? `\`${info.script}.lua\`` : '`—`', inline: true },
          { name: 'Alamat IP', value: `\`${info.ip || '—'}\``, inline: true },
          { name: 'Status', value: `${statusLabel} (${credText})`, inline: true },
        ],
        footer: { text: 'Lisensi UID · CGT Script Guard' },
        timestamp: info.at || new Date().toISOString(),
      },
    ],
  };

  enqueueWebhook(webhookUrl.trim(), payload);
}

async function sendTestWebhook(webhookUrl) {
  if (!isValidWebhookUrl(webhookUrl)) {
    throw new Error('URL Webhook Discord tidak valid (harus https://discord.com/api/webhooks/...)');
  }

  await postDiscordPayload(webhookUrl.trim(), {
    embeds: [
      {
        title: 'Tes Koneksi Webhook Berhasil',
        description: 'Notifikasi history eksekusi script buyer siap dikirim ke channel ini.',
        color: 0x10b981,
        fields: [
          { name: 'Discord Buyer', value: 'Contoh @buyer', inline: true },
          { name: 'ID (UID)', value: '`123456`', inline: true },
          { name: 'Nama Char', value: '`ExampleChar`', inline: true },
          { name: 'Script', value: '`autofind.lua`', inline: true },
          { name: 'Alamat IP', value: '`127.0.0.1`', inline: true },
          { name: 'Status', value: 'OK · Script Terkirim', inline: true },
        ],
        footer: { text: 'Lisensi UID · CGT Script Guard' },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

module.exports = {
  isValidWebhookUrl,
  sendVerifyLog,
  sendTestWebhook,
};
