/* ParveenBox UI. Plain ES5 for older TV Chromium: no arrow functions, async/await, template strings,
   ?. / ??, Object.assign, Array.prototype.findIndex or URLSearchParams. Data comes from data.js (window.PB). */
(function () {
  'use strict';
  if (!Element.prototype.matches) Element.prototype.matches = Element.prototype.webkitMatchesSelector;
  if (!Element.prototype.closest) Element.prototype.closest = function (s) { var e = this; while (e && e.nodeType === 1) { if (e.matches(s)) return e; e = e.parentNode; } return null; };

  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var ls = { get: function (k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }, set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
  var prog = ls.get('pb_prog', {}), metas = ls.get('pb_meta', {}), rid = 0, player = null, known = {};
  var persist = function () { ls.set('pb_prog', prog); ls.set('pb_meta', metas); };
  function extend(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }
  function toast(m) { var t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(t._t); t._t = setTimeout(function () { t.style.display = 'none'; }, 3500); }
  var errBox = function (t, m) { return '<div class="err"><h3>' + esc(t) + '</h3><p>' + esc(m) + '</p></div>'; };
  function fmtViews(n) { n = Number(n) || 0; if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'; if (n >= 1e3) return Math.round(n / 1e3) + 'K'; return String(n); }
  function parseQs(s) { var o = {}; String(s || '').split('&').forEach(function (kv) { if (!kv) return; var i = kv.indexOf('='); o[decodeURIComponent(i < 0 ? kv : kv.slice(0, i))] = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1)); }); return o; }

  function tile(p) {
    known[p.id] = p; var w = (prog[p.id] || { w: [] }).w.length, pct = p.count ? Math.min(100, Math.round(w / p.count * 100)) : 0;
    var stats = p.views != null ? fmtViews(p.views) + ' views' + (p.first ? ' · ' + new Date(p.first).getUTCFullYear() : '') + (p.status ? ' · ' + (p.status === 'ongoing' ? 'On-going' : 'Completed') : '') : '';
    return '<a class="tile" href="#/p/' + esc(p.id) + '"><div class="th"><img loading="lazy" src="' + esc(p.thumb) + '" alt="">' + (p.official ? '<span class="badge off">&#10003; Official</span>' : '') + '<span class="badge">' + p.count + ' eps</span></div>' + (pct ? '<div class="bar"><i style="width:' + pct + '%"></i></div>' : '') + '<div class="t"><div class="n">' + esc(p.title) + '</div><div class="m">' + esc(p.channel || '') + '</div>' + (stats ? '<div class="m">' + esc(stats) + '</div>' : '') + '</div></a>';
  }
  var skeleton = function (n) { var s = ''; for (var i = 0; i < n; i++) s += '<div class="sk"></div>'; return '<div class="row">' + s + '</div>'; };
  var SEC_NAMES = { all: 'All Hindi & Urdu', pk: 'Pakistani dramas', hi: 'Hindi TV serials', web: 'Hindi web series' };
  /* after a page renders, put the remote's focus somewhere useful */
  function focusFirst(sel) { if (document.activeElement && document.activeElement !== document.body && document.activeElement.id !== 'q') return; var e = $(sel); if (e) try { e.focus(); } catch (x) {} }

  /* ---------- home ---------- */
  function home(my) {
    var cont = Object.keys(prog).filter(function (id) { return prog[id].last && metas[id]; }).sort(function (a, b) { return (prog[b].at || 0) - (prog[a].at || 0); }).slice(0, 12);
    var h = cont.length ? '<h2 class="sec">Continue watching</h2><div class="row">' + cont.map(function (id) { return tile(metas[id]); }).join('') + '</div>' : '';
    var years = ''; for (var y = 2018; y >= 2010; y--) years += '<a class="chip" href="#/browse/all?year=' + y + '&sort=views">' + y + '</a>';
    h += '<h2 class="sec">Old favourites by year</h2><div class="chips">' + years + '</div>';
    $('#app').innerHTML = h + '<h2 class="sec">Most watched right now</h2>' + skeleton(8) + skeleton(8);
    focusFirst('.tile, .chip');
    PB.trending().then(function (secs) {
      if (my !== rid) return;
      $('#app').innerHTML = h + secs.map(function (s) { return '<h2 class="sec"><a href="#/browse/' + esc(s.key) + '">' + esc(s.title) + '<span class="more">See all &rsaquo;</span></a></h2><div class="row">' + s.items.map(tile).join('') + '</div>'; }).join('')
        + '<p class="note">Ranked by YouTube view counts on recent full-episode playlists, refreshed every 12 hours. Open a heading to see everything, or search for any title.</p>';
      focusFirst('.tile, .chip');
    }, function (e) { if (my !== rid) return; $('#app').innerHTML = h + errBox('Could not load the front page', e.message); });
  }

  /* ---------- browse (a whole section with sorting and filters) ---------- */
  function browseView(key, qs, my) {
    var year = qs.year || '', sort = qs.sort || 'views', status = qs.status || 'all';
    if (!SEC_NAMES[key]) key = 'all';
    var link = function (k, patch) { var o = extend({ year: year, sort: sort, status: status }, patch), p = [], f; for (f in o) if (o[f] && !(f === 'status' && o[f] === 'all') && !(f === 'sort' && o[f] === 'views')) p.push(f + '=' + encodeURIComponent(o[f])); return '#/browse/' + k + (p.length ? '?' + p.join('&') : ''); };
    var tabs = ['all', 'pk', 'hi', 'web'].map(function (k) { return '<a class="chip ' + (k === key ? 'on' : '') + '" href="' + link(k, {}) + '">' + esc(SEC_NAMES[k]) + '</a>'; }).join('');
    var sorts = [['views', 'Most viewed'], ['popular', 'Popular (views per day)'], ['newest', 'Newest first'], ['oldest', 'Oldest first']].map(function (s) { return '<option value="' + s[0] + '"' + (s[0] === sort ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('');
    var yopts = '<option value="">Any year</option>'; for (var y = new Date().getFullYear(); y >= 2005; y--) yopts += '<option value="' + y + '"' + (String(y) === year ? ' selected' : '') + '>' + y + '</option>';
    var stat = [['all', 'All'], ['completed', 'Completed'], ['ongoing', 'On-going']].map(function (s) { return '<a class="chip ' + (s[0] === status ? 'on' : '') + '" href="' + link(key, { status: s[0] }) + '">' + s[1] + '</a>'; }).join('');
    var head = '<h2 class="sec" style="margin-top:6px">' + esc(SEC_NAMES[key]) + (year ? ' · ' + esc(year) : '') + '</h2><div class="chips">' + tabs + '</div>'
      + '<div class="ctrls"><span class="pair"><label for="sortSel">Sort</label><select id="sortSel">' + sorts + '</select></span><span class="pair"><label for="yearSel">Year</label><select id="yearSel">' + yopts + '</select></span><span class="grp">' + stat + '</span></div>';
    $('#app').innerHTML = head + '<div id="bres">' + skeleton(6) + '<p class="note">Loading the full list. The first time can take 10 to 20 seconds.</p></div>';
    $('#sortSel').onchange = function (e) { location.hash = link(key, { sort: e.target.value }); };
    $('#yearSel').onchange = function (e) { location.hash = link(key, { year: e.target.value }); };
    focusFirst('.chip.on');
    PB.browse(key, year, sort, status).then(function (j) {
      if (my !== rid) return;
      $('#bres').innerHTML = j.items.length ? '<p class="note">' + j.total + ' series</p><div class="grid">' + j.items.map(tile).join('') + '</div>'
        + '<p class="note">Views are the total across the series\' episodes on YouTube. "Popular" is views per day since the first episode. On-going means a new episode was uploaded in the last 30 days. The year is the upload year.</p>'
        : errBox('Nothing matches', 'Try "All" status or a different year.');
    }, function (e) { if (my !== rid) return; $('#bres').innerHTML = errBox('Could not load this list', e.message); });
  }

  /* ---------- search ---------- */
  function searchView(q, my) {
    $('#app').innerHTML = '<h2 class="sec">Searching for “' + esc(q) + '”…</h2>' + skeleton(6);
    PB.search(q).then(function (r) {
      if (my !== rid) return;
      var h = '';
      if (r.results.length) h += '<h2 class="sec">Available here</h2><p class="note">Official channels first, then most viewed. ' + (r.hidden ? r.hidden + ' partial or repeated uploads hidden.' : 'Partial and repeated uploads are hidden.') + '</p><div class="grid">' + r.results.map(tile).join('') + '</div>';
      else h += errBox('Not found on YouTube', 'No full-episode playlist matched “' + q + '”. Try another spelling, or the original-language title.');
      $('#app').innerHTML = h;
      var t = $('.tile'); if (t && document.activeElement !== $('#q')) try { t.focus(); } catch (x) {}
    }, function (e) { if (my !== rid) return; $('#app').innerHTML = errBox('Search failed', e.message); });
  }

  /* ---------- watch ----------
     On the TV, episodes play in the "YouTube AdFree" app (webosbrew youtube-webos, app id youtube.leanback.v4):
     no ads, its own quality setting, and the remote works normally in its player. A YouTube player embedded in
     this page would show ads that ParveenBox can neither remove nor skip. Elsewhere (a computer) the embed is used. */
  var onTV = typeof window.PalmServiceBridge === 'function', bridge = null;
  function launchYouTube(v, list, done) {
    try {
      bridge = new PalmServiceBridge();          // keep a reference until the answer arrives
      bridge.onservicecallback = function (m) { done(/"returnValue":\s*true/.test(m)); };
      bridge.call('luna://com.webos.applicationManager/launch', JSON.stringify({ id: 'youtube.leanback.v4', params: { contentTarget: 'https://www.youtube.com/tv?v=' + v + (list ? '&list=' + list : '') } }));
    } catch (e) { done(false); }
  }
  var ytReady = null;
  function loadYT() {
    if (ytReady) return ytReady;
    ytReady = new Promise(function (res) {
      window.onYouTubeIframeAPIReady = function () { res(true); };
      var s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.onerror = function () { res(false); }; document.head.appendChild(s);
      setTimeout(function () { res(false); }, 10000);
    });
    return ytReady;
  }

  function watch(id, my) {
    var back = '<button class="back" id="backBtn">&larr; Back</button>';
    var bindBack = function () { var b = $('#backBtn'); if (b) b.onclick = function () { if (history.length > 1) history.back(); else location.hash = '#/'; }; };
    $('#app').innerHTML = back + skeleton(1); bindBack();
    var meta = known[id] || metas[id];
    Promise.all([meta || PB.playlist(id), PB.episodes(id)]).then(function (res) {
      if (my !== rid) return;
      var eps = res[1]; meta = res[0];
      if (!eps.length) { $('#app').innerHTML = back + errBox('No episodes', 'This playlist is empty or private.'); bindBack(); return; }
      metas[id] = extend(meta, { count: eps.length }); prog[id] = prog[id] || { w: [] }; persist();
      var idx = 0, i; for (i = 0; i < eps.length; i++) if (eps[i].v === prog[id].last) { idx = i; break; }
      var page = { id: id, my: my, meta: meta, eps: eps, idx: idx, back: back, bindBack: bindBack };
      if (onTV) tvWatch(page); else webWatch(page);
    }, function (e) { if (my !== rid) return; $('#app').innerHTML = back + errBox('Could not load this series', e.message); bindBack(); });
  }
  function epLabel(e, i) { return e.n != null ? 'Episode ' + e.n : 'Part ' + (i + 1); }
  function epList(P) {
    return P.eps.map(function (e, i) { return '<div class="ep ' + (i === P.idx ? 'cur' : '') + ' ' + (prog[P.id].w.indexOf(e.v) >= 0 ? 'seen' : '') + '" data-i="' + i + '" tabindex="0"><img loading="lazy" src="' + esc(e.th) + '" alt=""><div><div class="no">' + epLabel(e, i) + '</div><div class="tt">' + esc(e.t) + '</div></div></div>'; }).join('');
  }
  function bindEpList(P, play) {
    $('#epList').onclick = function (ev) { var d = ev.target.closest('.ep'); if (d) play(+d.getAttribute('data-i')); };
    $('#epList').onkeydown = function (ev) { if (ev.keyCode === 13) { var d = ev.target.closest('.ep'); if (d) { ev.preventDefault(); play(+d.getAttribute('data-i')); } } };
  }

  function tvWatch(P) {
    var id = P.id, eps = P.eps, i;
    /* hand YouTube the playlist only if our episode order is the playlist's own order; then AdFree plays the next episode by itself */
    var inOrder = true; for (i = 1; i < eps.length; i++) if (eps[i].pos < eps[i - 1].pos) { inOrder = false; break; }
    var resumed = !!prog[id].last;
    function render() {
      var e = eps[P.idx];
      $('#app').innerHTML = P.back + '<div class="hero"><img src="' + esc(e.th) + '" alt=""><div><h1>' + esc(P.meta.title) + '</h1><div class="sub">' + eps.length + ' episodes · ' + esc(P.meta.channel || '') + '</div>'
        + '<div class="ctl"><button class="btn pri" id="playBtn">&#9654; ' + (resumed ? 'Resume ' : 'Play ') + epLabel(e, P.idx) + '</button>' + (P.idx > 0 ? '<button class="btn" id="startBtn">Start from ' + epLabel(eps[0], 0) + '</button>' : '') + '</div>'
        + '<p class="note">Plays in YouTube AdFree: no ads, and the quality you set there. ' + (inOrder ? 'The next episode starts by itself. ' : '') + 'Press Back on the remote to return here.</p></div></div>'
        + '<div class="eps"><h3>Episodes</h3><div id="epList">' + epList(P) + '</div></div>';
      P.bindBack();
      $('#playBtn').onclick = function () { play(P.idx); };
      if ($('#startBtn')) $('#startBtn').onclick = function () { play(0); };
      bindEpList(P, play);
    }
    function play(i) {
      P.idx = Math.min(Math.max(i, 0), eps.length - 1); var e = eps[P.idx];
      prog[id].last = e.v; prog[id].at = Date.now(); if (prog[id].w.indexOf(e.v) < 0) prog[id].w.push(e.v); persist();
      resumed = true;
      launchYouTube(e.v, inOrder ? id : '', function (ok) { if (!ok) toast('Could not open YouTube AdFree. Check that it is installed.'); });
      render(); try { $('#playBtn').focus(); } catch (x) {}
    }
    render();
    try { $('#playBtn').focus(); } catch (x) {}
  }

  function webWatch(P) {
    var id = P.id, eps = P.eps, idx = P.idx;
    $('#app').innerHTML = P.back + '<div class="watch" id="wrap"><div><div class="player"><div id="yt"></div></div><h1 id="epT"></h1><div class="sub">' + esc(P.meta.title) + ' · ' + eps.length + ' episodes</div>'
      + '<div class="ctl"><button class="btn" id="prev">&#9198; Prev</button><button class="btn" id="next">Next &#9197;</button><button class="btn" id="fs">&#9974; Full screen</button><button class="btn" id="th">Theater mode</button><button class="btn" id="onyt">Open on YouTube &#8599;</button></div></div>'
      + '<div class="eps"><h3>Episodes</h3><div id="epList"></div></div></div>';
    P.bindBack();
    var draw = function () { P.idx = idx; $('#epList').innerHTML = epList(P); };
    var play = function (i, auto) {
      idx = Math.min(Math.max(i, 0), eps.length - 1); var e = eps[idx]; prog[id].last = e.v; prog[id].at = Date.now(); persist();
      $('#epT').textContent = e.t; draw();
      if (!auto) { var c = $('.ep.cur'); if (c) c.scrollIntoView(false); }
      if (player && player.loadVideoById) player.loadVideoById(e.v);
    };
    bindEpList(P, play);
    $('#prev').onclick = function () { play(idx - 1); }; $('#next').onclick = function () { play(idx + 1); };
    $('#onyt').onclick = function () { window.open('https://www.youtube.com/watch?v=' + eps[idx].v + '&list=' + id, '_blank'); };
    $('#th').onclick = function () { var w = $('#wrap'); w.classList.toggle('theater'); this.textContent = w.classList.contains('theater') ? 'Normal view' : 'Theater mode'; };
    $('#fs').onclick = function () { try { var f = player && player.getIframe ? player.getIframe() : null; var r = f && (f.requestFullscreen || f.webkitRequestFullscreen); if (r) r.call(f); else toast('Use the player’s own full-screen button.'); } catch (e) { toast('Use the player’s own full-screen button.'); } };
    $('#epT').textContent = eps[idx].t; draw();
    var cur = $('.ep.cur'); if (cur) cur.scrollIntoView(false);
    loadYT().then(function (ok) {
      if (P.my !== rid) return;
      if (!ok) { $('.player').innerHTML = '<div style="position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;color:#8b93a3">The YouTube player could not load. Check the internet connection.</div>'; return; }
      player = new YT.Player('yt', { videoId: eps[idx].v, playerVars: { rel: 0, playsinline: 1, autoplay: 1 }, events: {
        onStateChange: function (e) {
          if (e.data === YT.PlayerState.ENDED) { if (prog[id].w.indexOf(eps[idx].v) < 0) prog[id].w.push(eps[idx].v); persist(); if (idx < eps.length - 1) play(idx + 1, true); else draw(); }
        },
        onError: function (e) {
          var code = e && e.data;
          if (code === 101 || code === 150) { toast('The uploader only allows this episode on YouTube itself. Press "Open on YouTube".'); try { $('#onyt').focus(); } catch (x) {} }
          else toast('This episode cannot be played here (error ' + code + '). Press Next.');
        } } });
    });
  }

  /* ---------- TV remote: arrow keys move focus to the nearest item in that direction ---------- */
  /* the search box is left out on purpose: focusing it opens the TV keyboard, so it is only reached through the Search button */
  var FOCUSABLE = 'a[href], button, select, [tabindex="0"]';
  function visible(el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.getAttribute('tabindex') !== '-1'; }
  function moveFocus(dir) {
    var cur = document.activeElement;
    if (!cur || cur === document.body) { var f = $('.tile') || $(FOCUSABLE); if (f) f.focus(); return; }
    var a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2, bestEl = null, bestD = Infinity;
    var list = document.querySelectorAll(FOCUSABLE);
    for (var i = 0; i < list.length; i++) {
      var el = list[i]; if (el === cur || !visible(el)) continue;
      var b = el.getBoundingClientRect(), bx = b.left + b.width / 2, by = b.top + b.height / 2, dx = bx - ax, dy = by - ay, main, side;
      if (dir === 'left') { if (b.right > a.left + 1) continue; main = -dx; side = Math.abs(dy); }
      else if (dir === 'right') { if (b.left < a.right - 1) continue; main = dx; side = Math.abs(dy); }
      else if (dir === 'up') { if (b.bottom > a.top + 1) continue; main = -dy; side = Math.abs(dx); }
      else { if (b.top < a.bottom - 1) continue; main = dy; side = Math.abs(dx); }
      var d = main + side * 2.5;
      if (d < bestD) { bestD = d; bestEl = el; }
    }
    if (bestEl) {
      bestEl.focus();
      var r = bestEl.getBoundingClientRect();
      if (r.top < 70 || r.bottom > window.innerHeight) bestEl.scrollIntoView(r.top < 70);
      var row = bestEl.closest('.row'); if (row) { var rr = row.getBoundingClientRect(); if (r.left < rr.left || r.right > rr.right) row.scrollLeft += r.left - rr.left - 20; }
    }
  }
  var DIRS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };
  document.addEventListener('keydown', function (e) {
    var dir = DIRS[e.keyCode], t = e.target;
    if (!dir) return;
    if (t && t.tagName === 'INPUT') return;   // typing: leave the keys to the text box
    e.preventDefault(); moveFocus(dir);
  });

  /* ---------- routing & search box ---------- */
  function route() {
    var my = ++rid;
    if (player && player.destroy) { try { player.destroy(); } catch (e) {} player = null; }
    var h = location.hash, m;
    if ((m = h.match(/^#\/p\/([\w-]+)$/))) watch(m[1], my);
    else if ((m = h.match(/^#\/browse\/(\w+)(?:\?(.*))?$/))) { $('#q').value = ''; browseView(m[1], parseQs(m[2]), my); }
    else if ((m = h.match(/^#\/s\/(.+)$/))) { var q = decodeURIComponent(m[1]); $('#q').value = q; searchView(q, my); }
    else home(my);
    searchLabel();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  function go() { var q = $('#q').value.trim(); if (q.length >= 2) location.hash = '#/s/' + encodeURIComponent(q); else if (!q) location.hash = '#/'; }
  /* Search button -> box opens and takes focus (on the TV that brings up the keyboard); leaving the box closes it again */
  function searchLabel() { var m = location.hash.match(/^#\/s\/(.+)$/); $('#sbtn').innerHTML = '&#128269; ' + (m ? esc(decodeURIComponent(m[1])) : 'Search'); }
  function openSearch() { $('#sf').className = 'sbox open'; $('#sbtn').className = 'hide'; var q = $('#q'); q.removeAttribute('tabindex'); try { q.focus(); q.select(); } catch (x) {} }
  function closeSearch() { if (document.activeElement === $('#q')) return; $('#sf').className = 'sbox'; $('#sbtn').className = ''; $('#q').setAttribute('tabindex', '-1'); }
  $('#sbtn').onclick = openSearch;
  $('#q').addEventListener('blur', function () { setTimeout(closeSearch, 250); });   // the delay lets a click on the search icon go through first
  $('#sf').addEventListener('submit', function (e) {
    e.preventDefault(); go();
    try { $('#q').blur(); } catch (x) {}
    closeSearch();
    setTimeout(function () { if (!$('.tile')) try { $('#sbtn').focus(); } catch (x) {} }, 300);
  });
  /* on a computer, search after a pause in typing; on the TV only when you press Enter / the search key (each search costs quota) */
  var dt; if (!onTV) $('#q').addEventListener('input', function () { clearTimeout(dt); dt = setTimeout(function () { var q = $('#q').value.trim(); if (q.length >= 3) go(); else if (!q && location.hash.indexOf('#/s/') === 0) location.hash = '#/'; }, 1500); });
  if (!PB.hasKey) { $('#app').innerHTML = errBox('Missing YouTube key', 'This copy was built without YOUTUBE_API_KEY. Put it in the .env file and run the build again.'); return; }
  route();
})();
