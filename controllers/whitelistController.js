'use strict';

const store = require('../db/store');
const asyncHandler = require('../middleware/asyncHandler');

const UID_RE = /^\d{1,19}$/;
const DISCORD_ID_RE = /^\d{15,22}$/;
const PAGE_SIZE = 50;

function stats(data) {
  const values = Object.values(data.whitelist);
  const active = values.filter((e) => e.status === 'active').length;
  return { total: values.length, active, banned: values.length - active };
}

function displayTime(iso) {
  if (!iso) return '—';
  return iso.slice(0, 16).replace('T', ' ') + ' UTC';
}

function buildQuery(q, status) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status && status !== 'semua') params.set('status', status);
  return params;
}

exports.dashboard = asyncHandler(async (req, res) => {
  const data = await store.read();
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const statusRaw = typeof req.query.status === 'string' ? req.query.status : 'semua';
  const status = ['semua', 'active', 'banned'].includes(statusRaw) ? statusRaw : 'semua';

  const qLower = q.toLowerCase();
  let entries = Object.entries(data.whitelist).map(([uid, e]) => ({
    uid,
    status: e.status,
    scripts: e.scripts,
    discord_id: e.discord_id || '',
    note: e.note || '',
    last_check_display: displayTime(e.last_check),
    check_count: e.check_count || 0,
    created_at: e.created_at || '',
  }));

  if (qLower) {
    entries = entries.filter(
      (e) =>
        e.uid.includes(qLower) ||
        e.discord_id.includes(qLower) ||
        e.note.toLowerCase().includes(qLower) ||
        e.scripts.some((name) => name.toLowerCase().includes(qLower))
    );
  }
  if (status !== 'semua') entries = entries.filter((e) => e.status === status);

  entries.sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.uid.localeCompare(b.uid);
  });

  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
  const start = (page - 1) * PAGE_SIZE;
  const rows = entries.slice(start, start + PAGE_SIZE);

  const files = await store.listScripts();
  const names = Array.from(
    new Set([...Object.keys(data.scripts), ...files.map((f) => f.name)])
  ).sort((a, b) => a.localeCompare(b));

  const query = buildQuery(q, status);
  const pageUrl = (n) => {
    const params = new URLSearchParams(query);
    params.set('page', String(n));
    return '/admin?' + params.toString();
  };

  const freshWhitelist = req.session && req.session.freshWhitelist ? req.session.freshWhitelist : null;
  if (req.session && req.session.freshWhitelist) {
    req.session.freshWhitelist = null;
  }

  res.render('dashboard', {
    title: 'Dashboard',
    admin: req.admin,
    rows,
    stats: stats(data),
    filters: { q, status },
    page,
    pages,
    totalRows: entries.length,
    scripts: names,
    discordWebhook: data.settings.discord_webhook || '',
    freshWhitelist,
    msg: typeof req.query.ok === 'string' ? req.query.ok : null,
    err: typeof req.query.err === 'string' ? req.query.err : null,
    prevUrl: page > 1 ? pageUrl(page - 1) : null,
    nextUrl: page < pages ? pageUrl(page + 1) : null,
  });
});

function parseScripts(body) {
  const raw = Array.isArray(body.scripts)
    ? body.scripts
    : typeof body.scripts === 'string'
      ? [body.scripts]
      : [];
  return Array.from(new Set(raw.map((name) => String(name).trim()).filter(Boolean)));
}

async function validScripts(names) {
  const data = await store.read();
  const files = new Set((await store.listScripts()).map((f) => f.name));
  return names.filter(
    (name) => store.isSafeName(name) && (data.scripts[name] || files.has(name))
  );
}

exports.create = asyncHandler(async (req, res) => {
  const uid = typeof req.body.uid === 'string' ? req.body.uid.trim() : '';
  const discordId = typeof req.body.discord_id === 'string' ? req.body.discord_id.trim() : '';
  const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
  const picked = parseScripts(req.body);

  const back = (err) => res.redirect('/admin?err=' + encodeURIComponent(err));

  if (!UID_RE.test(uid)) return back('UID harus angka 1-19 digit');
  if (discordId && !DISCORD_ID_RE.test(discordId)) {
    return back('Discord User ID harus angka 15-22 digit (atau kosongkan)');
  }
  if (note.length > 200) return back('Note maksimal 200 karakter');
  if (picked.length === 0) return back('Pilih minimal satu script');

  const scripts = await validScripts(picked);
  if (scripts.length !== picked.length) {
    const missing = picked.filter((name) => !scripts.includes(name));
    return back(`Script tidak ada: ${missing.join(', ')}`);
  }

  const data = await store.read();
  if (data.whitelist[uid]) return back(`UID ${uid} sudah terdaftar — edit barisnya`);

  const created = store.newToken();
  const now = new Date().toISOString();
  const tokenLabel = (note || `UID ${uid}`).slice(0, 64);

  try {
    await store.update((db) => {
      if (db.whitelist[uid]) throw new store.StoreError(`UID ${uid} sudah terdaftar`);
      db.whitelist[uid] = {
        status: 'active',
        scripts,
        discord_id: discordId,
        note,
        created_at: now,
        last_check: null,
        check_count: 0,
      };
      db.tokens[created.id] = {
        hash: created.hash,
        raw: created.raw,
        label: tokenLabel,
        note: note || '',
        uid,
        active: true,
        bundle: scripts[0] || null,
        created_at: now,
        locked_at: now,
        last_used: null,
        use_count: 0,
      };
    });
  } catch (err) {
    return back(err.message);
  }

  req.session.freshWhitelist = {
    uid,
    discord_id: discordId,
    label: tokenLabel,
    raw: created.raw,
    script: scripts[0] || '',
    scripts,
  };

  return res.redirect('/admin?ok=' + encodeURIComponent(`UID ${uid} ditambahkan beserta token buyer baru. Salin token & script loader sekarang.`));
});

exports.editForm = asyncHandler(async (req, res) => {
  const uid = req.params.uid;
  const data = await store.read();
  const entry = data.whitelist[uid];
  if (!entry) {
    return res.status(404).render('error', {
      title: '404',
      status: 404,
      message: `UID '${uid}' tidak ada di whitelist`,
    });
  }

  const files = await store.listScripts();
  const names = Array.from(
    new Set([...Object.keys(data.scripts), ...files.map((f) => f.name)])
  ).sort((a, b) => a.localeCompare(b));

  res.render('whitelist_form', {
    title: `Edit UID ${uid}`,
    admin: req.admin,
    uid,
    status: entry.status,
    selected: entry.scripts,
    discord_id: entry.discord_id || '',
    note: entry.note || '',
    created_display: displayTime(entry.created_at),
    last_check_display: displayTime(entry.last_check),
    check_count: entry.check_count || 0,
    scripts: names,
    discordWebhook: data.settings.discord_webhook || '',
    msg: typeof req.query.ok === 'string' ? req.query.ok : null,
    err: typeof req.query.err === 'string' ? req.query.err : null,
  });
});

exports.update = asyncHandler(async (req, res) => {
  const uid = req.params.uid;
  const editUrl = `/admin/whitelist/${uid}`;
  const discordId = typeof req.body.discord_id === 'string' ? req.body.discord_id.trim() : '';
  const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
  const picked = parseScripts(req.body);
  const status = req.body.status === 'banned' ? 'banned' : 'active';

  const back = (key, message) =>
    res.redirect(`${editUrl}?${key}=` + encodeURIComponent(message));

  if (discordId && !DISCORD_ID_RE.test(discordId)) {
    return back('err', 'Discord User ID harus angka 15-22 digit (atau kosongkan)');
  }
  if (note.length > 200) return back('err', 'Note maksimal 200 karakter');
  if (picked.length === 0) return back('err', 'Pilih minimal satu script');

  const scripts = await validScripts(picked);
  if (scripts.length !== picked.length) {
    const missing = picked.filter((name) => !scripts.includes(name));
    return back('err', `Script tidak ada: ${missing.join(', ')}`);
  }

  try {
    await store.update((db) => {
      const entry = db.whitelist[uid];
      if (!entry) throw new store.StoreError(`UID ${uid} sudah tidak ada`);
      entry.scripts = scripts;
      entry.status = status;
      entry.discord_id = discordId;
      entry.note = note;
    });
  } catch (err) {
    return back('err', err.message);
  }

  return res.redirect('/admin?ok=' + encodeURIComponent(`UID ${uid} diperbarui`));
});

exports.toggle = asyncHandler(async (req, res) => {
  const uid = req.params.uid;
  let newStatus = null;

  try {
    await store.update((db) => {
      const entry = db.whitelist[uid];
      if (!entry) throw new store.StoreError('not_found');
      entry.status = entry.status === 'active' ? 'banned' : 'active';
      newStatus = entry.status;
    });
  } catch (err) {
    if (err.message === 'not_found') {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    throw err;
  }

  const data = await store.read();
  return res.json({ ok: true, status: newStatus, stats: stats(data) });
});

exports.remove = asyncHandler(async (req, res) => {
  const uid = req.params.uid;
  let existed = false;

  try {
    await store.update((db) => {
      if (!db.whitelist[uid]) throw new store.StoreError('not_found');
      delete db.whitelist[uid];
      existed = true;
    });
  } catch (err) {
    if (err.message === 'not_found') {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    throw err;
  }

  const data = await store.read();
  return res.json({ ok: true, removed: existed, stats: stats(data) });
});

exports.exportData = asyncHandler(async (req, res) => {
  const data = await store.read();
  const dateTag = new Date().toISOString().slice(0, 10);
  const payload = {
    type: 'script-web-whitelist',
    version: 1,
    exported_at: new Date().toISOString(),
    whitelist: data.whitelist || {},
  };
  res.setHeader('Content-Disposition', `attachment; filename="whitelist-export-${dateTag}.json"`);
  return res.json(payload);
});

exports.importData = asyncHandler(async (req, res) => {
  const rawPayload = typeof req.body.payload === 'string' ? req.body.payload.trim() : '';
  const overwrite = req.body.overwrite === '1' || req.body.overwrite === 'true';
  const back = (key, message) => res.redirect(`/admin?${key}=` + encodeURIComponent(message));

  if (!rawPayload) return back('err', 'Isi JSON import tidak boleh kosong');

  let parsed;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return back('err', 'Format JSON whitelist tidak valid');
  }

  const source =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.whitelist && typeof parsed.whitelist === 'object'
      ? parsed.whitelist
      : parsed;

  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return back('err', 'Struktur JSON whitelist harus object { "UID": { ... } }');
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  await store.update((db) => {
    for (const [rawUid, item] of Object.entries(source)) {
      const uid = String(rawUid || '').trim();
      if (!UID_RE.test(uid) || !item || typeof item !== 'object') {
        skipped++;
        continue;
      }
      const existed = Boolean(db.whitelist[uid]);
      if (existed && !overwrite) {
        skipped++;
        continue;
      }

      const rawScripts = Array.isArray(item.scripts) ? item.scripts : [];
      const scripts = Array.from(
        new Set(rawScripts.map((s) => String(s || '').trim()).filter((s) => store.isSafeName(s)))
      );
      const discordRaw = typeof item.discord_id === 'string' ? item.discord_id.trim() : '';
      const discord_id = DISCORD_ID_RE.test(discordRaw) ? discordRaw : '';
      const note = typeof item.note === 'string' ? item.note.trim().slice(0, 200) : '';
      const status = item.status === 'banned' ? 'banned' : 'active';

      db.whitelist[uid] = {
        status,
        scripts,
        discord_id,
        note,
        created_at: typeof item.created_at === 'string' && item.created_at ? item.created_at : now,
        last_check: typeof item.last_check === 'string' ? item.last_check : null,
        check_count: Number.isFinite(Number(item.check_count)) ? Math.max(0, Number(item.check_count)) : 0,
      };
      if (existed) updated++;
      else added++;
    }
  });

  return back('ok', `Import whitelist selesai: ${added} ditambah, ${updated} ditimpa, ${skipped} dilewati.`);
});
