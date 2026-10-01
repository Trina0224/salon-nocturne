// Host controls for the local prototype. The owner token lives only in this
// tab's sessionStorage and is sent as a bearer header (no cookies, no CSRF).
(function (root) {
  'use strict';

  /**
   * Wraps an idempotent write. While a request is in flight, further submits
   * return the same promise instead of sending again. If the outcome is
   * unknown (network failure, lost response, 5xx), a retry of the identical
   * request reuses the same Idempotency-Key, so the server replays the
   * original result rather than writing twice. A definite rejection (4xx)
   * or a success clears the remembered key.
   */
  function createSubmitter(send, makeKey) {
    var inFlight = null;
    var uncertain = null;
    return function submit(request) {
      if (inFlight) return inFlight;
      var text = JSON.stringify(request);
      var key = uncertain && uncertain.text === text ? uncertain.key : makeKey();
      inFlight = Promise.resolve()
        .then(function () { return send(request, key); })
        .then(function (result) {
          inFlight = null;
          uncertain = null;
          return result;
        }, function (err) {
          inFlight = null;
          uncertain = err && err.definite ? null : { text: text, key: key };
          throw err;
        });
      return inFlight;
    };
  }

  root.SalonAdmin = { createSubmitter: createSubmitter };
  if (typeof document === 'undefined') return;

  var KEY = 'salon.ownerToken';
  var out = document.querySelector('[data-admin-output]');

  function token() {
    try { return sessionStorage.getItem(KEY) || ''; } catch (e) { return ''; }
  }
  function say(text, isError) {
    out.textContent = text;
    out.classList.toggle('is-error', !!isError);
  }
  function key() {
    var a = new Uint8Array(12);
    crypto.getRandomValues(a);
    return 'host-' + Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function call(method, path, body, extraHeaders) {
    var headers = { Authorization: 'Bearer ' + token(), Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    Object.assign(headers, extraHeaders || {});
    return fetch('/api/v1' + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok) {
            var err = new Error((data.error && data.error.code) + ': ' + (data.error && data.error.message));
            // The server answered: a 4xx was definitely not written.
            err.definite = r.status < 500;
            throw err;
          }
          return data;
        });
      });
  }
  function current() {
    return call('GET', '/sessions/current').then(function (d) {
      if (!d.session) throw new Error('No session exists yet.');
      return d.session;
    });
  }
  // One submission per form at a time; the button is disabled meanwhile.
  function on(selector, handler) {
    var form = document.querySelector(selector);
    var submitButton = form.querySelector('[type="submit"]');
    var busy = false;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (busy) return;
      if (!token() && selector !== '[data-admin-token]') { say('Enter the owner token first.', true); return; }
      busy = true;
      if (submitButton) submitButton.disabled = true;
      Promise.resolve()
        .then(function () { return handler(new FormData(form), form); })
        .catch(function (err) {
          say(err.definite === false || err instanceof TypeError
            ? 'No response from the server. Submitting again safely retries the same request.'
            : err.message, true);
        })
        .then(function () {
          busy = false;
          if (submitButton) submitButton.disabled = false;
        });
    });
  }

  var submitHostPost = createSubmitter(function (request, idempotencyKey) {
    return call('POST', request.path, request.body, { 'Idempotency-Key': idempotencyKey });
  }, key);

  on('[data-admin-token]', function (f, form) {
    try { sessionStorage.setItem(KEY, String(f.get('token'))); } catch (e) { /* ignore */ }
    form.reset();
    return call('GET', '/me').then(function (me) {
      say('Signed in for this tab as ' + me.participant.display_name + ' (' + me.participant.role + ').');
    });
  });

  on('[data-admin-open]', function (f) {
    var num = function (n) { return Number(f.get(n)); };
    return call('POST', '/admin/sessions', {
      title: f.get('title'),
      description: f.get('description') || undefined,
      duration_minutes: num('minutes'),
      limits: {
        maxPosts: num('maxPosts'),
        maxPostsPerParticipant: num('maxPostsPerParticipant'),
        maxThreads: num('maxThreads'),
        maxBodyChars: num('maxBodyChars'),
      },
    }).then(function (d) {
      say('Opened “' + d.session.title + '” (generation ' + d.session.generation + ') until ' + d.session.hard_ends_at + '.');
    });
  });

  on('[data-admin-close]', function () {
    return current().then(function (s) {
      return call('POST', '/admin/sessions/' + s.id + '/close', { expected_revision: s.revision });
    }).then(function (d) {
      say('Session closed (' + d.session.close_reason + ') at ' + d.session.closed_at + '.');
    });
  });

  on('[data-admin-post]', function (f, form) {
    return current().then(function (s) {
      var thread = String(f.get('thread') || '').trim();
      var body = String(f.get('body') || '');
      if (thread) {
        return submitHostPost({
          path: '/threads/' + encodeURIComponent(thread) + '/posts',
          body: { body: body, session_id: s.id, generation: s.generation },
        });
      }
      var tags = String(f.get('tags') || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
      return submitHostPost({
        path: '/sessions/' + s.id + '/threads',
        body: { title: String(f.get('title') || ''), tags: tags, body: body, generation: s.generation },
      });
    }).then(function (d) {
      form.reset();
      var id = d.post ? d.post.id : '';
      say('Posted ' + id + '.');
    });
  });

  on('[data-admin-redact]', function (f) {
    var id = String(f.get('post')).trim();
    // Moderation needs the current revision; read it from the public post.
    return call('GET', '/posts/' + encodeURIComponent(id))
      .then(function (d) {
        return call('POST', '/admin/posts/' + encodeURIComponent(id) + '/moderate',
          { action: 'redact', reason: f.get('reason'), expected_revision: d.post.revision });
      })
      .then(function (d) { say('Post ' + d.post.id + ' removed.'); });
  });
})(typeof window !== 'undefined' ? window : globalThis);
