/* GitHub star badge. Hidden until the count is known; shown once the repo has at least one star.
   One unauthenticated request to the public GitHub API, cached in localStorage for 6 hours.
   Fails silently. No other requests, no tracking.
   Testing only: add ?stars=150 to the page URL to show a fake count without any request. */
(function () {
  'use strict';
  var API = 'https://api.github.com/repos/hsalazr/deck-for-t3code';
  var KEY = 'deck-for-t3code:stars';
  var TTL = 6 * 60 * 60 * 1000;
  var MIN = 0; // show from the first star

  function show(count) {
    if (typeof count !== 'number' || !isFinite(count) || count <= MIN) return;
    var text;
    try { text = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(count); }
    catch (e) { text = String(count); }
    var badges = document.querySelectorAll('[data-stars]');
    for (var i = 0; i < badges.length; i++) {
      var n = badges[i].querySelector('.stars-n');
      if (n) n.textContent = text;
      badges[i].hidden = false;
    }
  }

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function write(count, at) {
    try { localStorage.setItem(KEY, JSON.stringify({ n: count, t: at })); } catch (e) { /* storage blocked */ }
  }

  var override = /^[0-9]{1,9}$/.test((new URLSearchParams(location.search).get('stars')) || '')
    ? Number(new URLSearchParams(location.search).get('stars')) : null;
  if (override !== null) { show(override); return; }

  var cached = read();
  var now = Date.now();
  if (cached && typeof cached.t === 'number' && now - cached.t < TTL) { show(cached.n); return; }
  if (cached && typeof cached.n === 'number') show(cached.n); // stale count while we refresh

  if (typeof fetch !== 'function') return;
  fetch(API, { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (r) { if (!r.ok) throw 0; return r.json(); })
    .then(function (d) {
      var n = d && d.stargazers_count;
      if (typeof n !== 'number') throw 0;
      write(n, Date.now());
      show(n);
    })
    .catch(function () {
      // Rate limited or offline: back off for ~10 minutes instead of retrying on every page view.
      write(cached && typeof cached.n === 'number' ? cached.n : null, Date.now() - TTL + 10 * 60 * 1000);
    });
})();
