const crypto = require('crypto');

/**
 * Validate Telegram WebApp initData using HMAC-SHA256.
 * @param {string} initData - Raw initData string from Telegram WebApp
 * @param {string} botToken - Telegram bot token
 * @returns {{ valid: boolean, user: object|null }}
 */
function validateInitData(initData, botToken) {
  if (!initData || typeof initData !== 'string') {
    return { valid: false, user: null };
  }

  // Dev mode: if botToken is empty, skip HMAC validation, just parse user data
  if (!botToken || botToken === '') {
    return { valid: true, user: getUserFromInitData(initData) };
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');

    if (!hash) {
      return { valid: false, user: null };
    }

    // Collect and sort keys alphabetically (excluding 'hash')
    const keys = [];
    for (const [key] of params) {
      if (key !== 'hash') {
        keys.push(key);
      }
    }
    keys.sort();

    // Build dataCheckString: key=value\nkey=value...
    const dataCheckParts = [];
    for (const key of keys) {
      dataCheckParts.push(`${key}=${params.get(key)}`);
    }
    const dataCheckString = dataCheckParts.join('\n');

    // secret = HMAC_SHA256("WebAppData", botToken)
    const secret = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    // checkHash = HMAC_SHA256(secret, dataCheckString)
    const checkHash = crypto
      .createHmac('sha256', secret)
      .update(dataCheckString)
      .digest('hex');

    // Timing-safe comparison
    const checkHashBuf = Buffer.from(checkHash, 'hex');
    const hashBuf = Buffer.from(hash, 'hex');

    if (checkHashBuf.length !== hashBuf.length) {
      return { valid: false, user: null };
    }

    if (!crypto.timingSafeEqual(checkHashBuf, hashBuf)) {
      return { valid: false, user: null };
    }

    // Verify auth_date is not older than 24 hours
    const authDate = params.get('auth_date');
    if (authDate) {
      const authTimestamp = parseInt(authDate, 10) * 1000;
      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;
      if (now - authTimestamp > oneDay) {
        return { valid: false, user: null };
      }
    }

    // Extract user data
    const user = getUserFromInitData(initData);
    return { valid: true, user };

  } catch (err) {
    console.error('[Auth] Validation error:', err.message);
    return { valid: false, user: null };
  }
}

/**
 * Extract user info from initData string.
 * @param {string} initData - Raw initData string
 * @returns {object|null}
 */
function getUserFromInitData(initData) {
  if (!initData || typeof initData !== 'string') {
    return null;
  }

  try {
    const params = new URLSearchParams(initData);
    const userRaw = params.get('user');

    if (!userRaw) {
      return null;
    }

    const user = JSON.parse(userRaw);
    return {
      id: user.id ? String(user.id) : null,
      first_name: user.first_name || null,
      last_name: user.last_name || null,
      username: user.username || null,
      language_code: user.language_code || null,
    };
  } catch (err) {
    console.error('[Auth] Error extracting user:', err.message);
    return null;
  }
}

module.exports = {
  validateInitData,
  getUserFromInitData,
};
