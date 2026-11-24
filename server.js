'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');

const store = require('./db/store');
const { startDiscordBot, stopDiscordBot } = require('./bot/discordBot');
const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');

/* Versi aset = hash isi file. Query string di view ikut berubah setiap kali
 * admin.js/admin.css diedit, jadi browser tidak memakai salinan cache lama. */
function assetVersion(relPath) {
  try {
    const buf = fs.readFileSync(path.join(__dirname, relPath));
    return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
  } catch {
    return 'dev';
  }
}

function createApp(sessionSecret) {
  const app = express();
  app.disable('x-powered-by');

  /* Railway/Render/nginx: percayai satu hop proxy supaya req.ip = IP buyer. */
  const rawProxy = process.env.TRUST_PROXY ?? '1';
  app.set(
    'trust proxy',
    rawProxy === '0' || rawProxy === 'false'
      ? false
      : Number.isNaN(Number(rawProxy))
        ? rawProxy
        : Number(rawProxy)
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
    })
  );

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.locals.adminJsVersion = assetVersion('public/js/admin.js');
  app.locals.adminCssVersion = assetVersion('public/css/admin.css');

  app.use(express.urlencoded({ extended: false, limit: '5mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

  app.use(
    cookieSession({
      name: 'sid',
      keys: [sessionSecret],
      maxAge: 8 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    })
  );

  app.use((req, res, next) => {
    if (req.session && !req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(16).toString('hex');
    }
    res.locals.csrfToken = req.session ? req.session.csrfToken : '';
    next();
  });

  app.use(authRoutes);
  app.use('/admin', adminRoutes);

  app.get('/', (req, res) => res.redirect('/admin'));

  app.use(publicRoutes);

  /* 404 */
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).type('text/plain').send('ERROR:not_found');
    }
    return res.status(404).render('error', {
      title: '404',
      status: 404,
      message: 'Halaman tidak ditemukan',
    });
  });

  /* error */
  app.use((err, req, res, next) => {
    console.error('[error]', err && err.stack ? err.stack : err);
    if (res.headersSent) return next(err);
    if (req.path.startsWith('/api/')) {
      return res.status(500).type('text/plain').send('ERROR:server');
    }
    return res.status(500).render('error', {
      title: '500',
      status: 500,
      message: 'Terjadi kesalahan di server. Cek console.',
    });
  });

  return app;
}

async function main() {
  await store.ensureDataDir();
  const data = await store.read();

  let sessionSecret = process.env.SESSION_SECRET || data.settings.session_secret;
  if (!sessionSecret) {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    await store.update((db) => {
      if (!db.settings.session_secret) {
        db.settings.session_secret = sessionSecret;
      }
    });
    console.log('[bootstrap] settings.session_secret dibuat otomatis.');
  }

  if (!data.settings.app_secret) {
    const initialSecret = process.env.APP_SECRET || crypto.randomBytes(32).toString('hex');
    await store.update((db) => {
      if (!db.settings.app_secret) {
        db.settings.app_secret = initialSecret;
      }
    });
    console.log('[bootstrap] settings.app_secret diinisialisasi.');
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminPassword) {
    const adminUser = (process.env.ADMIN_USERNAME || 'admin').trim();
    const forceSeed = process.env.ADMIN_FORCE_SEED === '1';

    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(adminUser)) {
      console.warn('[bootstrap] ADMIN_USERNAME tidak valid (3-32 karakter [A-Za-z0-9_.-]), dilewati.');
    } else if (adminPassword.length < 6) {
      console.warn('[bootstrap] ADMIN_PASSWORD minimal 6 karakter, auto-seed dilewati.');
    } else if (!data.admins[adminUser] || forceSeed) {
      const passwordHash = await bcrypt.hash(adminPassword, 12);
      const apiToken = crypto.randomBytes(32).toString('hex');
      await store.update((db) => {
        if (!db.admins[adminUser] || forceSeed) {
          db.admins[adminUser] = {
            password_hash: passwordHash,
            api_token: apiToken,
            created_at: new Date().toISOString(),
          };
        }
      });
      console.log(`[bootstrap] Admin '${adminUser}' siap digunakan.`);
    }
  }

  const app = createApp(sessionSecret);
  const host = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, host, () => {
    console.log(`lisensi siap di http://${host}:${port}`);
    startDiscordBot();
  });

  const shutdown = (sig) => {
    console.log(`[${sig}] menutup server...`);
    stopDiscordBot().finally(() => {
      server.close(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('server gagal start:', err.message);
  process.exit(1);
});
