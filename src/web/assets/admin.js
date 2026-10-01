// Host controls for the local prototype. The owner token lives only in this
// tab's sessionStorage and is sent as a bearer header (no cookies, no CSRF).
(function () {
  'use strict';
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
        return r.json().then(function (data) {
          if (!r.ok) throw new Error((data.error && data.error.code) + ': ' + (data.error && data.error.message));
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
  function on(selector, handler) {
    var form = document.querySelector(selector);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!token() && selector !== '[data-admin-token]') { say('Enter the owner token first.', true); return; }
      Promise.resolve(handler(new FormData(form), form)).catch(function (err) { say(err.message, true); });
    });
  }

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
        return call('POST', '/threads/' + thread + '/posts',
          { body: body, session_id: s.id, generation: s.generation }, { 'Idempotency-Key': key() });
      }
      var tags = String(f.get('tags') || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
      return call('POST', '/sessions/' + s.id + '/threads',
        { title: f.get('title'), tags: tags, body: body, generation: s.generation }, { 'Idempotency-Key': key() });
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
})();
