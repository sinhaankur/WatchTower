/**
 * Thin HTTP client for the WatchTower /api surface.
 *
 * The Workspace add-on intentionally talks to the same endpoints the
 * VS Code extension and the MCP server use — no add-on-specific code
 * exists on the WatchTower backend. Auth, audit, rate limits, and Pro
 * gating all apply automatically because every call goes through the
 * normal request middleware.
 *
 * UrlFetchApp.fetch is Apps Script's HTTP client. It's synchronous,
 * returns the full body as a string, and supports retries via the
 * "muteHttpExceptions" flag — we use it so 4xx/5xx responses come
 * back as objects instead of throwing, which gives us better error
 * messages in the card UI.
 */

/** Throw with the most useful detail we can extract from a failed response. */
function ApiError_(status, body) {
  var detail = '';
  try {
    var parsed = JSON.parse(body);
    detail = parsed && parsed.detail ? String(parsed.detail) : '';
  } catch (e) {
    detail = body && body.length < 200 ? body : '';
  }
  var err = new Error('HTTP ' + status + (detail ? ': ' + detail : ''));
  err.status = status;
  err.detail = detail;
  return err;
}

function apiHeaders_() {
  var token = getStoredToken_();
  if (!token) {
    throw new Error('No API token configured. Open the add-on sidebar and tap Configure.');
  }
  return {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/json',
    'User-Agent': 'watchtower-workspace-addon/1',
  };
}

function apiGet_(path) {
  var url = getStoredApiUrl_().replace(/\/+$/, '') + path;
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: apiHeaders_(),
    muteHttpExceptions: true,
  });
  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code < 200 || code >= 300) {
    throw ApiError_(code, body);
  }
  try {
    return JSON.parse(body);
  } catch (e) {
    return body;
  }
}

function apiPost_(path, payload) {
  var url = getStoredApiUrl_().replace(/\/+$/, '') + path;
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: apiHeaders_(),
    contentType: 'application/json',
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true,
  });
  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code < 200 || code >= 300) {
    throw ApiError_(code, body);
  }
  try {
    return JSON.parse(body);
  } catch (e) {
    return body;
  }
}
