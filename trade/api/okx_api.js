const crypto = require('crypto');
const axios = require('axios');

const { isOkxAuthError, getHttpErrorInfo } = require('./okx_errors');

const AUTH_ERROR_NOTIFY_INTERVAL_MS = 60 * 60 * 1000;

/**
 * @param {Object} params
 * @returns {string}
 */
function getParamsString(params) {
  return Object.keys(params)
      .filter((key) => params[key] !== undefined && params[key] !== null)
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
      .join('&');
}

module.exports = function() {
  let WEB_BASE = 'https://www.okx.com';
  let config = {
    apiKey: '',
    secretKey: '',
    passphrase: '',
  };
  let log = {};
  let lastAuthMode = null;
  let lastAuthErrorNotifyTimestamp = 0;

  /**
   * @returns {'authenticated'|'keyless'|null}
   */
  function getLastAuthMode() {
    return lastAuthMode;
  }

  /**
   * @param {number|null} httpCode
   * @param {Object|null} data
   * @returns {Error}
   */
  function buildRequestError(httpCode, data) {
    const okxCode = data?.code;
    const msg = data?.msg ?? data?.message ?? 'Unknown error';
    const error = new Error(`${httpCode ?? 'HTTP error'} [${okxCode}] ${msg}`);
    error.httpCode = httpCode;
    error.okxCode = okxCode;
    error.isAuthError = isOkxAuthError(httpCode, okxCode);
    error.isTemporary = Boolean(getHttpErrorInfo(httpCode)?.isTemporary);
    return error;
  }

  /**
   * @param {'GET'|'POST'} method
   * @param {string} path
   * @param {Object} params
   * @param {boolean} useAuth
   * @returns {Promise<Object>}
   */
  async function rawRequest(method, path, params = {}, useAuth = false) {
    const queryString = getParamsString(params);
    const requestPath = queryString ? `${path}?${queryString}` : path;
    const url = `${WEB_BASE}${requestPath}`;

    const headers = {
      'Content-Type': 'application/json',
    };

    if (useAuth && config.apiKey) {
      const timestamp = new Date().toISOString();
      const signPayload = `${timestamp}${method}${requestPath}`;
      const sign = crypto
          .createHmac('sha256', config.secretKey)
          .update(signPayload)
          .digest('base64');

      headers['OK-ACCESS-KEY'] = config.apiKey;
      headers['OK-ACCESS-SIGN'] = sign;
      headers['OK-ACCESS-TIMESTAMP'] = timestamp;
      headers['OK-ACCESS-PASSPHRASE'] = config.passphrase;
    }

    try {
      const response = await axios({
        url,
        method,
        data: method === 'POST' ? params : undefined,
        headers,
        timeout: 10000,
      });

      const data = response.data;

      if (data?.code !== '0') {
        throw buildRequestError(response.status, data);
      }

      return data.data;
    } catch (error) {
      if (error.response) {
        throw buildRequestError(error.response.status, error.response.data);
      }

      throw error;
    }
  }

  /**
   * Notify operator at most once per hour when degrading to keyless mode.
   * @param {string} detail
   */
  function notifyAuthDegradation(detail) {
    const now = Date.now();

    if (now - lastAuthErrorNotifyTimestamp < AUTH_ERROR_NOTIFY_INTERVAL_MS) {
      return;
    }

    lastAuthErrorNotifyTimestamp = now;

    try {
      const notify = require('../../helpers/notify');
      const configReader = require('../../modules/configReader');
      notify(
          `${configReader.notifyName}: OKX API key rejected; using public keyless market data for PW. Renew okx_api* in config.jsonc and restart. Detail: ${detail}`,
          'warn',
      );
    } catch (e) {
      // notify may be unavailable in tests
    }
  }

  /**
   * Public market GET: auth-first, keyless retry on auth errors only.
   * @param {string} path
   * @param {Object} params
   * @returns {Promise<Object>}
   */
  async function publicMarketGet(path, params = {}) {
    const hasCredentials = Boolean(config.apiKey && config.secretKey && config.passphrase);

    if (hasCredentials) {
      try {
        const data = await rawRequest('GET', path, params, true);
        lastAuthMode = 'authenticated';
        return data;
      } catch (error) {
        if (!error.isAuthError) {
          throw error;
        }

        const detail = error.message || String(error);
        log.warn(`OKX API: Authenticated request failed (${detail}). Retrying public keyless request.`);

        try {
          const data = await rawRequest('GET', path, params, false);
          lastAuthMode = 'keyless';
          notifyAuthDegradation(detail);
          return data;
        } catch (keylessError) {
          throw keylessError;
        }
      }
    }

    const data = await rawRequest('GET', path, params, false);
    lastAuthMode = 'keyless';
    return data;
  }

  const EXCHANGE_API = {
    setConfig(apiServer, apiKey, secretKey, passphrase, logger, publicOnly = false) {
      if (apiServer) {
        WEB_BASE = apiServer;
      }

      if (logger) {
        log = logger;
      }

      if (!publicOnly || apiKey) {
        config = {
          apiKey: apiKey || '',
          secretKey: secretKey || '',
          passphrase: passphrase || '',
        };
      }
    },

    getLastAuthMode,

    /**
     * GET /api/v5/public/instruments
     * @param {string} instType
     * @returns {Promise<Array>}
     */
    instruments(instType = 'SPOT') {
      return publicMarketGet('/api/v5/public/instruments', { instType });
    },

    /**
     * GET /api/v5/market/books
     * @param {string} instId
     * @param {number} sz
     * @returns {Promise<Array>}
     */
    orderBook(instId, sz = 20) {
      return publicMarketGet('/api/v5/market/books', { instId, sz });
    },

    /**
     * GET /api/v5/market/ticker
     * @param {string} instId
     * @returns {Promise<Array>}
     */
    ticker(instId) {
      return publicMarketGet('/api/v5/market/ticker', { instId });
    },

    /**
     * GET /api/v5/market/trades
     * @param {string} instId
     * @param {number} limit
     * @returns {Promise<Array>}
     */
    trades(instId, limit = 100) {
      return publicMarketGet('/api/v5/market/trades', { instId, limit });
    },

    // Exposed for unit tests
    publicMarketGet,
    rawRequest,
  };

  return EXCHANGE_API;
};
