/* Shiai: draw generator, admin scoring and live board for a kendo shiai run from Google Sheets.
   Paste this into Extensions > Apps Script as Code.gs. Add an HTML file named Admin. */

/* ===================== SHIAI CORE (shared by Code.gs and the web page) =====================
   Pure functions only: no sheet or page access here, so the sheet and the web app always agree.
   Kendo scoring: M (men), K (kote), D (do), T (tsuki) and H (point from opponent's hansoku) are ippon.
   ∆ marks one hansoku against that fighter (shown, but scores nothing).
============================================================================================== */

var SHIAI_IPPON = ['M', 'K', 'D', 'T', 'H'];
var SHIAI_DECISIONS = ['Red wins by forfeit', 'White wins by forfeit', 'Both forfeit', 'Red wins by hantei', 'White wins by hantei'];
var SHIAI_DEFAULTS = { title: 'Shiai', type: 'individual', teamSize: 3, courts: 1, poolSize: 3, qualify: 2, winPts: 3, drawPts: 2, ipponPts: 1, showSpirit: false, hantei: false, enchoMin: 0, forfeitIppon: 2 };

function shiaiKey(s) { return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase(); }
function shiaiClean(s) { return String(s == null ? '' : s).trim().replace(/\s+/g, ' '); }

function shiaiMark(v) {
  var s = String(v == null ? '' : v).trim().toUpperCase();
  if (!s) return '';
  if (s === '∆' || s === 'Δ' || s === '▲' || s === '△' || s === '^' || s === 'X') return '∆';
  return s.charAt(0);
}

// Pool round robin order. Red is listed first. Small pools use the usual fixed orders.
function shiaiRoundRobin(n) {
  if (n < 2) return [];
  if (n === 2) return [[1, 2]];
  if (n === 3) return [[1, 2], [2, 3], [3, 1]];
  if (n === 4) return [[1, 2], [3, 4], [1, 3], [2, 4], [1, 4], [2, 3]];
  var ids = []; for (var i = 1; i <= n; i++) ids.push(i);
  if (n % 2) ids.push(0);
  var m = ids.length, out = [];
  for (var r = 0; r < m - 1; r++) {
    for (var j = 0; j < m / 2; j++) {
      var a = ids[j], b = ids[m - 1 - j];
      if (a && b) out.push(r % 2 ? [b, a] : [a, b]);
    }
    ids.splice(1, 0, ids.pop());
  }
  return out;
}

function shiaiPoolLetters(n) {
  var out = [];
  for (var i = 0; i < n; i++) out.push(i < 26 ? String.fromCharCode(65 + i) : 'P' + (i + 1));
  return out;
}

// Put fighters without a pool into pools, keeping club mates apart where possible.
// Returns a new list; fighters that already have a pool keep it.
function shiaiAssignPools(fighters, poolSize) {
  var list = fighters.map(function (f) { return { name: f.name, dojo: f.dojo, grade: f.grade, pool: shiaiClean(f.pool).toUpperCase() }; });
  var open = list.filter(function (f) { return !f.pool; });
  if (!open.length) return list;
  var size = Math.max(2, Number(poolSize) || 3);
  var existing = {};
  list.forEach(function (f) { if (f.pool) existing[f.pool] = (existing[f.pool] || 0) + 1; });
  var nPools = Math.max(1, Math.ceil(open.length / size));
  var letters = shiaiPoolLetters(nPools + Object.keys(existing).length).filter(function (l) { return !existing[l]; }).slice(0, nPools);
  // Biggest clubs first, then deal round the pools in a snake so each club spreads out.
  var byDojo = {};
  open.forEach(function (f) { var k = shiaiKey(f.dojo) || '~' + f.name; (byDojo[k] = byDojo[k] || []).push(f); });
  var groups = Object.keys(byDojo).map(function (k) { return byDojo[k]; }).sort(function (a, b) { return b.length - a.length; });
  var order = [].concat.apply([], groups);
  var counts = letters.map(function () { return 0; });
  var cap = letters.map(function (_, i) { return Math.floor(open.length / nPools) + (i < open.length % nPools ? 1 : 0); });
  var clubIn = letters.map(function () { return {}; });
  order.forEach(function (f) {
    var k = shiaiKey(f.dojo);
    var best = -1;
    for (var i = 0; i < letters.length; i++) {
      if (counts[i] >= cap[i]) continue;
      if (best < 0) { best = i; continue; }
      var ci = k ? (clubIn[i][k] || 0) : 0, cb = k ? (clubIn[best][k] || 0) : 0;
      if (ci < cb || (ci === cb && counts[i] < counts[best])) best = i;
    }
    f.pool = letters[best]; counts[best]++;
    if (k) clubIn[best][k] = (clubIn[best][k] || 0) + 1;
  });
  return list;
}

// Standard seeded bracket order, e.g. 8 -> [1,8,4,5,2,7,3,6].
function shiaiSeedOrder(size) {
  var order = [1];
  while (order.length < size) {
    var n = order.length * 2, next = [];
    order.forEach(function (s) { next.push(s, n + 1 - s); });
    order = next;
  }
  return order;
}

function shiaiRoundName(entrants) {
  if (entrants === 2) return { stage: 'Final', code: 'FINAL' };
  if (entrants === 4) return { stage: 'Semi-final', code: 'SF' };
  if (entrants === 8) return { stage: 'Quarter-final', code: 'QF' };
  return { stage: 'Last ' + entrants, code: 'R' + entrants + '-' };
}

// Knockout from pool places. Pool winners are seeded and get any byes; fighters from the same pool
// are kept as far apart in the bracket as possible.
function shiaiBuildKnockout(poolSizes, qualify) {
  var pools = Object.keys(poolSizes).sort();
  var winners = [], others = [];
  pools.forEach(function (p) {
    for (var place = 1; place <= Math.min(qualify, poolSizes[p]); place++) {
      (place === 1 ? winners : others).push({ src: p + place, pool: p, place: place });
    }
  });
  others.sort(function (a, b) { return a.place - b.place || (a.pool < b.pool ? -1 : 1); });
  var q = winners.length + others.length;
  if (q < 2) return [];
  var size = 1; while (size < q) size *= 2;
  var seeds = shiaiSeedOrder(size);
  var slots = new Array(size).fill(null);
  var n = pools.length;
  // The SAKF layout: with 2 through from each of 2, 4, 8... pools, each pool winner meets the next
  // pool's runner-up (A1-B2, C1-D2 | B1-C2, D1-A2). A, C... winners take the top half, B, D... the bottom,
  // so fighters from the same pool can only meet in the final.
  var even = n >= 2 && (n & (n - 1)) === 0 && others.length === n && others.every(function (o) { return o.place === 2; });
  if (even) {
    var pairs = [[], []];
    pools.forEach(function (p, i) { pairs[i % 2].push(p + '1', pools[(i + 1) % n] + '2'); });
    slots = pairs[0].concat(pairs[1]).map(function (src) { return { src: src }; });
  } else winners.forEach(function (w, i) { slots[seeds.indexOf(i + 1)] = w; });
  var free = [];
  if (!even) seeds.forEach(function (s, i) { if (s > winners.length && s <= q) free.push(i); });
  var meet = function (a, b) { var x = a ^ b, r = 0; while (x) { r++; x >>= 1; } return r; };
  if (!even) others.forEach(function (o) {
    var mates = [];
    slots.forEach(function (s, i) { if (s && s.pool === o.pool) mates.push(i); });
    var best = null, bestScore = -1, bestSeed = Infinity;
    free.forEach(function (i) {
      var score = mates.length ? Math.min.apply(null, mates.map(function (m) { return meet(i, m); })) : 99;
      if (score > bestScore || (score === bestScore && seeds[i] < bestSeed)) { best = i; bestScore = score; bestSeed = seeds[i]; }
    });
    slots[best] = o; free.splice(free.indexOf(best), 1);
  });
  // Build rounds. Each entry is a source: 'A1' (pool place) or 'W:QF1' (winner of a fight).
  var fights = [];
  var current = slots.map(function (s) { return s ? s.src : null; });
  var entrants = size;
  while (current.length > 1) {
    var rn = shiaiRoundName(entrants), next = [], n = 0;
    for (var i = 0; i < current.length; i += 2) {
      var a = current[i], b = current[i + 1];
      if (a && b) {
        n++;
        var code = rn.code === 'FINAL' ? 'FINAL' : rn.code + n;
        fights.push({ code: code, stage: rn.stage, redFrom: a, whiteFrom: b, half: i < current.length / 2 ? 0 : 1 });
        next.push('W:' + code);
      } else next.push(a || b);
    }
    current = next; entrants /= 2;
  }
  return fights;
}

// The whole draw: pool fights, one pool at a time on each court, then the knockout.
function shiaiBuildDraw(fighters, settings) {
  var st = shiaiSettings(settings);
  var assigned = shiaiAssignPools(fighters.filter(function (f) { return shiaiClean(f.name); }), st.poolSize);
  var pools = {};
  assigned.forEach(function (f) { (pools[f.pool] = pools[f.pool] || []).push(f); });
  var letters = Object.keys(pools).sort();
  var courts = Math.max(1, st.courts);
  var rows = [];
  var perCourt = [];
  for (var c = 0; c < courts; c++) perCourt.push([]);
  // Spread pools over courts, biggest pools first, onto the court with the fewest fights.
  var load = perCourt.map(function () { return 0; });
  letters.slice().sort(function (a, b) { return pools[b].length - pools[a].length || (a < b ? -1 : 1); }).forEach(function (p) {
    var c = load.indexOf(Math.min.apply(null, load));
    perCourt[c].push(p);
    load[c] += shiaiRoundRobin(pools[p].length).length;
  });
  perCourt.forEach(function (ps, ci) {
    ps.sort();
    var lists = ps.map(function (p) {
      return shiaiRoundRobin(pools[p].length).map(function (pair, k) {
        return { code: p + '-' + (k + 1), stage: 'Pool ' + p, pool: p, court: ci + 1, red: pools[p][pair[0] - 1].name, white: pools[p][pair[1] - 1].name };
      });
    });
    // Each pool is fought start to finish before the next pool on that court begins.
    lists.forEach(function (l) { l.forEach(function (f) { rows.push(f); }); });
  });
  var sizes = {};
  letters.forEach(function (p) { sizes[p] = pools[p].length; });
  var ko = st.qualify > 0 && letters.length ? shiaiBuildKnockout(sizes, st.qualify) : [];
  ko.forEach(function (f) {
    f.court = f.stage === 'Final' || courts === 1 ? 1 : (f.half % courts) + 1;
    rows.push(f);
  });
  // Pool fights first, ordered per court; then knockout rounds in order.
  var pool = rows.filter(function (r) { return r.pool; });
  var koRows = rows.filter(function (r) { return !r.pool; });
  var ordered = [];
  if (courts > 1) {
    // Alternate courts so fight numbers read naturally down the sheet.
    var byCourt = []; for (var c2 = 0; c2 < courts; c2++) byCourt.push(pool.filter(function (r) { return r.court === c2 + 1; }));
    var mx = Math.max.apply(null, byCourt.map(function (l) { return l.length; }));
    for (var i = 0; i < mx; i++) byCourt.forEach(function (l) { if (l[i]) ordered.push(l[i]); });
  } else ordered = pool;
  ordered = ordered.concat(koRows);
  ordered.forEach(function (r, i) {
    r.order = i + 1;
    r.red = r.red || shiaiSourceLabel(r.redFrom);
    r.white = r.white || shiaiSourceLabel(r.whiteFrom);
    r.redFrom = r.redFrom || ''; r.whiteFrom = r.whiteFrom || ''; r.pool = r.pool || '';
  });
  return { fighters: assigned, fights: ordered };
}

function shiaiOrdinal(n) { return n === 1 ? 'winner' : n === 2 ? '2nd' : n === 3 ? '3rd' : n + 'th'; }
function shiaiSourceLabel(src) {
  src = shiaiClean(src);
  if (!src) return '';
  var w = /^W:(.+)$/i.exec(src);
  if (w) return 'Winner of ' + w[1].toUpperCase();
  var p = /^([A-Za-z]+)(\d+)$/.exec(src);
  if (p) return 'Pool ' + p[1].toUpperCase() + ' ' + shiaiOrdinal(Number(p[2]));
  return src;
}

// Ippon for each side. M, K, D, T score. A point from hansoku can be entered as H, or left to the
// opponent's ∆ marks: every two ∆ give one ippon. Whichever shows more is used, so it never counts twice.
function shiaiPoints(rm, wm) {
  var c = function (ms, m) { return ms.filter(function (x) { return x === m; }).length; };
  var base = function (ms) { return c(ms, 'M') + c(ms, 'K') + c(ms, 'D') + c(ms, 'T'); };
  return {
    r: base(rm) + Math.max(c(rm, 'H'), Math.floor(c(wm, '∆') / 2)),
    w: base(wm) + Math.max(c(wm, 'H'), Math.floor(c(rm, '∆') / 2)),
  };
}

function shiaiPositions(n) {
  if (n === 3) return ['Senpo', 'Chuken', 'Taisho'];
  if (n === 5) return ['Senpo', 'Jiho', 'Chuken', 'Fukusho', 'Taisho'];
  var out = []; for (var i = 1; i <= n; i++) out.push('Bout ' + i); return out;
}
var SHIAI_PLAYOFF_BOUT = 'Daihyosen';
var SHIAI_PLAYOFF_RE = /^(daihy|play.?off)/i;

// Team competitions: each match is a 'Team' row followed by one row per bout and a play-off bout row.
// members = { teamKey: [names in order] } fills in pool lineups; scorers can change them.
function shiaiTeamRows(matches, settings, members) {
  var st = shiaiSettings(settings);
  var pos = shiaiPositions(st.teamSize);
  var out = [];
  matches.forEach(function (m) {
    out.push(Object.assign({}, m, { bout: 'Team' }));
    var rm = (members || {})[shiaiKey(m.red)] || [], wm = (members || {})[shiaiKey(m.white)] || [];
    pos.concat([SHIAI_PLAYOFF_BOUT]).forEach(function (p, i) {
      out.push({ order: '', code: m.code, stage: '', court: '', bout: p, red: p === SHIAI_PLAYOFF_BOUT ? '' : (rm[i] || ''), white: p === SHIAI_PLAYOFF_BOUT ? '' : (wm[i] || ''), pool: '', redFrom: '', whiteFrom: '' });
    });
  });
  return out;
}

function shiaiSettings(s) {
  s = s || {};
  var n = function (v, d) { var x = Number(v); return v === '' || v == null || !isFinite(x) ? d : x; };
  return {
    title: shiaiClean(s.title) || SHIAI_DEFAULTS.title,
    courts: Math.max(1, Math.round(n(s.courts, SHIAI_DEFAULTS.courts))),
    poolSize: Math.max(2, Math.round(n(s.poolSize, SHIAI_DEFAULTS.poolSize))),
    qualify: Math.max(0, Math.round(n(s.qualify, SHIAI_DEFAULTS.qualify))),
    winPts: n(s.winPts, SHIAI_DEFAULTS.winPts),
    drawPts: n(s.drawPts, SHIAI_DEFAULTS.drawPts),
    ipponPts: n(s.ipponPts, SHIAI_DEFAULTS.ipponPts),
    type: /^team/i.test(shiaiClean(s.type)) ? 'team' : 'individual',
    teamSize: Math.max(1, Math.min(7, Math.round(n(s.teamSize, SHIAI_DEFAULTS.teamSize)))),
    showSpirit: s.showSpirit === true || /^(y|yes|true|1)$/i.test(String(s.showSpirit || '').trim()),
    hantei: s.hantei === true || /^(y|yes|true|1)$/i.test(String(s.hantei || '').trim()),
    enchoMin: Math.max(0, n(s.enchoMin, 0)),
  };
}

/* raw = { settings, fighters:[{name,dojo,grade,pool}], fights:[{order,code,stage,court,red,rm[],wm[],white,decision,done,shinpan[],pool,redFrom,whiteFrom}], spirit:[name...] }
   Returns everything the web app shows, plus the resolved names the sheet writes back. */
function shiaiCompute(raw) {
  var st = shiaiSettings(raw.settings);
  var fighters = (raw.fighters || []).filter(function (f) { return shiaiClean(f.name); }).map(function (f) {
    return { name: shiaiClean(f.name), dojo: shiaiClean(f.dojo), grade: shiaiClean(f.grade), pool: shiaiClean(f.pool).toUpperCase(), members: (f.members || []).map(shiaiClean).filter(Boolean) };
  });
  var byName = {};
  fighters.forEach(function (f) { byName[shiaiKey(f.name)] = f; });

  var isDone = function (v) { return v === true || /^(true|yes|y|x|✓|1)$/i.test(String(v || '').trim()); };
  var decisionOf = function (v) { var d = shiaiClean(v); return SHIAI_DECISIONS.indexOf(d) >= 0 ? d : ''; };
  function single(f, i) {
    var rm = (f.rm || []).map(shiaiMark).filter(Boolean), wm = (f.wm || []).map(shiaiMark).filter(Boolean);
    var pts = shiaiPoints(rm, wm);
    var stage = shiaiClean(f.stage);
    var o = {
      order: Number(f.order) || i + 1, code: shiaiClean(f.code).toUpperCase() || String(i + 1), stage: stage,
      court: Math.max(1, Number(f.court) || 1), pool: shiaiClean(f.pool).toUpperCase(),
      playoff: /play.?off/i.test(stage) || /-PO\d*$/i.test(shiaiClean(f.code)),
      redFrom: shiaiClean(f.redFrom), whiteFrom: shiaiClean(f.whiteFrom),
      redTyped: shiaiClean(f.red), whiteTyped: shiaiClean(f.white),
      rm: rm, wm: wm, rIpp: pts.r, wIpp: pts.w,
      decision: decisionOf(f.decision), done: isDone(f.done),
      shinpan: (f.shinpan || []).map(shiaiClean).filter(Boolean),
    };
    // Forfeits end the fight. The winner is credited two ippon (fusen-gachi); both forfeiting is a draw.
    if (/forfeit/i.test(o.decision)) {
      o.done = true;
      if (/^both/i.test(o.decision)) { o.rIpp = 0; o.wIpp = 0; }
      else if (/^red/i.test(o.decision)) { o.rIpp = SHIAI_DEFAULTS.forfeitIppon; o.wIpp = 0; }
      else { o.wIpp = SHIAI_DEFAULTS.forfeitIppon; o.rIpp = 0; }
      o.forfeit = true;
    }
    o.hantei = /hantei/i.test(o.decision);
    o.res = !o.done ? null : /^both/i.test(o.decision) ? 'draw' : /^red/i.test(o.decision) ? 'red' : /^white/i.test(o.decision) ? 'white' : o.rIpp > o.wIpp ? 'red' : o.wIpp > o.rIpp ? 'white' : 'draw';
    o.row = f.row;
    return o;
  }
  // Knockout fights, pool play-offs and the daihyosen can't end level: the fight carries on in encho
  // (next ippon wins), or goes to hantei where the competition allows it.
  function mustWin_(o) {
    if (o.res === 'draw' && !/^both/i.test(o.decision)) { o.res = null; o.done = false; o.level = true; }
  }
  var fights;
  if (st.type === 'team') {
    // Group rows into matches: a 'Team' row, then its bouts (same fight code).
    var groups = [], cur = null;
    (raw.fights || []).forEach(function (f) {
      var bout = shiaiClean(f.bout);
      if (/^team$/i.test(bout) || !cur) { cur = { head: f, bouts: [] }; groups.push(cur); if (!/^team$/i.test(bout)) cur.bouts.push(f); }
      else cur.bouts.push(f);
    });
    fights = groups.filter(function (g) { return shiaiClean(g.head.red) || shiaiClean(g.head.white) || shiaiClean(g.head.redFrom) || shiaiClean(g.head.whiteFrom); }).map(function (g, i) {
      var m = single(g.head, i);
      m.order = i + 1;
      m.team = true;
      m.bouts = g.bouts.map(function (b, k) { var x = single(b, k); x.pos = shiaiClean(b.bout) || 'Bout ' + (k + 1); x.extra = SHIAI_PLAYOFF_RE.test(x.pos); if (x.extra) mustWin_(x); return x; });
      var regular = m.bouts.filter(function (b) { return !b.extra; }), extra = m.bouts.filter(function (b) { return b.extra; })[0];
      // As on the old team sheet: each bout gives its team 3 for a win, 2 for a draw and 1 per ippon.
      // The team with more points wins the match. The daihyosen, if fought, counts like a bout.
      m.rWins = 0; m.wWins = 0; m.rIpp = 0; m.wIpp = 0; m.draws = 0;
      var tally = function (b) { m.rIpp += b.rIpp; m.wIpp += b.wIpp; if (b.res === 'red') m.rWins++; else if (b.res === 'white') m.wWins++; else if (b.res === 'draw') m.draws++; };
      regular.forEach(function (b) { if (b.done) tally(b); });
      if (extra && extra.done && extra.res) tally(extra);
      var allDone = regular.length > 0 && regular.every(function (b) { return b.done; });
      var res = null;
      if (m.decision && /forfeit/i.test(m.decision)) {
        // A whole team forfeits: the winner takes every bout as a forfeit win.
        var full = regular.length || st.teamSize;
        m.rWins = 0; m.wWins = 0; m.draws = 0; m.rIpp = 0; m.wIpp = 0;
        if (/^both/i.test(m.decision)) res = 'draw';
        else if (/^red/i.test(m.decision)) { res = 'red'; m.rWins = full; m.rIpp = full * SHIAI_DEFAULTS.forfeitIppon; }
        else { res = 'white'; m.wWins = full; m.wIpp = full * SHIAI_DEFAULTS.forfeitIppon; }
      } else if (allDone) {
        var sR = m.rWins * st.winPts + m.draws * st.drawPts + m.rIpp * st.ipponPts, sW = m.wWins * st.winPts + m.draws * st.drawPts + m.wIpp * st.ipponPts;
        res = sR > sW ? 'red' : sW > sR ? 'white' : 'draw';
        // Knockout matches can't end level: the daihyosen decides it.
        if (res === 'draw' && !m.pool) { res = null; m.level = true; }
      }
      m.rScore = m.rWins * st.winPts + m.draws * st.drawPts + m.rIpp * st.ipponPts;
      m.wScore = m.wWins * st.winPts + m.draws * st.drawPts + m.wIpp * st.ipponPts;
      m.res = res;
      m.done = !!res;
      m.started = regular.some(function (b) { return b.done || b.rm.length || b.wm.length; });
      m.rm = []; m.wm = [];
      return m;
    });
  } else {
    fights = (raw.fights || []).filter(function (f) { return shiaiClean(f.red) || shiaiClean(f.white) || shiaiClean(f.redFrom) || shiaiClean(f.whiteFrom); }).map(single);
    fights.forEach(function (f) { if (!f.pool || f.playoff) mustWin_(f); });
  }
  fights.sort(function (a, b) { return a.order - b.order; });
  fights.forEach(function (f, i) { f.order = i + 1; });
  var byCode = {};
  fights.forEach(function (f) { byCode[f.code] = f; });

  function outcome(f) { return f.res || null; }

  // Pools. Pool fights always have their names typed in by the draw.
  var poolNames = {};
  fighters.forEach(function (f) { if (f.pool) poolNames[f.pool] = true; });
  fights.forEach(function (f) { if (f.pool) poolNames[f.pool] = true; });
  var pools = Object.keys(poolNames).sort().map(function (p) {
    var members = fighters.filter(function (f) { return f.pool === p; }).map(function (f) { return f.name; });
    var pf = fights.filter(function (f) { return f.pool === p; });
    pf.forEach(function (f) {
      [f.redTyped, f.whiteTyped].forEach(function (n) { if (n && !members.some(function (m) { return shiaiKey(m) === shiaiKey(n); })) members.push(n); });
    });
    var rows = members.map(function (name) {
      var fr = byName[shiaiKey(name)];
      return { name: name, dojo: fr ? fr.dojo : '', members: fr ? fr.members : [], fought: 0, w: 0, d: 0, l: 0, ipp: 0, against: 0, points: 0, poW: 0, poIpp: 0 };
    });
    var row = function (n) { return rows.filter(function (r) { return shiaiKey(r.name) === shiaiKey(n); })[0]; };
    var main = pf.filter(function (f) { return !f.playoff; });
    main.forEach(function (f) {
      var o = outcome(f); if (!o) return;
      var r = row(f.redTyped), w = row(f.whiteTyped); if (!r || !w) return;
      r.fought++; w.fought++; r.ipp += f.rIpp; w.ipp += f.wIpp; r.against += f.wIpp; w.against += f.rIpp;
      if (f.team) { r.score = (r.score || 0) + f.rScore; w.score = (w.score || 0) + f.wScore; }
      if (o === 'red') { r.w++; w.l++; } else if (o === 'white') { w.w++; r.l++; } else { r.d++; w.d++; }
    });
    pf.filter(function (f) { return f.playoff; }).forEach(function (f) {
      var o = outcome(f); if (!o) return;
      var r = row(f.redTyped), w = row(f.whiteTyped); if (!r || !w) return;
      r.poIpp += f.rIpp; w.poIpp += f.wIpp;
      if (o === 'red') r.poW++; else if (o === 'white') w.poW++;
    });
    // Individual: 3 a win, 2 a draw, 1 per ippon. Teams: the bout points of every match added up.
    rows.forEach(function (r) { r.points = st.type === 'team' ? (r.score || 0) : r.w * st.winPts + r.d * st.drawPts + r.ipp * st.ipponPts; });
    rows.sort(function (a, b) { return b.points - a.points || b.poW - a.poW || b.poIpp - a.poIpp || a.name.localeCompare(b.name); });
    var same = function (a, b) { return a.points === b.points && a.poW === b.poW && a.poIpp === b.poIpp; };
    rows.forEach(function (r, i) {
      r.place = i && same(rows[i - 1], r) ? rows[i - 1].place : i + 1;
    });
    var complete = main.length > 0 && main.every(function (f) { return outcome(f); });
    var qual = st.qualify;
    var tiedPlaces = [];
    rows.forEach(function (r) {
      var group = rows.filter(function (x) { return x.place === r.place; });
      r.tied = group.length > 1 && r.place <= Math.max(1, qual);
      if (r.tied && tiedPlaces.indexOf(r.place) < 0) tiedPlaces.push(r.place);
      r.qualified = complete && !r.tied && r.place <= qual;
    });
    var tiedNames = complete ? rows.filter(function (r) { return r.tied; }).map(function (r) { return r.name; }) : [];
    return {
      pool: p, complete: complete, played: main.filter(function (f) { return outcome(f); }).length, total: main.length,
      playoffNeeded: complete && tiedNames.length > 0, tiedNames: tiedNames,
      rows: rows.map(function (r) { return { place: r.place, name: r.name, dojo: r.dojo, members: r.members, fought: r.fought, w: r.w, d: r.d, l: r.l, ipp: r.ipp, against: r.against, points: r.points, tied: complete && r.tied, qualified: r.qualified }; }),
    };
  });
  var poolBy = {};
  pools.forEach(function (p) { poolBy[p.pool] = p; });

  // Resolve a source like 'A1' or 'W:QF1' to a name, or null while it is not decided.
  function resolve(src) {
    var w = /^W:(.+)$/i.exec(src);
    if (w) {
      var f = byCode[w[1].toUpperCase()];
      if (!f || !f.result || f.result === 'draw') return null;
      return f.result === 'red' ? f.redName : f.whiteName;
    }
    var m = /^([A-Za-z]+)(\d+)$/.exec(src);
    if (m) {
      var pl = poolBy[m[1].toUpperCase()], place = Number(m[2]);
      if (!pl || !pl.complete) return null;
      var at = pl.rows.filter(function (r) { return r.place === place; });
      return at.length === 1 && !at[0].tied ? at[0].name : null;
    }
    return null;
  }
  fights.forEach(function (f) {
    ['red', 'white'].forEach(function (side) {
      var from = f[side + 'From'], typed = f[side + 'Typed'];
      var name = from ? resolve(from) : typed;
      f[side + 'Name'] = name || '';
      f[side + 'Label'] = name || shiaiSourceLabel(from) || 'To be decided';
      f[side + 'Pending'] = !name;
    });
    var o = outcome(f);
    f.result = o;
  });

  // Now / next per court: the first fights not yet done.
  var courts = {};
  fights.forEach(function (f) { courts[f.court] = true; });
  Object.keys(courts).forEach(function (c) {
    var left = fights.filter(function (f) { return String(f.court) === c && !f.done; });
    if (left[0]) left[0].status = 'now';
    if (left[1]) left[1].status = 'next';
  });

  // Results
  var ko = fights.filter(function (f) { return !f.pool && !f.playoff; });
  var final = byCode.FINAL;
  var results = null;
  var winnerOf = function (f) { return f.result === 'red' ? f.redName : f.result === 'white' ? f.whiteName : ''; };
  var loserOf = function (f) { return f.result === 'red' ? f.whiteName : f.result === 'white' ? f.redName : ''; };
  if (final && final.result && final.result !== 'draw') {
    var thirds = ko.filter(function (f) { return f.stage === 'Semi-final'; }).map(loserOf).filter(Boolean);
    results = { first: winnerOf(final), second: loserOf(final), thirds: thirds };
  } else if (!ko.length && pools.length === 1 && pools[0].complete && !pools[0].playoffNeeded) {
    var rr = pools[0].rows;
    results = { first: rr[0] ? rr[0].name : '', second: rr[1] ? rr[1].name : '', thirds: rr[2] ? [rr[2].name] : [] };
  }
  var spirit = [];
  if (st.showSpirit) {
    var tally = {};
    (raw.spirit || []).map(shiaiClean).filter(Boolean).forEach(function (n) { var k = shiaiKey(n); tally[k] = tally[k] || { name: n, votes: 0 }; tally[k].votes++; });
    spirit = Object.keys(tally).map(function (k) { return tally[k]; }).sort(function (a, b) { return b.votes - a.votes || a.name.localeCompare(b.name); });
  }

  var dojoOf = function (n) { var f = byName[shiaiKey(n)]; return f ? f.dojo : ''; };
  var membersOf = function (n) { var f = byName[shiaiKey(n)]; return f && f.members ? f.members : []; };
  return {
    title: st.title,
    type: st.type,
    courts: Object.keys(courts).length,
    settings: { winPts: st.winPts, drawPts: st.drawPts, ipponPts: st.ipponPts, qualify: st.qualify, hantei: st.hantei, enchoMin: st.enchoMin, teamSize: st.teamSize },
    fighters: fighters.map(function (f) { return { name: f.name, dojo: f.dojo, pool: f.pool, members: f.members }; }),
    fights: fights.map(function (f) {
      return {
        order: f.order, code: f.code, stage: f.stage || (f.pool ? 'Pool ' + f.pool : ''), court: f.court, pool: f.pool, ko: !f.pool && !f.playoff, playoff: f.playoff,
        red: { name: f.redName, label: f.redLabel, pending: f.redPending, from: f.redFrom, dojo: dojoOf(f.redName), members: membersOf(f.redName), marks: f.rm, ippon: f.rIpp },
        white: { name: f.whiteName, label: f.whiteLabel, pending: f.whitePending, from: f.whiteFrom, dojo: dojoOf(f.whiteName), members: membersOf(f.whiteName), marks: f.wm, ippon: f.wIpp },
        decision: f.decision, done: f.done, result: f.result, status: f.status || (f.done ? 'done' : 'later'), row: f.row, hantei: !!f.hantei, forfeit: !!f.forfeit,
        scores: f.team ? { red: f.rScore, white: f.wScore } : null,
        shinpan: f.shinpan,
        team: !!f.team, level: !!f.level,
        wins: f.team ? { red: f.rWins, white: f.wWins } : null,
        bouts: f.team ? f.bouts.map(function (b, k) {
          var rmem = membersOf(f.redName), wmem = membersOf(f.whiteName);
          return { pos: b.pos, extra: b.extra, done: b.done, result: b.res, decision: b.decision, row: b.row, level: !!b.level, hantei: !!b.hantei, forfeit: !!b.forfeit,
            red: { name: b.redTyped || (b.extra ? '' : rmem[k] || ''), marks: b.rm, ippon: b.rIpp }, white: { name: b.whiteTyped || (b.extra ? '' : wmem[k] || ''), marks: b.wm, ippon: b.wIpp } };
        }).filter(function (b) { return !b.extra || b.done || b.red.marks.length || b.white.marks.length || b.red.name || b.white.name; }) : null,
      };
    }),
    pools: pools,
    results: results,
    spirit: spirit,
  };
}

// Time estimate formulas for the Competitions tab. tab = fights tab name, L = the competition's column
// letter, R = row numbers of the settings. Counts the fights on the tab: fights (team bouts) before the
// semi-finals take the first time, the semi-finals and final the second. Courts run side by side.
function shiaiTimingFormulas(tab, team, L, R) {
  var q = "'" + tab.replace(/'/g, "''") + "'!";
  var B = q + '$B$2:$B$2000', E = q + '$E$2:$E$2000';
  var notBout = team ? ',' + E + ',"<>Team",' + E + ',"<>' + SHIAI_PLAYOFF_BOUT + '"' : '';
  var count = function (crit) { return 'COUNTIFS(' + B + ',' + crit + notBout + ')'; };
  var late = count('"SF*"') + '+' + count('"FINAL"');
  var courts = 'MAX(1,N(' + L + R.courts + '))';
  return {
    early: '=' + count('"<>"') + '-(' + late + ')',
    late: '=' + late,
    time: '=(ROUNDUP(' + L + R.nEarly + '/' + courts + ',0)*' + L + R.early + '+ROUNDUP(' + L + R.nLate + '/' + courts + ',0)*' + L + R.late + ')/1440',
    finish: '=IF(' + L + R.start + '="","",' + L + R.start + '+' + L + R.time + ')',
  };
}

// Shinpan rotation: three referee a match (shushin first, then two fukushin). Every two matches the
// longest-serving one steps out and the next on the list steps in, so the list cycles in order.
// block = which pair of matches this is, counted through the whole day.
var SHIAI_MATCHES_PER_ROTATION = 2;
function shiaiShinpanFor(names, block) {
  var n = names.length, out = ['', '', ''];
  for (var k = 0; k < Math.min(3, n); k++) out[k] = names[(block + k) % n];
  return out;
}

// The pool table that sits beside the fights on the admin sheet: one block per pool, with
// what's left to fight and whether a play-off is needed. Returns rows of 9 cells and a style per row.
var SHIAI_PANEL_HEAD = ['Place', 'Fighter', 'Fought', 'Won', 'Drawn', 'Lost', 'Ippon', 'Points', 'Status'];
function shiaiPoolPanel(state) {
  var rows = [], styles = [];
  var team = state.type === 'team';
  var push = function (r, s) { while (r.length < 9) r.push(''); rows.push(r); styles.push(s); };
  var ordinal = function (n) { return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : n + 'th'; };
  if (!state.pools.length) { push(['No pools yet. Generate the draw first.'], 'note'); return { rows: rows, styles: styles }; }
  state.pools.forEach(function (p) {
    var left = p.total - p.played;
    var status = !p.total ? 'no fights' : p.playoffNeeded ? 'PLAY-OFF NEEDED' : p.complete ? 'finished' : p.played + ' of ' + p.total + (p.total === 1 ? ' fight' : ' fights') + ' done, ' + left + ' to go';
    push(['Pool ' + p.pool, status], p.playoffNeeded ? 'alert-title' : p.complete ? 'done-title' : 'title');
    var head = SHIAI_PANEL_HEAD.slice(); if (team) head[1] = 'Team';
    push(head, 'head');
    p.rows.forEach(function (r) {
      var st = r.tied ? 'Tied: play-off' : r.qualified ? 'Through' : p.complete ? 'Out' : '';
      push([p.played ? r.place : '', r.name, r.fought, r.w, r.d, r.l, r.ipp, r.points, st], r.tied ? 'tied' : r.qualified ? 'through' : 'row');
    });
    if (p.playoffNeeded) {
      var places = {};
      p.rows.filter(function (r) { return r.tied; }).forEach(function (r) { (places[r.place] = places[r.place] || []).push(r.name); });
      Object.keys(places).forEach(function (pl) {
        var nm = places[pl]; push([nm.slice(0, -1).join(', ') + ' and ' + nm[nm.length - 1] + ' are level for ' + ordinal(Number(pl)) + '. Use Shiai > Add play-off fights.'], 'alert');
      });
    } else if (p.complete) {
      var through = p.rows.filter(function (r) { return r.qualified; }).map(function (r) { return ordinal(r.place) + ' ' + r.name; });
      if (through.length) push(['Through: ' + through.join(', ')], 'note');
    }
    push([], 'gap');
  });
  return { rows: rows, styles: styles };
}

/* ===================== SHEET SIDE =====================
   Tabs:
     Competitions      - one column per competition (Kids, Juniors, Teams...) with its settings
     Entries           - one row per fighter: Competition, Name, Dojo, Grade, Pool, Team (team events only), Age (for your reference)
     Shinpan           - referees, for the dropdowns
     Fighting Spirit   - votes, per competition
     <Name> Fights     - made by "Generate draw"; scorers work here
     <Name> Standings  - kept up to date by the script
   Scorers only type marks, Decision and Done on a Fights tab. Everything else updates by itself.
======================================================== */

var TAB = { comps: 'Competitions', entries: 'Entries', shinpan: 'Shinpan', spirit: 'Fighting Spirit', board: 'Board' };
var COMP_SETTINGS = [
  ['Type', 'type', 'Individual', 'Individual or Team'],
  ['Courts (shiaijo)', 'courts', 1, ''],
  ['Pool size', 'poolSize', 3, 'Only used for entries with no pool'],
  ['Qualify per pool', 'qualify', 2, '0 = no knockout'],
  ['Points for a win', 'winPts', 3, ''],
  ['Points for a draw', 'drawPts', 2, ''],
  ['Points per ippon', 'ipponPts', 1, ''],
  ['Bouts per team match', 'teamSize', 3, 'Team events only. A daihyosen bout is added after these.'],
  ['Show fighting spirit on web app', 'showSpirit', 'No', 'Yes or No'],
  ['Encho minutes', 'enchoMin', '', 'Blank = until someone scores'],
  ['Hantei after encho', 'hantei', 'No', 'Yes or No. Knockout and play-off fights only.'],
];
var MARKS = ['M', 'K', 'D', 'T', 'H', '∆'];
// Timing lives on the Competitions tab only (the web app never shows it).
var TIMING_SETTINGS = [
  ['Minutes per fight before semi-finals', 3, 'Pool fights, play-offs and quarter-finals. In team events, per bout.'],
  ['Minutes per fight from semi-finals', 5, 'Semi-finals and final'],
  ['Start time', '', 'Type a time like 9:00 to get a finish time'],
];
var TIMING_ROWS = ['Time estimate', 'Fights before semi-finals', 'Fights from semi-finals', 'Estimated time', 'Estimated finish'];
var MAX_COMPS = 8;

// Column layout of a Fights tab. Team tabs have an extra Bout column after Court.
function layout_(type) {
  var t = type === 'team' ? 1 : 0;
  // Laid out like the original score sheets: Red, Red's marks, Forfeit, White's marks, Forfeit, White,
  // Fight complete, Result. Five mark boxes a side.
  var L = { team: !!t, nm: 5, order: 1, code: 2, stage: 3, court: 4, bout: t ? 5 : 0, red: 5 + t, rm: 6 + t, rF: 11 + t, wm: 12 + t, wF: 17 + t, white: 18 + t, done: 19 + t, winner: 20 + t, shinpan: 21 + t, rIpp: 24 + t, wIpp: 25 + t, pool: 26 + t, redFrom: 27 + t, whiteFrom: 28 + t, hantei: 29 + t };
  L.n = 29 + t;
  L.panel = L.n + 2; // pool tables start here, after one empty column
  L.headers = ['#', 'Fight', 'Stage', 'Court'].concat(t ? ['Bout'] : [], ['Red', '', '', '', '', '', 'Forfeit', '', '', '', '', '', 'Forfeit', 'White', 'Fight complete', 'Result', 'Shushin', 'Fukushin', 'Fukushin', 'Red ippon', 'White ippon', 'Pool', 'Red from', 'White from', 'Hantei']);
  return L;
}
function colLetter_(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  var draw = ui.createMenu('Generate draw');
  var comps = [];
  try { comps = readComps_(); } catch (e) {}
  comps.slice(0, MAX_COMPS).forEach(function (c, i) { draw.addItem(c.name, 'drawComp' + (i + 1)); });
  if (!comps.length) draw.addItem('Add competitions on the Competitions tab first', 'setupSheets');
  ui.createMenu('Shiai')
    .addSubMenu(draw)
    .addItem('Add play-off fights', 'addPlayoffs')
    .addItem('Redo shinpan rotation from the next fight', 'rotateShinpanMenu')
    .addItem('Refresh standings', 'refreshNow')
    .addItem('Update public board', 'refreshBoard')
    .addSeparator()
    .addItem('Set up sheets', 'setupSheets')
    .addItem('Tidy Fights formatting', 'formatAllMenu')
    .addToUi();
}
function drawComp1() { generateDraw_(0); } function drawComp2() { generateDraw_(1); } function drawComp3() { generateDraw_(2); } function drawComp4() { generateDraw_(3); }
function drawComp5() { generateDraw_(4); } function drawComp6() { generateDraw_(5); } function drawComp7() { generateDraw_(6); } function drawComp8() { generateDraw_(7); }

// Runs for every edit by a person.
function onEdit(e) {
  try {
    var name = e && e.range ? e.range.getSheet().getName() : '';
    if (name === TAB.board) return;
    var comps = readComps_();
    var hit = comps.filter(function (c) { return fightsTab_(c) === name; })[0];
    if (hit) refreshComp_(hit);
    else if ([TAB.entries, TAB.comps, TAB.spirit].indexOf(name) >= 0) comps.forEach(refreshComp_);
    publishBoard_();
  } catch (err) { /* never block a scorer's edit */ }
}

function refreshNow() { readComps_().forEach(refreshComp_); publishBoard_(); SpreadsheetApp.getActive().toast('Standings and knockout names updated.'); }
function formatAllMenu() { readComps_().forEach(function (c) { var sh = sheet_(fightsTab_(c)); if (sh) formatFights_(sh, c); }); SpreadsheetApp.getActive().toast('Fights tabs tidied.'); }

function sheet_(name) { return SpreadsheetApp.getActive().getSheetByName(name); }
function fightsTab_(c) { return c.name + ' Fights'; }
function standingsTab_(c) { return c.name + ' Standings'; }

function makeTab_(name, headers, widths) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#1f2a44').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    (widths || []).forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  }
  return sh;
}

function setupSheets() { setupSheets_(); onOpen(); }
function setupSheets_() {
  var ss = SpreadsheetApp.getActive();
  var c = ss.getSheetByName(TAB.comps);
  if (!c) {
    c = ss.insertSheet(TAB.comps, 0);
    c.getRange(1, 1, 1, 2).setValues([['Event name', 'Shiai']]).setFontWeight('bold');
    c.getRange(3, 1, 1, 4).setValues([['Setting', 'Kids', 'Juniors', 'Teams']]).setFontWeight('bold').setBackground('#1f2a44').setFontColor('#ffffff');
    c.getRange(4, 1, COMP_SETTINGS.length, 4).setValues(COMP_SETTINGS.map(function (r) { return [r[0], r[2], r[2], r[1] === 'type' ? 'Team' : r[2]]; }));
    c.setColumnWidth(1, 240);
  }
  makeTab_(TAB.entries, ['Competition', 'Name', 'Dojo', 'Grade', 'Pool', 'Team', 'Age'], [120, 220, 160, 70, 60, 140, 50]);
  makeTab_(TAB.shinpan, ['Shinpan'], [220]);
  makeTab_(TAB.spirit, ['Competition', 'Shinpan', 'Vote 1', 'Vote 2'], [120, 220, 220, 220]);
  readComps_().forEach(function (comp) {
    var sh = makeTab_(fightsTab_(comp), layout_(comp.settings.type).headers);
    makeTab_(standingsTab_(comp), ['Pool', 'Place', comp.settings.type === 'team' ? 'Team' : 'Fighter', 'Dojo', 'Fought', 'Won', 'Drawn', 'Lost', 'Ippon', 'Points', 'Note'], [60, 60, 220, 200, 60, 60, 60, 60, 60, 60, 260]);
    formatFights_(sh, comp);
  });
  timingRows_();
}

// Adds the timing settings and the time estimate rows to the Competitions tab if they are missing,
// and (re)writes the estimate formulas for every competition column.
function timingRows_() {
  var sh = sheet_(TAB.comps);
  if (!sh) return;
  var v = sh.getDataRange().getValues();
  var h = -1;
  v.forEach(function (r, i) { if (h < 0 && String(r[0]).trim().toLowerCase() === 'setting') h = i; });
  if (h < 0) return;
  var cols = [], notes = 0;
  v[h].forEach(function (x, c) {
    var name = String(x).trim();
    if (!c || !name) return;
    if (/^notes?$/i.test(name)) notes = c + 1; else cols.push({ col: c + 1, name: name });
  });
  var labels = v.map(function (r) { return String(r[0]).trim().toLowerCase(); });
  var rowOf = function (label) { var i = labels.indexOf(label.toLowerCase()); return i < 0 ? 0 : i + 1; };
  var add = function (label, value, note, bold) {
    var r = sh.getLastRow() + 1;
    sh.getRange(r, 1).setValue(label).setFontWeight('bold');
    if (value !== null) cols.forEach(function (c) { sh.getRange(r, c.col).setValue(value); });
    if (note && notes) sh.getRange(r, notes).setValue(note).setFontColor('#777777');
    if (bold) sh.getRange(r, 1).setFontColor('#1f2a44');
    labels[r - 1] = label.toLowerCase();
    return r;
  };
  TIMING_SETTINGS.forEach(function (t) { if (!rowOf(t[0])) add(t[0], t[1], t[2]); });
  if (!rowOf(TIMING_ROWS[0])) { sh.getRange(sh.getLastRow() + 2, 1).setValue(TIMING_ROWS[0]).setFontWeight('bold').setFontSize(12); labels[sh.getLastRow() - 1] = TIMING_ROWS[0].toLowerCase(); }
  TIMING_ROWS.slice(1).forEach(function (t) { if (!rowOf(t)) add(t, null, ''); });
  var R = {
    type: rowOf('Type'), courts: rowOf('Courts (shiaijo)'), early: rowOf(TIMING_SETTINGS[0][0]), late: rowOf(TIMING_SETTINGS[1][0]), start: rowOf(TIMING_SETTINGS[2][0]),
    nEarly: rowOf(TIMING_ROWS[1]), nLate: rowOf(TIMING_ROWS[2]), time: rowOf(TIMING_ROWS[3]), finish: rowOf(TIMING_ROWS[4]),
  };
  var f = shiaiTimingFormulas;
  cols.forEach(function (c) {
    var L = colLetter_(c.col);
    var team = /^team/i.test(String(sh.getRange(R.type, c.col).getValue()));
    var fx = f(c.name + ' Fights', team, L, R);
    sh.getRange(R.nEarly, c.col).setFormula(fx.early);
    sh.getRange(R.nLate, c.col).setFormula(fx.late);
    sh.getRange(R.time, c.col).setFormula(fx.time).setNumberFormat('[h]:mm');
    sh.getRange(R.finish, c.col).setFormula(fx.finish).setNumberFormat('h:mm');
    sh.getRange(R.start, c.col).setNumberFormat('h:mm');
    [R.nEarly, R.nLate, R.time, R.finish].forEach(function (r) { sh.getRange(r, c.col).setBackground('#eef1f7').setHorizontalAlignment('center'); });
  });
  if (notes && cols.length) {
    sh.getRange(R.time, notes).setFormula('="All competitions one after another: "&TEXT(SUM(' + colLetter_(cols[0].col) + R.time + ':' + colLetter_(cols[cols.length - 1].col) + R.time + '),"[h]:mm")').setFontColor('#777777');
    sh.getRange(R.nEarly, notes).setValue('Counted from the Fights tab. Courts run side by side.').setFontColor('#777777');
  }
}

function readEvent_() {
  var sh = sheet_(TAB.comps);
  return sh ? String(sh.getRange(1, 2).getValue() || '').trim() : '';
}

// Competitions tab: the row starting "Setting" names the competitions; rows below hold settings.
/* Read memo: only switched on during read-only phases (building the reply and the board), so a
   save never sees stale rows. */
var MEMO_ = null;
function memo_(key, fn) {
  if (!MEMO_) return fn();
  if (!(key in MEMO_)) MEMO_[key] = fn();
  return MEMO_[key];
}
function reading_(fn) {
  var was = MEMO_; MEMO_ = MEMO_ || {};
  try { return fn(); } finally { MEMO_ = was; }
}

function readComps_() { return memo_('comps', readCompsNow_); }
function readCompsNow_() {
  var sh = sheet_(TAB.comps);
  if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getRange(1, 1, sh.getLastRow(), Math.max(2, sh.getLastColumn())).getValues();
  var h = -1;
  v.forEach(function (r, i) { if (h < 0 && String(r[0]).trim().toLowerCase() === 'setting') h = i; });
  if (h < 0) return [];
  var keyOf = {};
  COMP_SETTINGS.forEach(function (r) { keyOf[r[0].toLowerCase()] = r[1]; });
  var comps = [];
  for (var c = 1; c < v[h].length; c++) {
    var name = String(v[h][c]).trim();
    if (!name || /^notes?$/i.test(name)) continue;
    var s = { title: name };
    for (var i = h + 1; i < v.length; i++) { var k = keyOf[String(v[i][0]).trim().toLowerCase()]; if (k) s[k] = v[i][c]; }
    s = Object.assign(shiaiSettings(s), { showSpirit: s.showSpirit });
    comps.push({ name: name, settings: s });
  }
  return comps;
}

function readEntryRows_() { return memo_('entries', readEntryRowsNow_); }
function readEntryRowsNow_() {
  var sh = sheet_(TAB.entries);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues();
}

// Entrants for a competition: fighters, or teams built from their members' rows.
function entrants_(comp, rows) {
  rows = rows || readEntryRows_();
  var mine = rows.filter(function (r) { return shiaiKey(r[0]) === shiaiKey(comp.name) && String(r[1]).trim(); });
  if (comp.settings.type !== 'team') return mine.map(function (r) { return { name: r[1], dojo: r[2], grade: r[3], pool: r[4] }; });
  var teams = {}, order = [];
  mine.forEach(function (r) {
    var t = shiaiClean(r[5]); if (!t) return;
    var k = shiaiKey(t);
    if (!teams[k]) { teams[k] = { name: t, dojos: [], pool: '', members: [] }; order.push(k); }
    teams[k].members.push(shiaiClean(r[1]));
    if (shiaiClean(r[2]) && teams[k].dojos.indexOf(shiaiClean(r[2])) < 0) teams[k].dojos.push(shiaiClean(r[2]));
    if (!teams[k].pool && shiaiClean(r[4])) teams[k].pool = shiaiClean(r[4]);
  });
  return order.map(function (k) { var t = teams[k]; return { name: t.name, dojo: t.dojos.join(', '), pool: t.pool, members: t.members }; });
}

function readFightRows_(comp) { return memo_('rows|' + comp.name, function () { return readFightRowsNow_(comp); }); }
function readFightRowsNow_(comp) {
  var sh = sheet_(fightsTab_(comp));
  var L = layout_(comp.settings.type);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, L.n).getValues();
}

function marksOf_(L, r) { return r.slice(L.rm - 1, L.rm - 1 + L.nm).concat(r.slice(L.wm - 1, L.wm - 1 + L.nm)); }
function hasMarks_(L, r) { return marksOf_(L, r).some(function (v) { return String(v).trim(); }); }
function isHead_(L, r) { return !L.team || String(r[L.bout - 1]).trim().toLowerCase() === 'team'; }

function decisionOfRow_(L, r) {
  var rf = r[L.rF - 1] === true, wf = r[L.wF - 1] === true, h = String(r[L.hantei - 1] || '').trim().toLowerCase();
  if (rf && wf) return 'Both forfeit';
  if (rf) return 'White wins by forfeit';
  if (wf) return 'Red wins by forfeit';
  if (h === 'red') return 'Red wins by hantei';
  if (h === 'white') return 'White wins by hantei';
  return '';
}

function rowToFight_(L) {
  return function (r, i) {
    return {
      order: i + 1, code: r[L.code - 1], stage: r[L.stage - 1], court: r[L.court - 1], bout: L.bout ? r[L.bout - 1] : '',
      red: r[L.red - 1], rm: r.slice(L.rm - 1, L.rm - 1 + L.nm), wm: r.slice(L.wm - 1, L.wm - 1 + L.nm), white: r[L.white - 1],
      // A ticked Forfeit means that side forfeits, so the other side wins (and the fight is over).
      decision: decisionOfRow_(L, r), row: i + 2,
      done: r[L.done - 1] === true || r[L.rF - 1] === true || r[L.wF - 1] === true, shinpan: r.slice(L.shinpan - 1, L.shinpan + 2),
      pool: r[L.pool - 1], redFrom: r[L.redFrom - 1], whiteFrom: r[L.whiteFrom - 1],
    };
  };
}

function readSpirit_(comp) { return memo_('spirit|' + comp.name, function () { return readSpiritNow_(comp); }); }
function readSpiritNow_(comp) {
  var sh = sheet_(TAB.spirit);
  if (!sh || sh.getLastRow() < 2) return [];
  var out = [];
  sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(3, sh.getLastColumn())).getValues().forEach(function (r) {
    if (shiaiKey(r[0]) !== shiaiKey(comp.name)) return;
    r.slice(2).forEach(function (v) { if (String(v).trim()) out.push(v); });
  });
  return out;
}

function readRaw_(comp, entryRows) { return memo_('raw|' + comp.name, function () { return readRawNow_(comp, entryRows); }); }
function readRawNow_(comp, entryRows) {
  var L = layout_(comp.settings.type);
  return { settings: comp.settings, fighters: entrants_(comp, entryRows), fights: readFightRows_(comp).map(rowToFight_(L)), spirit: readSpirit_(comp) };
}

function blankRow_(L, f) {
  var r = new Array(L.n).fill('');
  r[L.order - 1] = f.order || ''; r[L.code - 1] = f.code; r[L.stage - 1] = f.stage || ''; r[L.court - 1] = f.court || '';
  if (L.bout) r[L.bout - 1] = f.bout || '';
  r[L.red - 1] = f.red || ''; r[L.white - 1] = f.white || ''; r[L.done - 1] = false; r[L.rF - 1] = false; r[L.wF - 1] = false;
  if (f.shinpan) for (var k = 0; k < 3; k++) r[L.shinpan - 1 + k] = f.shinpan[k] || '';
  r[L.pool - 1] = f.pool || ''; r[L.redFrom - 1] = f.redFrom || ''; r[L.whiteFrom - 1] = f.whiteFrom || '';
  return r;
}

function generateDraw_(idx) {
  var ui = SpreadsheetApp.getUi();
  var comp = readComps_()[idx];
  if (!comp) { ui.alert('That competition is no longer on the Competitions tab. Reload the sheet to refresh the menu.'); return; }
  var L = layout_(comp.settings.type);
  var entryRows = readEntryRows_();
  var entrants = entrants_(comp, entryRows);
  var what = L.team ? 'teams' : 'fighters';
  if (entrants.length < 2) { ui.alert('Add at least two ' + what + ' for ' + comp.name + ' on the Entries tab first (Competition column = "' + comp.name + '"' + (L.team ? ', with a Team name' : '') + ').'); return; }
  var existing = readFightRows_(comp);
  var started = existing.some(function (r) { return r[L.done - 1] === true || hasMarks_(L, r); });
  var msg = started
    ? comp.name + ' already has scores. A new draw replaces every ' + comp.name + ' fight and its scores. Continue?'
    : 'Make the ' + comp.name + ' draw for ' + entrants.length + ' ' + what + '? Any without a pool get one.';
  if (ui.alert('Generate draw: ' + comp.name, msg, ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  var n = doDraw_(comp);
  publishBoard_();
  var sh = sheet_(fightsTab_(comp));
  sh.activate();
  ui.alert('Draw ready', comp.name + ': ' + n + (L.team ? ' team matches' : ' fights') + ' on the "' + fightsTab_(comp) + '" tab.', ui.ButtonSet.OK);
}

// Makes a competition's draw from its Entries and writes the Fights tab. Returns the number of matches.
function doDraw_(comp) {
  setupSheets_();
  var L = layout_(comp.settings.type);
  var entryRows = readEntryRows_();
  var entrants = entrants_(comp, entryRows);
  if (entrants.length < 2) throw new Error('Add at least two ' + (L.team ? 'teams' : 'fighters') + ' for ' + comp.name + ' first.');

  var draw = shiaiBuildDraw(entrants, comp.settings);
  // Write pools back to the Entries tab.
  var poolOf = {};
  draw.fighters.forEach(function (f) { poolOf[shiaiKey(f.name)] = f.pool; });
  var esh = sheet_(TAB.entries);
  esh.getRange(2, 5, entryRows.length, 1).setValues(entryRows.map(function (r) {
    if (shiaiKey(r[0]) !== shiaiKey(comp.name)) return [r[4]];
    var k = shiaiKey(L.team ? r[5] : r[1]);
    return [poolOf[k] || r[4]];
  }));

  var list = draw.fights;
  if (L.team) {
    var members = {};
    entrants.forEach(function (t) { members[shiaiKey(t.name)] = t.members; });
    list = shiaiTeamRows(draw.fights, comp.settings, members);
  }
  var rows = list.map(function (f) { return blankRow_(L, f); });
  rotateShinpanRows_(comp, L, rows, 0, shinpanStart_(comp));
  var sh = sheet_(fightsTab_(comp));
  if (sh.getMaxRows() > 1) sh.getRange(2, 1, sh.getMaxRows() - 1, sh.getMaxColumns()).clear();
  if (sh.getMaxRows() < rows.length + 1) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 1 - sh.getMaxRows());
  sh.getRange(2, 1, rows.length, L.n).setValues(rows);
  formatFights_(sh, comp);
  timingRows_();
  refreshComp_(comp);
  return draw.fights.length;
}

function addPlayoffs() {
  var ui = SpreadsheetApp.getUi();
  var added = doPlayoffs_();
  publishBoard_();
  if (!added) { ui.alert('No play-offs needed right now. A play-off is only added once a pool is finished and a tie decides a place.'); return; }
  ui.alert(added + (added === 1 ? ' play-off match added.' : ' play-off matches added.') + ' The winner takes the higher place.');
}

// Adds play-off fights for every finished pool with a deciding tie. Returns how many were added.
function doPlayoffs_() {
  var added = 0;
  var entryRows = readEntryRows_();
  readComps_().forEach(function (comp) {
    var L = layout_(comp.settings.type);
    var state = shiaiCompute(readRaw_(comp, entryRows));
    var sh = sheet_(fightsTab_(comp));
    if (!sh) return;
    var rows = readFightRows_(comp);
    var isHead = function (r) { return !L.team || String(r[L.bout - 1]).trim().toLowerCase() === 'team'; };
    var members = {};
    entrants_(comp, entryRows).forEach(function (t) { members[shiaiKey(t.name)] = t.members || []; });
    state.pools.forEach(function (p) {
      if (!p.playoffNeeded) return;
      var existing = rows.filter(function (r) { return isHead(r) && String(r[L.pool - 1]).toUpperCase() === p.pool && /-PO\d+$/i.test(r[L.code - 1]); }).length;
      var places = {};
      p.rows.filter(function (r) { return r.tied; }).forEach(function (r) { (places[r.place] = places[r.place] || []).push(r.name); });
      Object.keys(places).forEach(function (pl) {
        var names = places[pl];
        shiaiRoundRobin(names.length).forEach(function (pair) {
          // Insert after the last row that belongs to this pool (for teams, after that match's bouts).
          var last = -1, court = 1;
          rows.forEach(function (r, i) { if (isHead(r) && String(r[L.pool - 1]).toUpperCase() === p.pool) { last = i; court = r[L.court - 1] || 1; } });
          while (L.team && last + 1 < rows.length && !isHead(rows[last + 1])) last++;
          existing++;
          var m = { code: p.pool + '-PO' + existing, stage: 'Pool ' + p.pool + ' play-off', court: court, red: names[pair[0] - 1], white: names[pair[1] - 1], pool: p.pool };
          var newRows = (L.team ? shiaiTeamRows([m], comp.settings, members) : [m]).map(function (f) { return blankRow_(L, f); });
          sh.insertRowsAfter(last + 2, newRows.length);
          sh.getRange(last + 3, 1, newRows.length, L.n).setValues(newRows);
          Array.prototype.splice.apply(rows, [last + 1, 0].concat(newRows));
          added++;
        });
      });
    });
    if (added) { formatFights_(sh, comp); rotateShinpan_(comp); refreshComp_(comp); }
  });
  return added;
}

/* ---------- Shinpan rotation ----------
   The Shinpan tab lists the referees in rotation order. Three referee each match; every two matches one
   steps out and the next on the list steps in. The rotation carries on from one competition to the next
   in the order of the Competitions tab. Names can be changed by hand on any match; they are only
   rewritten by Generate draw or by Shiai > Redo shinpan rotation from the next fight. */
function readShinpan_() { return memo_('shinpan', readShinpanNow_); }
function readShinpanNow_() {
  var sh = sheet_(TAB.shinpan);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return shiaiClean(r[0]); }).filter(Boolean);
}
function matchCount_(comp) {
  var L = layout_(comp.settings.type);
  return readFightRows_(comp).filter(function (r) { return isHead_(L, r) && String(r[L.code - 1]).trim(); }).length;
}
// Which rotation block the first match of this competition starts on.
function shinpanStart_(comp) {
  var start = 0;
  readComps_().some(function (c) {
    if (c.name === comp.name) return true;
    start += Math.ceil(matchCount_(c) / SHIAI_MATCHES_PER_ROTATION);
    return false;
  });
  return start;
}
// Fills the shinpan cells of match rows from match number `from` (0-based) on. Multiple courts split the list.
function rotateShinpanRows_(comp, L, rows, from, start, names) {
  names = names || readShinpan_();
  if (!names.length) return;
  var courts = Math.max(1, comp.settings.courts);
  var perCourt = {}, idx = 0;
  rows.forEach(function (r) {
    if (!isHead_(L, r) || !String(r[L.code - 1]).trim()) return;
    var c = Math.max(1, Number(r[L.court - 1]) || 1);
    var j = perCourt[c] = (perCourt[c] === undefined ? 0 : perCourt[c] + 1);
    var mine = courts > 1 ? names.filter(function (_, i) { return i % courts === (c - 1) % courts; }) : names;
    if (idx++ >= from) {
      var set = shiaiShinpanFor(mine, start + Math.floor(j / SHIAI_MATCHES_PER_ROTATION));
      for (var k = 0; k < 3; k++) r[L.shinpan - 1 + k] = set[k];
    }
  });
}
function rotateShinpan_(comp) {
  var L = layout_(comp.settings.type);
  var sh = sheet_(fightsTab_(comp));
  var rows = readFightRows_(comp);
  if (!sh || !rows.length) return 0;
  var heads = rows.filter(function (r) { return isHead_(L, r) && String(r[L.code - 1]).trim(); });
  var state = shiaiCompute(readRaw_(comp));
  var from = 0;
  while (from < state.fights.length && state.fights[from].done) from++;
  rotateShinpanRows_(comp, L, rows, from, shinpanStart_(comp));
  sh.getRange(2, L.shinpan, rows.length, 3).setValues(rows.map(function (r) { return r.slice(L.shinpan - 1, L.shinpan + 2); }));
  return heads.length - from;
}
// Redo the rotation for every competition in one pass: one read and one write per Fights tab.
function rotateAll_() {
  var names = readShinpan_();
  if (!names.length) return 0;
  var entryRows = readEntryRows_();
  var start = 0, left = 0;
  readComps_().forEach(function (comp) {
    var L = layout_(comp.settings.type);
    var sh = sheet_(fightsTab_(comp));
    var rows = sh ? readFightRowsNow_(comp) : [];
    var heads = rows.filter(function (r) { return isHead_(L, r) && String(r[L.code - 1]).trim(); }).length;
    if (rows.length) {
      var state = shiaiCompute({ settings: comp.settings, fighters: entrants_(comp, entryRows), fights: rows.map(rowToFight_(L)), spirit: [] });
      var from = 0;
      while (from < state.fights.length && state.fights[from].done) from++;
      rotateShinpanRows_(comp, L, rows, from, start, names);
      sh.getRange(2, L.shinpan, rows.length, 3).setValues(rows.map(function (r) { return r.slice(L.shinpan - 1, L.shinpan + 2); }));
      left += heads - from;
    }
    start += Math.ceil(heads / SHIAI_MATCHES_PER_ROTATION);
  });
  return left;
}
function rotateShinpanMenu() {
  var names = readShinpan_();
  if (names.length < 3) { SpreadsheetApp.getUi().alert('Put at least three shinpan on the Shinpan tab, in the order they rotate.'); return; }
  var n = rotateAll_();
  publishBoard_();
  SpreadsheetApp.getActive().toast('Shinpan filled in for ' + n + ' matches still to fight.');
}

// The pool tables beside the fights, so the table can see who is through and when a play-off is needed.
function writePoolPanel_(sh, L, state) {
  var panel = shiaiPoolPanel(state);
  var cache = CacheService.getScriptCache();
  var key = 'panel|' + sh.getSheetId() + '|' + L.panel;
  var sig = JSON.stringify(panel);
  if (sig.length < 90000 && cache.get(key) === sig) return;
  var maxRows = sh.getMaxRows();
  var need = panel.rows.length + 1;
  if (maxRows < need) { sh.insertRowsAfter(maxRows, need - maxRows); maxRows = need; }
  if (sh.getMaxColumns() < L.panel + 8) sh.insertColumnsAfter(sh.getMaxColumns(), L.panel + 8 - sh.getMaxColumns());
  var first = !cache.get(key);
  if (first) {
    sh.getRange(1, L.panel, maxRows, 9).clearContent().clearFormat().clearDataValidations();
    sh.getRange(1, L.panel, 1, 9).setValues([['POOLS (fills in by itself)', '', '', '', '', '', '', '', '']]).setFontWeight('bold').setBackground('#1f2a44').setFontColor('#ffffff');
    sh.setColumnWidth(L.panel - 1, 24);
    [50, 190, 55, 50, 55, 45, 50, 55, 110].forEach(function (w, i) { sh.setColumnWidth(L.panel + i, w); });
  } else if (maxRows > need) {
    sh.getRange(need + 1, L.panel, maxRows - need, 9).clearContent().clearFormat();
  }
  if (panel.rows.length) {
    var colours = { title: '#dde3ef', 'done-title': '#e2f1e8', 'alert-title': '#fde2c4', head: '#f4f5f8', tied: '#fff1d6', through: '#e9f6ee', alert: '#fde2c4' };
    var bold = { title: 1, 'done-title': 1, 'alert-title': 1, head: 1, alert: 1 };
    var nine = function (v) { return [v, v, v, v, v, v, v, v, v]; };
    var bg = panel.styles.map(function (st) { return nine(colours[st] || null); });
    var fw = panel.styles.map(function (st) { return nine(bold[st] ? 'bold' : 'normal'); });
    var fc = panel.styles.map(function (st) { return nine(st === 'alert' || st === 'alert-title' ? '#9a3412' : st === 'note' ? '#555555' : '#000000'); });
    sh.getRange(2, L.panel, panel.rows.length, 9).setValues(panel.rows).setBackgrounds(bg).setFontWeights(fw).setFontColors(fc).setVerticalAlignment('middle');
  }
  try { cache.put(key, sig, 21600); } catch (e) { /* too big to remember: it just rewrites next time */ }
}

// Recalculate one competition and write back: match numbers, knockout names, team results, Standings.
function refreshComp_(comp) {
  var lock = LockService.getDocumentLock();
  var got = lock.tryLock(8000);
  try {
    var L = layout_(comp.settings.type);
    var sh = sheet_(fightsTab_(comp));
    if (!sh) return;
    var rows = readFightRows_(comp);
    var state = shiaiCompute(readRaw_(comp));
    if (rows.length) {
      var byOrder = {};
      state.fights.forEach(function (f) { byOrder[f.order] = f; });
      var nums = [], red = [], white = [];
      var teamCols = { done: [], rIpp: [], wIpp: [], winner: [] };
      var match = 0, cur = null, k = 0;
      rows.forEach(function (r) {
        var head = !L.team || String(r[L.bout - 1]).trim().toLowerCase() === 'team';
        var filled = String(r[L.red - 1]).trim() || String(r[L.white - 1]).trim() || String(r[L.redFrom - 1]).trim();
        var f = null;
        if (head && filled) { match++; f = byOrder[match]; cur = f; k = 0; }
        nums.push([head && filled ? match : '']);
        if (L.team && !head) {
          // Knockout lineups: once a team is known, fill empty bout names with its members in order.
          var po = SHIAI_PLAYOFF_RE.test(String(r[L.bout - 1]).trim());
          var rn = r[L.red - 1], wn = r[L.white - 1];
          // Before the bout starts, a name that isn't in the team (empty, or left from an earlier result) is replaced.
          var started = r[L.done - 1] === true || hasMarks_(L, r);
          var inTeam = function (n, side) { return cur[side].members.some(function (m) { return shiaiKey(m) === shiaiKey(n); }); };
          if (cur && !po && !started && !cur.red.pending && !inTeam(rn, 'red')) rn = cur.red.members[k] || '';
          if (cur && !po && !started && !cur.white.pending && !inTeam(wn, 'white')) wn = cur.white.members[k] || '';
          red.push([rn]); white.push([wn]); k++;
        } else {
          red.push([f && r[L.redFrom - 1] ? f.red.label : r[L.red - 1]]);
          white.push([f && r[L.whiteFrom - 1] ? f.white.label : r[L.white - 1]]);
        }
        if (L.team) {
          if (head && f) {
            teamCols.done.push([f.done]);
            teamCols.rIpp.push([f.wins ? f.wins.red + ' won, ' + f.red.ippon + ' ipp, ' + f.scores.red + ' pts' : '']);
            teamCols.wIpp.push([f.wins ? f.wins.white + ' won, ' + f.white.ippon + ' ipp, ' + f.scores.white + ' pts' : '']);
            teamCols.winner.push([f.result === 'red' ? f.red.name : f.result === 'white' ? f.white.name : f.result === 'draw' ? 'Draw' : f.level ? 'Level: fight the daihyosen' : '']);
          } else {
            teamCols.done.push([r[L.done - 1]]); teamCols.rIpp.push([null]); teamCols.wIpp.push([null]); teamCols.winner.push([null]);
          }
        }
      });
      var same = function (col, vals) { return rows.every(function (r, i) { return String(r[col - 1]) === String(vals[i][0]); }); };
      if (!same(L.order, nums)) sh.getRange(2, L.order, rows.length, 1).setValues(nums);
      if (!same(L.red, red)) sh.getRange(2, L.red, rows.length, 1).setValues(red);
      if (!same(L.white, white)) sh.getRange(2, L.white, rows.length, 1).setValues(white);
      if (L.team) {
        // Only touch the Team rows, so the bout formulas stay in place.
        rows.forEach(function (r, i) {
          if (teamCols.winner[i][0] === null) return;
          if (r[L.done - 1] !== teamCols.done[i][0]) sh.getRange(i + 2, L.done).setValue(teamCols.done[i][0]);
          if (String(r[L.rIpp - 1]) !== String(teamCols.rIpp[i][0]) || String(r[L.wIpp - 1]) !== String(teamCols.wIpp[i][0])) sh.getRange(i + 2, L.rIpp, 1, 2).setValues([[teamCols.rIpp[i][0], teamCols.wIpp[i][0]]]);
          if (String(r[L.winner - 1]) !== String(teamCols.winner[i][0])) sh.getRange(i + 2, L.winner).setValue(teamCols.winner[i][0]);
        });
      }
    }
    writeStandings_(comp, state);
    writePoolPanel_(sh, L, state);
  } finally { if (got) lock.releaseLock(); }
}

function writeStandings_(comp, state) {
  var sh = sheet_(standingsTab_(comp));
  if (!sh) return;
  var out = [];
  state.pools.forEach(function (p) {
    p.rows.forEach(function (r) {
      var note = r.tied ? 'Tied: play-off needed' : r.qualified ? 'Through to knockout' : !p.complete ? p.played + ' of ' + p.total + ' done' : '';
      out.push([p.pool, r.place, r.name, (r.members && r.members.length ? r.members.join(', ') : r.dojo), r.fought, r.w, r.d, r.l, r.ipp, r.points, note]);
    });
  });
  var cache = CacheService.getScriptCache(), key = 'stand|' + sh.getSheetId();
  var sig = JSON.stringify([out, state.results || null]);
  if (sig.length < 90000 && cache.get(key) === sig) return;
  try { cache.put(key, sig, 21600); } catch (e) {}
  if (sh.getMaxRows() > 1) sh.getRange(2, 1, sh.getMaxRows() - 1, 11).clearContent();
  if (out.length) {
    if (sh.getMaxRows() < out.length + 1) sh.insertRowsAfter(sh.getMaxRows(), out.length + 1 - sh.getMaxRows());
    sh.getRange(2, 1, out.length, 11).setValues(out);
  }
  sh.getRange(1, 13, 8, 2).clearContent();
  if (state.results) {
    var r = state.results;
    var res = [['Results', ''], ['1st', r.first], ['2nd', r.second]].concat(r.thirds.map(function (t) { return ['3rd', t]; }));
    sh.getRange(1, 13, res.length, 2).setValues(res);
  }
}

function formatFights_(sh, comp) {
  if (!sh) return;
  var L = layout_(comp.settings.type);
  var A = function (c) { return colLetter_(c); };
  sh.getRange(1, 1, 1, L.n).setValues([L.headers]).setFontWeight('bold').setBackground('#1f2a44').setFontColor('#ffffff').setHorizontalAlignment('center');
  sh.getRange(1, L.red, 1, L.nm + 2).setBackground('#c8102e');
  sh.getRange(1, L.wm, 1, L.nm + 2).setBackground('#ffffff').setFontColor('#1f2a44');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(L.team ? 5 : 2);
  var widths = {};
  widths[L.order] = 40; widths[L.code] = 70; widths[L.stage] = 130; widths[L.court] = 50; if (L.bout) widths[L.bout] = 80;
  widths[L.red] = 200; widths[L.white] = 200; widths[L.rF] = 62; widths[L.wF] = 62; widths[L.done] = 70; widths[L.rIpp] = 95; widths[L.wIpp] = 95; widths[L.winner] = 200;
  widths[L.shinpan] = 150; widths[L.shinpan + 1] = 150; widths[L.shinpan + 2] = 150; widths[L.pool] = 45; widths[L.redFrom] = 80; widths[L.whiteFrom] = 80;
  for (var c = 1; c <= L.n; c++) sh.setColumnWidth(c, widths[c] || 32);
  var n = Math.max(1, sh.getLastRow() - 1);
  sh.getRange(2, 1, n, L.n).setVerticalAlignment('middle');
  var markRule = SpreadsheetApp.newDataValidation().requireValueInList(MARKS, true).setAllowInvalid(false).setHelpText('M, K, D or T for ippon. H for a hansoku point, or just two ∆ on the other side.').build();
  [L.rm, L.wm].forEach(function (c) { sh.getRange(2, c, n, L.nm).setHorizontalAlignment('center').setFontWeight('bold').setDataValidation(markRule); });
  sh.getRange(2, L.rF, n, 1).insertCheckboxes(); sh.getRange(2, L.wF, n, 1).insertCheckboxes();
  sh.getRange(2, L.done, n, 1).insertCheckboxes();
  sh.getRange(2, L.hantei, n, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Red', 'White'], true).setAllowInvalid(false).setHelpText('Only after encho, where the competition allows hantei.').build());
  var shinpan = sheet_(TAB.shinpan);
  if (shinpan) sh.getRange(2, L.shinpan, n, 3).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(shinpan.getRange('A2:A'), true).setAllowInvalid(true).build());
  var entries = sheet_(TAB.entries);
  if (L.team && entries) {
    sh.getRange(2, L.red, n, 1).clearDataValidations(); sh.getRange(2, L.white, n, 1).clearDataValidations();
  }
  // Bout formulas. Team rows are left for the script, which writes the match result there.
  var vals = sh.getRange(2, 1, n, L.n).getValues();
  var rc = function (c) { return 'RC' + c; };
  var ipp = function (own, opp) {
    var o = rc(own) + ':' + rc(own + L.nm - 1), x = rc(opp) + ':' + rc(opp + L.nm - 1);
    return 'SUMPRODUCT(COUNTIF(' + o + ',{"M","K","D","T"}))+MAX(COUNTIF(' + o + ',"H"),INT(COUNTIF(' + x + ',"∆")/2))';
  };
  // A forfeit credits the winner with two ippon; both forfeiting scores nothing.
  var credit = function (mine, theirs, expr) { return 'IF(' + rc(mine) + '=TRUE,0,IF(' + rc(theirs) + '=TRUE,' + SHIAI_DEFAULTS.forfeitIppon + ',' + expr + '))'; };
  var fR = '=IF(' + rc(L.red) + '&' + rc(L.white) + '="","",' + credit(L.rF, L.wF, ipp(L.rm, L.wm)) + ')';
  var fW = '=IF(' + rc(L.red) + '&' + rc(L.white) + '="","",' + credit(L.wF, L.rF, ipp(L.wm, L.rm)) + ')';
  var redName = L.team ? 'IF(' + rc(L.red) + '="","Red",' + rc(L.red) + ')' : rc(L.red);
  var whiteName = L.team ? 'IF(' + rc(L.white) + '="","White",' + rc(L.white) + ')' : rc(L.white);
  // Level knockout fights, pool play-offs and the daihyosen go to encho instead of a draw.
  var winF = function (mustWin) {
    return '=IF(AND(' + rc(L.rF) + '=TRUE,' + rc(L.wF) + '=TRUE),"Draw",IF(' + rc(L.rF) + '=TRUE,' + whiteName + ',IF(' + rc(L.wF) + '=TRUE,' + redName + ',IF(' + rc(L.done) + '<>TRUE,"",IF(' + rc(L.hantei) + '="Red",' + redName + ',IF(' + rc(L.hantei) + '="White",' + whiteName + ',IF(' + rc(L.rIpp) + '>' + rc(L.wIpp) + ',' + redName + ',IF(' + rc(L.wIpp) + '>' + rc(L.rIpp) + ',' + whiteName + ',' + (mustWin ? '"Level: encho"' : '"Draw"') + '))))))))';
  };
  if (L.team) {
    fR = '=IF(' + rc(L.bout) + '="","",' + credit(L.rF, L.wF, ipp(L.rm, L.wm)) + ')';
    fW = '=IF(' + rc(L.bout) + '="","",' + credit(L.wF, L.rF, ipp(L.wm, L.rm)) + ')';
  }
  var formulas = vals.map(function (r) {
    var head = L.team && String(r[L.bout - 1]).trim().toLowerCase() === 'team';
    var mustWin = L.team ? SHIAI_PLAYOFF_RE.test(String(r[L.bout - 1]).trim()) : (!String(r[L.pool - 1]).trim() || /-PO\d*$/i.test(String(r[L.code - 1])));
    return head ? null : [fR, fW, winF(mustWin)];
  });
  formulas.forEach(function (f, i) { if (f) { sh.getRange(i + 2, L.rIpp, 1, 2).setFormulasR1C1([[f[0], f[1]]]); sh.getRange(i + 2, L.winner).setFormulaR1C1(f[2]); } });
  sh.getRange(2, L.rIpp, n, 2).setFontColor('#8a8f99').setHorizontalAlignment('center');
  sh.getRange(2, L.winner, n, 1).setFontColor('#1f2a44').setFontWeight('bold').setBackground('#eef1f7');
  sh.getRange(2, L.pool, n, 3).setFontColor('#8a8f99');
  sh.getRange(2, L.red, n, 1).setFontWeight('bold');
  sh.getRange(2, L.white, n, 1).setFontWeight('bold');

  var D = '$' + A(L.done), Cc = '$' + A(L.court), E = '$' + A(L.red), N = '$' + A(L.white), S = '$' + A(L.winner), B = L.bout ? '$' + A(L.bout) : '';
  var rules = [];
  var range = function (c, w) { return sh.getRange(2, c, n, w || 1); };
  if (L.team) {
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=' + B + '2="Team"').setBackground('#dde3ef').setBold(true).setRanges([sh.getRange(2, 1, n, L.n)]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(' + B + '2="Team",' + D + '2<>TRUE,COUNTIFS(' + Cc + '$2:' + Cc + '2,' + Cc + '2,' + B + '$2:' + B + '2,"Team",' + D + '$2:' + D + '2,FALSE)=1)').setBackground('#fff4c2').setRanges([range(1, 5)]).build());
  } else {
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=' + D + '2=TRUE').setFontColor('#9aa0aa').setRanges([range(1, 4)]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(' + D + '2<>TRUE,' + E + '2<>"",COUNTIFS(' + Cc + '$2:' + Cc + '2,' + Cc + '2,' + D + '$2:' + D + '2,FALSE)=1)').setBackground('#fff4c2').setRanges([range(1, 4)]).build());
  }
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(' + S + '2<>"",' + S + '2=' + E + '2)').setBackground('#f6c9cf').setRanges([range(L.red)]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(' + S + '2<>"",' + S + '2=' + N + '2)').setBackground('#dfe3ea').setRanges([range(L.white)]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=OR(LEFT(' + E + '2,5)="Pool ",LEFT(' + E + '2,9)="Winner of")').setFontColor('#8a8f99').setItalic(true).setRanges([range(L.red)]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=OR(LEFT(' + N + '2,5)="Pool ",LEFT(' + N + '2,9)="Winner of")').setFontColor('#8a8f99').setItalic(true).setRanges([range(L.white)]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('∆').setFontColor('#b45309').setRanges([range(L.rm, L.nm), range(L.wm, L.nm)]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenCellNotEmpty().setBackground('#fbe3e6').setRanges([range(L.rm, L.nm)]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenCellNotEmpty().setBackground('#eceff4').setRanges([range(L.wm, L.nm)]).build());
  sh.setConditionalFormatRules(rules);
}


/* ===================== ADMIN APP =====================
   The web app link opens the admin page, which scores fights and runs the day. Deploy it with
   "Who has access: Only myself" so only your Google account can open it. The sheet stays the
   record: you can still score in it directly.
====================================================== */
function compByName_(name) {
  var c = readComps_().filter(function (x) { return x.name === name; })[0];
  if (!c) throw new Error('No competition called ' + name + '.');
  return c;
}
// Raw settings as typed on the Competitions tab, by label, for the admin settings screen.
function readCompSettingRows_() {
  var sh = sheet_(TAB.comps);
  var v = sh.getDataRange().getValues();
  var h = -1;
  v.forEach(function (r, i) { if (h < 0 && String(r[0]).trim().toLowerCase() === 'setting') h = i; });
  var out = {};
  if (h < 0) return out;
  for (var c = 1; c < v[h].length; c++) {
    var name = String(v[h][c]).trim();
    if (!name || /^notes?$/i.test(name)) continue;
    var o = {};
    for (var i = h + 1; i < v.length; i++) {
      var label = String(v[i][0]).trim();
      if (!label) continue;
      var val = v[i][c];
      if (val instanceof Date) val = ('0' + val.getHours()).slice(-2) + ':' + ('0' + val.getMinutes()).slice(-2);
      o[label] = val;
    }
    out[name] = o;
  }
  return out;
}

function adminData_() {
  var entryRows = readEntryRows_();
  var esh = sheet_(TAB.entries);
  var entries = esh && esh.getLastRow() > 1 ? esh.getRange(2, 1, esh.getLastRow() - 1, 7).getValues() : [];
  var spiritSh = sheet_(TAB.spirit);
  var spirit = spiritSh && spiritSh.getLastRow() > 1 ? spiritSh.getRange(2, 1, spiritSh.getLastRow() - 1, 4).getValues() : [];
  var raw = readCompSettingRows_();
  return JSON.stringify({
    ok: true, event: readEvent_(), updated: new Date().toISOString(),
    shinpan: readShinpan_(),
    entries: entries.filter(function (r) { return String(r[1]).trim(); }),
    spirit: spirit.filter(function (r) { return String(r[0]).trim(); }),
    comps: readComps_().map(function (c) {
      return { name: c.name, settings: c.settings, setting: raw[c.name] || {}, raw: readRaw_(c, entryRows) };
    }),
  });
}

function adminLoad() { return reading_(adminData_); }

// patch: { rm:[], wm:[], rF, wF, done, hantei:'Red'|'White'|'', shinpan:[3], red, white }
function adminSave(compName, row, patch) {
  var comp = compByName_(compName);
  var L = layout_(comp.settings.type);
  var sh = sheet_(fightsTab_(comp));
  var lock = LockService.getDocumentLock(); lock.waitLock(10000);
  try {
    var r = sh.getRange(row, 1, 1, L.n).getValues()[0];
    var set = function (col, val) { r[col - 1] = val; };
    var marks = function (col, list) { for (var k = 0; k < L.nm; k++) set(col + k, (list || [])[k] || ''); };
    if (patch.rm) marks(L.rm, patch.rm);
    if (patch.wm) marks(L.wm, patch.wm);
    if ('rF' in patch) set(L.rF, !!patch.rF);
    if ('wF' in patch) set(L.wF, !!patch.wF);
    if ('done' in patch) set(L.done, !!patch.done);
    if ('hantei' in patch) set(L.hantei, patch.hantei || '');
    if (patch.shinpan) for (var k = 0; k < 3; k++) set(L.shinpan + k, patch.shinpan[k] || '');
    if (L.team && 'red' in patch) set(L.red, patch.red || '');
    if (L.team && 'white' in patch) set(L.white, patch.white || '');
    // Write only the typed cells, so the formulas in the row stay. Red to Fight complete has no formulas.
    var keys = Object.keys(patch);
    var scoring = keys.some(function (k) { return k !== 'shinpan' && k !== 'hantei'; });
    if (scoring) sh.getRange(row, L.red, 1, L.done - L.red + 1).setValues([r.slice(L.red - 1, L.done)]);
    if (patch.shinpan) sh.getRange(row, L.shinpan, 1, 3).setValues([r.slice(L.shinpan - 1, L.shinpan + 2)]);
    if ('hantei' in patch) sh.getRange(row, L.hantei).setValue(r[L.hantei - 1]);
  } finally { lock.releaseLock(); }
  // Shinpan names, and marks on an individual fight that isn't finished, don't change standings or the draw.
  var light = keys.every(function (k) { return k === 'shinpan' || ((k === 'rm' || k === 'wm') && !L.team); }) && r[L.done - 1] !== true;
  if (!light) refreshComp_(comp);
  return finish_();
}

function adminDraw(compName) {
  doDraw_(compByName_(compName));
  return finish_();
}
function adminPlayoffs() {
  var n = doPlayoffs_();
  return JSON.stringify({ added: n, data: JSON.parse(finish_()) });
}
function adminRotate() {
  var lock = LockService.getDocumentLock(); lock.waitLock(10000);
  try { rotateAll_(); } finally { lock.releaseLock(); }
  return finish_();
}
// Clears every score in one competition: marks, forfeits, hantei and Fight complete. Play-off fights
// are removed and the shinpan rotation is redone. The draw, names and entries stay.
function adminResetComp(compName) {
  var comp = compByName_(compName);
  var L = layout_(comp.settings.type);
  var sh = sheet_(fightsTab_(comp));
  if (!sh) throw new Error('No fights for ' + compName + ' yet.');
  var lock = LockService.getDocumentLock(); lock.waitLock(10000);
  try {
    var rows = readFightRowsNow_(comp);
    // Remove play-off fights (for teams, the whole match), bottom up so row numbers hold.
    var po = rows.map(function (r) { return /-PO\d+$/i.test(String(r[L.code - 1]).trim()); });
    for (var i = rows.length - 1; i >= 0; i--) if (po[i]) sh.deleteRow(i + 2);
    rows = rows.filter(function (_, i) { return !po[i]; });
    if (rows.length) {
      var block = rows.map(function (r) {
        var out = r.slice(L.red - 1, L.done);
        for (var k = 0; k < L.nm; k++) { out[L.rm - L.red + k] = ''; out[L.wm - L.red + k] = ''; }
        out[L.rF - L.red] = false; out[L.wF - L.red] = false; out[L.done - L.red] = false;
        return out;
      });
      sh.getRange(2, L.red, rows.length, block[0].length).setValues(block);
      sh.getRange(2, L.hantei, rows.length, 1).setValues(rows.map(function () { return ['']; }));
    }
    CacheService.getScriptCache().removeAll(['panel|' + sh.getSheetId() + '|' + L.panel]);
    rotateAll_();
  } finally { lock.releaseLock(); }
  refreshComp_(comp);
  return finish_();
}
// rows: [[Competition, Name, Dojo, Grade, Pool, Team, Age]]
function adminSaveEntries(rows) {
  var sh = sheet_(TAB.entries);
  var lock = LockService.getDocumentLock(); lock.waitLock(10000);
  try {
    if (sh.getMaxRows() > 1) sh.getRange(2, 1, sh.getMaxRows() - 1, 7).clearContent();
    var clean = rows.filter(function (r) { return String(r[1] || '').trim(); }).map(function (r) { return [0, 1, 2, 3, 4, 5, 6].map(function (i) { return r[i] == null ? '' : r[i]; }); });
    if (clean.length) {
      if (sh.getMaxRows() < clean.length + 1) sh.insertRowsAfter(sh.getMaxRows(), clean.length + 1 - sh.getMaxRows());
      sh.getRange(2, 1, clean.length, 7).setValues(clean);
    }
  } finally { lock.releaseLock(); }
  readComps_().forEach(refreshComp_);
  return finish_();
}
function adminSaveShinpan(names) {
  var sh = sheet_(TAB.shinpan);
  if (sh.getMaxRows() > 1) sh.getRange(2, 1, sh.getMaxRows() - 1, 1).clearContent();
  var list = names.map(shiaiClean).filter(Boolean);
  if (list.length) {
    if (sh.getMaxRows() < list.length + 1) sh.insertRowsAfter(sh.getMaxRows(), list.length + 1 - sh.getMaxRows());
    sh.getRange(2, 1, list.length, 1).setValues(list.map(function (n) { return [n]; }));
  }
  return reading_(adminData_);
}
// votes: [[shinpan, vote1, vote2]] for one competition
function adminSaveSpirit(compName, votes) {
  var sh = sheet_(TAB.spirit);
  var all = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues() : [];
  var keep = all.filter(function (r) { return String(r[0]).trim() && shiaiKey(r[0]) !== shiaiKey(compName); });
  var mine = votes.map(function (v) { return [compName, v[0] || '', v[1] || '', v[2] || '']; });
  var out = keep.concat(mine);
  if (sh.getMaxRows() > 1) sh.getRange(2, 1, sh.getMaxRows() - 1, 4).clearContent();
  if (out.length) {
    if (sh.getMaxRows() < out.length + 1) sh.insertRowsAfter(sh.getMaxRows(), out.length + 1 - sh.getMaxRows());
    sh.getRange(2, 1, out.length, 4).setValues(out);
  }
  return finish_();
}
// values: { 'Setting label': value } for one competition column
// redraw: 'pools' clears this competition's pools and makes a new draw, 'draw' makes a new draw
// keeping the pools, '' just saves.
function adminSaveSettings(compName, values, redraw) {
  var sh = sheet_(TAB.comps);
  var v = sh.getDataRange().getValues();
  var h = -1;
  v.forEach(function (r, i) { if (h < 0 && String(r[0]).trim().toLowerCase() === 'setting') h = i; });
  var col = v[h].map(function (x) { return String(x).trim(); }).indexOf(compName) + 1;
  if (h < 0 || col < 1) throw new Error('No column for ' + compName + ' on the Competitions tab.');
  Object.keys(values).forEach(function (label) {
    for (var i = h + 1; i < v.length; i++) if (String(v[i][0]).trim() === label) sh.getRange(i + 1, col).setValue(values[label]);
  });
  timingRows_();
  if (redraw) {
    var comp = compByName_(compName);
    if (redraw === 'pools') clearPools_(comp);
    doDraw_(comp);
  } else readComps_().forEach(refreshComp_);
  return finish_();
}
// Blanks the Pool column on the Entries tab for one competition, so the next draw makes fresh pools.
function clearPools_(comp) {
  var sh = sheet_(TAB.entries);
  var rows = readEntryRowsNow_();
  if (!rows.length) return;
  sh.getRange(2, 5, rows.length, 1).setValues(rows.map(function (r) { return [shiaiKey(r[0]) === shiaiKey(comp.name) ? '' : r[4]]; }));
}

/* ===================== PUBLIC BOARD =====================
   The board on GitHub Pages reads the Board tab straight from the sheet (share the sheet as
   "Anyone with the link: Viewer"). Every change writes the latest standings there as JSON,
   split over column A in pieces. Don't type in the Board tab.
========================================================== */
var BOARD_CHUNK = 20000;
function boardState_() {
  var entryRows = readEntryRows_();
  var comps = readComps_().map(function (c) { return Object.assign(shiaiCompute(readRaw_(c, entryRows)), { name: c.name }); });
  return JSON.stringify({ ok: true, event: readEvent_(), updated: new Date().toISOString(), competitions: comps });
}
// After a change: write the board and build the admin reply from a single read of the sheet.
function finish_() {
  return reading_(function () { publishBoard_(); return adminData_(); });
}
function publishBoard_() {
  try {
    var ss = SpreadsheetApp.getActive();
    var sh = ss.getSheetByName(TAB.board) || ss.insertSheet(TAB.board);
    var json = boardState_();
    var rows = [['Used by the public board. Updated automatically: do not edit.']];
    for (var i = 0; i < json.length; i += BOARD_CHUNK) rows.push(['~' + json.slice(i, i + BOARD_CHUNK)]);
    var old = sh.getLastRow();
    if (old > rows.length) sh.getRange(rows.length + 1, 1, old - rows.length, 1).clearContent();
    sh.getRange(1, 1, rows.length, 1).setNumberFormat('@').setValues(rows);
  } catch (e) { /* never block scoring because of the board */ }
}
function refreshBoard() { publishBoard_(); SpreadsheetApp.getActive().toast('Public board updated.'); }

/* ===================== WEB APP =====================
   Deploy > New deployment > Web app. Execute as: Me. Who has access: Only myself.
   The /exec link opens the admin page.
==================================================== */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Admin')
    .setTitle('Admin · ' + (readEvent_() || 'Shiai'))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
