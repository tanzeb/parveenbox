/*
 * ParveenBox TV user script. webOS runs this on every page the ParveenBox app opens.
 *
 * On YouTube pages (the embedded player, or YouTube's player page shown full screen):
 *   1. removes the ad entries from YouTube's player data before the video starts
 *      (the same idea as webosbrew / NicholasBly youtube-webos), and skips any ad that still appears
 *   2. asks for the highest quality the video has
 *   3. tells ParveenBox's page that it is running (so ParveenBox knows the ad blocking works there)
 * On YouTube's player page opened full screen by ParveenBox (address ends in #pb=...):
 *   4. plays the next episode when one ends, and Back returns to ParveenBox
 */
(function () {
  'use strict';
  var host = location.hostname;
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return;

  /* ---------- 1. remove ads from the player data ---------- */
  var AD_KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams', 'adBreakParams'];
  function clean(o, depth) {
    if (!o || typeof o !== 'object' || (depth || 0) > 3) return o;
    for (var i = 0; i < AD_KEYS.length; i++) if (AD_KEYS[i] in o) { try { delete o[AD_KEYS[i]]; } catch (e) { o[AD_KEYS[i]] = undefined; } }
    if (o.playerResponse) clean(o.playerResponse, (depth || 0) + 1);
    if (o.embeddedPlayerResponse) clean(o.embeddedPlayerResponse, (depth || 0) + 1);
    if (Array.isArray(o)) for (var j = 0; j < o.length && j < 8; j++) clean(o[j], (depth || 0) + 1);
    return o;
  }
  function looksLikePlayerData(o) {
    return o && typeof o === 'object' && (o.adPlacements || o.playerAds || o.adSlots || o.playerResponse || o.streamingData || Array.isArray(o));
  }
  var origParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    var r = origParse.call(this, text, reviver);
    try { if (looksLikePlayerData(r)) clean(r); } catch (e) { /* never break YouTube */ }
    return r;
  };
  if (window.Response && Response.prototype.json) {
    var origJson = Response.prototype.json;
    Response.prototype.json = function () {
      return origJson.call(this).then(function (d) { try { if (looksLikePlayerData(d)) clean(d); } catch (e) { /* ignore */ } return d; });
    };
  }
  ['ytInitialPlayerResponse', 'ytInitialData'].forEach(function (name) {
    try {
      var val = window[name];
      Object.defineProperty(window, name, { configurable: true, get: function () { return val; }, set: function (v) { val = clean(v); } });
      if (val) clean(val);
    } catch (e) { /* already defined by the page */ }
  });

  /* ---------- 2. highest quality ---------- */
  try {
    var now = Date.now();
    localStorage.setItem('yt-player-quality', JSON.stringify({ data: JSON.stringify({ quality: 4320, previousQuality: 1080 }), expiration: now + 31536000000, creation: now }));
  } catch (e) { /* storage blocked */ }
  /* best quality: the one chosen in the Up menu (if this video has it), otherwise the highest the video offers.
     Set once when an episode starts and checked once more a few seconds later, never in a loop (that made videos rebuffer). */
  var QNAMES = { highres: '8K', hd2160: '4K', hd1440: '2K (1440p)', hd1080: '1080p', hd720: '720p', large: '480p', medium: '360p', small: '240p', tiny: '144p' };
  function qName(q) { return QNAMES[q] || q || ''; }
  function wantedQuality(levels) {
    var pick = null; try { pick = localStorage.getItem('pb_quality'); } catch (e) { /* ignore */ }
    if (pick && pick !== 'max' && levels.indexOf(pick) >= 0) return pick;
    for (var i = 0; i < levels.length; i++) if (levels[i] !== 'auto') return levels[i];
    return null;
  }
  var qualityTries = {};
  function forceQuality(p, again) {
    if (!p || !p.getAvailableQualityLevels) return '';
    var levels = p.getAvailableQualityLevels() || [];
    var want = wantedQuality(levels);
    if (!want) return '';
    var vid = (p.getVideoData && p.getVideoData() && p.getVideoData().video_id) || '';
    var n = qualityTries[vid] || 0;
    if (n >= 2 && !again) return want;
    qualityTries[vid] = n + 1;
    if (!p.getPlaybackQuality || p.getPlaybackQuality() !== want || again) {
      try { if (p.setPlaybackQualityRange) p.setPlaybackQualityRange(want, want); } catch (e) { /* ignore */ }
      try { if (p.setPlaybackQuality) p.setPlaybackQuality(want); } catch (e) { /* ignore */ }
    }
    return want;
  }

  /* ---------- watch loop: skip ads that slip through, keep the quality, report to ParveenBox ---------- */
  var mutedByUs = false, qualityTimer = {};
  function player() { return document.querySelector('#movie_player') || document.querySelector('.html5-video-player'); }
  setInterval(function () {
    var p = player(); if (!p) return;
    var v = p.querySelector('video');
    var inAd = p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting');
    if (inAd) {
      var skip = document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-container button');
      if (skip) { try { skip.click(); } catch (e) { /* ignore */ } }
      if (v && isFinite(v.duration) && v.duration > 0) { if (!v.muted) { v.muted = true; mutedByUs = true; } try { v.currentTime = v.duration; } catch (e) { /* ignore */ } }
      return;
    }
    if (v && mutedByUs) { v.muted = false; mutedByUs = false; }
    var vid = (p.getVideoData && p.getVideoData() && p.getVideoData().video_id) || '';
    if (vid && !qualityTimer[vid] && p.getAvailableQualityLevels && (p.getAvailableQualityLevels() || []).length) {
      qualityTimer[vid] = Date.now(); try { forceQuality(p); } catch (e) { /* ignore */ }
      setTimeout(function () { try { forceQuality(player()); } catch (e) { /* ignore */ } }, 4000);
    }
    if (window.parent !== window) { try { window.parent.postMessage({ pb: 'adfree-active', quality: (p.getPlaybackQuality && p.getPlaybackQuality()) || '' }, '*'); } catch (e) { /* ignore */ } }
  }, 300);

  /* ---------- 4. full-screen episode page opened by ParveenBox ---------- */
  var m = /#pb=(.+)$/.exec(location.href);
  if (window.top !== window || !m) return;
  var st; try { st = JSON.parse(decodeURIComponent(m[1])); } catch (e) { return; }
  if (!st || !st.ret || !st.eps || !st.eps.length) return;
  st.w = st.w || [];
  st.lb = st.lb || st.eps.map(function (x, i) { return i + 1; });

  function epLabel(i) { return 'Episode ' + st.lb[i]; }
  function stateUrl(i) {
    return 'https://www.youtube.com/embed/' + st.eps[i] + '?autoplay=1&rel=0&playsinline=1&iv_load_policy=3&modestbranding=1' +
      '#pb=' + encodeURIComponent(JSON.stringify({ ret: st.ret, pl: st.pl, eps: st.eps, lb: st.lb, i: i, w: st.w, n: st.n }));
  }
  function backToParveenBox() {
    var p = player(), q = '';
    try { q = (p && p.getPlaybackQuality && p.getPlaybackQuality()) || ''; } catch (e) { /* ignore */ }
    location.replace(st.ret + '#/p/' + st.pl + '?last=' + st.eps[st.i] + '&w=' + st.w.join(',') + '&pbok=1' + (q ? '&q=' + q : ''));
  }
  /* change episode inside this page: no new page load (faster, and the TV never hands it to the YouTube app) */
  var done = false, started = Date.now();
  function playEpisode(i) {
    i = Math.max(0, Math.min(st.eps.length - 1, i));
    st.i = i; done = false; started = Date.now();
    try { history.replaceState(null, '', stateUrl(i)); } catch (e) { /* ignore */ }
    var p = player();
    if (p && p.loadVideoById) { try { p.loadVideoById(st.eps[i]); } catch (e) { location.replace(stateUrl(i)); return; } }
    else { location.replace(stateUrl(i)); return; }
    say((st.n ? st.n + ' – ' : '') + epLabel(i) + ' of ' + st.eps.length, 3000);
  }
  function next() {
    var cur = st.eps[st.i];
    if (st.w.indexOf(cur) < 0) st.w.push(cur);
    if (st.i < st.eps.length - 1) playEpisode(st.i + 1);
    else backToParveenBox();
  }

  /* ---------- on-screen pieces: notice, quality badge, quality menu (Up), episode strip (Down) ---------- */
  var FONT = 'font-family:Roboto,Arial,sans-serif;';
  function overlayHost() { return document.fullscreenElement || document.webkitFullscreenElement || document.body || document.documentElement; }
  function el(css) { var d = document.createElement('div'); d.style.cssText = css; overlayHost().appendChild(d); return d; }
  function mk(css, text, kids) {
    var d = document.createElement('div'); if (css) d.style.cssText = css; if (text) d.textContent = text;
    (kids || []).forEach(function (k) { d.appendChild(k); }); return d;
  }
  function fill(box, kids) { while (box.firstChild) box.removeChild(box.firstChild); kids.forEach(function (k) { box.appendChild(k); }); if (box.parentNode !== overlayHost()) overlayHost().appendChild(box); }
  var note, badge, menu = null, strip = null;
  function say(text, ms) {
    if (!note) note = el(FONT + 'position:fixed;left:50%;top:4%;transform:translateX(-50%);z-index:2147483647;background:rgba(15,17,21,.9);color:#fff;font-size:26px;font-weight:500;padding:14px 28px;border-radius:12px;pointer-events:none;transition:opacity .3s');
    if (note.parentNode !== overlayHost()) overlayHost().appendChild(note);
    note.textContent = text; note.style.opacity = '1';
    clearTimeout(note._t); note._t = setTimeout(function () { note.style.opacity = '0'; }, ms || 3500);
  }
  function showBadge(ms) {
    var p = player(); if (!p || !p.getPlaybackQuality) return;
    var q = p.getPlaybackQuality(); if (!q || q === 'unknown') return;
    if (!badge) badge = el(FONT + 'position:fixed;right:3%;top:4%;z-index:2147483647;background:rgba(15,17,21,.85);color:#fff;font-size:24px;font-weight:700;padding:10px 18px;border-radius:10px;pointer-events:none;transition:opacity .3s');
    if (badge.parentNode !== overlayHost()) overlayHost().appendChild(badge);
    badge.textContent = 'Quality: ' + qName(q); badge.style.opacity = '1';
    clearTimeout(badge._t); badge._t = setTimeout(function () { badge.style.opacity = '0'; }, ms || 5000);
  }
  /* Up: choose the quality (remembered for every episode) */
  function openMenu() {
    var p = player(); if (!p || !p.getAvailableQualityLevels) { say('Quality list not ready yet. Try again in a moment.'); return; }
    var levels = (p.getAvailableQualityLevels() || []).filter(function (q) { return q !== 'auto'; });
    if (!levels.length) { say('Quality list not ready yet. Try again in a moment.'); return; }
    var cur = p.getPlaybackQuality && p.getPlaybackQuality();
    var items = [{ q: 'max', t: 'Always the best (' + qName(levels[0]) + ')' }].concat(levels.map(function (q) { return { q: q, t: qName(q) }; }));
    var pick = 'max'; try { pick = localStorage.getItem('pb_quality') || 'max'; } catch (e) { /* ignore */ }
    var sel = 0; for (var i = 0; i < items.length; i++) if (items[i].q === pick) sel = i;
    menu = el(FONT + 'position:fixed;right:3%;top:12%;z-index:2147483647;background:rgba(15,17,21,.95);color:#fff;font-size:26px;padding:16px 0;border-radius:14px;min-width:380px');
    function draw() {
      fill(menu, [mk('padding:4px 26px 12px;color:#9aa3b2;font-size:22px', 'Quality (now ' + qName(cur) + ')')].concat(items.map(function (it, j) {
        return mk('padding:10px 26px;' + (j === sel ? 'background:#ff4d5a;font-weight:700' : ''), it.t + (it.q === pick ? '  ✓' : ''));
      })).concat([mk('padding:12px 26px 0;color:#9aa3b2;font-size:20px', 'Up/Down to choose, OK to set, Back to close')]));
    }
    draw();
    menu._move = function (d) { sel = (sel + d + items.length) % items.length; draw(); };
    menu._ok = function () {
      try { localStorage.setItem('pb_quality', items[sel].q); } catch (e) { /* ignore */ }
      closeMenu(); var pl = player(); if (pl) { var vid = pl.getVideoData && pl.getVideoData().video_id; qualityTries[vid] = 0; forceQuality(pl, true); }
      say('Quality: ' + items[sel].t, 2500); setTimeout(function () { showBadge(4000); }, 3000);
    };
  }
  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  /* Down: the episode strip, choose any episode */
  function openStrip() {
    var sel = st.i;
    strip = el(FONT + 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:linear-gradient(transparent,rgba(15,17,21,.97) 25%);color:#fff;padding:60px 3% 34px');
    function draw() {
      var start = Math.max(0, Math.min(sel - 2, st.eps.length - 6)), cards = [];
      for (var j = start; j < Math.min(st.eps.length, start + 6); j++) {
        var on = j === sel, watched = st.w.indexOf(st.eps[j]) >= 0, now = j === st.i;
        cards.push(mk('display:inline-block;vertical-align:top;width:15%;margin-right:1.6%;border-radius:10px;overflow:hidden;background:#1c2029;border:4px solid ' + (on ? '#fff' : 'transparent'), '', [
          mk('position:relative;padding-top:56.25%;background:#222 url(https://i.ytimg.com/vi/' + st.eps[j] + '/mqdefault.jpg) center/cover'),
          mk('padding:8px 12px;font-size:22px;white-space:nowrap;overflow:hidden;font-weight:' + (on ? 700 : 500), epLabel(j) + (now ? ' ▶' : watched ? ' ✓' : ''))
        ]));
      }
      fill(strip, [mk('font-size:24px;margin-bottom:14px;color:#cfd4dc', (st.n ? st.n + ' · ' : '') + st.eps.length + ' episodes · Left/Right to choose, OK to play, Back or Down to close'),
        mk('white-space:nowrap', '', cards)]);
    }
    draw();
    strip._move = function (d) { sel = Math.max(0, Math.min(st.eps.length - 1, sel + d)); draw(); };
    strip._ok = function () { var i = sel; closeStrip(); if (i !== st.i) playEpisode(i); };
  }
  function closeStrip() { if (strip) { strip.remove(); strip = null; } }

  window.addEventListener('keydown', function (e) {
    var k = e.keyCode, v = document.querySelector('video');
    var stop = function () { e.preventDefault(); e.stopImmediatePropagation(); };
    if (menu) {
      stop();
      if (k === 38) menu._move(-1); else if (k === 40) menu._move(1); else if (k === 13) menu._ok(); else if (k === 461 || k === 27 || k === 8 || k === 37 || k === 39) closeMenu();
      return;
    }
    if (strip) {
      stop();
      if (k === 37) strip._move(-1); else if (k === 39) strip._move(1); else if (k === 13) strip._ok(); else if (k === 461 || k === 27 || k === 8 || k === 40 || k === 38) closeStrip();
      return;
    }
    if (k === 461 || k === 27 || k === 8) { stop(); backToParveenBox(); return; }
    if (k === 13 && v) { stop(); if (v.paused) v.play(); else v.pause(); showBadge(3000); return; }
    if ((k === 37 || k === 39) && v) { stop(); try { v.currentTime = Math.max(0, v.currentTime + (k === 39 ? 10 : -10)); } catch (x) { /* ignore */ } return; }
    if (k === 40) { stop(); try { openStrip(); } catch (x) { closeStrip(); say('Episode list failed: ' + x.message, 5000); } return; }
    if (k === 38) { stop(); try { openMenu(); } catch (x) { closeMenu(); say('Quality list failed: ' + x.message, 5000); } return; }
  }, true);

  /* end of an episode, unplayable episodes, and a quick start */
  var shownBadgeFor = '';
  setInterval(function () {
    var v = document.querySelector('video'), p = player();
    if (p && p.classList.contains('ad-showing')) return;
    var age = Date.now() - started;
    if (v && !done && v.duration > 60 && age > 5000 && (v.ended || (v.paused && v.currentTime >= v.duration - 1))) { done = true; say('Next episode', 2000); setTimeout(next, 1200); }
    if (!done && age > 6000 && document.querySelector('.ytp-error, .ytp-error-content')) { done = true; say('This episode cannot play here. Playing the next one.', 4000); setTimeout(next, 4000); }
    /* autoplay did not kick in: start it straight away instead of waiting */
    if (v && v.paused && !done && v.currentTime < 1 && age > 700 && age < 10000 && !menu && !strip) { try { var r = v.play(); if (r && r.catch) r.catch(function () {}); } catch (x) { /* ignore */ } }
    var vid = p && p.getVideoData && p.getVideoData().video_id;
    if (vid && shownBadgeFor !== vid && age > 2500 && p.getPlaybackQuality && p.getPlaybackQuality() && p.getPlaybackQuality() !== 'unknown') { shownBadgeFor = vid; showBadge(5000); }
  }, 300);
  function hello() { say((st.n ? st.n + ' – ' : '') + epLabel(st.i) + ' of ' + st.eps.length + '.   Down: episodes   Up: quality   Back: ParveenBox', 5000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hello); else hello();
})();
