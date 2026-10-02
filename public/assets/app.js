// Progressive enhancements only; every page works without this script.
(function (root) {
  'use strict';

  /**
   * What a page watching one session should do with a status response.
   * The page polls the session it shows, never "whatever is current", so a
   * new session opening elsewhere cannot keep an old tab polling forever.
   * Returns 'retry' | 'stop' | 'closed' | 'new' | 'none'.
   */
  function decidePoll(observedSessionId, seenSeq, response) {
    if (!response) return 'retry';
    if (response.notFound) return 'stop';
    var s = response.session;
    if (!s || s.id !== observedSessionId) return 'stop';
    if (s.state !== 'open') return 'closed';
    var latest = response.stats ? response.stats.latest_post_seq : 0;
    return latest > seenSeq ? 'new' : 'none';
  }

  root.SalonNocturne = { decidePoll: decidePoll };
  if (typeof document === 'undefined') return;

  // Read mode: hide the scene and widen the text column. Remembered per browser.
  var READ_KEY = 'salon.readMode';
  var button = document.querySelector('[data-read-mode]');
  function storedReadMode() {
    try { return localStorage.getItem(READ_KEY) === '1'; } catch (e) { return false; }
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
      try { localStorage.setItem(READ_KEY, on ? '1' : '0'); } catch (e) { /* storage unavailable */ }
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

  // After "show new thoughts", put the reader back where they were reading.
  var SCROLL_KEY = 'salon.restoreScroll';
  try {
    var saved = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || 'null');
    sessionStorage.removeItem(SCROLL_KEY);
    if (saved && saved.url === location.pathname + location.search) {
      window.scrollTo({ top: saved.y, left: 0, behavior: 'instant' });
    }
  } catch (e) { /* storage unavailable */ }

  // New-post notice. Polls this page's own session at a modest interval while
  // it is open and the tab is visible; it never scrolls the page.
  var notice = document.querySelector('[data-new-thoughts]');
  if (!notice) return;
  var sessionId = notice.getAttribute('data-session-id');
  var seen = Number(notice.getAttribute('data-seen-seq')) || 0;
  var refreshUrl = notice.getAttribute('data-refresh-url');
  var noticeButton = notice.querySelector('button');
  var timer = null;

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  noticeButton.addEventListener('click', function () {
    try {
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ url: refreshUrl, y: window.scrollY }));
    } catch (e) { /* storage unavailable */ }
    window.location.assign(refreshUrl);
  });

  function check() {
    if (document.hidden) return;
    fetch('/api/v1/sessions/' + encodeURIComponent(sessionId) + '/status', { headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 404) return { notFound: true };
        return r.ok ? r.json() : null;
      })
      .catch(function () { return null; })
      .then(function (data) {
        var action = decidePoll(sessionId, seen, data);
        if (action === 'stop') {
          stop();
        } else if (action === 'closed') {
          stop();
          noticeButton.textContent = 'This session has closed · refresh';
          notice.hidden = false;
        } else if (action === 'new') {
          noticeButton.textContent = 'New thoughts have arrived · show them';
          notice.hidden = false;
        }
      });
  }
  timer = setInterval(check, 20000);
})(typeof window !== 'undefined' ? window : globalThis);
