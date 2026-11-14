'use strict';

const express = require('express');
const { loginLimiter } = require('../middleware/rateLimit');
const verifyCsrf = require('../middleware/verifyCsrf');
const { showSetup, setup, showLogin, login, logout } = require('../controllers/authController');

const router = express.Router();

router.get('/setup', showSetup);
router.post('/setup', loginLimiter, verifyCsrf, setup);
router.get('/login', showLogin);
router.post('/login', loginLimiter, verifyCsrf, login);
router.post('/logout', verifyCsrf, logout);

module.exports = router;
