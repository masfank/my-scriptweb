'use strict';

const crypto = require('crypto');
const store = require('../db/store');
const asyncHandler = require('../middleware/asyncHandler');
const discordWebhook = require('../utils/discordWebhook');

function currentSecret(data) {
  if (data.settings.app_secret) {
    return { secret: data.settings.app_secret, fromEnv: false };
  }
  return { secret: process.env.APP_SECRET || '', fromEnv: true };
}

exports.show = asyncHandler(async (req, res) => {
  const data = await store.read();
  const current = currentSecret(data);
  res.render('secret', {
    title: 'Secret',
    admin: req.admin,
    secret: current.secret,
    fromEnv: current.fromEnv,
    msg: typeof req.query.ok === 'string' ? req.query.ok : null,
    err: typeof req.query.err === 'string' ? req.query.err : null,
  });
});

exports.rotate = asyncHandler(async (req, res) => {
  const secret = crypto.randomBytes(32).toString('hex');
  await store.update((data) => {
    data.settings.app_secret = secret;
  });
  res.redirect('/admin/secret?ok=' + encodeURIComponent('Secret baru dibuat. Update loader semua buyer.'));
});

function webhookRedirectTarget(req) {
  const next = typeof req.body.next === 'string' ? req.body.next.trim() : '';
  if (next === '/admin/logs' || next === '/admin') return next;
  return '/admin';
}

exports.saveWebhook = asyncHandler(async (req, res) => {
  const raw = typeof req.body.webhook_url === 'string' ? req.body.webhook_url.trim() : '';
  const target = webhookRedirectTarget(req);

  if (raw && !discordWebhook.isValidWebhookUrl(raw)) {
    return res.redirect(
      `${target}?err=` + encodeURIComponent('URL Webhook Discord tidak valid (harus https://discord.com/api/webhooks/...)')
    );
  }

  await store.update((data) => {
    data.settings.discord_webhook = raw;
  });

  const msg = raw
    ? 'Webhook Discord berhasil disimpan dan diaktifkan.'
    : 'Webhook Discord dinonaktifkan.';
  return res.redirect(`${target}?ok=` + encodeURIComponent(msg));
});

exports.testWebhook = asyncHandler(async (req, res) => {
  const data = await store.read();
  const raw = typeof req.body.webhook_url === 'string' ? req.body.webhook_url.trim() : '';
  const url = raw || data.settings.discord_webhook || '';

  if (!url) {
    return res.status(400).json({ ok: false, error: 'Masukkan URL Webhook Discord terlebih dahulu.' });
  }

  try {
    await discordWebhook.sendTestWebhook(url);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});
