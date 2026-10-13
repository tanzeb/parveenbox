/* ParveenBox data layer: runs in the browser, talks to the YouTube Data API directly.
   Ported from the old server.js. Plain ES5 + Promise + XMLHttpRequest so it runs on older TV Chromium
   (no arrow functions, let/const, async/await, template strings, ?. or ??).
   PB.trending()                          : most-viewed recent playlists per section (front page)
   PB.browse(section, year, sort, status) : full list for a section, sorted + filtered
   PB.search(q)                           : typo-tolerant search, official channels first, duplicates removed
   PB.episodes(id)                        : all episodes of a playlist, in order
   PB.playlist(id)                        : one playlist's details
   Results are cached in localStorage, so reopening the app costs no quota.                       */
(function () {
  'use strict';
  var KEY = (window.PB_CONFIG && window.PB_CONFIG.youtubeKey) || '';
  var H = 36e5, DAY = 864e5, CP = 'pbc1:';   // CP: cache prefix, bump to drop every cached entry

  function fail(msg, fatal) { var e = new Error(msg); e.fatal = !!fatal; return e; }
  function extend(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }
  function values(map) { var out = [], k; for (k in map) out.push(map[k]); return out; }

  /* ---------- promise helpers ---------- */
  function settle(ps) {
    return Promise.all(ps.map(function (p) {
      return Promise.resolve(p).then(function (v) { return { ok: true, v: v }; }, function (e) { return { ok: false, e: e }; });
    }));
  }
  function mapLimit(items, n, fn) {
    return new Promise(function (res, rej) {
      var out = new Array(items.length), i = 0, done = 0, active = 0, dead = false;
      if (!items.length) return res(out);
      function next() {
        while (!dead && active < n && i < items.length) (function (k) {
          active++;
          Promise.resolve().then(function () { return fn(items[k]); }).then(function (v) {
            out[k] = v; active--; done++;
            if (done === items.length) res(out); else next();
          }, function (e) { dead = true; rej(e); });
        })(i++);
      }
      next();
    });
  }

  /* ---------- cache: in-flight de-duplication in memory + TTL copy in localStorage ---------- */
  var mem = {};
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function lsPut(k, v) {
    var s = JSON.stringify(v);
    for (var tries = 0; tries < 6; tries++) {
      try { localStorage.setItem(k, s); return; } catch (e) { if (!evictOldest()) return; }
    }
  }
  /* storage full: drop the oldest quarter of cached API results (never the watch progress) */
  function evictOldest() {
    var list = [], i, k, o;
    try {
      for (i = 0; i < localStorage.length; i++) {
        k = localStorage.key(i);
        if (k && k.indexOf('pbc') === 0) { o = lsGet(k); list.push({ k: k, t: (o && o.t) || 0 }); }
      }
      if (!list.length) return false;
      list.sort(function (a, b) { return a.t - b.t; });
      for (i = 0; i < Math.max(1, Math.ceil(list.length / 4)); i++) localStorage.removeItem(list[i].k);
      return true;
    } catch (e) { return false; }
  }
  function cached(key, ttl, fn, memOnly) {
    var now = Date.now(), m = mem[key], s;
    if (m && now - m.t < ttl) return m.p;
    if (!memOnly) {
      s = lsGet(CP + key);
      if (s && now - s.t < ttl) { mem[key] = { t: s.t, p: Promise.resolve(s.v) }; return mem[key].p; }
    }
    var p = Promise.resolve().then(fn).then(function (v) { if (!memOnly) lsPut(CP + key, { t: now, v: v }); return v; });
    mem[key] = { t: now, p: p };
    p.then(null, function () { if (mem[key] && mem[key].p === p) delete mem[key]; });
    return p;
  }
  function clearCache() {
    mem = {};
    try { for (var i = localStorage.length - 1; i >= 0; i--) { var k = localStorage.key(i); if (k && k.indexOf('pbc') === 0) localStorage.removeItem(k); } } catch (e) {}
  }

  /* ---------- text helpers ---------- */
  function dec(s) { return String(s || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }
  function norm(s) {
    s = String(s || '').toLowerCase();
    if (s.normalize) s = s.normalize('NFKD');
    return s.replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9؀-ۿऀ-ॿ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function skel(s) { return s.replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1'); }
  function lev(a, b) {
    if (a === b) return 0; var m = a.length, n = b.length, i, j, p = [], c; if (!m) return n; if (!n) return m;
    for (j = 0; j <= n; j++) p[j] = j;
    for (i = 1; i <= m; i++) { c = [i]; for (j = 1; j <= n; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1)); p = c; }
    return p[n];
  }
  var STOP = {}; 'the a of full episode episodes drama dramas serial series web season hd new latest all complete urdu hindi pakistani official ep'.split(' ').forEach(function (w) { STOP[w] = 1; });
  function words(s) { return norm(s).split(' ').filter(Boolean); }
  function tokMatch(q, t) {
    if (q === t) return true;
    if (q.length >= 4 && (t.indexOf(q) === 0 || (t.length >= 4 && q.indexOf(t) === 0))) return true;
    if (lev(q, t) <= (q.length >= 7 ? 2 : q.length >= 4 ? 1 : 0)) return true;          // typos
    var a = skel(q), b = skel(t); return a.length >= 3 && a === b;                    // transliteration: kinare ~ kinaray
  }
  function sim(query, title) {
    var qt = words(query), c = qt.filter(function (w) { return !STOP[w]; }); if (c.length) qt = c;
    var tt = words(title);
    if (!qt.length || !tt.length) return 0;
    return qt.filter(function (q) { return tt.some(function (t) { return tokMatch(q, t); }); }).length / qt.length;
  }
  var NOISE = /\b(ost|songs?|scenes?|promos?|teasers?|clips?|status|reactions?|bts|behind the scenes|trailers?|shorts|compilation|funny|memes?|making)\b/i;
  /* browse + front page are Hindi/Urdu only: drop titles that announce another language */
  var OTHER_LANG = /\b(tamil|telugu|malayalam|kannada|bengali|bangla|punjabi|marathi|gujarati|korean|k-?drama|chinese|c-?drama|turkish|english|spanish|thai|indonesian|arabic)\b/i;

  /* ---------- YouTube ---------- */
  function yt(ep, params) {
    if (!KEY) return Promise.reject(fail('This copy of ParveenBox has no YouTube API key. Rebuild it with YOUTUBE_API_KEY in the .env file.', true));
    var q = [], k;
    params.key = KEY;
    for (k in params) if (params[k] !== undefined && params[k] !== '' && params[k] !== null) q.push(k + '=' + encodeURIComponent(params[k]));
    var url = 'https://www.googleapis.com/youtube/v3/' + ep + '?' + q.join('&');
    return new Promise(function (res, rej) {
      var x = new XMLHttpRequest();
      x.open('GET', url, true);
      x.timeout = 20000;
      x.onload = function () {
        var j = null; try { j = JSON.parse(x.responseText); } catch (e) {}
        if (x.status >= 200 && x.status < 300 && j) return res(j);
        rej(apiError(x.status, j));
      };
      x.onerror = function () { rej(fail('Network error. Check the TV\'s internet connection.')); };
      x.ontimeout = function () { rej(fail('YouTube took too long to answer. Try again.')); };
      x.send();
    });
  }
  function apiError(status, j) {
    var e = (j && j.error) || {}, reason = (e.errors && e.errors[0] && e.errors[0].reason) || '', msg = e.message || 'YouTube API error';
    if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded/.test(reason))
      return fail('Today\'s free YouTube quota is used up. It resets at midnight US Pacific time (about 12:30 to 1:30 pm in India). Things you already opened still work.', true);
    if (status === 400 && /keyInvalid|badRequest/.test(reason) && /key/i.test(msg)) return fail('The YouTube API key is not valid.', true);
    if (status === 403) return fail('YouTube refused the request: ' + msg + ' (check the API key restrictions in Google Cloud).', true);
    return fail(msg, false);
  }
  function thumb(t) { t = t || {}; return (t.high || t.medium || t.standard || t.default || {}).url || ''; }
  function iso(ms) { return new Date(ms).toISOString(); }
  function playlistInfo(ids) {
    if (!ids.length) return Promise.resolve([]);
    return yt('playlists', { part: 'snippet,contentDetails', id: ids.slice(0, 50).join(','), maxResults: 50 }).then(function (j) {
      return (j.items || []).map(function (p) {
        return { id: p.id, title: dec(p.snippet.title), channel: dec(p.snippet.channelTitle), channelId: p.snippet.channelId, thumb: thumb(p.snippet.thumbnails), count: p.contentDetails.itemCount, created: Date.parse(p.snippet.publishedAt) || null };
      });
    });
  }
  function playlistSearch(q, o) {
    o = o || {};
    return yt('search', { part: 'snippet', type: 'playlist', q: q, maxResults: o.max || 25, order: o.order || 'relevance', regionCode: o.region, relevanceLanguage: o.lang, publishedAfter: o.after, publishedBefore: o.before })
      .then(function (s) { return playlistInfo((s.items || []).map(function (i) { return i.id && i.id.playlistId; }).filter(Boolean)); });
  }

  /* ---------- official channels ---------- */
  var OFFICIAL = /(hum tv|hum network|ary digital|ary zindagi|geo entertainment|geo tv|har pal geo|green entertainment|express entertainment|a-?plus|tv one|ptv|7th sky|urdu ?1|zee tv|zee5|zee entertainment|star plus|star bharat|star utsav|jio ?hotstar|disney\+? ?hotstar|hotstar|sony ?(liv|sab|entertainment|tv)|sab tv|colors tv|dangal|shemaroo|alt ?balaji|mx player|ullu|sun neo|(^|\s)(&tv|and ?tv)(\s|$))/i;
  var CH_KEY = 'pbc_ch', CH_TTL = 7 * DAY;
  function channelInfo(ids) {
    var store = lsGet(CH_KEY) || {}, now = Date.now(), need = [], seen = {}, batches = [], i;
    ids.forEach(function (id) { if (id && !seen[id] && !(store[id] && now - store[id].t < CH_TTL)) { seen[id] = 1; need.push(id); } });
    for (i = 0; i < need.length; i += 50) batches.push(need.slice(i, i + 50));
    return Promise.all(batches.map(function (b) {
      return yt('channels', { part: 'snippet,statistics', id: b.join(','), maxResults: 50 }).then(function (j) {
        (j.items || []).forEach(function (c) {
          var st = c.statistics || {};
          store[c.id] = { t: now, title: dec(c.snippet.title), subs: st.hiddenSubscriberCount ? 0 : Number(st.subscriberCount) || 0 };
        });
      }, function (e) { if (e.fatal) throw e; });
    })).then(function () {
      lsPut(CH_KEY, store);
      return function (id) { return store[id] || { title: '', subs: 0 }; };
    });
  }
  /* official = a known broadcaster / streaming service, or a very large channel */
  function isOfficial(name, ch) { return OFFICIAL.test(String(name || '') + ' ' + ch.title) || ch.subs >= 3e6; }
  function titleKey(t) { return norm(t).replace(/\b(full|episodes?|epi|ep|all|complete|hd|drama|serial|series|official|new|season \d+)\b/g, ' ').replace(/\s+/g, ' ').trim(); }

  /* ---------- sections (Hindi + Urdu only) ---------- */
  var SECTIONS = {
    pk: { title: 'Pakistani dramas', minEps: 8, region: 'PK', lang: 'ur', queries: ['Pakistani drama serial full episodes', 'Urdu drama all episodes HD'] },
    hi: { title: 'Hindi TV serials', minEps: 10, region: 'IN', lang: 'hi', queries: ['Hindi TV serial full episodes', 'Indian TV serial all episodes Hindi'] },
    web: { title: 'Hindi web series', minEps: 4, region: 'IN', lang: 'hi', queries: ['Hindi web series full episodes', 'web series all episodes Hindi season'] }
  };
  var SEC_KEYS = ['pk', 'hi', 'web'];
  function eligible(p, sec) { return p.count >= sec.minEps && p.count <= 2500 && !NOISE.test(p.title) && !OTHER_LANG.test(p.title); }

  /* run every query of a section, keep eligible playlists once each, in query order */
  function sectionPool(sec, opts) {
    return settle(sec.queries.map(function (q) { return playlistSearch(q, extend(opts, { region: sec.region, lang: sec.lang })); })).then(function (rs) {
      var seen = {}, list = [], err = null;
      rs.forEach(function (r) {
        if (!r.ok) { err = r.e; return; }
        r.v.forEach(function (p) { if (eligible(p, sec) && !seen[p.id]) { seen[p.id] = 1; list.push(p); } });
      });
      if (!list.length && err) throw err;
      return list;
    });
  }

  /* ---------- front page: most viewed right now ---------- */
  function trending() {
    return cached('trending', 12 * H, function () {
      var after = iso(Date.now() - 730 * DAY);                       // last ~2 years
      return settle(SEC_KEYS.map(function (key) { return sectionPool(SECTIONS[key], { order: 'viewCount', after: after, max: 25 }); })).then(function (rs) {
        var out = [], err = null;
        rs.forEach(function (r, i) {
          if (!r.ok) { err = r.e; return; }
          if (r.v.length) out.push({ key: SEC_KEYS[i], title: SECTIONS[SEC_KEYS[i]].title, items: r.v.slice(0, 20) });
        });
        if (!out.length && err) throw err;
        return out;
      });
    });
  }

  /* ---------- browse: whole section, with real view counts and dates ---------- */
  function enrich(p) {
    return cached('en:' + p.id, 12 * H, function () {
      var ids = [], dates = [];
      function page(tok, n) {
        return yt('playlistItems', { part: 'contentDetails', maxResults: 50, playlistId: p.id, pageToken: tok }).then(function (j) {
          (j.items || []).forEach(function (i) {
            var c = i.contentDetails || {}, d;
            if (c.videoId) { ids.push(c.videoId); d = Date.parse(c.videoPublishedAt); if (d) dates.push(d); }
          });
          if (j.nextPageToken && n < 6) return page(j.nextPageToken, n + 1);   // up to 300 episodes per series
        });
      }
      return page(undefined, 1).then(function () {
        var batches = [], k;
        for (k = 0; k < ids.length; k += 50) batches.push(ids.slice(k, k + 50));
        return Promise.all(batches.map(function (b) { return yt('videos', { part: 'statistics', id: b.join(',') }); }));
      }).then(function (vs) {
        var views = 0;
        vs.forEach(function (v) { (v.items || []).forEach(function (it) { views += Number(it.statistics && it.statistics.viewCount) || 0; }); });
        return extend(p, { views: views, first: dates.length ? Math.min.apply(null, dates) : null, last: dates.length ? Math.max.apply(null, dates) : null });
      });
    }, true).then(null, function (e) { if (e.fatal) throw e; return null; });   // quota problems surface; one bad playlist is skipped
  }
  function yearOf(ms) { return ms ? new Date(ms).getUTCFullYear() : null; }

  function browseSection(key, year) {
    return cached('browse:' + key + ':' + (year || 0), 12 * H, function () {
      var opts = { order: 'viewCount', max: 50 };
      if (year) { opts.after = year + '-01-01T00:00:00Z'; opts.before = (year + 1) + '-01-01T00:00:00Z'; }
      return sectionPool(SECTIONS[key], opts).then(function (list) {
        return mapLimit(list.slice(0, 45), 6, enrich);
      }).then(function (rich) {
        return rich.filter(function (p) { return p && (!year || yearOf(p.first) === year || yearOf(p.created) === year); })
          .map(function (p) { return extend(p, { section: key }); });
      });
    });
  }
  function withStatus(p, now) { return extend(p, { status: p.last && now - p.last < 30 * DAY ? 'ongoing' : 'completed' }); }

  var SORTS = { newest: 1, oldest: 1, views: 1, popular: 1 }, STATUSES = { all: 1, completed: 1, ongoing: 1 };
  function browse(section, year, sort, status) {
    if (section !== 'all' && !SECTIONS[section]) section = 'all';
    if (!SORTS[sort]) sort = 'views';
    if (!STATUSES[status]) status = 'all';
    year = parseInt(year, 10) || 0;
    if (year && (year < 2005 || year > new Date().getUTCFullYear())) year = 0;
    var keys = section === 'all' ? SEC_KEYS : [section];
    return settle(keys.map(function (k) { return browseSection(k, year); })).then(function (rs) {
      var seen = {}, items = [], now = Date.now(), firstErr = null, any = false;
      rs.forEach(function (r) {
        if (!r.ok) { firstErr = firstErr || r.e; return; }
        any = true;
        r.v.forEach(function (p) { if (!seen[p.id]) { seen[p.id] = 1; items.push(withStatus(p, now)); } });
      });
      if (!any) throw firstErr;
      if (status !== 'all') items = items.filter(function (p) { return p.status === status; });
      function perDay(p) { return p.views / Math.max(30, (now - (p.first || now)) / DAY); }   // "popular" = views per day since release
      var by = {
        newest: function (a, b) { return (b.first || 0) - (a.first || 0); },
        oldest: function (a, b) { return (a.first || 1e15) - (b.first || 1e15); },
        views: function (a, b) { return b.views - a.views; },
        popular: function (a, b) { return perDay(b) - perDay(a); }
      };
      items.sort(by[sort]);
      return { section: section, title: section === 'all' ? 'All Hindi & Urdu' : SECTIONS[section].title, year: year || null, sort: sort, status: status, total: items.length, items: items };
    });
  }

  /* ---------- search ---------- */
  function search(q) {
    q = String(q || '').trim().slice(0, 120);
    if (q.length < 2) return Promise.reject(fail('Type at least 2 characters.'));
    return cached('search:' + norm(q), 6 * H, function () {
      var noisy = NOISE.test(q), pool = {}, order = [];
      function add(p) { if (!pool[p.id]) { pool[p.id] = p; order.push(p.id); } }
      /* titles already on the front page that match well */
      var fromFront = trending().then(function (secs) {
        secs.forEach(function (s) { s.items.forEach(function (p) { if (sim(q, p.title) >= 0.7) add(p); }); });
      }, function () {});
      var fromSearch = fromFront.then(function () { return playlistSearch(q + ' full episodes', { max: 15 }); });
      return settle([fromSearch]).then(function (rs) {
        if (rs[0].ok) rs[0].v.forEach(add);
        else if (!order.length) throw rs[0].e;
        var cand = order.map(function (id) { var p = pool[id]; return extend(p, { score: +sim(q, p.title).toFixed(2) }); })
          .filter(function (p) { return p.score >= 0.6 && p.count >= 3 && (noisy || !NOISE.test(p.title)); })
          .sort(function (a, b) { return b.score - a.score || b.count - a.count; }).slice(0, 20);
        var best = cand[0] ? cand[0].score : 0, found = cand.length;
        /* only keep real matches for the title, then look at each one properly */
        cand = cand.filter(function (p) { return p.score >= Math.max(0.6, best - 0.2); });
        return mapLimit(cand, 6, enrich).then(function (rich) {
          rich = rich.filter(Boolean);
          return channelInfo(rich.map(function (p) { return p.channelId; })).then(function (chOf) {
            rich = rich.map(function (p) { var ch = chOf(p.channelId); return extend(p, { subs: ch.subs, official: isOfficial(p.channel, ch) }); });
            /* 1. same channel + same title uploaded twice: keep the one with most views */
            var byKey = {};
            rich.forEach(function (p) {
              var k = p.channelId + '|' + titleKey(p.title), o = byKey[k];
              if (!o || p.views > o.views || (p.views === o.views && p.count > o.count)) byKey[k] = p;
            });
            rich = values(byKey);
            /* 1b. other channels' playlists of the very same videos (same episode count and same total views) */
            var bySet = {};
            rich.forEach(function (p) { var k = p.count + '|' + p.views, o = bySet[k]; if (!p.views || !o || (p.official && !o.official)) bySet[k + (p.views ? '' : '|' + p.id)] = p; });
            rich = values(bySet);
            /* 2. partial uploads: hide playlists with far fewer episodes than the fullest one */
            var maxCount = 0; rich.forEach(function (p) { if (p.count > maxCount) maxCount = p.count; });
            rich = rich.filter(function (p) { return p.count >= Math.max(3, maxCount * 0.5); });
            /* 3. official channels first, then by views */
            var now = Date.now();
            rich = rich.map(function (p) { return withStatus(p, now); })
              .sort(function (a, b) { return (b.official - a.official) || b.views - a.views; }).slice(0, 10);
            return { query: q, results: rich, best: best, hidden: Math.max(0, found - rich.length) };
          });
        });
      });
    });
  }

  /* ---------- episodes ---------- */
  function episodes(id) {
    return cached('ep:' + id, 3 * H, function () {
      var items = [];
      function page(tok) {
        return yt('playlistItems', { part: 'snippet', maxResults: 50, playlistId: id, pageToken: tok }).then(function (j) {
          (j.items || []).forEach(function (i) {
            var s = i.snippet;
            if (/^(private|deleted) video$/i.test(s.title)) return;
            items.push({ v: s.resourceId.videoId, t: dec(s.title), th: thumb(s.thumbnails), pos: s.position });
          });
          if (j.nextPageToken && items.length < 1000) return page(j.nextPageToken);
        });
      }
      return page(undefined).then(function () {
        items.forEach(function (e) { var m = e.t.match(/\b(?:episode|epi|ep|e)\s*[-.#:]?\s*0*(\d{1,4})\b/i); e.n = m ? +m[1] : null; });
        var withN = items.filter(function (e) { return e.n != null; }), nums = {}, distinct = 0;
        withN.forEach(function (e) { if (!nums[e.n]) { nums[e.n] = 1; distinct++; } });
        if (items.length && withN.length >= items.length * 0.7 && distinct >= withN.length * 0.8)
          items.sort(function (a, b) { return (a.n == null ? 1e9 : a.n) - (b.n == null ? 1e9 : b.n) || a.pos - b.pos; });
        return items;
      });
    });
  }

  function okId(id) { return /^[\w-]{10,60}$/.test(id || ''); }
  function playlist(id) {
    if (!okId(id)) return Promise.reject(fail('Bad playlist id.'));
    return cached('pl:' + id, 24 * H, function () {
      return playlistInfo([id]).then(function (r) { if (!r[0]) throw fail('Playlist not found or private.'); return r[0]; });
    });
  }

  window.PB = {
    hasKey: !!KEY, sections: SECTIONS, trending: trending, browse: browse, search: search,
    episodes: function (id) { return okId(id) ? episodes(id) : Promise.reject(fail('Bad playlist id.')); },
    playlist: playlist, clearCache: clearCache, sim: sim, norm: norm
  };
})();
