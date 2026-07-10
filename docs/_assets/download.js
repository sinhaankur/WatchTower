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

  var os = detectOS();
  if (!os) return; // unknown OS → leave generic label + /releases/latest link

  // Relabel immediately (still points at /releases/latest until the API answers).
  for (var i = 0; i < buttons.length; i++) setLabel(buttons[i], os, '');

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
        });
      });
    })
    .catch(function () { /* offline / rate-limited → buttons stay on /releases/latest */ });
})();
