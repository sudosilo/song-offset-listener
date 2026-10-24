import { cacheGet, cacheSet } from '../lib/search-cache.js';

export const config = { runtime: 'edge' };

// Builds genre, decade and BPM facts for every song whose acapella or instrumental search is saved,
// so Autosmash can pick from saved songs without any video searches. Runs a small batch per call.
const MB = 'https://musicbrainz.org/ws/2';
const UA = { 'User-Agent': 'LyricSmash/1.0 ( no-contact-configured )', Accept: 'application/json' };
const HEADERS = { 'content-type': 'application/json' };

export default async function handler(request) {
  try { return await run(request); } catch (err) { return reply({ error: String(err && err.stack || err).slice(0, 400) }, 200); }
}

async function run(request) {
  const started = Date.now();
  const limit = Math.min(15, Math.max(1, parseInt(new URL(request.url).searchParams.get('limit'), 10) || 10));
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return reply({ error: 'redis not configured' }, 500);
  const auth = { Authorization: 'Bearer ' + token };

  const songs = new Map();
  for (const kind of ['acapella', 'instrumental']) {
    const suffix = ' ' + kind;
    let cursor = '0', rounds = 0;
    do {
      const res = await fetch(url + '/scan/' + cursor + '/match/' + encodeURIComponent('songsync:search:*' + suffix) + '/count/1000', { headers: auth });
      const r = (await res.json()).result || ['0', []];
      cursor = String(r[0]);
      for (const k of r[1] || []) {
        const q = k.slice('songsync:search:'.length).slice(0, -suffix.length);
        if (q) songs.set(norm(q), q);
      }
      rounds++;
    } while (cursor !== '0' && rounds < 40);
  }

  const indexed = new Set((await redis(url, auth, ['SMEMBERS', 'songsync:songindex'])) || []);
  const todo = [...songs.entries()].filter(([n]) => !indexed.has(n));
  let done = 0;
  // fast pass: Deezer facts, six songs at a time
  for (let k = 0; k < todo.length && Date.now() - started < 7000; k += 6) {
    const wave = todo.slice(k, k + 6);
    const metas = await Promise.all(wave.map(([n, q]) => describe(q)));
    for (let w = 0; w < wave.length; w++) {
      const [n, q] = wave[w];
      await cacheSet('songsync:songmeta:' + n, metas[w] || { query: q, missing: true }, 0);
      await redis(url, auth, ['SADD', 'songsync:songindex', n]);
      if (metas[w] && metas[w].artist) await redis(url, auth, ['SADD', 'songsync:needtags', norm(metas[w].artist) + '|' + metas[w].artist]);
      done++;
    }
    await new Promise(r => setTimeout(r, 800));
  }
  // slow pass: genre tags per artist from MusicBrainz, one per second, with whatever time is left
  let tagged = 0;
  if (todo.length - done <= 0) {
    const need = (await redis(url, auth, ['SRANDMEMBER', 'songsync:needtags', '12'])) || [];
    for (const entry of need) {
      if (Date.now() - started > 9000) break;
      const cut = entry.indexOf('|');
      const artist = entry.slice(cut + 1);
      const tags = await artistTags(artist);
      if (tags) { await cacheSet('songsync:artisttags:' + norm(artist), tags, 0); await redis(url, auth, ['SREM', 'songsync:needtags', entry]); tagged++; }
      await new Promise(r => setTimeout(r, 1100));
    }
    if (tagged) await cacheSet('songsync:songmetas', null, 1);
  }
  const tagsLeft = (await redis(url, auth, ['SCARD', 'songsync:needtags'])) || 0;
  return reply({ saved: songs.size, indexed: indexed.size + done, remaining: Math.max(0, todo.length - done), artistsToTag: tagsLeft, ms: Date.now() - started });
}

async function artistTags(artist) {
  const mbr = await mb('/artist/?fmt=json&limit=3&query=' + encodeURIComponent('artist:"' + artist.replace(/["\\]/g, ' ') + '"'));
  if (!mbr) return null;
  const a = (mbr.artists || []).find(x => norm(x.name) === norm(artist)) || (mbr.artists || [])[0];
  return a && a.tags ? a.tags.sort((x, y) => (y.count || 0) - (x.count || 0)).slice(0, 12).map(t => t.name) : [];
}

async function describe(q) {
  const s = await dz('https://api.deezer.com/search?limit=5&q=' + encodeURIComponent(q));
  const hit = s && s.data && s.data[0];
  if (!hit) return null;
  const tr = await dz('https://api.deezer.com/track/' + hit.id);
  const al = hit.album ? await dz('https://api.deezer.com/album/' + hit.album.id) : null;
  const artist = hit.artist ? hit.artist.name : '';
  const date = (tr && tr.release_date) || (al && al.release_date) || '';
  return {
    query: q,
    title: (hit.title_short || hit.title || '').replace(/\s*\(.*?\)|\s*\[.*?\]/g, '').trim(),
    artist,
    bpm: tr && parseFloat(tr.bpm) > 0 ? Math.round(parseFloat(tr.bpm) * 10) / 10 : null,
    rank: hit.rank || 0,
    year: date ? parseInt(date.slice(0, 4), 10) : null,
    genres: al && al.genres && al.genres.data ? al.genres.data.map(g => g.name) : []
  };
}

async function dz(u) {
  try { const r = await fetch(u); return r.ok ? await r.json() : null; } catch (e) { return null; }
}
async function mb(path) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(MB + path, { headers: UA, signal: ctl.signal });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}
async function redis(url, auth, cmd) {
  try {
    const r = await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, auth), body: JSON.stringify(cmd) });
    return (await r.json()).result;
  } catch (e) { return null; }
}
function norm(s) { return (s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, ''); }
function reply(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers: HEADERS }); }
