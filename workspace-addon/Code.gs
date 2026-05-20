/**
 * WatchTower Workspace add-on — entry points.
 *
 * Apps Script wires every add-on surface through named global functions
 * declared in this file. The function bodies delegate to the card
 * builders in cards.gs to keep this file purely about routing.
 *
 * Surfaces:
 *   - onHomepage(e)      → invoked when the user opens the add-on
 *                          sidebar (any Workspace host). Shows the
 *                          project list, or the configure card if no
 *                          token is saved yet.
 *   - onGmailMessage(e)  → invoked when the user opens an email with
 *                          the add-on sidebar visible. Surfaces an
 *                          "Open in WatchTower" affordance when the
 *                          email body or subject references a tracked
 *                          repo.
 *   - showSettings(e)    → universal action — opens the settings card.
 *   - And the action handlers triggered by buttons inside cards:
 *     openProject_, triggerDeployFromCard_, saveSettings_, clearSettings_.
 */

/** Homepage trigger — any Workspace host. */
function onHomepage(e) {  // eslint-disable-line no-unused-vars
  const token = getStoredToken_();
  if (!token) {
    return buildConfigureCard_();
  }
  return buildHomepageCard_();
}

/** Gmail contextual trigger — fires when the user has an email open. */
function onGmailMessage(e) {  // eslint-disable-line no-unused-vars
  const token = getStoredToken_();
  if (!token) {
    return buildConfigureCard_();
  }
  // Pull the message subject + body so we can detect GitHub references.
  // gmail.addons.current.message.metadata is enough for the subject; the
  // full body would need gmail.addons.current.message.readonly which is
  // a more sensitive scope. The metadata scope alone is enough for the
  // "GitHub deploy notification" use case — those emails encode the
  // repo in the subject.
  const messageId = e && e.gmail && e.gmail.messageId;
  let subject = '';
  if (messageId) {
    try {
      const accessToken = e.gmail.accessToken;
      GmailApp.setCurrentMessageAccessToken(accessToken);
      const message = GmailApp.getMessageById(messageId);
      subject = message ? message.getSubject() : '';
    } catch (err) {
      // Permission denied or expired token — fall through to the
      // hostname card without the contextual link.
      subject = '';
    }
  }
  return buildGmailContextCard_(subject);
}

/** Universal action — invoked from the toolbar's "Configure" entry. */
function showSettings(e) {  // eslint-disable-line no-unused-vars
  return buildSettingsCard_();
}

/* ── Action handlers (called by CardService.newAction.setFunctionName) ── */

/** Open a project's URL in the user's browser. */
function openProject_(e) {  // eslint-disable-line no-unused-vars
  const projectUrl = e.parameters.url;
  return CardService.newActionResponseBuilder()
    .setOpenLink(CardService.newOpenLink().setUrl(projectUrl))
    .build();
}

/** Trigger a deployment from the project detail card. */
function triggerDeployFromCard_(e) {
  const projectId = e.parameters.projectId;
  const branch = e.parameters.branch || 'main';
  try {
    apiPost_('/api/projects/' + projectId + '/deployments', { branch: branch });
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification().setText('Deployment queued.'))
      .setNavigation(CardService.newNavigation().updateCard(buildHomepageCard_()))
      .build();
  } catch (err) {
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification().setText('Failed: ' + err.message))
      .build();
  }
}

/** Persist the operator-entered API URL + token. */
function saveSettings_(e) {
  const url = (e.formInput.apiUrl || '').trim().replace(/\/+$/, '');
  const token = (e.formInput.apiToken || '').trim();
  if (!url || !token) {
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification().setText('Both URL and token are required.'))
      .build();
  }
  setStoredApiUrl_(url);
  setStoredToken_(token);
  // Verify by hitting /health so the operator gets immediate feedback
  // if the URL or token is wrong, before they navigate away.
  try {
    apiGet_('/health');
  } catch (err) {
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification().setText('Saved, but health check failed: ' + err.message))
      .build();
  }
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText('Saved and verified.'))
    .setNavigation(CardService.newNavigation().updateCard(buildHomepageCard_()))
    .build();
}

/** Wipe stored credentials — for "disconnect from WatchTower". */
function clearSettings_(e) {  // eslint-disable-line no-unused-vars
  clearStoredCredentials_();
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText('Disconnected.'))
    .setNavigation(CardService.newNavigation().updateCard(buildConfigureCard_()))
    .build();
}
