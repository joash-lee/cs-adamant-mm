/**
 * OKX API error codes and HTTP status helpers.
 * Docs: https://www.okx.com/docs-v5/en/#overview-error-code
 */

const httpErrorCodeDescriptions = {
  400: { description: 'Bad Request' },
  401: { description: 'Unauthorized', isAuthError: true },
  403: { description: 'Forbidden', isAuthError: true },
  429: { description: 'Rate limit reached', isTemporary: true },
  500: { description: 'Internal Server Error', isTemporary: true },
  503: { description: 'Service Unavailable', isTemporary: true },
};

/** OKX business codes that indicate invalid/expired API credentials */
const OKX_AUTH_ERROR_CODES = new Set([
  '50101', // API key does not exist
  '50102', // Timestamp request expired
  '50103', // Request header OK-ACCESS-KEY cannot be empty
  '50104', // Invalid OK-ACCESS-TIMESTAMP
  '50105', // Invalid OK-ACCESS-PASSPHRASE
  '50106', // Invalid OK-ACCESS-SIGN
  '50107', // Invalid authorization
  '50111', // Invalid OK-ACCESS-KEY
  '50112', // Invalid OK-ACCESS-TIMESTAMP
  '50113', // Invalid sign
  '50114', // Invalid authorization
  '50115', // Invalid request method
  '50116', // IP not in whitelist
]);

/**
 * @param {number|null|undefined} httpCode
 * @param {string|number|null|undefined} okxCode
 * @returns {boolean}
 */
function isOkxAuthError(httpCode, okxCode) {
  if (httpCode === 401 || httpCode === 403) {
    return true;
  }

  if (okxCode !== null && okxCode !== undefined) {
    return OKX_AUTH_ERROR_CODES.has(String(okxCode));
  }

  return false;
}

/**
 * @param {number|null|undefined} httpCode
 * @returns {{ description: string, isTemporary?: boolean, isAuthError?: boolean }|undefined}
 */
function getHttpErrorInfo(httpCode) {
  return httpErrorCodeDescriptions[httpCode];
}

module.exports = {
  httpErrorCodeDescriptions,
  OKX_AUTH_ERROR_CODES,
  isOkxAuthError,
  getHttpErrorInfo,
};
