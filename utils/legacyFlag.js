'use strict';

/**
 * utils/legacyFlag.js — saklar jendela plaintext untuk loader lama.
 *
 * Sumber kebenaran = settings.legacy_plaintext di db.json (diatur dari
 * /admin/secret). Env LEGACY_PLAINTEXT hanya fallback kalau pengaturan belum
 * pernah disimpan, supaya deploy berbasis env tetap bisa memaksa nilainya.
 */
function legacyPlaintextEnabled(data) {
  const settings = data && data.settings ? data.settings : {};
  if (typeof settings.legacy_plaintext === 'boolean') return settings.legacy_plaintext;
  return process.env.LEGACY_PLAINTEXT === '1';
}

module.exports = { legacyPlaintextEnabled };
