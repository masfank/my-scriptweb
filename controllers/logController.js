'use strict';

/**
 * controllers/logController.js — riwayat aktivitas eksekusi script buyer (/api/verify).
 */

const store = require('../db/store');
const asyncHandler = require('../middleware/asyncHandler');

const PAGE_SIZE = 50;

const RESULT_LABELS = {
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

function displayTimeFull(iso) {
  if (!iso || typeof iso !== 'string') return '—';
  return iso.slice(0, 19).replace('T', ' ') + ' UTC';
}

function buildQuery(q, status, script) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status && status !== 'semua') params.set('status', status);
  if (script && script !== 'semua') params.set('script', script);
  return params;
}

exports.list = asyncHandler(async (req, res) => {
  const data = await store.read();
  const files = await store.listScripts();

  const scriptSet = new Set([
    ...Object.keys(data.scripts),
    ...files.map((f) => f.name),
  ]);

  const rawLogs = await store.readLogs();
  for (const item of rawLogs) {
    if (item && item.script && store.isSafeName(item.script)) {
      scriptSet.add(item.script);
    }
  }
  const scripts = Array.from(scriptSet).sort((a, b) => a.localeCompare(b));

  const totalCount = rawLogs.length;
  const okCount = rawLogs.filter((l) => l && l.result === 'ok').length;
  const rejectedCount = totalCount - okCount;

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const statusRaw = typeof req.query.status === 'string' ? req.query.status : 'semua';
  const status = ['semua', 'ok', 'rejected'].includes(statusRaw) ? statusRaw : 'semua';
  const scriptFilter =
    typeof req.query.script === 'string' && req.query.script !== 'semua'
      ? req.query.script.trim()
      : 'semua';

  let entries = rawLogs.map((l) => {
    const uid = l.uid || '';
    const wl = uid && data.whitelist[uid] ? data.whitelist[uid] : null;
    const tok = l.token_id && data.tokens[l.token_id] ? data.tokens[l.token_id] : null;
    const result = l.result || 'unknown';
    const resultLabel = RESULT_LABELS[result] || `Ditolak · ${result}`;

    return {
      id: l.id || '',
      at: l.at || '',
      at_display: displayTimeFull(l.at),
      uid,
      char_name: l.char_name || '',
      in_whitelist: Boolean(wl),
      discord_id: wl && wl.discord_id ? wl.discord_id : '',
      buyer_note: wl && wl.note ? wl.note : '',
      script: l.script || '',
      result,
      is_ok: result === 'ok',
      result_label: resultLabel,
      via: l.via || '-',
      token_id: l.token_id || '',
      token_label: l.token_label || (tok ? tok.label : ''),
      ip: l.ip || '—',
    };
  });

  if (status === 'ok') {
    entries = entries.filter((e) => e.is_ok);
  } else if (status === 'rejected') {
    entries = entries.filter((e) => !e.is_ok);
  }

  if (scriptFilter !== 'semua') {
    entries = entries.filter((e) => e.script === scriptFilter);
  }

  const qLower = q.toLowerCase();
  if (qLower) {
    entries = entries.filter(
      (e) =>
        e.uid.toLowerCase().includes(qLower) ||
        e.char_name.toLowerCase().includes(qLower) ||
        e.discord_id.toLowerCase().includes(qLower) ||
        e.buyer_note.toLowerCase().includes(qLower) ||
        e.script.toLowerCase().includes(qLower) ||
        e.token_label.toLowerCase().includes(qLower) ||
        e.token_id.toLowerCase().includes(qLower) ||
        e.ip.toLowerCase().includes(qLower) ||
        e.result.toLowerCase().includes(qLower) ||
        e.result_label.toLowerCase().includes(qLower)
    );
  }

  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
  const start = (page - 1) * PAGE_SIZE;
  const rows = entries.slice(start, start + PAGE_SIZE);

  const query = buildQuery(q, status, scriptFilter);
  const pageUrl = (n) => {
    const params = new URLSearchParams(query);
    params.set('page', String(n));
    return '/admin/logs?' + params.toString();
  };

  res.render('logs', {
    title: 'Log Aktivitas Buyer',
    admin: req.admin,
    rows,
    stats: {
      total: totalCount,
      ok: okCount,
      rejected: rejectedCount,
      max: store.MAX_LOGS,
    },
    filters: { q, status, script: scriptFilter },
    scripts,
    page,
    pages,
    totalRows: entries.length,
    discordWebhook: data.settings.discord_webhook || '',
    msg: typeof req.query.ok === 'string' ? req.query.ok : null,
    err: typeof req.query.err === 'string' ? req.query.err : null,
    prevUrl: page > 1 ? pageUrl(page - 1) : null,
    nextUrl: page < pages ? pageUrl(page + 1) : null,
  });
});

exports.clear = asyncHandler(async (req, res) => {
  await store.clearLogs();

  if (req.accepts(['html', 'json']) === 'json') {
    return res.json({ ok: true });
  }
  return res.redirect(
    '/admin/logs?ok=' + encodeURIComponent('Seluruh riwayat log aktivitas berhasil dibersihkan.')
  );
});
