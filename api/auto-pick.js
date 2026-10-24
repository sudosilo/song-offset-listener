import { cacheGet, cacheSet, normQuery } from '../lib/search-cache.js';

export const config = { runtime: 'edge' };

// Picks songs by genre tag, decade and BPM for Autosmash.
// Genre and decade come from MusicBrainz tags; BPM is checked against Deezer, which filters by tempo.
const MB = 'https://musicbrainz.org/ws/2';
const UA = { 'User-Agent': 'LyricSmash/1.0 ( no-contact-configured )', Accept: 'application/json' };
const HEADERS = { 'content-type': 'application/json' };

export default async function handler(request) {
  const p = new URL(request.url).searchParams;
  const tag = (p.get('tag') || '').toLowerCase().replace(/["\\]/g, ' ').trim().slice(0, 40);
  const era = parseInt(p.get('era'), 10);
  const bpm = parseFloat(p.get('bpm'));
  const spread = Math.min(12, Math.max(2, parseFloat(p.get('spread')) || 4));
  const skip = new Set((p.get('skip') || '').split(',').map(s => s.trim()).filter(Boolean));
  if (!tag || !(bpm > 40)) return reply({ error: 'need a genre and a bpm', picks: [] }, 400);

  let query = 'tag:"' + tag + '" AND status:official';
  if (era >= 1900 && era <= 2090) query += ' AND firstreleasedate:[' + era + ' TO ' + (era + 9) + ']';

  const poolKey = 'songsync:autopool:' + normQuery(query);
  let pool = await cacheGet(poolKey);
  if (!pool || !pool.length) {
    const first = await mb('/recording/?fmt=json&limit=100&query=' + encodeURIComponent(query));
    const count = first ? first.count || 0 : 0;
    let rows = first ? first.recordings || [] : [];
    if (count > 100) {
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

  const cands = shuffle(pool.filter(x => !skip.has((x.title + '|' + x.artist).toLowerCase()))).slice(0, 16);
  const lo = Math.floor(bpm - spread), hi = Math.ceil(bpm + spread);
  const picks = [];
  for (let i = 0; i < cands.length && picks.length < 3; i += 4) {
    const batch = await Promise.all(cands.slice(i, i + 4).map(c => checkTempo(c, lo, hi)));
    batch.forEach(x => { if (x) picks.push(x); });
  }
  return reply({ picks, poolSize: pool.length });
}

async function checkTempo(c, lo, hi) {
  try {
    const q = 'artist:"' + c.artist + '" track:"' + c.title + '" bpm_min:"' + lo + '" bpm_max:"' + hi + '"';
    const res = await fetch('https://api.deezer.com/search?limit=3&q=' + encodeURIComponent(q));
    if (!res.ok) return null;
    const data = await res.json();
    const hit = (data.data || [])[0];
    if (!hit) return null;
    const tr = await fetch('https://api.deezer.com/track/' + hit.id);
    const t = tr.ok ? await tr.json() : {};
    const exact = parseFloat(t.bpm);
    const bpm = exact > 0 ? Math.round(exact * 10) / 10 : Math.round((lo + hi) / 2);
    if (exact > 0) await cacheSet('songsync:bpm:' + normQuery(c.title + '|' + c.artist), { bpm, key: null, source: 'deezer' }, 0);
    return { title: hit.title_short || c.title, artist: hit.artist ? hit.artist.name : c.artist, bpm, durationSeconds: hit.duration || null };
  } catch (err) {
    return null;
  }
}

async function mb(path) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(MB + path, { headers: UA });
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
