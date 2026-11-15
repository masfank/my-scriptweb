'use strict';

const crypto = require('crypto');
const store = require('../db/store');
const asyncHandler = require('../middleware/asyncHandler');

const UID_RE = /^\d{1,19}$/;
const DISCORD_ID_RE = /^\d{15,22}$/;
const MAX_SOURCE = 2_000_000;

exports.exportAll = asyncHandler(async (req, res) => {
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
  res.setHeader('Content-Disposition', `attachment; filename="script-web-backup-${dateTag}.json"`);
  return res.json({
    type: 'script-web-universal-backup',
    version: 1,
    exported_at: new Date().toISOString(),
    whitelist: data.whitelist || {},
    tokens: data.tokens || {},
    buyers: data.buyers || {},
    scripts,
    settings: {
      app_secret: data.settings.app_secret || '',
      discord_webhook: data.settings.discord_webhook || '',
      bot_config: data.settings.bot_config || {},
    },
  });
});

exports.importAll = asyncHandler(async (req, res) => {
  const rawPayload = typeof req.body.payload === 'string' ? req.body.payload.trim() : '';
  const overwrite = req.body.overwrite === '1' || req.body.overwrite === 'true';
  const includeSettings = req.body.include_settings === '1' || req.body.include_settings === 'true';
  const back = (key, message) => res.redirect(`/admin?${key}=` + encodeURIComponent(message));

  if (!rawPayload) return back('err', 'Isi JSON backup tidak boleh kosong');

  let parsed;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return back('err', 'Format JSON backup tidak valid');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return back('err', 'Struktur JSON backup tidak valid');
  }

  const data = await store.read();
  const now = new Date().toISOString();

  /* 1. Tulis file script .lua dulu sebelum update metadata di db.json */
  const scriptList = Array.isArray(parsed.scripts)
    ? parsed.scripts
    : parsed.scripts && typeof parsed.scripts === 'object'
      ? Object.entries(parsed.scripts).map(([name, val]) => ({ name, ...(val && typeof val === 'object' ? val : {}) }))
      : [];

  let sAdd = 0;
  let sUpd = 0;
  const scriptMeta = {};

  for (const item of scriptList) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const source = typeof item.source === 'string' ? item.source : '';
    const version = (typeof item.version === 'string' ? item.version.trim() : '').slice(0, 32) || '1.0.0';
    if (!store.isSafeName(name) || !source || source.length > MAX_SOURCE) continue;

    const existed = Boolean(data.scripts[name]) || (await store.readScript(name)) !== null;
    if (existed && !overwrite) continue;

    await store.writeScript(name, source);
    scriptMeta[name] = {
      version,
      updated_at: typeof item.updated_at === 'string' && item.updated_at ? item.updated_at : now,
    };
    if (existed) sUpd++;
    else sAdd++;
  }

  /* 2. Update whitelist, tokens, buyers, script metadata, dan settings secara atomik */
  let wAdd = 0;
  let wUpd = 0;
  let tAdd = 0;
  let tUpd = 0;
  let bAdd = 0;
  let bUpd = 0;

  await store.update((db) => {
    for (const [name, meta] of Object.entries(scriptMeta)) {
      db.scripts[name] = meta;
    }

    if (parsed.whitelist && typeof parsed.whitelist === 'object' && !Array.isArray(parsed.whitelist)) {
      for (const [rawUid, item] of Object.entries(parsed.whitelist)) {
        const uid = String(rawUid || '').trim();
        if (!UID_RE.test(uid) || !item || typeof item !== 'object') continue;
        const existed = Boolean(db.whitelist[uid]);
        if (existed && !overwrite) continue;

        const rawScripts = Array.isArray(item.scripts) ? item.scripts : [];
        const scripts = Array.from(
          new Set(rawScripts.map((s) => String(s || '').trim()).filter((s) => store.isSafeName(s)))
        );
        const discordRaw = typeof item.discord_id === 'string' ? item.discord_id.trim() : '';

        db.whitelist[uid] = {
          status: item.status === 'banned' ? 'banned' : 'active',
          scripts,
          discord_id: DISCORD_ID_RE.test(discordRaw) ? discordRaw : '',
          note: typeof item.note === 'string' ? item.note.trim().slice(0, 200) : '',
          created_at: typeof item.created_at === 'string' && item.created_at ? item.created_at : now,
          last_check: typeof item.last_check === 'string' ? item.last_check : null,
          check_count: Number.isFinite(Number(item.check_count)) ? Math.max(0, Number(item.check_count)) : 0,
        };
        if (existed) wUpd++;
        else wAdd++;
      }
    }

    if (parsed.tokens && typeof parsed.tokens === 'object' && !Array.isArray(parsed.tokens)) {
      for (const [rawId, item] of Object.entries(parsed.tokens)) {
        if (!item || typeof item !== 'object') continue;
        const id = /^[a-f0-9]{16}$/.test(rawId) ? rawId : crypto.randomBytes(8).toString('hex');
        const rawToken = typeof item.raw === 'string' && /^[a-f0-9]{64}$/.test(item.raw.trim()) ? item.raw.trim() : '';
        let hash = typeof item.hash === 'string' && /^[a-f0-9]{64}$/.test(item.hash.trim()) ? item.hash.trim() : '';
        if (!hash && rawToken) hash = store.hashToken(rawToken);
        const label = typeof item.label === 'string' ? item.label.trim().slice(0, 64) : '';
        if (!hash || !label) continue;

        const existed = Boolean(db.tokens[id]);
        if (existed && !overwrite) continue;

        const rawUids = Array.isArray(item.uids)
          ? item.uids
          : item.uid !== null && item.uid !== undefined && String(item.uid).trim() !== ''
            ? [item.uid]
            : [];
        const uids = Array.from(
          new Set(rawUids.map((u) => String(u ?? '').trim()).filter((u) => UID_RE.test(u)))
        );
        const bundleRaw = typeof item.bundle === 'string' ? item.bundle.trim() : '';

        const entry = {
          hash,
          label,
          note: typeof item.note === 'string' ? item.note.trim().slice(0, 200) : '',
          uid: uids[0] || null,
          uids,
          active: item.active !== false,
          bundle: bundleRaw && store.isSafeName(bundleRaw) ? bundleRaw : null,
          created_at: typeof item.created_at === 'string' && item.created_at ? item.created_at : now,
          locked_at: uids.length > 0 ? (typeof item.locked_at === 'string' ? item.locked_at : now) : null,
          last_used: typeof item.last_used === 'string' ? item.last_used : null,
          use_count: Number.isFinite(Number(item.use_count)) ? Math.max(0, Number(item.use_count)) : 0,
        };
        if (rawToken) entry.raw = rawToken;

        db.tokens[id] = entry;
        if (existed) tUpd++;
        else tAdd++;
      }
    }

    if (parsed.buyers && typeof parsed.buyers === 'object' && !Array.isArray(parsed.buyers)) {
      if (!db.buyers || typeof db.buyers !== 'object') db.buyers = {};
      for (const [rawDid, info] of Object.entries(parsed.buyers)) {
        const did = String(rawDid || '').trim();
        if (!DISCORD_ID_RE.test(did) || !info || typeof info !== 'object') continue;
        const existed = Boolean(db.buyers[did]);
        if (existed && !overwrite) continue;

        const maxNum = Number(info.max_uids);
        db.buyers[did] = {
          max_uids: Number.isFinite(maxNum) ? Math.min(100, Math.max(1, Math.floor(maxNum))) : 1,
          note: typeof info.note === 'string' ? info.note.trim().slice(0, 200) : '',
          updated_at: typeof info.updated_at === 'string' && info.updated_at ? info.updated_at : now,
        };
        if (existed) bUpd++;
        else bAdd++;
      }
    }

    if (includeSettings && parsed.settings && typeof parsed.settings === 'object') {
      if (typeof parsed.settings.discord_webhook === 'string' && (overwrite || !db.settings.discord_webhook)) {
        db.settings.discord_webhook = parsed.settings.discord_webhook.trim();
      }
      if (typeof parsed.settings.app_secret === 'string' && parsed.settings.app_secret.trim() && overwrite) {
        db.settings.app_secret = parsed.settings.app_secret.trim();
      }
      const bc = parsed.settings.bot_config;
      if (bc && typeof bc === 'object' && !Array.isArray(bc) && (overwrite || !db.settings.bot_config)) {
        const cleanRoles = (arr) =>
          Array.isArray(arr)
            ? Array.from(new Set(arr.map((x) => String(x || '').trim()).filter((x) => DISCORD_ID_RE.test(x))))
            : [];
        const cleanScripts = (arr) =>
          Array.isArray(arr)
            ? Array.from(new Set(arr.map((x) => String(x || '').trim()).filter((x) => store.isSafeName(x))))
            : [];
        const cleanRoleScripts = Array.isArray(bc.role_scripts)
          ? bc.role_scripts
              .filter((r) => r && typeof r === 'object' && DISCORD_ID_RE.test(String(r.role_id || '').trim()))
              .map((r) => ({
                role_id: String(r.role_id).trim(),
                label: typeof r.label === 'string' ? r.label.trim().slice(0, 60) : '',
                scripts: cleanScripts(r.scripts),
              }))
          : [];
        db.settings.bot_config = {
          prefix: (typeof bc.prefix === 'string' && bc.prefix.trim().slice(0, 5)) || '!',
          buyer_role_ids: cleanRoles(bc.buyer_role_ids),
          admin_role_ids: cleanRoles(bc.admin_role_ids),
          default_scripts: cleanScripts(bc.default_scripts),
          role_scripts: cleanRoleScripts,
        };
      }
    }
  });

  return back(
    'ok',
    `Import universal selesai — Whitelist: +${wAdd}/${wUpd} timpa, Token: +${tAdd}/${tUpd} timpa, Kuota Buyer: +${bAdd}/${bUpd} timpa, Script: +${sAdd}/${sUpd} timpa.`
  );
});
