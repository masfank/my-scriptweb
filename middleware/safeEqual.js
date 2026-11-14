'use strict';

/**
 * Perbandingan string tahan timing: hash dulu supaya panjang selalu 32 byte,
 * lalu timingSafeEqual.
 */

const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

module.exports = function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return crypto.timingSafeEqual(sha256(a), sha256(b));
};
