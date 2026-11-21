'use strict';

const store = require('../db/store');

const UID_RE = /^\d{1,19}$/;
const DISCORD_ID_RE = /^\d{15,22}$/;
const ROLE_ID_RE = /^\d{15,22}$/;
const MAX_UIDS = 100;

function normalizeRoleIds(raw) {
  if (Array.isArray(raw)) {
    return Array.from(
      new Set(raw.map((s) => String(s || '').trim()).filter((s) => ROLE_ID_RE.test(s)))
    );
  }
  const single = String(raw || '').trim();
  return ROLE_ID_RE.test(single) ? [single] : [];
}

function getRoleRules(db) {
  const list = db.settings && db.settings.bot_config && db.settings.bot_config.role_scripts;
  if (!Array.isArray(list)) return [];
  return list
    .filter((rule) => rule && ROLE_ID_RE.test(String(rule.role_id || '')))
    .map((rule) => ({
      role_id: String(rule.role_id),
      label: typeof rule.label === 'string' && rule.label.trim() ? rule.label.trim() : String(rule.role_id),
      scripts: Array.isArray(rule.scripts) ? rule.scripts.filter((s) => typeof s === 'string' && s) : [],
      max_uids:
        Number.isInteger(rule.max_uids) && rule.max_uids >= 1 && rule.max_uids <= MAX_UIDS
          ? rule.max_uids
          : 1,
    }));
}

function ownerUids(db, discordId) {
  return Object.entries(db.whitelist || {}).filter(([, entry]) => entry && entry.discord_id === discordId);
}

function uidMatchesRule(entry, rule) {
  const scripts = Array.isArray(entry && entry.scripts) ? entry.scripts : [];
  return rule.scripts.some((script) => scripts.includes(script));
}

function roleMax(db, discordId, rule) {
  const buyer = (db.buyers && db.buyers[discordId]) || {};
  if (!rule) {
    return Number.isInteger(buyer.max_uids) && buyer.max_uids >= 1
      ? Math.min(buyer.max_uids, MAX_UIDS)
      : 1;
  }
  const override = buyer.roles && buyer.roles[rule.role_id];
  if (override && Number.isInteger(override.max_uids) && override.max_uids >= 1) {
    return Math.min(override.max_uids, MAX_UIDS);
  }
  return rule.max_uids;
}

function scopeUids(db, discordId, rule, rules) {
  return ownerUids(db, discordId)
    .filter(([, entry]) => {
      const matched = rules.some((r) => uidMatchesRule(entry, r));
      return rule ? uidMatchesRule(entry, rule) : !matched;
    })
    .map(([uid]) => uid);
}

function quotaScope(db, discordId, rule, rules) {
  const uids = scopeUids(db, discordId, rule, rules);
  return {
    role_id: rule ? rule.role_id : null,
    label: rule ? rule.label : 'Umum',
    used: uids.length,
    max: roleMax(db, discordId, rule),
    uids,
  };
}

function quotaScopes(db, discordId, rules = getRoleRules(db)) {
  const rows = rules.map((rule) => quotaScope(db, discordId, rule, rules));
  const general = quotaScope(db, discordId, null, rules);
  return rules.length === 0 || general.used > 0 ? [...rows, general] : rows;
}
async function grantRoleScriptsToUids({ discordId, roleId }) {
  const cleanDiscordId = typeof discordId === 'string' ? discordId.trim() : '';
  const cleanRoleId = normalizeRoleIds(roleId)[0] || '';
  if (!DISCORD_ID_RE.test(cleanDiscordId) || !cleanRoleId) return 0;

  let granted = 0;
  await store.update((db) => {
    const rules = getRoleRules(db);
    const rule = rules.find((r) => r.role_id === cleanRoleId);
    if (!rule || rule.scripts.length === 0) return;

    let used = scopeUids(db, cleanDiscordId, rule, rules).length;
    const max = roleMax(db, cleanDiscordId, rule);
    for (const entry of Object.values(db.whitelist || {})) {
      if (!entry || entry.discord_id !== cleanDiscordId || used >= max) continue;
      const cur = Array.isArray(entry.scripts) ? entry.scripts : [];
      const missing = rule.scripts.filter((script) => !cur.includes(script));
      if (missing.length === 0) continue;
      entry.scripts = [...cur, ...missing];
      used += 1;
      granted += 1;
    }
  });
  return granted;
}

async function revokeRoleScriptsFromUids({ discordId, roleId, keepRoleIds = [], keepScripts = [] }) {
  const cleanDiscordId = typeof discordId === 'string' ? discordId.trim() : '';
  const cleanRoleId = normalizeRoleIds(roleId)[0] || '';
  if (!DISCORD_ID_RE.test(cleanDiscordId) || !cleanRoleId) {
    return { uids: 0, scripts: [], emptied: 0 };
  }

  let result = { uids: 0, scripts: [], emptied: 0 };
  await store.update((db) => {
    const rules = getRoleRules(db);
    const role = rules.find((r) => r.role_id === cleanRoleId);
    if (!role || role.scripts.length === 0) return;

    const keep = new Set(
      Array.isArray(keepScripts) ? keepScripts.filter((s) => typeof s === 'string') : []
    );
    for (const id of normalizeRoleIds(keepRoleIds)) {
      const keptRule = rules.find((r) => r.role_id === id);
      if (keptRule) keptRule.scripts.forEach((script) => keep.add(script));
    }
    const removed = role.scripts.filter((script) => !keep.has(script));
    if (removed.length === 0) return;

    let changed = 0;
    let emptied = 0;
    for (const entry of Object.values(db.whitelist || {})) {
      if (!entry || entry.discord_id !== cleanDiscordId) continue;
      const cur = Array.isArray(entry.scripts) ? entry.scripts : [];
      const next = cur.filter((script) => !removed.includes(script));
      if (next.length === cur.length) continue;
      entry.scripts = next;
      changed += 1;
      if (next.length === 0) emptied += 1;
    }
    result = { uids: changed, scripts: removed, emptied };
  });
  return result;
}

async function revokeUnheldRoleScripts({ discordId, heldRoleIds = [], keepScripts = [] }) {
  const cleanDiscordId = typeof discordId === 'string' ? discordId.trim() : '';
  if (!DISCORD_ID_RE.test(cleanDiscordId)) return { uids: 0, scripts: [], emptied: 0 };

  let result = { uids: 0, scripts: [], emptied: 0 };
  await store.update((db) => {
    const rules = getRoleRules(db);
    const held = normalizeRoleIds(heldRoleIds);
    const keep = new Set(
      Array.isArray(keepScripts) ? keepScripts.filter((s) => typeof s === 'string') : []
    );
    rules.filter((r) => held.includes(r.role_id)).forEach((r) => r.scripts.forEach((s) => keep.add(s)));
    const removable = Array.from(
      new Set(rules.filter((r) => !held.includes(r.role_id)).flatMap((r) => r.scripts))
    ).filter((s) => !keep.has(s));
    if (removable.length === 0) return;

    let changed = 0;
    let emptied = 0;
    for (const entry of Object.values(db.whitelist || {})) {
      if (!entry || entry.discord_id !== cleanDiscordId) continue;
      const cur = Array.isArray(entry.scripts) ? entry.scripts : [];
      const next = cur.filter((script) => !removable.includes(script));
      if (next.length === cur.length) continue;
      entry.scripts = next;
      changed += 1;
      if (next.length === 0) emptied += 1;
    }
    result = { uids: changed, scripts: removable, emptied };
  });
  return result;
}

async function resolveScripts(requested) {
  const data = await store.read();
  const files = await store.listScripts();
  const available = Array.from(
    new Set([...Object.keys(data.scripts), ...files.map((f) => f.name)])
  ).sort((a, b) => a.localeCompare(b));

  if (Array.isArray(requested) && requested.length > 0) {
    const valid = requested
      .map((s) => String(s || '').trim())
      .filter((s) => store.isSafeName(s) && available.includes(s));
    return Array.from(new Set(valid));
  }
  return available;
}

async function addBuyerUid({
  uid,
  discordId,
  discordName = '',
  requestedScripts,
  requestedRoleIds,
  includeGeneral = false,
  requestedMax,
}) {
  const cleanUid = typeof uid === 'string' ? uid.trim() : '';
  const cleanDiscordId = typeof discordId === 'string' ? discordId.trim() : '';
  const cleanName = typeof discordName === 'string' ? discordName.trim().slice(0, 200) : '';

  if (!UID_RE.test(cleanUid)) {
    return { status: 400, body: { ok: false, error: 'invalid_uid', message: 'UID harus angka 1–19 digit.' } };
  }
  if (!DISCORD_ID_RE.test(cleanDiscordId)) {
    return { status: 400, body: { ok: false, error: 'invalid_discord_id', message: 'Discord ID tidak valid.' } };
  }

  const scripts = await resolveScripts(requestedScripts);
  if (scripts.length === 0) {
    return { status: 400, body: { ok: false, error: 'no_scripts', message: 'Belum ada script tersedia di panel.' } };
  }

  const cleanRoleIds = normalizeRoleIds(requestedRoleIds);
  let outcome = null;
  await store.update((db) => {
    const existing = db.whitelist[cleanUid];
    if (existing && existing.discord_id && existing.discord_id !== cleanDiscordId) {
      outcome = {
        status: 409,
        body: { ok: false, error: 'uid_taken', message: `UID ${cleanUid} sudah terdaftar oleh buyer lain.` },
      };
      return;
    }

    const rules = getRoleRules(db);
    const selected = cleanRoleIds
      .map((id) => rules.find((rule) => rule.role_id === id))
      .filter(Boolean);
    if (cleanRoleIds.length > 0 && selected.length !== cleanRoleIds.length) {
      outcome = {
        status: 400,
        body: {
          ok: false,
          error: 'invalid_role',
          message: 'Role buyer tidak ditemukan di mapping script.',
        },
      };
      return;
    }

    const scopes = selected.length > 0 || includeGeneral ? [...selected] : [null];
    if (includeGeneral) scopes.push(null);

    let requestedGeneralMax = 0;
    if (selected.length === 0) {
      const reqMax = Number(requestedMax);
      if (Number.isInteger(reqMax) && reqMax >= 1 && reqMax <= MAX_UIDS) requestedGeneralMax = reqMax;
    }

    const checks = scopes.map((rule) => {
      const currentUids = scopeUids(db, cleanDiscordId, rule, rules);
      const max = rule
        ? roleMax(db, cleanDiscordId, rule)
        : Math.max(roleMax(db, cleanDiscordId, null), requestedGeneralMax);
      const alreadyCounted = existing ? currentUids.includes(cleanUid) : false;
      return {
        rule,
        max,
        uids: currentUids,
        used: currentUids.length + (alreadyCounted ? 0 : 1),
      };
    });

    const failed = checks.filter((check) => check.used > check.max);
    if (failed.length > 0) {
      const detail = failed
        .map((check) => `${check.rule ? check.rule.label : 'Umum'} ${check.used - 1}/${check.max}`)
        .join(', ');
      outcome = {
        status: 403,
        body: {
          ok: false,
          error: 'quota_exceeded',
          message: `Kuota UID penuh (${detail}). Hubungi admin untuk tambah slot.`,
          used: failed[0].used - 1,
          max: failed[0].max,
          uids: failed[0].uids,
          quotas: checks.map((check) => ({
            role_id: check.rule ? check.rule.role_id : null,
            label: check.rule ? check.rule.label : 'Umum',
            used: check.used - 1,
            max: check.max,
          })),
        },
      };
      return;
    }

    const now = new Date().toISOString();
    const buyer = db.buyers[cleanDiscordId] || { max_uids: 1, roles: {} };
    if (!buyer.roles || typeof buyer.roles !== 'object' || Array.isArray(buyer.roles)) buyer.roles = {};
    if (requestedGeneralMax > buyer.max_uids) buyer.max_uids = requestedGeneralMax;
    if (cleanName) buyer.note = cleanName;
    buyer.updated_at = now;
    db.buyers[cleanDiscordId] = buyer;

    if (existing) {
      existing.status = 'active';
      existing.discord_id = cleanDiscordId;
      /* !add bersifat final: script lama dari role lain tidak boleh ikut terbawa. */
      existing.scripts = [...scripts];
      if (cleanName && !existing.note) existing.note = cleanName;
    } else {
      db.whitelist[cleanUid] = {
        status: 'active',
        scripts,
        discord_id: cleanDiscordId,
        note: cleanName || `Discord ${cleanDiscordId}`,
        created_at: now,
        last_check: null,
        check_count: 0,
      };
    }

    const updatedRules = getRoleRules(db);
    const quotas = scopes.map((rule) => quotaScope(db, cleanDiscordId, rule, updatedRules));
    const primary = quotas[0] || { used: 0, max: 1, uids: [] };
    outcome = {
      status: 200,
      body: {
        ok: true,
        uid: cleanUid,
        discord_id: cleanDiscordId,
        used: primary.used,
        max: primary.max,
        uids: primary.uids,
        quotas,
        role_ids: cleanRoleIds,
        scripts: db.whitelist[cleanUid].scripts,
      },
    };
  });

  return outcome;
}

async function getBuyerInfo(discordId) {
  const cleanDiscordId = typeof discordId === 'string' ? discordId.trim() : '';
  if (!DISCORD_ID_RE.test(cleanDiscordId)) {
    return { status: 400, body: { ok: false, error: 'invalid_discord_id' } };
  }

  const data = await store.read();
  const uids = Object.entries(data.whitelist)
    .filter(([, item]) => item.discord_id === cleanDiscordId)
    .map(([uid, item]) => ({
      uid,
      status: item.status,
      scripts: item.scripts,
    }));

  const quotas = quotaScopes(data, cleanDiscordId);
  const totalMax = quotas.reduce((sum, scope) => sum + scope.max, 0) || 1;

  return {
    status: 200,
    body: { ok: true, discord_id: cleanDiscordId, used: uids.length, max: totalMax, uids, quotas },
  };
}

async function setBuyerMax({ discordId, roleId, maxUids, note = '' }) {
  const cleanDiscordId = typeof discordId === 'string' ? discordId.trim() : '';
  const maxNum = Number(maxUids);
  const cleanNote = typeof note === 'string' ? note.trim().slice(0, 200) : '';
  const cleanRoleIds = normalizeRoleIds(roleId);

  if (!DISCORD_ID_RE.test(cleanDiscordId)) {
    return { status: 400, body: { ok: false, error: 'invalid_discord_id', message: 'Discord ID tidak valid.' } };
  }
  if (roleId && cleanRoleIds.length === 0) {
    return { status: 400, body: { ok: false, error: 'invalid_role', message: 'Role ID tidak valid.' } };
  }
  if (!Number.isInteger(maxNum) || maxNum < 1 || maxNum > MAX_UIDS) {
    return { status: 400, body: { ok: false, error: 'invalid_max', message: `max_uids harus angka bulat 1–${MAX_UIDS}.` } };
  }

  const cleanRoleId = cleanRoleIds[0] || '';
  let outcome = null;
  await store.update((db) => {
    const rule = cleanRoleId ? getRoleRules(db).find((r) => r.role_id === cleanRoleId) : null;
    if (cleanRoleId && !rule) {
      outcome = {
        status: 400,
        body: { ok: false, error: 'invalid_role', message: 'Role belum di-mapping di panel Bot.' },
      };
      return;
    }

    const label = rule ? rule.label : 'Umum';
    const now = new Date().toISOString();
    const prev = db.buyers[cleanDiscordId] || {};
    const roles = prev.roles && typeof prev.roles === 'object' && !Array.isArray(prev.roles) ? { ...prev.roles } : {};
    if (cleanRoleId) {
      roles[cleanRoleId] = {
        max_uids: maxNum,
        note: cleanNote || (roles[cleanRoleId] && roles[cleanRoleId].note) || label,
        updated_at: now,
      };
    }

    db.buyers[cleanDiscordId] = {
      ...prev,
      max_uids: cleanRoleId ? Number(prev.max_uids) || 1 : maxNum,
      note: cleanNote || prev.note || (cleanRoleId ? label : ''),
      roles,
      updated_at: now,
    };
    outcome = {
      status: 200,
      body: {
        ok: true,
        discord_id: cleanDiscordId,
        scope: cleanRoleId ? 'role' : 'general',
        role_id: cleanRoleId || null,
        label,
        max_uids: maxNum,
      },
    };
  });

  return outcome;
}

async function removeBuyerUid({ uid, discordId = '', force = false }) {
  const cleanUid = typeof uid === 'string' ? uid.trim() : '';
  const cleanDiscordId = typeof discordId === 'string' ? discordId.trim() : '';

  if (!UID_RE.test(cleanUid)) {
    return { status: 400, body: { ok: false, error: 'invalid_uid', message: 'UID tidak valid.' } };
  }

  let outcome = null;
  await store.update((db) => {
    const entry = db.whitelist[cleanUid];
    if (!entry) {
      outcome = { status: 404, body: { ok: false, error: 'not_found', message: `UID ${cleanUid} tidak ditemukan.` } };
      return;
    }
    if (!force && entry.discord_id !== cleanDiscordId) {
      outcome = { status: 403, body: { ok: false, error: 'forbidden', message: 'UID ini bukan milikmu.' } };
      return;
    }
    delete db.whitelist[cleanUid];
    outcome = { status: 200, body: { ok: true, removed: cleanUid } };
  });

  return outcome;
}

module.exports = {
  UID_RE,
  DISCORD_ID_RE,
  ROLE_ID_RE,
  addBuyerUid,
  getBuyerInfo,
  setBuyerMax,
  removeBuyerUid,
  getRoleRules,
  grantRoleScriptsToUids,
  revokeRoleScriptsFromUids,
  revokeUnheldRoleScripts,
  getBuyerQuotaOverview: (data, discordId) => quotaScopes(data, discordId),
};
