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
