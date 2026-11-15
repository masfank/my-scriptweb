'use strict';

/**
 * controllers/tokenController.js — token per buyer.
 *
 * Token dibuat di server, hanya hash SHA-256 yang disimpan. Nilai mentah
 * ditampilkan sekali di halaman hasil; setelah itu tidak bisa dipulihkan.
 *
 * Satu token mengunci dirinya ke satu UID pada verifikasi pertama. Admin bisa
 * melepas kunci (unlock) supaya buyer bisa pindah perangkat/UID, atau
 * menonaktifkan token sepenuhnya (revoke).
 */

const crypto = require('crypto');
const store = require('../db/store');
const asyncHandler = require('../middleware/asyncHandler');

const LABEL_MAX = 64;
const NOTE_MAX = 200;
const UID_RE = /^\d{1,19}$/;

function displayTime(iso) {
  if (!iso) return '—';
  return iso.slice(0, 16).replace('T', ' ') + ' UTC';
}

function mask(token) {
  return token.raw.slice(0, 6) + '…' + token.raw.slice(-4);
}

exports.list = asyncHandler(async (req, res) => {
  const data = await store.read();
  const files = await store.listScripts();

  const ids = new Set([...Object.keys(data.scripts), ...files.map((f) => f.name)]);
  const scripts = Array.from(ids).sort((a, b) => a.localeCompare(b));

  const fresh = req.session && req.session.freshToken ? req.session.freshToken : null;
  if (req.session && req.session.freshToken) {
    req.session.freshToken = null;
  }

  const whitelistOptions = Object.entries(data.whitelist)
    .map(([uid, entry]) => ({
      uid,
      note: entry.note || '',
      discord_id: entry.discord_id || '',
      status: entry.status || 'active',
    }))
    .sort((a, b) => a.uid.localeCompare(b.uid));

  const rows = Object.entries(data.tokens)
    .map(([id, token]) => {
      const uids =
        Array.isArray(token.uids) && token.uids.length > 0
          ? token.uids.map(String)
          : token.uid !== null && token.uid !== undefined && String(token.uid) !== ''
            ? [String(token.uid)]
            : [];
      return {
        id,
        raw: token.raw || '',
        label: token.label || '',
        uid: uids[0] || '',
        uids,
        bundle: token.bundle || '',
        locked: uids.length > 0,
        active: token.active === true,
        note: token.note || '',
        use_count: token.use_count || 0,
        last_used_display: displayTime(token.last_used),
        locked_at_display: displayTime(token.locked_at),
        created_at_display: displayTime(token.created_at),
      };
    })
    .sort((a, b) => (a.created_at_display < b.created_at_display ? 1 : -1));

  res.render('tokens', {
    title: 'Token buyer',
    admin: req.admin,
    rows,
    scripts,
    whitelistOptions,
    fresh,
    msg: typeof req.query.ok === 'string' ? req.query.ok : null,
    err: typeof req.query.err === 'string' ? req.query.err : null,
  });
});

exports.create = asyncHandler(async (req, res) => {
  const label = (typeof req.body.label === 'string' ? req.body.label : '').trim();
  const note = (typeof req.body.note === 'string' ? req.body.note : '').trim();
  const rawUids = Array.isArray(req.body.uids)
    ? req.body.uids
    : typeof req.body.uids === 'string' && req.body.uids.trim()
      ? [req.body.uids]
      : typeof req.body.uid === 'string' && req.body.uid.trim()
        ? [req.body.uid]
        : [];
  const uids = Array.from(new Set(rawUids.map((u) => String(u).trim()).filter(Boolean)));
  const bundle = typeof req.body.bundle === 'string' ? req.body.bundle : '';

  if (!label) {
    return res.redirect('/admin/tokens?err=' + encodeURIComponent('Label wajib diisi'));
  }
  if (label.length > LABEL_MAX) {
    return res.redirect('/admin/tokens?err=' + encodeURIComponent(`Label maksimal ${LABEL_MAX} karakter`));
  }
  if (note.length > NOTE_MAX) {
    return res.redirect('/admin/tokens?err=' + encodeURIComponent(`Note maksimal ${NOTE_MAX} karakter`));
  }
  const invalidUid = uids.find((u) => !UID_RE.test(u));
  if (invalidUid) {
    return res.redirect('/admin/tokens?err=' + encodeURIComponent(`UID tidak valid: ${invalidUid}`));
  }

  const data = await store.read();
  if (bundle && !store.isSafeName(bundle)) {
    return res.redirect('/admin/tokens?err=' + encodeURIComponent('Script bundle tidak valid'));
  }
  const missingUid = uids.find((u) => !data.whitelist[u]);
  if (missingUid) {
    return res.redirect(
      '/admin/tokens?err=' + encodeURIComponent(`UID ${missingUid} belum ada di whitelist — tambahkan dulu`)
    );
  }

  const created = store.newToken();
  const now = new Date().toISOString();

  await store.update((db) => {
    db.tokens[created.id] = {
      hash: created.hash,
      raw: created.raw,
      label,
      note,
      uid: uids[0] || null,
      uids,
      active: true,
      bundle: bundle || null,
      created_at: now,
      locked_at: uids.length > 0 ? now : null,
      last_used: null,
      use_count: 0,
    };
  });

  req.session.freshToken = {
    id: created.id,
    raw: created.raw,
    label,
    uid: uids[0] || null,
    uids,
    bundle: bundle || null,
  };

  return res.redirect('/admin/tokens?ok=' + encodeURIComponent('Token dibuat.'));
});

exports.consumeFresh = (req, res) => {
  const fresh = req.session && req.session.freshToken;
  if (req.session) req.session.freshToken = null;
  if (!fresh) return res.redirect('/admin/tokens');
  return res.render('token_fresh', {
    title: 'Token baru',
    admin: req.admin,
    token: fresh,
    masked: mask(fresh),
  });
};

exports.toggle = asyncHandler(async (req, res) => {
  const id = req.params.id;
  let active = null;

  try {
    await store.update((db) => {
      const token = db.tokens[id];
      if (!token) throw new store.StoreError('not_found');
      token.active = token.active !== true;
      active = token.active;
    });
  } catch (err) {
    if (err.message === 'not_found') {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    throw err;
  }

  return res.json({ ok: true, active });
});

exports.unlock = asyncHandler(async (req, res) => {
  const id = req.params.id;
  let unlockedFrom = '';

  try {
    await store.update((db) => {
      const token = db.tokens[id];
      if (!token) throw new store.StoreError('not_found');
      const prev =
        Array.isArray(token.uids) && token.uids.length > 0
          ? token.uids
          : token.uid
            ? [token.uid]
            : [];
      unlockedFrom = prev.join(', ');
      token.uid = null;
      token.uids = [];
      token.locked_at = null;
    });
  } catch (err) {
    if (err.message === 'not_found') {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    throw err;
  }

  return res.json({ ok: true, unlocked_from: unlockedFrom });
});

exports.updateUids = asyncHandler(async (req, res) => {
  const id = req.params.id;
  const rawUids = Array.isArray(req.body.uids)
    ? req.body.uids
    : typeof req.body.uids === 'string' && req.body.uids.trim()
      ? [req.body.uids]
      : [];
  const uids = Array.from(new Set(rawUids.map((u) => String(u).trim()).filter(Boolean)));
  const back = (key, message) => res.redirect(`/admin/tokens?${key}=` + encodeURIComponent(message));

  const invalidUid = uids.find((u) => !UID_RE.test(u));
  if (invalidUid) return back('err', `UID tidak valid: ${invalidUid}`);

  const data = await store.read();
  if (!data.tokens[id]) return back('err', 'Token tidak ditemukan');
  const missingUid = uids.find((u) => !data.whitelist[u]);
  if (missingUid) return back('err', `UID ${missingUid} belum ada di whitelist — tambahkan dulu`);

  const now = new Date().toISOString();
  await store.update((db) => {
    const token = db.tokens[id];
    if (!token) throw new store.StoreError('not_found');
    token.uid = uids[0] || null;
    token.uids = uids;
    token.locked_at = uids.length > 0 ? (token.locked_at || now) : null;
  });

  const summary = uids.length > 0 ? `dikunci ke ${uids.length} UID (${uids.join(', ')})` : 'diatur ke auto-lock';
  return back('ok', `UID token diperbarui: ${summary}. Token tetap sama.`);
});

exports.rotate = asyncHandler(async (req, res) => {
  const id = req.params.id;
  const created = store.newToken();
  let payload = null;

  try {
    await store.update((db) => {
      const token = db.tokens[id];
      if (!token) throw new store.StoreError('not_found');
      token.hash = created.hash;
      token.raw = created.raw;
      payload = {
        id,
        raw: created.raw,
        label: token.label || '',
        uid: token.uid || null,
        bundle: token.bundle || null,
      };
    });
  } catch (err) {
    if (err.message === 'not_found') {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    throw err;
  }

  return res.json({ ok: true, ...payload });
});

exports.remove = asyncHandler(async (req, res) => {
  const id = req.params.id;
  let existed = false;

  try {
    await store.update((db) => {
      if (!db.tokens[id]) throw new store.StoreError('not_found');
      delete db.tokens[id];
      existed = true;
    });
  } catch (err) {
    if (err.message === 'not_found') {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    throw err;
  }

  return res.json({ ok: true, removed: existed });
});

exports.exportData = asyncHandler(async (req, res) => {
  const data = await store.read();
  const dateTag = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="tokens-export-${dateTag}.json"`);
  return res.json({
    type: 'script-web-tokens',
    version: 1,
    exported_at: new Date().toISOString(),
    tokens: data.tokens || {},
  });
});

exports.importData = asyncHandler(async (req, res) => {
  const rawPayload = typeof req.body.payload === 'string' ? req.body.payload.trim() : '';
  const overwrite = req.body.overwrite === '1' || req.body.overwrite === 'true';
  const back = (key, message) => res.redirect(`/admin/tokens?${key}=` + encodeURIComponent(message));

  if (!rawPayload) return back('err', 'Isi JSON import tidak boleh kosong');

  let parsed;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return back('err', 'Format JSON token tidak valid');
  }

  const source =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.tokens && typeof parsed.tokens === 'object'
      ? parsed.tokens
      : parsed;

  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return back('err', 'Struktur JSON token harus object { "id16hex": { ... } }');
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  await store.update((db) => {
    for (const [rawId, item] of Object.entries(source)) {
      if (!item || typeof item !== 'object') {
        skipped++;
        continue;
      }
      const id = /^[a-f0-9]{16}$/.test(rawId) ? rawId : crypto.randomBytes(8).toString('hex');
      const rawToken = typeof item.raw === 'string' && /^[a-f0-9]{64}$/.test(item.raw.trim()) ? item.raw.trim() : '';
      let hash = typeof item.hash === 'string' && /^[a-f0-9]{64}$/.test(item.hash.trim()) ? item.hash.trim() : '';
      if (!hash && rawToken) {
        hash = store.hashToken(rawToken);
      }
      const label = typeof item.label === 'string' ? item.label.trim().slice(0, LABEL_MAX) : '';
      if (!hash || !label) {
        skipped++;
        continue;
      }

      const existed = Boolean(db.tokens[id]);
      if (existed && !overwrite) {
        skipped++;
        continue;
      }

      const rawUids = Array.isArray(item.uids)
        ? item.uids
        : item.uid !== null && item.uid !== undefined && String(item.uid).trim() !== ''
          ? [item.uid]
          : [];
      const uids = Array.from(
        new Set(rawUids.map((u) => String(u ?? '').trim()).filter((u) => UID_RE.test(u)))
      );

      const bundleRaw = typeof item.bundle === 'string' ? item.bundle.trim() : '';
      const bundle = bundleRaw && store.isSafeName(bundleRaw) ? bundleRaw : null;

      const entry = {
        hash,
        label,
        note: typeof item.note === 'string' ? item.note.trim().slice(0, NOTE_MAX) : '',
        uid: uids[0] || null,
        uids,
        active: item.active !== false,
        bundle,
        created_at: typeof item.created_at === 'string' && item.created_at ? item.created_at : now,
        locked_at: uids.length > 0 ? (typeof item.locked_at === 'string' ? item.locked_at : now) : null,
        last_used: typeof item.last_used === 'string' ? item.last_used : null,
        use_count: Number.isFinite(Number(item.use_count)) ? Math.max(0, Number(item.use_count)) : 0,
      };
      if (rawToken) entry.raw = rawToken;

      db.tokens[id] = entry;
      if (existed) updated++;
      else added++;
    }
  });

  return back('ok', `Import token selesai: ${added} ditambah, ${updated} ditimpa, ${skipped} dilewati.`);
});
