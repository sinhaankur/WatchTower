/**
 * Credential storage for the WatchTower Workspace add-on.
 *
 * Tokens live in PropertiesService.getUserProperties() — scoped to the
 * (user, script) pair, so each operator's credentials only persist for
 * their own Google account and only for THIS script. Apps Script
 * encrypts user properties at rest; we don't add a second layer because
 * the encryption key would have to live in the same script (no
 * practical advantage).
 *
 * Two keys are stored:
 *   wt.apiUrl    base URL of the operator's WatchTower install
 *   wt.apiToken  the bearer token; same shape as WATCHTOWER_API_TOKEN
 *                everywhere else in the project
 *
 * Both are write-only from cards.gs's settings form; cleared together
 * via clearStoredCredentials_().
 */

var STORE_KEY_API_URL = 'wt.apiUrl';
var STORE_KEY_API_TOKEN = 'wt.apiToken';

function getStoredToken_() {
  return PropertiesService.getUserProperties().getProperty(STORE_KEY_API_TOKEN) || '';
}

function setStoredToken_(token) {
  PropertiesService.getUserProperties().setProperty(STORE_KEY_API_TOKEN, token);
}

function getStoredApiUrl_() {
  return PropertiesService.getUserProperties().getProperty(STORE_KEY_API_URL) || 'http://localhost:8000';
}

function setStoredApiUrl_(url) {
  PropertiesService.getUserProperties().setProperty(STORE_KEY_API_URL, url);
}

function clearStoredCredentials_() {
  var props = PropertiesService.getUserProperties();
  props.deleteProperty(STORE_KEY_API_URL);
  props.deleteProperty(STORE_KEY_API_TOKEN);
}
