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
  var REGION = (window.PB_CONFIG && window.PB_CONFIG.region) || 'IN';   // the viewer's country, for blocked videos
  var H = 36e5, DAY = 864e5, CP = 'pbc4:';   // CP: cache prefix, bump to drop every cached entry

  function fail(msg, fatal) { var e = new Error(msg); e.fatal = !!fatal; return e; }
  function extend(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }

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
        if (k && k.indexOf('pbc') === 0) { o = lsGet(k); list.push({ k: k, t: (o && o.t) || 0 }); }   /* old prefixes go first */
      }
      if (!list.length) return false;
      list.sort(function (a, b) { return a.t - b.t; });
      for (i = 0; i < Math.max(1, Math.ceil(list.length / 4)); i++) localStorage.removeItem(list[i].k);
      return true;
    } catch (e) { return false; }
  }
  var staleListener = null;
  function cached(key, ttl, fn, memOnly, force) {
    var now = Date.now(), m = mem[key], s = null;
    if (!force && m && now - m.t < ttl) return m.p;
    if (!memOnly) {
      s = lsGet(CP + key);
      if (!force && s && now - s.t < ttl) { mem[key] = { t: s.t, p: Promise.resolve(s.v) }; return mem[key].p; }
    }
    var p = Promise.resolve().then(fn).then(function (v) { if (!memOnly) lsPut(CP + key, { t: now, v: v }); return v; }, function (e) {
      /* the daily YouTube limit is used up, or no internet: show what was saved before instead of an error */
      if (s && s.v != null) { if (staleListener) staleListener(e, s.t); return s.v; }
      throw e;
    });
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
  /* true when the title contains the query's words next to each other, in order ("Kabhi Main Kabhi Tum"),
     not just scattered somewhere in a long song title */
  function phrase(query, title) {
    var qt = words(query), tt = words(title), i, j;
    if (!qt.length) return false;
    for (i = 0; i + qt.length <= tt.length; i++) {
      for (j = 0; j < qt.length && tokMatch(qt[j], tt[i + j]); j++) {}
      if (j === qt.length) return true;
    }
    return false;
  }
  var NOISE = /\b(ost|osts|sound ?tracks?|songs?|title (song|track)|lyrics?|lyrical|music|audio|naat|naats|qawwali|scenes?|promos?|teasers?|trailers?|clips?|status|reactions?|reviews?|recaps?|explained|bts|behind the scenes|shorts|compilation|funny|memes?|making|highlights?|best moments|interviews?|podcasts?|talk show|morning show|game show|comedy show|news|cooking|recipes?|jeeto pakistan|ramzan|transmission|live stream|bloopers?|mashup|whatsapp|tiktok|fan ?made|then and now|real life|top \d+|ringtones?)\b/i;
  /* browse + front page are Hindi/Urdu only: drop titles that announce another language */
  /* Pakistani dramas only: drop titles that announce something else ("English subtitles" is fine) */
  var OTHER_LANG = /\b(hindi|india|indian|turk|osman|ertugrul|dizi(leri)?|star ?plus|zee ?tv|zee5|colors tv|sony (tv|sab|liv)|sab tv|star bharat|dangal|tamil|telugu|malayalam|kannada|bengali|bangla|marathi|gujarati|korean|k-?drama|chinese|c-?drama|turkish|dubbed|spanish|thai|indonesian|arabic)\b/i;

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
  function playlists(params) {
    return yt('playlists', extend({ part: 'snippet,contentDetails', maxResults: 50 }, params)).then(function (j) {
      return (j.items || []).map(function (p) {
        return { id: p.id, title: dec(p.snippet.title), channel: dec(p.snippet.channelTitle), channelId: p.snippet.channelId, thumb: thumb(p.snippet.thumbnails), count: p.contentDetails.itemCount, created: Date.parse(p.snippet.publishedAt) || null };
      });
    });
  }
  function playlistInfo(ids) { return ids.length ? playlists({ id: ids.slice(0, 50).join(',') }) : Promise.resolve([]); }
  function playlistSearch(q, o) {
    o = o || {};
    return yt('search', { part: 'snippet', type: 'playlist', q: q, maxResults: o.max || 25, order: o.order || 'relevance', regionCode: o.region, relevanceLanguage: o.lang, publishedAfter: o.after, publishedBefore: o.before })
      .then(function (s) { return playlistInfo((s.items || []).map(function (i) { return i.id && i.id.playlistId; }).filter(Boolean)); });
  }

  /* ---------- official channels ---------- */
  var OFFICIAL = /(hum tv|hum network|ary digital|ary zindagi|geo entertainment|geo tv|har pal geo|green entertainment|express entertainment|a-?plus|tv one|ptv|7th sky|urdu ?1|zee tv|zee5|zee entertainment|star plus|star bharat|star utsav|jio ?hotstar|disney\+? ?hotstar|hotstar|sony ?(liv|sab|entertainment|tv)|sab tv|colors tv|dangal|shemaroo|alt ?balaji|mx player|ullu|sun neo|(^|\s)(&tv|and ?tv)(\s|$))/i;
  var CH_KEY = 'pb_channels', CH_TTL = 7 * DAY;   // not under the 'pbc' prefix, so a full cache never evicts it
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

  /* ---------- sections (Hindi + Urdu only) ---------- */
  var SECTIONS = {
    pk: { title: 'Pakistani dramas', minEps: 8, region: 'PK', lang: 'ur', queries: ['Pakistani drama serial full episodes', 'Urdu drama all episodes HD'] }
  };
  var SEC_KEYS = ['pk'];
  /* over 400 episodes is an Indian daily soap, not a Pakistani serial */
  function eligible(p, sec) { return p.count >= sec.minEps && p.count <= 400 && !NOISE.test(p.title) && !OTHER_LANG.test(p.title + ' ' + p.channel); }

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
    return cached('trending', 24 * H, function () {
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

  /* ---------- most watched this month ----------
     This month's most-viewed Pakistani drama episodes (one video search + their view counts), added up per drama and
     matched to the drama's playlist on the same channel (that channel's newest 50 playlists, 1 unit each: new dramas
     with only a few episodes are found too). Official Pakistani channels are often blocked in the viewer's country,
     so each drama then plays from the best upload that is not (see playable). Saved for a day: about 110 quota units,
     plus a search (about 130 units, saved two weeks) for each drama whose official playlist is blocked. */
  /* "Hurmat" = "Hurmat हुरमत", but not "Mohabbat Dagh Ki Soorat" for "Mohabbat": the words must match both ways
     (Hindi/Urdu script is left out, many uploads add the name in it) */
  function sameDrama(name, title) {
    var t = showTitle(title).replace(/[^\x00-\x7f]+/g, ' ');
    return sim(name, t) >= 0.8 && sim(t, name) >= 0.8;
  }
  function playable(name, official) {
    return (official ? enrich(official) : Promise.resolve(null)).then(function (p) {
      if (p && p.blocked <= 0.5) return p;
      return search(name).then(function (r) {
        var now = Date.now(), cands = [];
        r.groups.forEach(function (g) {
          if (!sameDrama(name, g.title)) return;
          /* on air this month, so a real copy has new episodes; nearly every episode must play here. Items come
             sorted playable, official, most viewed */
          cands = cands.concat(g.items.filter(function (x) {
            return sameDrama(name, x.title) && x.blocked <= 0.1 && x.last && now - x.last < 60 * DAY
              && (!official || x.count <= official.count * 1.5 + 2);   // far more episodes than the original: another drama, or clips
          }));
        });
        return firstWithEpisodes(cands);
      }, function (e) { if (e.fatal) throw e; return null; });
    });
  }
  /* a copy of a drama, not a playlist of clips, promos or reviews under its name: at least half the videos are
     numbered episodes that are not promos, teasers, reviews... */
  function firstWithEpisodes(list) {
    if (!list.length) return Promise.resolve(null);
    return episodes(list[0].id).then(function (eps) {
      var n = eps.filter(function (e) { return e.n != null && !NOISE.test(e.t); }).length;
      return eps.length && n >= eps.length / 2 ? list[0] : firstWithEpisodes(list.slice(1));
    }, function (e) { if (e.fatal) throw e; return firstWithEpisodes(list.slice(1)); });
  }
  function monthly() {
    return cached('monthly2', 24 * H, function () {
      var after = iso(Date.now() - 30 * DAY);
      return yt('search', { part: 'snippet', type: 'video', q: 'Pakistani drama episode', order: 'viewCount', publishedAfter: after, maxResults: 50, regionCode: 'PK', relevanceLanguage: 'ur' }).then(function (s) {
        var items = (s.items || []).filter(function (it) { return it.id && it.id.videoId && it.snippet; }), chs = [];
        items.forEach(function (it) { if (chs.indexOf(it.snippet.channelId) < 0) chs.push(it.snippet.channelId); });
        return Promise.all([items, settle(chs.slice(0, 10).map(function (id) { return playlists({ channelId: id }); }))]);
      }).then(function (r) {
        var items = r[0], lists = [];
        r[1].forEach(function (x) { if (x.ok) lists = lists.concat(x.v.filter(function (p) { return eligible(p, { minEps: 1 }); })); });
        if (!items.length) return [];
        return yt('videos', { part: 'statistics', id: items.map(function (it) { return it.id.videoId; }).join(','), maxResults: 50 }).then(function (vs) {
          var views = {}; (vs.items || []).forEach(function (v) { views[v.id] = Number(v.statistics && v.statistics.viewCount) || 0; });
          var shows = {}, order = [];
          items.forEach(function (it) {
            var t = dec(it.snippet.title), ch = dec(it.snippet.channelTitle);
            if (NOISE.test(t) || OTHER_LANG.test(t + ' ' + ch)) return;
            /* "Tapish Mega Last Episode 35" -> "Tapish" */
            var name = showTitle(t).replace(/\b(episode|epi|ep)\b.*$/i, '').replace(/(\s+(mega|last|final|first|\d+(st|nd|rd|th)))+\s*$/i, '').replace(/[\s:,-]+$/, '').trim();
            if (name.length < 2) return;
            var k = ch + '|' + norm(name);
            if (!shows[k]) { shows[k] = { name: name, channel: ch, views: 0 }; order.push(k); }
            shows[k].views += views[it.id.videoId] || 0;
          });
          var top = order.map(function (k) { return shows[k]; }).sort(function (a, b) { return b.views - a.views; }).slice(0, 20);
          return mapLimit(top, 3, function (sh) {
            var best = null, bestScore = 0;
            lists.forEach(function (p) {
              if (p.channel !== sh.channel) return;
              var sc = Math.min(sim(sh.name, p.title), sim(showTitle(p.title), sh.name));
              if (sc > bestScore) { bestScore = sc; best = p; }
            });
            return playable(sh.name, bestScore >= 0.8 ? best : null);
          }).then(function (picks) {
            var seen = {}, out = [];
            picks.forEach(function (p, i) { if (p && !seen[p.id]) { seen[p.id] = 1; out.push(extend(p, { monthViews: top[i].views })); } });
            return out;
          });
        });
      });
    });
  }

  /* ---------- browse: whole section, with real view counts and dates ---------- */
  function enrich(p) {
    return cached('en:' + p.id, 7 * DAY, function () {
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
        return Promise.all(batches.map(function (b) { return yt('videos', { part: 'statistics,contentDetails', id: b.join(',') }); }));
      }).then(function (vs) {
        var views = 0;
        var total = 0, blocked = 0;
        vs.forEach(function (v) {
          (v.items || []).forEach(function (it) {
            var rr = it.contentDetails && it.contentDetails.regionRestriction;
            views += Number(it.statistics && it.statistics.viewCount) || 0; total++;
            if (rr && ((rr.blocked && rr.blocked.indexOf(REGION) >= 0) || (rr.allowed && rr.allowed.indexOf(REGION) < 0))) blocked++;
          });
        });
        /* blocked: share of episodes YouTube will not play in the viewer's country (e.g. Pakistani channels in India) */
        return extend(p, { views: views, blocked: total ? blocked / total : 0, first: dates.length ? Math.min.apply(null, dates) : null, last: dates.length ? Math.max.apply(null, dates) : null });
      });
    }, true).then(null, function (e) { if (e.fatal) throw e; return null; });   // quota problems surface; one bad playlist is skipped
  }
  function yearOf(ms) { return ms ? new Date(ms).getUTCFullYear() : null; }

  function browseSection(key, year) {
    return cached('browse:' + key + ':' + (year || 0), 7 * DAY, function () {
      var opts = { order: 'viewCount', max: 50 };
      if (year) { opts.after = year + '-01-01T00:00:00Z'; opts.before = (year + 1) + '-01-01T00:00:00Z'; }
      return sectionPool(SECTIONS[key], opts).then(function (list) {
        return mapLimit(list.slice(0, 45), 6, enrich);
      }).then(function (rich) {
        return rich.filter(function (p) { return p && p.blocked <= 0.5 && (!year || yearOf(p.first) === year || yearOf(p.created) === year); })
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
  /* Nothing is hidden: every matching upload is listed so you can choose. Exact title matches come first,
     then official channels, then most viewed. Re-uploads and partial uploads get a label instead of being removed. */
  /* ---------- search: dramas only, one group per drama, the original upload first ----------
     One YouTube search (100 quota units) for "<title> drama". Only real drama playlists are kept: at least 4 videos,
     the typed title must match (spelling mistakes allowed), and songs, OST, scenes, promos, clips and non-Pakistani
     titles are left out. Uploads of the same drama are grouped; the original (official channel, then most views)
     comes first and the other uploads follow, labelled, so you can still choose. Saved for two weeks. */
  var FILLER = /\b(full|episodes?|epi|ep|all|complete|hd|4k|drama|dramas|serial|series|official|new|latest|season|part|pakistani|urdu|presented by|digitally|powered by|watch|online|free|only on|exclusive|last|\d+)\b/g;
  function titleKey(title, channel) {
    var k = norm(title).replace(FILLER, ' ');
    words(channel).forEach(function (w) { if (w.length > 2) k = k.replace(new RegExp('\\b' + w + '\\b', 'g'), ' '); });
    k = k.replace(/\b(hum|tv|ary|digital|geo|har|pal|green|entertainment|express|ptv|aplus|plus|one|network|by|on|with|and|the|ft|feat)\b/g, ' ');
    return k.replace(/\s+/g, ' ').trim();
  }
  function sameShow(a, b) {
    if (!a || !b) return a === b;
    if (a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return true;
    return sim(a, b) >= 0.85 && sim(b, a) >= 0.85;
  }
  /* "Dhoop Kinare | Episode 01 - 27 | HUM TV" -> "Dhoop Kinare" */
  function showTitle(t) {
    var s0 = String(t || '').split(/\s[|–—-]\s|\|/)[0];
    s0 = s0.replace(/\b(full|all|complete|hd)\b.*$/i, '').replace(/\b(drama serial|episodes?|ep)\b.*$/i, '').replace(/[\s:,-]+$/, '').trim();
    return s0.length >= 2 ? s0 : String(t || '').trim();
  }
  function search(q, force) {
    q = String(q || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (q.length < 2) return Promise.reject(fail('Type at least 2 letters.'));
    return cached('search4:' + norm(q), 14 * DAY, function () {
      var wantNoise = NOISE.test(q), wantOther = OTHER_LANG.test(q);
      return playlistSearch(q + ' drama', { max: 50, region: 'IN', lang: 'ur' }).then(function (found) {
        var cand = found.map(function (p) { return extend(p, { score: sim(q, p.title), phrase: phrase(q, p.title) }); })
          .filter(function (p) { return p.score >= 0.75 && p.count >= 4 && (wantNoise || !NOISE.test(p.title)) && (wantOther || !OTHER_LANG.test(p.title + ' ' + p.channel)); })
          .sort(function (a, b) { return (b.phrase - a.phrase) || (b.score - a.score) || (b.count - a.count); }).slice(0, 14);
        return mapLimit(cand, 5, enrich).then(function (rich) {
          rich = rich.filter(Boolean);
          return channelInfo(rich.map(function (p) { return p.channelId; })).then(function (chOf) {
            var now = Date.now();
            var items = rich.map(function (p) { var ch = chOf(p.channelId); return withStatus(extend(p, { subs: ch.subs, official: isOfficial(p.channel, ch), key: titleKey(p.title, p.channel) }), now); });
            items.sort(function (a, b) { return (b.phrase - a.phrase) || (b.official - a.official) || (b.views - a.views); });
            var groups = [];
            items.forEach(function (p) {
              var g = null; for (var i = 0; i < groups.length; i++) if (sameShow(groups[i].key, p.key)) { g = groups[i]; break; }
              if (g) g.items.push(p); else groups.push({ key: p.key, items: [p] });
            });
            groups.forEach(function (g) {
              g.items.sort(function (a, b) { return ((a.blocked > 0.5) - (b.blocked > 0.5)) || (b.official - a.official) || (b.views - a.views); });
              var orig = g.items[0], firstOf = {};
              orig.original = true;
              g.title = showTitle(orig.title);
              g.items.forEach(function (p) {
                var k = p.count + '|' + p.views;
                if (p !== orig && p.views && firstOf[k]) p.note = 'Same episodes as ' + firstOf[k].channel;
                else if (p.views) firstOf[k] = p;
                if (!p.note && p !== orig && orig.count >= 8 && p.count < orig.count * 0.6) p.note = 'Partial: ' + p.count + ' of ' + orig.count + ' episodes';
                if (p.blocked > 0.5) p.note = 'Not available in your country';
              });
            });
            groups.sort(function (a, b) { return (b.items[0].phrase - a.items[0].phrase) || (b.items[0].official - a.items[0].official) || (b.items[0].views - a.items[0].views); });
            return { query: q, groups: groups.map(function (g) { return { title: g.title, items: g.items }; }) };
          });
        });
      });
    }, false, force);
  }

  /* ---------- episodes ---------- */
  function episodes(id) {
    return cached('ep:' + id, 6 * H, function () {
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
      return page(undefined).then(function () { return order(items); });
    });
  }
  /* sort by the episode number in the titles, when most titles have a distinct one */
  function order(items) {
    items.forEach(function (e) { var m = e.t.match(/\b(?:episode|epi|ep|e)\s*[-.#:]?\s*0*(\d{1,4})\b/i); e.n = m ? +m[1] : null; });
    var withN = items.filter(function (e) { return e.n != null; }), nums = {}, distinct = 0;
    withN.forEach(function (e) { if (!nums[e.n]) { nums[e.n] = 1; distinct++; } });
    if (items.length && withN.length >= items.length * 0.7 && distinct >= withN.length * 0.8)
      items.sort(function (a, b) { return (a.n == null ? 1e9 : a.n) - (b.n == null ? 1e9 : b.n) || a.pos - b.pos; });
    return items;
  }

  function okId(id) { return /^[\w-]{10,60}$/.test(id || ''); }
  function playlist(id) {
    if (!okId(id)) return Promise.reject(fail('Bad playlist id.'));
    return cached('pl:' + id, 7 * DAY, function () {
      return playlistInfo([id]).then(function (r) { if (!r[0]) throw fail('Playlist not found or private.'); return r[0]; });
    });
  }

  window.PB = {
    hasKey: !!KEY, sections: SECTIONS, trending: trending, monthly: monthly, browse: browse, search: search,
    episodes: function (id) { return okId(id) ? episodes(id) : Promise.reject(fail('Bad playlist id.')); },
    playlist: playlist, clearCache: clearCache, sim: sim, phrase: phrase, showTitle: showTitle, order: order, eligible: eligible, sameDrama: sameDrama,   // sim, phrase, order, eligible, sameDrama: for tests/
    onStale: function (fn) { staleListener = fn; }
  };
})();
