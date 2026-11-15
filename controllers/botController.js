'use strict';

const store = require('../db/store');
const asyncHandler = require('../middleware/asyncHandler');
const buyerQuota = require('../utils/buyerQuota');
const { getBotStatus, getGuildRoles } = require('../bot/discordBot');

const ROLE_ID_RE = /^\d{15,22}$/;

function parseRoleIds(raw) {
  return Array.from(
    new Set(
      String(raw || '')
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => ROLE_ID_RE.test(s))
    )
  );
}

exports.showPage = asyncHandler(async (req, res) => {
  const data = await store.read();
  const files = await store.listScripts();
  const scripts = Array.from(new Set([...Object.keys(data.scripts), ...files.map((f) => f.name)])).sort((a, b) =>
    a.localeCompare(b)
  );

  const cfg = (data.settings && data.settings.bot_config) || {};
  const botConfig = {
    prefix: (typeof cfg.prefix === 'string' && cfg.prefix.trim()) || (process.env.BOT_PREFIX || '!').trim() || '!',
    buyer_role_ids: Array.isArray(cfg.buyer_role_ids) ? cfg.buyer_role_ids : [],
    admin_role_ids: Array.isArray(cfg.admin_role_ids) ? cfg.admin_role_ids : [],
    default_scripts: Array.isArray(cfg.default_scripts) ? cfg.default_scripts : [],
    role_scripts: Array.isArray(cfg.role_scripts) ? cfg.role_scripts : [],
  };

  const uidCounts = {};
  for (const entry of Object.values(data.whitelist || {})) {
    if (entry.discord_id) uidCounts[entry.discord_id] = (uidCounts[entry.discord_id] || 0) + 1;
  }

  const buyers = Object.entries(data.buyers || {})
    .map(([discord_id, info]) => ({
      discord_id,
      note: info.note || '',
      max_uids: info.max_uids || 1,
      used_uids: uidCounts[discord_id] || 0,
    }))
    .sort((a, b) => a.discord_id.localeCompare(b.discord_id));

  res.render('bot', {
    title: 'Bot Discord',
    admin: req.admin,
    botStatus: getBotStatus(),
    discordRoles: getGuildRoles(),
    botConfig,
    scripts,
    buyers,
    msg: typeof req.query.ok === 'string' ? req.query.ok : null,
    err: typeof req.query.err === 'string' ? req.query.err : null,
  });
});

exports.saveConfig = asyncHandler(async (req, res) => {
  const prefixRaw = typeof req.body.prefix === 'string' ? req.body.prefix.trim() : '';
  const prefix = prefixRaw.slice(0, 5) || '!';
  const buyerRoleIds = parseRoleIds(req.body.buyer_role_ids);
  const adminRoleIds = parseRoleIds(req.body.admin_role_ids);

  const rawScripts = Array.isArray(req.body.default_scripts)
    ? req.body.default_scripts
    : typeof req.body.default_scripts === 'string' && req.body.default_scripts.trim()
      ? [req.body.default_scripts]
      : [];
  const defaultScripts = Array.from(
    new Set(rawScripts.map((s) => String(s || '').trim()).filter((s) => store.isSafeName(s)))
  );

  await store.update((db) => {
    const prev = (db.settings && db.settings.bot_config) || {};
    db.settings.bot_config = {
      prefix,
      buyer_role_ids: buyerRoleIds,
      admin_role_ids: adminRoleIds,
      default_scripts: defaultScripts,
      role_scripts: Array.isArray(prev.role_scripts) ? prev.role_scripts : [],
    };
  });

  return res.redirect('/admin/bot?ok=' + encodeURIComponent('Pengaturan Bot Discord disimpan dan langsung aktif.'));
});

exports.addRoleScript = asyncHandler(async (req, res) => {
  const roleId = typeof req.body.role_id === 'string' ? req.body.role_id.trim() : '';
  const label = typeof req.body.label === 'string' ? req.body.label.trim().slice(0, 64) : '';
  const rawScripts = Array.isArray(req.body.scripts)
    ? req.body.scripts
    : typeof req.body.scripts === 'string' && req.body.scripts.trim()
      ? [req.body.scripts]
      : [];
  const scripts = Array.from(
    new Set(rawScripts.map((s) => String(s || '').trim()).filter((s) => store.isSafeName(s)))
  );

  if (!ROLE_ID_RE.test(roleId)) {
    return res.redirect('/admin/bot?err=' + encodeURIComponent('Role ID Discord harus angka 15–22 digit.'));
  }
  if (scripts.length === 0) {
    return res.redirect('/admin/bot?err=' + encodeURIComponent('Pilih minimal 1 script untuk role tersebut.'));
  }

  await store.update((db) => {
    const prev = (db.settings && db.settings.bot_config) || {};
    const list = Array.isArray(prev.role_scripts) ? [...prev.role_scripts] : [];
    const idx = list.findIndex((item) => item && item.role_id === roleId);
    const entry = { role_id: roleId, label, scripts };
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);

    db.settings.bot_config = {
      prefix: prev.prefix || '!',
      buyer_role_ids: Array.isArray(prev.buyer_role_ids) ? prev.buyer_role_ids : [],
      admin_role_ids: Array.isArray(prev.admin_role_ids) ? prev.admin_role_ids : [],
      default_scripts: Array.isArray(prev.default_scripts) ? prev.default_scripts : [],
      role_scripts: list,
    };
  });

  return res.redirect('/admin/bot?ok=' + encodeURIComponent(`Mapping role ${label || roleId} → ${scripts.join(', ')} disimpan.`));
});

exports.removeRoleScript = asyncHandler(async (req, res) => {
  const roleId = typeof req.params.roleId === 'string' ? req.params.roleId.trim() : '';
  if (!ROLE_ID_RE.test(roleId)) {
    return res.redirect('/admin/bot?err=' + encodeURIComponent('Role ID tidak valid.'));
  }

  await store.update((db) => {
    const prev = (db.settings && db.settings.bot_config) || {};
    const list = Array.isArray(prev.role_scripts) ? prev.role_scripts.filter((item) => item && item.role_id !== roleId) : [];
    db.settings.bot_config = {
      ...prev,
      role_scripts: list,
    };
  });

  return res.redirect('/admin/bot?ok=' + encodeURIComponent(`Mapping role ${roleId} dihapus.`));
});

exports.setMaxWeb = asyncHandler(async (req, res) => {
  const outcome = await buyerQuota.setBuyerMax({
    discordId: req.body.discord_id,
    maxUids: req.body.max_uids,
    note: req.body.note,
  });
  if (!outcome.body.ok) {
    return res.redirect('/admin/bot?err=' + encodeURIComponent(outcome.body.message || outcome.body.error));
  }
  return res.redirect('/admin/bot?ok=' + encodeURIComponent(`Kuota UID untuk ${outcome.body.discord_id} diatur ke ${outcome.body.max_uids}.`));
});

exports.addUid = asyncHandler(async (req, res) => {
  const outcome = await buyerQuota.addBuyerUid({
    uid: req.body.uid,
    discordId: req.body.discord_id,
    discordName: req.body.discord_name,
    requestedScripts: req.body.scripts,
    requestedMax: req.body.max_uids,
  });
  return res.status(outcome.status).json(outcome.body);
});

exports.getBuyer = asyncHandler(async (req, res) => {
  const outcome = await buyerQuota.getBuyerInfo(req.params.discordId);
  return res.status(outcome.status).json(outcome.body);
});

exports.setMax = asyncHandler(async (req, res) => {
  const outcome = await buyerQuota.setBuyerMax({
    discordId: req.body.discord_id,
    maxUids: req.body.max_uids,
    note: req.body.note,
  });
  return res.status(outcome.status).json(outcome.body);
});

exports.removeUid = asyncHandler(async (req, res) => {
  const outcome = await buyerQuota.removeBuyerUid({
    uid: req.body.uid,
    discordId: req.body.discord_id,
    force: req.body.force === true || req.body.force === '1',
  });
  return res.status(outcome.status).json(outcome.body);
});
