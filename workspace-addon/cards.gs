/**
 * Card builders for every screen the add-on renders.
 *
 * Apps Script's CardService API is a builder pattern — each
 * card.addSection().addWidget(...) call returns the card so you can
 * chain. Keep card construction in this file so Code.gs stays a thin
 * router, and so future card additions (project detail, deploy log
 * viewer, etc.) all live next to each other.
 *
 * Style note: don't over-decorate. Workspace add-on sidebars are
 * narrow (300 px ish) and dense data wins over chrome.
 */

/* ── Header (reused across every card) ───────────────────────────── */

function watchtowerHeader_() {
  return CardService.newCardHeader()
    .setTitle('WatchTower')
    .setSubtitle('Deployment control plane');
}

/* ── Configure card — shown when no token is saved ───────────────── */

function buildConfigureCard_() {
  var card = CardService.newCardBuilder()
    .setHeader(watchtowerHeader_());

  var section = CardService.newCardSection()
    .addWidget(CardService.newTextParagraph().setText(
      "<b>Connect to WatchTower</b><br>Paste the API token from your WatchTower install. " +
      "Same token your VS Code extension or browser dashboard uses."
    ))
    .addWidget(CardService.newTextInput()
      .setFieldName('apiUrl')
      .setTitle('API URL')
      .setHint('http://localhost:8000')
      .setValue(getStoredApiUrl_()))
    .addWidget(CardService.newTextInput()
      .setFieldName('apiToken')
      .setTitle('API token')
      .setHint('WATCHTOWER_API_TOKEN'))
    .addWidget(CardService.newTextButton()
      .setText('Save and verify')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction().setFunctionName('saveSettings_')));

  card.addSection(section);
  return card.build();
}

/* ── Settings card — for the universal action ───────────────────── */

function buildSettingsCard_() {
  var card = CardService.newCardBuilder()
    .setHeader(watchtowerHeader_());

  var section = CardService.newCardSection()
    .setHeader('Connection')
    .addWidget(CardService.newTextInput()
      .setFieldName('apiUrl')
      .setTitle('API URL')
      .setValue(getStoredApiUrl_()))
    .addWidget(CardService.newTextInput()
      .setFieldName('apiToken')
      .setTitle('API token')
      .setHint(getStoredToken_() ? '(unchanged — leave blank to keep)' : 'Paste your WATCHTOWER_API_TOKEN'))
    .addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText('Save')
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setOnClickAction(CardService.newAction().setFunctionName('saveSettings_')))
      .addButton(CardService.newTextButton()
        .setText('Disconnect')
        .setOnClickAction(CardService.newAction().setFunctionName('clearSettings_'))));

  card.addSection(section);
  return card.build();
}

/* ── Homepage card — project list with status pills ──────────────── */

function buildHomepageCard_() {
  var card = CardService.newCardBuilder()
    .setHeader(watchtowerHeader_());

  var projects = [];
  var fetchError = '';
  try {
    projects = apiGet_('/api/projects') || [];
  } catch (err) {
    fetchError = err.message || String(err);
  }

  if (fetchError) {
    card.addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText(
        "<b>Couldn't reach WatchTower:</b><br>" + escapeHtml_(fetchError) +
        "<br><br>Open <i>Configure</i> from the toolbar to update the API URL or token."
      )));
    return card.build();
  }

  if (!projects || projects.length === 0) {
    card.addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText(
        "No projects yet. Create one from the WatchTower dashboard."
      )));
    return card.build();
  }

  var section = CardService.newCardSection().setHeader('Projects (' + projects.length + ')');
  for (var i = 0; i < projects.length && i < 20; i++) {
    var p = projects[i];
    var status = p.is_active === false ? 'paused' : 'active';
    var detail =
      'Branch: ' + escapeHtml_(p.repo_branch || 'main') +
      '   ·   ' + escapeHtml_(p.use_case || 'project') +
      '   ·   ' + status;
    var keyValue = CardService.newDecoratedText()
      .setTopLabel(escapeHtml_(p.name))
      .setText(detail)
      .setWrapText(true)
      .setButton(CardService.newTextButton()
        .setText('Deploy')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('triggerDeployFromCard_')
          .setParameters({ projectId: String(p.id), branch: String(p.repo_branch || 'main') })));
    section.addWidget(keyValue);
  }
  card.addSection(section);

  if (projects.length > 20) {
    card.addSection(CardService.newCardSection().addWidget(
      CardService.newTextParagraph().setText(
        '(' + (projects.length - 20) + ' more — open the dashboard to see all.)'
      )
    ));
  }

  return card.build();
}

/* ── Gmail contextual card — adds an "Open in WatchTower" link ──── */

function buildGmailContextCard_(subject) {
  var card = CardService.newCardBuilder()
    .setHeader(watchtowerHeader_());

  // Try to find a GitHub repo reference in the subject. The "GitHub →
  // WatchTower" link is the most-useful affordance for the Gmail
  // surface (operator just got a deploy-related email; needs to act).
  var repoMatch = subject ? subject.match(/([\w.-]+\/[\w.-]+)/) : null;
  var section = CardService.newCardSection();
  if (repoMatch) {
    section
      .addWidget(CardService.newTextParagraph().setText(
        '<b>Mentioned repo:</b> ' + escapeHtml_(repoMatch[1])
      ))
      .addWidget(CardService.newTextButton()
        .setText('Find in WatchTower')
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setOpenLink(CardService.newOpenLink().setUrl(
          getStoredApiUrl_() + '/projects?q=' + encodeURIComponent(repoMatch[1])
        )));
  } else {
    section.addWidget(CardService.newTextParagraph().setText(
      'Open the homepage tab for your project list, or use the toolbar to configure.'
    ));
  }
  card.addSection(section);

  // Always include the homepage view inline so the operator doesn't
  // have to navigate to find their projects.
  try {
    var projects = apiGet_('/api/projects') || [];
    if (projects.length > 0) {
      var listSection = CardService.newCardSection().setHeader('Your projects');
      for (var i = 0; i < Math.min(5, projects.length); i++) {
        var p = projects[i];
        listSection.addWidget(CardService.newDecoratedText()
          .setText(escapeHtml_(p.name))
          .setBottomLabel(escapeHtml_(p.repo_branch || 'main'))
          .setButton(CardService.newTextButton()
            .setText('Deploy')
            .setOnClickAction(CardService.newAction()
              .setFunctionName('triggerDeployFromCard_')
              .setParameters({ projectId: String(p.id), branch: String(p.repo_branch || 'main') }))));
      }
      card.addSection(listSection);
    }
  } catch (e) {
    // Silent — the contextual surface should never block on a
    // background API failure.
  }

  return card.build();
}

/* ── Helpers ─────────────────────────────────────────────────────── */

/**
 * CardService's setText() honours a small allow-list of HTML tags
 * (b, i, br, etc.). We still want to defend against user-controlled
 * strings (project names, error messages) injecting markup, so
 * everything that lands in a setText() call should pass through here
 * first.
 */
function escapeHtml_(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
