'use strict';

/**
 * controllers/loaderGenController.js — unduh loader yang sudah terisi konfigurasi
 * buyer. Logika loader tetap satu: `loader.lua` di repo (lihat utils/loaderTemplate).
 */

const asyncHandler = require('../middleware/asyncHandler');
const store = require('../db/store');
const { renderLoader } = require('../utils/loaderTemplate');

exports.show = asyncHandler(async (req, res) => {
  const data = await store.read();

  const authMode = req.query.auth === 'secret' ? 'secret' : 'token';
  const secret = authMode === 'secret' ? data.settings.app_secret || process.env.APP_SECRET || '' : '';

  if (authMode === 'secret' && req.admin && req.admin.role === 'leader') {
    return res.status(403).type('text/plain').send('ERROR:secret_mode_owner_only');
  }

  const mode = typeof req.query.mode === 'string' ? req.query.mode : 'full';

  let out;
  try {
    out = renderLoader({
      mode,
      baseUrl: typeof req.query.base === 'string' ? req.query.base : '',
      token: typeof req.query.token === 'string' ? req.query.token : '',
      secret,
      script: typeof req.query.script === 'string' ? req.query.script : 'auto',
    });
  } catch (err) {
    return res.status(400).type('text/plain').send('ERROR:' + err.message);
  }

  res.type('text/plain');
  res.set('Cache-Control', 'no-store');
  res.set('Content-Disposition', 'inline; filename="loader.lua"');
  res.send(out);
});
