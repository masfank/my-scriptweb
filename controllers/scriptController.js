'use strict';

const store = require('../db/store');
const asyncHandler = require('../middleware/asyncHandler');

const MAX_SOURCE = 2_000_000;

function displayTime(iso) {
  if (!iso) return '—';
  return iso.slice(0, 16).replace('T', ' ') + ' UTC';
}

function back(res, path, key, message) {
  return res.redirect(`${path}?${key}=` + encodeURIComponent(message));
}

exports.list = asyncHandler(async (req, res) => {
  const data = await store.read();
  const files = await store.listScripts();

  const usedBy = {};
  for (const entry of Object.values(data.whitelist)) {
    for (const name of entry.scripts) usedBy[name] = (usedBy[name] || 0) + 1;
  }

  const rows = files.map((file) => {
    const meta = data.scripts[file.name];
    return {
      name: file.name,
      version: meta && meta.version ? meta.version : '—',
      size_kb: (file.size / 1024).toFixed(1),
      updated_at_display: displayTime(meta && meta.updated_at),
      used_by: usedBy[file.name] || 0,
    };
  });

  res.render('scripts', {
    title: 'Scripts',
    admin: req.admin,
    rows,
    msg: typeof req.query.ok === 'string' ? req.query.ok : null,
    err: typeof req.query.err === 'string' ? req.query.err : null,
  });
});

exports.newForm = asyncHandler(async (req, res) => {
  res.render('script_form', {
    title: 'Script baru',
    admin: req.admin,
    mode: 'new',
    action: '/admin/scripts',
    name: '',
    version: '1.0.0',
    source: '',
    msg: null,
    err: typeof req.query.err === 'string' ? req.query.err : null,
  });
});

exports.editForm = asyncHandler(async (req, res) => {
  const name = req.params.name;
  const source = await store.readScript(name);
  if (source === null) {
    return res.status(404).render('error', {
      title: '404',
      status: 404,
      message: `Script '${name}' tidak ditemukan`,
    });
  }

  const data = await store.read();
  const meta = data.scripts[name];

  res.render('script_form', {
    title: `Edit ${name}`,
    admin: req.admin,
    mode: 'edit',
    action: `/admin/scripts/${encodeURIComponent(name)}`,
    name,
    version: meta && meta.version ? meta.version : '1.0.0',
    source,
    msg: null,
    err: typeof req.query.err === 'string' ? req.query.err : null,
  });
});

exports.saveNew = asyncHandler(async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const version = (typeof req.body.version === 'string' ? req.body.version.trim() : '') || '1.0.0';
  const source = typeof req.body.source_code === 'string' ? req.body.source_code : '';

  if (!store.isSafeName(name)) {
    return back(res, '/admin/scripts/new', 'err', 'Nama script: huruf, angka, _ dan - (maks 64)');
  }
  if (version.length > 32) return back(res, '/admin/scripts/new', 'err', 'Versi maksimal 32 karakter');
  if (!source) return back(res, '/admin/scripts/new', 'err', 'Source tidak boleh kosong');
  if (source.length > MAX_SOURCE) return back(res, '/admin/scripts/new', 'err', 'Source terlalu besar');

  const data = await store.read();
  if (data.scripts[name] || (await store.readScript(name)) !== null) {
    return back(res, '/admin/scripts/new', 'err', 'Script sudah ada');
  }

  await store.writeScript(name, source);
  await store.update((db) => {
    db.scripts[name] = { version, updated_at: new Date().toISOString() };
  });

  return back(res, '/admin/scripts', 'ok', `Script ${name} dibuat`);
});

exports.update = asyncHandler(async (req, res) => {
  const name = req.params.name;
  const version = (typeof req.body.version === 'string' ? req.body.version.trim() : '') || '1.0.0';
  const source = typeof req.body.source_code === 'string' ? req.body.source_code : '';
  const editUrl = `/admin/scripts/${encodeURIComponent(name)}`;

  if (version.length > 32) return back(res, editUrl, 'err', 'Versi maksimal 32 karakter');
  if (!source) return back(res, editUrl, 'err', 'Source tidak boleh kosong');
  if (source.length > MAX_SOURCE) return back(res, editUrl, 'err', 'Source terlalu besar');

  if ((await store.readScript(name)) === null) {
    return res.status(404).render('error', {
      title: '404',
      status: 404,
      message: `Script '${name}' tidak ditemukan`,
    });
  }

  /* file dulu, metadata belakangan: metadata gagal = file tetap terlayani */
  await store.writeScript(name, source);
  await store.update((db) => {
    db.scripts[name] = { version, updated_at: new Date().toISOString() };
  });

  return back(res, '/admin/scripts', 'ok', `Script ${name} disimpan`);
});

exports.remove = asyncHandler(async (req, res) => {
  const name = req.params.name;
  const data = await store.read();
  const used = Object.values(data.whitelist).filter((e) => e.scripts.includes(name)).length;

  if (used > 0) {
    return back(res, '/admin/scripts', 'err', `Script masih dipakai ${used} UID`);
  }

  await store.deleteScript(name);
  await store.update((db) => {
    delete db.scripts[name];
  });

  return back(res, '/admin/scripts', 'ok', `Script ${name} dihapus`);
});

exports.exportData = asyncHandler(async (req, res) => {
  const data = await store.read();
  const files = await store.listScripts();
  const scripts = [];

  for (const file of files) {
    const source = await store.readScript(file.name);
    if (source === null) continue;
    const meta = data.scripts[file.name] || {};
    scripts.push({
      name: file.name,
      version: meta.version || '1.0.0',
      updated_at: meta.updated_at || null,
      source,
    });
  }

  const dateTag = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="scripts-export-${dateTag}.json"`);
  return res.json({
    type: 'script-web-scripts',
    version: 1,
    exported_at: new Date().toISOString(),
    scripts,
  });
});

exports.importData = asyncHandler(async (req, res) => {
  const rawPayload = typeof req.body.payload === 'string' ? req.body.payload.trim() : '';
  const overwrite = req.body.overwrite === '1' || req.body.overwrite === 'true';

  if (!rawPayload) return back(res, '/admin/scripts', 'err', 'Isi JSON import tidak boleh kosong');

  let parsed;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return back(res, '/admin/scripts', 'err', 'Format JSON script tidak valid');
  }

  let items = [];
  const rawList = parsed && typeof parsed === 'object' && parsed.scripts !== undefined ? parsed.scripts : parsed;
  if (Array.isArray(rawList)) {
    items = rawList;
  } else if (rawList && typeof rawList === 'object') {
    items = Object.entries(rawList).map(([name, val]) => ({ name, ...(val && typeof val === 'object' ? val : {}) }));
  } else {
    return back(res, '/admin/scripts', 'err', 'Struktur JSON script tidak valid');
  }

  const data = await store.read();
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const metaUpdates = {};

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      skipped++;
      continue;
    }
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const source = typeof item.source === 'string' ? item.source : '';
    const version = (typeof item.version === 'string' ? item.version.trim() : '').slice(0, 32) || '1.0.0';

    if (!store.isSafeName(name) || !source || source.length > MAX_SOURCE) {
      skipped++;
      continue;
    }

    const existed = Boolean(data.scripts[name]) || (await store.readScript(name)) !== null;
    if (existed && !overwrite) {
      skipped++;
      continue;
    }

    await store.writeScript(name, source);
    metaUpdates[name] = {
      version,
      updated_at: typeof item.updated_at === 'string' && item.updated_at ? item.updated_at : new Date().toISOString(),
    };
    if (existed) updated++;
    else added++;
  }

  if (Object.keys(metaUpdates).length > 0) {
    await store.update((db) => {
      for (const [name, meta] of Object.entries(metaUpdates)) {
        db.scripts[name] = meta;
      }
    });
  }

  return back(res, '/admin/scripts', 'ok', `Import script selesai: ${added} ditambah, ${updated} ditimpa, ${skipped} dilewati.`);
});
