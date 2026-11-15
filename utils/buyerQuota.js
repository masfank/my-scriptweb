'use strict';

const store = require('../db/store');

const UID_RE = /^\d{1,19}$/;
const DISCORD_ID_RE = /^\d{15,22}$/;

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

async function addBuyerUid({ uid, discordId, discordName = '', requestedScripts, requestedMax }) {
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

    const ownedUids = Object.entries(db.whitelist)
      .filter(([, item]) => item.discord_id === cleanDiscordId)
      .map(([id]) => id);

    const savedMax =
      db.buyers[cleanDiscordId] && db.buyers[cleanDiscordId].max_uids
        ? db.buyers[cleanDiscordId].max_uids
        : 1;
    const reqMaxNum = Number(requestedMax);
    const maxUids = Number.isInteger(reqMaxNum) && reqMaxNum >= 1 ? Math.max(savedMax, reqMaxNum) : savedMax;

    if (!existing && ownedUids.length >= maxUids) {
      outcome = {
        status: 403,
        body: {
          ok: false,
          error: 'quota_exceeded',
          message: `Kuota UID kamu sudah penuh (${ownedUids.length}/${maxUids}). Hubungi admin untuk tambah slot UID.`,
          used: ownedUids.length,
          max: maxUids,
          uids: ownedUids,
        },
      };
      return;
    }

    const now = new Date().toISOString();
    if (!db.buyers[cleanDiscordId]) {
      db.buyers[cleanDiscordId] = { max_uids: maxUids, note: cleanName, updated_at: now };
    } else if (cleanName) {
      db.buyers[cleanDiscordId].note = cleanName;
      db.buyers[cleanDiscordId].updated_at = now;
    }

    if (existing) {
      existing.status = 'active';
      existing.discord_id = cleanDiscordId;
      existing.scripts = Array.from(new Set([...(existing.scripts || []), ...scripts]));
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

    const updatedOwned = existing ? ownedUids : [...ownedUids, cleanUid];
    outcome = {
      status: 200,
      body: {
        ok: true,
        uid: cleanUid,
        discord_id: cleanDiscordId,
        used: updatedOwned.length,
        max: maxUids,
        uids: updatedOwned,
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

  const maxUids =
    data.buyers[cleanDiscordId] && data.buyers[cleanDiscordId].max_uids
      ? data.buyers[cleanDiscordId].max_uids
      : 1;

  return {
    status: 200,
    body: { ok: true, discord_id: cleanDiscordId, used: uids.length, max: maxUids, uids },
  };
}

async function setBuyerMax({ discordId, maxUids, note = '' }) {
  const cleanDiscordId = typeof discordId === 'string' ? discordId.trim() : '';
  const maxNum = Number(maxUids);
  const cleanNote = typeof note === 'string' ? note.trim().slice(0, 200) : '';

  if (!DISCORD_ID_RE.test(cleanDiscordId)) {
    return { status: 400, body: { ok: false, error: 'invalid_discord_id', message: 'Discord ID tidak valid.' } };
  }
  if (!Number.isInteger(maxNum) || maxNum < 1 || maxNum > 100) {
    return { status: 400, body: { ok: false, error: 'invalid_max', message: 'max_uids harus angka bulat 1–100.' } };
  }

  await store.update((db) => {
    db.buyers[cleanDiscordId] = {
      max_uids: maxNum,
      note: cleanNote || (db.buyers[cleanDiscordId] && db.buyers[cleanDiscordId].note) || '',
      updated_at: new Date().toISOString(),
    };
  });

  return { status: 200, body: { ok: true, discord_id: cleanDiscordId, max_uids: maxNum } };
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
  addBuyerUid,
  getBuyerInfo,
  setBuyerMax,
  removeBuyerUid,
};
