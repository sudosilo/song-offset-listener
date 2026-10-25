import { cacheGet, cacheSet, normQuery } from '../lib/search-cache.js';

export const config = { runtime: 'edge' };

// Picks songs by genre tag, decade and BPM for Autosmash.
// Genre and decade come from MusicBrainz tags; BPM is checked against Deezer, which filters by tempo.
const MB = 'https://musicbrainz.org/ws/2';
const UA = { 'User-Agent': 'LyricSmash/1.0 ( no-contact-configured )', Accept: 'application/json' };
const HEADERS = { 'content-type': 'application/json' };

export default async function handler(request) {
  trace.length = 0;
  const started = Date.now();
  const p = new URL(request.url).searchParams;
  const tag = (p.get('tag') || '').toLowerCase().replace(/["\\]/g, ' ').trim().slice(0, 40);
  const era = parseInt(p.get('era'), 10);
  const bpm = parseFloat(p.get('bpm'));
  const spread = Math.min(16, Math.max(2, parseFloat(p.get('spread')) || 6));
  const skip = new Set((p.get('skip') || '').split(',').map(s => s.trim()).filter(Boolean));
  const kind = p.get('kind') === 'inst' ? 'instrumental' : (p.get('kind') === 'aca' ? 'acapella' : null);
  const cachedOnly = p.get('cached') === '1' && kind;
  const want = Math.min(12, Math.max(1, parseInt(p.get('n'), 10) || 3));
  if (!tag || !(bpm > 40)) return reply({ error: 'need a genre and a bpm', picks: [] }, 400);

  if (cachedOnly) {
    const metas = await savedSongFacts();
    const have = await cachedSongs(kind);
    const lo = bpm - spread, hi = bpm + spread;
    const fits = metas.filter(m => m && !m.missing && m.bpm && have.has(norm(m.query)) &&
      !skip.has(((m.title || '') + '|' + (m.artist || '')).toLowerCase()) &&
      tagMatches(m, tag) && (!(era >= 1900) || (m.year >= era && m.year <= era + 9)));
    const picks = [];
    for (const m of shuffle(fits)) {
      const f = [1, 2, 0.5].find(x => m.bpm * x >= lo && m.bpm * x <= hi);
      if (f) picks.push({ title: m.title, artist: m.artist, bpm: m.bpm, fold: f, query: m.query });
      if (picks.length >= want) break;
    }
    return reply({ picks, cache: { indexedSongs: metas.length, savedForSide: have.size, fitGenre: fits.length }, ms: Date.now() - started,
      error: picks.length ? undefined : (fits.length ? 'no saved songs in that tempo window' : 'no saved songs in that genre and decade yet') });
  }

  let query = 'tag:"' + tag + '" AND status:official';
  if (era >= 1900 && era <= 2090) query += ' AND firstreleasedate:[' + era + ' TO ' + (era + 9) + ']';

  const poolKey = 'songsync:autopool:' + normQuery(query);
  let pool = await cacheGet(poolKey);
  if (!pool || !pool.length) {
    const first = await mb('/recording/?fmt=json&limit=100&query=' + encodeURIComponent(query));
    const count = first ? first.count || 0 : 0;
    let rows = first ? first.recordings || [] : [];
    if (count > 100 && Date.now() - started < 3000) {
      const offset = Math.floor(Math.random() * Math.min(count - 100, 2000));
      await wait(1100);
      const more = await mb('/recording/?fmt=json&limit=100&offset=' + offset + '&query=' + encodeURIComponent(query));
      if (more && more.recordings) rows = rows.concat(more.recordings);
    }
    const seen = new Set();
    pool = [];
    for (const r of rows) {
      const artist = ((r['artist-credit'] || [])[0] || {}).name;
      const title = (r.title || '').replace(/\(.*?\)|\[.*?\]/g, '').trim();
      if (!artist || !title || /live|remix|demo|instrumental|karaoke|version|edit|mix\b/i.test(r.title + ' ' + (r.disambiguation || ''))) continue;
      const k = (title + '|' + artist).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      pool.push({ title, artist });
    }
    if (pool.length) await cacheSet(poolKey, pool, 604800);
  }
  if (!pool.length) return reply({ error: 'no songs found for that genre and decade', picks: [] });

  let cacheInfo = null;
  let usable = pool.filter(x => !skip.has((x.title + '|' + x.artist).toLowerCase()));
  if (cachedOnly) {
    const have = await cachedSongs(kind);
    usable = usable.filter(x => have.has(norm(x.title + x.artist)));
    cacheInfo = { cachedSongs: have.size, usable: usable.length };
    if (!usable.length) return reply({ picks: [], poolSize: pool.length, cachedMatches: 0, error: 'none of these songs are cached yet' });
  }
  const cands = shuffle(usable).slice(0, 28);
  const lo = Math.floor(bpm - spread), hi = Math.ceil(bpm + spread);
  const picks = [];
  for (let i = 0; i < cands.length && picks.length < (Date.now() - started > 6000 ? 1 : 3) && Date.now() - started < 9000; i += 4) {
    if (i) await wait(300);
    const batch = await Promise.all(cands.slice(i, i + 4).map(c => checkTempo(c, lo, hi)));
    batch.forEach(x => { if (x) picks.push(x); });
  }
  return reply({ picks, poolSize: pool.length, cache: cacheInfo, ms: Date.now() - started, checked: p.get('debug') ? trace.slice(0, 30) : undefined, sample: p.get('debug') ? pool.slice(0, 8) : undefined });
}

const trace = [];
const MIN_RANK = 120000;
async function checkTempo(c, lo, hi) {
  try {
    const key = 'songsync:bpm:' + normQuery(c.title + '|' + c.artist);
    let bpm = null, title = c.title, artist = c.artist, dur = null;
    const cached = await cacheGet(key);
    if (cached && !cached.bpm && typeof cached.rank === 'number' && cached.rank < MIN_RANK) return null;
    if (cached && cached.bpm) { bpm = cached.bpm; if (typeof cached.rank === 'number' && cached.rank < MIN_RANK) return null; }
    else {
      const res = await fetch('https://api.deezer.com/search?limit=5&q=' + encodeURIComponent(c.artist + ' ' + c.title));
      if (!res.ok) return null;
      const data = await res.json();
      const want = norm(c.artist), wantT = norm(c.title);
      const hit = (data.data || []).find(r => r.artist && norm(r.artist.name) === want && norm(r.title_short || r.title).startsWith(wantT));
      if (hit && (hit.rank || 0) < MIN_RANK) { await cacheSet(key, { bpm: null, rank: hit.rank || 0 }, 2592000); return null; }
      if (!hit) { trace.push(c.artist + ' / ' + c.title + ': no deezer match (' + (data.error ? JSON.stringify(data.error).slice(0, 80) : (data.data || []).length + ' rows') + ')'); return null; }
      const tr = await fetch('https://api.deezer.com/track/' + hit.id);
      const t = tr.ok ? await tr.json() : {};
      bpm = parseFloat(t.bpm) > 0 ? Math.round(parseFloat(t.bpm) * 10) / 10 : null;
      if (!bpm) { trace.push(c.artist + ' / ' + c.title + ': no bpm'); return null; }
      await cacheSet(key, { bpm, key: null, source: 'deezer', rank: hit.rank || 0 }, 0);
      title = (hit.title_short || c.title).replace(/\s*\(.*?\)|\s*\[.*?\]/g, '').trim(); artist = hit.artist.name; dur = hit.duration || null;
    }
    for (const f of [1, 2, 0.5]) {
      const v = bpm * f;
      if (v >= lo && v <= hi) return { title, artist, bpm, durationSeconds: dur, fold: f };
    }
    trace.push(c.artist + ' / ' + c.title + ': ' + bpm);
    return null;
  } catch (err) {
    trace.push('error ' + String(err).slice(0, 60));
    return null;
  }
}
// Every song whose acapella or instrumental search is already saved, so picking it costs no video searches.
async function cachedSongs(kind) {
  const listKey = 'songsync:cachedsongs:' + kind;
  const saved = await cacheGet(listKey);
  if (saved && saved.length) return new Set(saved);
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const out = new Set();
  if (!url || !token) return out;
  const suffix = ' ' + kind;
  let cursor = '0', rounds = 0;
  do {
    try {
      const res = await fetch(url + '/scan/' + cursor + '/match/' + encodeURIComponent('songsync:search:*' + suffix) + '/count/1000', { headers: { Authorization: 'Bearer ' + token } });
      const r = (await res.json()).result || ['0', []];
      cursor = String(r[0]);
      for (const k of r[1] || []) {
        let q = k.slice('songsync:search:'.length);
        try { q = decodeURIComponent(q); } catch (e) {}
        if (q.endsWith(suffix)) out.add(norm(q.slice(0, -suffix.length)));
      }
    } catch (e) { break; }
    rounds++;
  } while (cursor !== '0' && rounds < 40);
  if (out.size) await cacheSet(listKey, [...out], 600);
  return out;
}

async function savedSongFacts() {
  const hot = await cacheGet('songsync:songmetas');
  if (hot && hot.length) return hot;
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return [];
  const post = async (body) => (await (await fetch(url + (Array.isArray(body[0]) ? '/pipeline' : ''), { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json());
  const members = (await post(['SMEMBERS', 'songsync:songindex'])).result || [];
  const out = [];
  for (let i = 0; i < members.length; i += 300) {
    const r = await post(['MGET'].concat(members.slice(i, i + 300).map(n => 'songsync:songmeta:' + n)));
    (r.result || []).forEach(v => { try { if (v) out.push(JSON.parse(v)); } catch (e) {} });
  }
  const artists = [...new Set(out.map(m => m && m.artist).filter(Boolean))];
  for (let i = 0; i < artists.length; i += 300) {
    const r = await post(['MGET'].concat(artists.slice(i, i + 300).map(a => 'songsync:artisttags:' + norm(a))));
    const got = {};
    (r.result || []).forEach((v, k) => { try { if (v) got[artists[i + k]] = JSON.parse(v); } catch (e) {} });
    out.forEach(m => { if (m && got[m.artist] && (!m.tags || !m.tags.length)) m.tags = got[m.artist]; });
  }
  if (out.length) await cacheSet('songsync:songmetas', out, 300);
  return out;
}
const SYN = {
  industrial: ['metal', 'electro', 'alternative'], 'hard rock': ['rock', 'metal'], 'heavy metal': ['metal'], metal: ['metal'],
  'hip hop': ['rap/hip hop'], rap: ['rap/hip hop'], trap: ['rap/hip hop'], 'r&b': ['r&b'], soul: ['soul & funk', 'r&b'], funk: ['soul & funk'],
  disco: ['dance', 'soul & funk'], synthpop: ['pop', 'electro'], 'new wave': ['pop', 'alternative', 'rock'], punk: ['rock', 'alternative'],
  grunge: ['rock', 'alternative'], house: ['dance', 'electro'], techno: ['electro', 'dance'], 'drum and bass': ['electro', 'dance'],
  dubstep: ['electro', 'dance'], electronic: ['electro', 'dance'], emo: ['alternative', 'rock'], 'indie rock': ['alternative', 'rock'],
  'alternative rock': ['alternative', 'rock'], 'trip hop': ['electro', 'alternative'], 'classic rock': ['rock'], rock: ['rock'], pop: ['pop'],
  country: ['country'], blues: ['blues'], jazz: ['jazz'], reggae: ['reggae'], latin: ['latin'], dance: ['dance']
};
function tagMatches(m, tag) {
  const t = tag.toLowerCase().trim();
  if (t === 'any') return true;
  const tags = (m.tags || []).map(x => x.toLowerCase());
  const genres = (m.genres || []).map(x => x.toLowerCase());
  const words = t.split(/[\s,/&]+/).filter(Boolean);
  if (tags.length && words.every(w => tags.join(' | ').includes(w))) return true;
  if (words.every(w => genres.join(' | ').includes(w))) return true;
  const syn = SYN[t];
  if (syn && genres.some(g => syn.includes(g))) return !tags.length || tags.some(x => words.some(w => x.includes(w))) || genres.some(g => syn[0] === g);
  return false;
}
function norm(s) { return (s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, ''); }

async function mb(path) {
  for (let i = 0; i < 2; i++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
      const res = await fetch(MB + path, { headers: UA, signal: ctl.signal });
      clearTimeout(timer);
      if (res.status === 503) { await wait(1500); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch (err) { await wait(1000); }
  }
  return null;
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function reply(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers: HEADERS }); }
