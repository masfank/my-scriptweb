'use strict';

/**
 * db/init.js — siapkan folder data + db.json default.
 * Jalankan: npm run init
 */

require('dotenv').config();

const store = require('./store');

async function main() {
  await store.ensureDataDir();
  console.log('data dir:', store.paths.dataDir);
  console.log('db file :', store.paths.dbFile);
  console.log('scripts :', store.paths.scriptsDir);
  console.log('siap.');
}

main().catch((err) => {
  console.error('init gagal:', err.message);
  process.exit(1);
});
