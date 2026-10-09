/*
 * download.js — device-specific "download the right installer" for every page.
 *
 * Any link with class `js-download` becomes an OS-aware download button:
 *   1. Detect the visitor's OS (+ Mac arch) from UA-CH / userAgent / WebGL.
 *   2. Ask the GitHub Releases API for the matching asset.
 *   3. Point the button straight at that .dmg/.exe/.AppImage and, on click,
 *      START THE FILE DOWNLOAD — the visitor never lands on the release page's
 *      raw folder listing of every platform's files.
 *
 * Progressive enhancement: unknown OS, offline, or a rate-limited API all
 * degrade to opening /releases/latest. There is never a dead link.
 *
 * Optional per-button hooks (any element inside the button):
 *   .js-dl-label  → replaced with "Download for macOS"   (the headline)
 *   .js-dl-sub    → replaced with "Apple Silicon · v1.19.0" (the subline)
 * If neither exists, the button's own text is set to "Download for <OS>".
 */
(function () {
  var REPO = 'sinhaankur/WatchTower';
  var buttons = document.querySelectorAll('.js-download');
  if (!buttons.length) return;

  var LABEL = { mac: 'macOS', win: 'Windows', linux: 'Linux' };

  // --- Detect OS. Prefer high-entropy UA-CH platform, fall back to UA string. ---
  function detectOS() {
    var p = (navigator.userAgentData && navigator.userAgentData.platform) || '';
    var ua = navigator.userAgent || '';
    var hay = (p + ' ' + ua).toLowerCase();
    if (/mac|darwin/.test(hay)) return 'mac';
    if (/win/.test(hay)) return 'win';
    if (/linux|x11/.test(hay) && !/android/.test(hay)) return 'linux'; // exclude Android
    return null;
  }

  // Apple Silicon vs Intel: UA reports "MacIntel" even on M-series, so probe the
  // WebGL renderer. true = arm64, false = intel, null = unknown.
  function macIsArm() {
    try {
      var gl = document.createElement('canvas').getContext('webgl');
      var dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
      var r = dbg ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
      if (/apple m\d|apple gpu/i.test(r)) return true;
      if (/intel|amd|radeon|nvidia/i.test(r)) return false;
    } catch (e) { /* ignore */ }
    return null;
  }

  // Pick the best asset for this OS/arch from the release's asset list.
  function pickAsset(assets, os) {
    function by(re) { for (var i = 0; i < assets.length; i++) if (re.test(assets[i].name)) return assets[i]; return null; }
    if (os === 'mac') {
      var arm = macIsArm();
      if (arm === false) return by(/(x64|x86_64|intel).*\.dmg$/i) || by(/\.dmg$/i);
      return by(/arm64.*\.dmg$/i) || by(/\.dmg$/i); // arm or unknown → current Macs
    }
    if (os === 'win') return by(/\.exe$/i) || by(/win.*\.zip$/i);
    if (os === 'linux') return by(/\.appimage$/i) || by(/\.deb$/i);
    return null;
  }

  function archLabel(os) {
    if (os !== 'mac') return '';
    var arm = macIsArm();
    if (arm === true) return 'Apple Silicon';
    if (arm === false) return 'Intel';
    return '';
  }

  // Set the button's visible text, using .js-dl-label / .js-dl-sub when present.
  function setLabel(btn, os, tag) {
    var label = btn.querySelector('.js-dl-label');
    var sub = btn.querySelector('.js-dl-sub');
    var head = 'Download for ' + LABEL[os];
    var bits = [];
    var a = archLabel(os);
    if (a) bits.push(a);
    if (tag) bits.push('v' + tag);
    var subtext = bits.join(' · ');
    if (label) {
      label.textContent = head;
      if (sub && subtext) sub.textContent = subtext;
    } else {
      btn.textContent = subtext ? head + ' · ' + subtext : head;
    }
  }

  // --- First-run guidance ---------------------------------------------------
  // The installers are not yet code-signed, so the OS shows a scary-looking
  // "unidentified developer" / SmartScreen prompt on first launch. For a
  // non-technical user that prompt is where the funnel dies — they assume
  // the app is unsafe and delete it. So the moment they download, we show the
  // EXACT prompt they'll see and the EXACT safe steps to get past it. Honest
  // about why it happens (not yet signed) + reassuring (open-source, local).
  var FIRST_RUN = {
    mac: {
      title: 'Opening it on macOS',
      body: 'The first time you open WatchTower, macOS may say <strong>“WatchTower can’t be opened because Apple cannot check it for malicious software.”</strong> That’s because the app isn’t code-signed yet — not because anything is wrong.',
      steps: [
        'Open the downloaded <strong>.dmg</strong> and drag WatchTower to Applications.',
        'In Applications, <strong>right-click</strong> WatchTower → <strong>Open</strong>.',
        'Click <strong>Open</strong> in the dialog. You only do this once.'
      ]
    },
    win: {
      title: 'Opening it on Windows',
      body: 'Windows SmartScreen may show <strong>“Windows protected your PC.”</strong> That appears for any app without a paid signing certificate yet — it doesn’t mean the app is harmful.',
      steps: [
        'Run the downloaded <strong>.exe</strong>.',
        'On the blue SmartScreen box, click <strong>More info</strong>.',
        'Click <strong>Run anyway</strong>. You only do this once.'
      ]
    },
    linux: {
      title: 'Opening it on Linux',
      body: 'The <strong>.AppImage</strong> needs to be marked executable before it runs (or install the <strong>.deb</strong> on Debian/Ubuntu).',
      steps: [
        'Right-click the <strong>.AppImage</strong> → Properties → allow <strong>“Executable as program.”</strong>',
        'Or in a terminal: <code>chmod +x WatchTower-*.AppImage &amp;&amp; ./WatchTower-*.AppImage</code>',
        'Prefer apt? Install the <strong>.deb</strong>: <code>sudo dpkg -i WatchTower-*.deb</code>'
      ]
    }
  };

  function showFirstRunHelp(os) {
    var info = FIRST_RUN[os];
    if (!info || document.getElementById('wt-firstrun')) return;
    var panel = document.createElement('div');
    panel.id = 'wt-firstrun';
    panel.setAttribute('role', 'status');
    panel.style.cssText = [
      'margin:14px 0 0', 'padding:14px 16px', 'max-width:520px',
      'border:1px solid rgba(120,130,150,.28)', 'border-radius:12px',
      'background:rgba(245,247,250,.9)', 'color:#334155',
      'font-size:.85rem', 'line-height:1.5', 'text-align:left',
      'box-shadow:0 6px 24px rgba(15,23,42,.06)'
    ].join(';');
    var stepsHtml = info.steps.map(function (s) { return '<li style="margin:.2rem 0">' + s + '</li>'; }).join('');
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px">' +
        '<strong style="font-size:.92rem">⬇ Downloading… ' + info.title + '</strong>' +
        '<button type="button" aria-label="Dismiss" style="border:0;background:none;cursor:pointer;color:#94a3b8;font-size:1.1rem;line-height:1">×</button>' +
      '</div>' +
      '<p style="margin:.5rem 0 .4rem">' + info.body + '</p>' +
      '<ol style="margin:.2rem 0 .4rem 1.1rem;padding:0">' + stepsHtml + '</ol>' +
      '<p style="margin:.4rem 0 0;color:#64748b;font-size:.78rem">WatchTower is open source and runs entirely on your machine — ' +
        '<a href="https://github.com/' + REPO + '" style="color:#64748b">review the code</a>. ' +
        'Signed installers are coming.</p>';
    // Place the panel right after the first download button's container.
    var anchor = buttons[0];
    var host = (anchor && anchor.closest && anchor.closest('.hero-actions')) || (anchor && anchor.parentNode);
    if (host && host.parentNode) {
      host.parentNode.insertBefore(panel, host.nextSibling);
    } else if (anchor && anchor.parentNode) {
      anchor.parentNode.appendChild(panel);
    }
    panel.querySelector('button').addEventListener('click', function () { panel.remove(); });
  }

  var os = detectOS();
  if (!os) return; // unknown OS → leave generic label + /releases/latest link

  // Relabel immediately (still points at /releases/latest until the API answers).
  for (var i = 0; i < buttons.length; i++) setLabel(buttons[i], os, '');

  // Show the first-run help on click regardless of whether the API resolved —
  // even in the degraded /releases/latest path the user still needs the
  // "how to open an unsigned app" steps. The deep-link handler below adds
  // preventDefault; this one only adds the help (doesn't block navigation).
  Array.prototype.forEach.call(buttons, function (btn) {
    btn.addEventListener('click', function () { showFirstRunHelp(os); });
  });

  fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {
    headers: { Accept: 'application/vnd.github+json' }
  })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('release ' + r.status)); })
    .then(function (rel) {
      var assets = Array.isArray(rel.assets) ? rel.assets : [];
      var asset = pickAsset(assets, os);
      if (!asset || !asset.browser_download_url) return; // no binary → keep release-page link
      var tag = rel.tag_name ? rel.tag_name.replace(/^v/, '') : '';
      var url = asset.browser_download_url;

      Array.prototype.forEach.call(buttons, function (btn) {
        btn.href = url;
        btn.setAttribute('download', asset.name);
        btn.removeAttribute('target'); // download in place, no stray blank tab
        btn.removeAttribute('rel');
        setLabel(btn, os, tag);
        // Explicitly kick off the download so the browser saves the file
        // instead of navigating anywhere. GitHub serves the asset with
        // Content-Disposition: attachment, so this downloads the installer.
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          var a = document.createElement('a');
          a.href = url;
          a.setAttribute('download', asset.name);
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          // Surface the "how to get past the first-launch security prompt"
          // help right when they've got the file in hand.
          showFirstRunHelp(os);
        });
      });
    })
    .catch(function () { /* offline / rate-limited → buttons stay on /releases/latest */ });
})();
