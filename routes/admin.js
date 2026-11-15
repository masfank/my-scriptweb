'use strict';

const express = require('express');
const requireAdmin = require('../middleware/requireAdmin');
const requireOwner = require('../middleware/requireOwner');
const verifyCsrf = require('../middleware/verifyCsrf');
const store = require('../db/store');

const whitelist = require('../controllers/whitelistController');
const scripts = require('../controllers/scriptController');
const settings = require('../controllers/settingsController');
const tokens = require('../controllers/tokenController');
const logs = require('../controllers/logController');
const users = require('../controllers/userController');
const backup = require('../controllers/backupController');

const router = express.Router();

const UID_RE = /^\d{1,19}$/;

function rejectParam(req, res, message) {
  if (req.accepts(['html', 'json']) === 'json') {
    return res.status(400).json({ ok: false, error: 'bad_request' });
  }
  const back = req.path.startsWith('/scripts') ? '/admin/scripts' : '/admin';
  return res.redirect(`${back}?err=` + encodeURIComponent(message));
}

function validateUid(req, res, next) {
  if (!UID_RE.test(req.params.uid)) return rejectParam(req, res, 'UID tidak valid');
  next();
}

function validateName(req, res, next) {
  if (!store.isSafeName(req.params.name)) return rejectParam(req, res, 'Nama script tidak valid');
  next();
}

router.use(requireAdmin);
router.use(verifyCsrf);

router.use(async (req, res, next) => {
  if (req.method === 'GET') {
    try {
      const data = await store.read();
      res.locals.loaderTokens = Object.entries(data.tokens || {})
        .filter(([, t]) => t.active === true && typeof t.raw === 'string' && t.raw.length > 0)
        .map(([id, t]) => ({
          id,
          label: t.label || '',
          raw: t.raw,
          bundle: t.bundle || '',
          uids: Array.isArray(t.uids) && t.uids.length > 0 ? t.uids.map(String) : t.uid ? [String(t.uid)] : [],
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
    } catch {
      res.locals.loaderTokens = [];
    }
  }
  next();
});

router.get('/', whitelist.dashboard);
router.get('/whitelist/export', whitelist.exportData);
router.post('/whitelist/import', whitelist.importData);
router.post('/whitelist', whitelist.create);
router.get('/whitelist/:uid', validateUid, whitelist.editForm);
router.post('/whitelist/:uid', validateUid, whitelist.update);
router.post('/whitelist/:uid/toggle', validateUid, whitelist.toggle);
router.post('/whitelist/:uid/delete', validateUid, whitelist.remove);

/* /scripts/new, /scripts/export, /scripts/import HARUS sebelum /scripts/:name (khusus Admin) */
router.get('/scripts', requireOwner, scripts.list);
router.get('/scripts/export', requireOwner, scripts.exportData);
router.post('/scripts/import', requireOwner, scripts.importData);
router.get('/scripts/new', requireOwner, scripts.newForm);
router.post('/scripts', requireOwner, scripts.saveNew);
router.get('/scripts/:name', requireOwner, validateName, scripts.editForm);
router.post('/scripts/:name', requireOwner, validateName, scripts.update);
router.post('/scripts/:name/delete', requireOwner, validateName, scripts.remove);

/* token buyer: dibuat di sini, dikirim ke loader sebagai X-Buyer-Token */
router.get('/tokens', tokens.list);
router.get('/tokens/export', tokens.exportData);
router.post('/tokens/import', tokens.importData);
router.get('/tokens/new/fresh', tokens.consumeFresh);
router.post('/tokens', tokens.create);
router.post('/tokens/:id/toggle', tokens.toggle);
router.post('/tokens/:id/unlock', tokens.unlock);
router.post('/tokens/:id/uids', tokens.updateUids);
router.post('/tokens/:id/rotate', tokens.rotate);
router.post('/tokens/:id/delete', tokens.remove);

router.get('/secret', requireOwner, settings.show);
router.post('/secret/rotate', requireOwner, settings.rotate);

/* kelola akun admin & leader (khusus Admin) */
router.get('/users', requireOwner, users.list);
router.post('/users', requireOwner, users.create);
router.post('/users/:username/password', requireOwner, users.resetPassword);
router.post('/users/:username/delete', requireOwner, users.remove);

/* universal backup export & import semua data (khusus Admin) */
router.get('/backup/export', requireOwner, backup.exportAll);
router.post('/backup/import', requireOwner, backup.importAll);

/* webhook discord untuk history eksekusi buyer (khusus Admin) */
router.post('/webhook', requireOwner, settings.saveWebhook);
router.post('/webhook/test', requireOwner, settings.testWebhook);

/* riwayat log eksekusi script buyer */
router.get('/logs', logs.list);
router.post('/logs/clear', requireOwner, logs.clear);

module.exports = router;
