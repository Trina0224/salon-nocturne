// Progressive enhancements only; every page works without this script.
(function () {
  'use strict';

  // Read mode: hide the scene and widen the text column. Remembered per browser.
  var KEY = 'salon.readMode';
  var button = document.querySelector('[data-read-mode]');
  function storedReadMode() {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  function applyReadMode(on) {
    document.body.classList.toggle('read-mode', on);
    if (button) button.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  if (button) {
    applyReadMode(storedReadMode());
    button.addEventListener('click', function () {
      var on = !document.body.classList.contains('read-mode');
      applyReadMode(on);
      try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) { /* storage unavailable */ }
    });
  }

  // Show times in the reader's own time zone; the server renders UTC.
  var fmt;
  try {
    fmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  } catch (e) { fmt = null; }
  if (fmt) {
    document.querySelectorAll('time[data-local-time]').forEach(function (el) {
      var d = new Date(el.getAttribute('datetime'));
      if (!isNaN(d)) {
        el.textContent = fmt.format(d);
        el.title = d.toISOString().replace('.000Z', 'Z');
      }
    });
  }

  // New-post notice. Polls public status at a modest interval only while the
  // session is open and the tab is visible; it never scrolls the page.
  var notice = document.querySelector('[data-new-thoughts]');
  if (!notice) return;
  var sessionId = notice.getAttribute('data-session-id');
  var seen = Number(notice.getAttribute('data-latest-seq')) || 0;
  var stopped = false;
  var noticeButton = notice.querySelector('button');
  noticeButton.addEventListener('click', function () { window.location.reload(); });

  function check() {
    if (stopped || document.hidden) return;
    fetch('/api/v1/sessions/current', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.session || data.session.id !== sessionId) return;
        if (data.session.state !== 'open') {
          stopped = true;
          noticeButton.textContent = 'This session has closed · refresh';
          notice.hidden = false;
          return;
        }
        var latest = data.stats ? data.stats.latest_seq : 0;
        if (latest > seen) {
          noticeButton.textContent = 'New thoughts have arrived · show them';
          notice.hidden = false;
        }
      })
      .catch(function () { /* transient; try again later */ });
  }
  var timer = setInterval(function () { if (stopped) clearInterval(timer); else check(); }, 20000);
})();
