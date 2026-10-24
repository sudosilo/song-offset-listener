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
  if (!tag || !(bpm > 40)) return reply({ error: 'need a genre and a bpm', picks: [] }, 400);

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

  const cands = shuffle(pool.filter(x => !skip.has((x.title + '|' + x.artist).toLowerCase()))).slice(0, 28);
  const lo = Math.floor(bpm - spread), hi = Math.ceil(bpm + spread);
  const picks = [];
  for (let i = 0; i < cands.length && picks.length < (Date.now() - started > 6000 ? 1 : 3) && Date.now() - started < 9000; i += 4) {
    if (i) await wait(300);
    const batch = await Promise.all(cands.slice(i, i + 4).map(c => checkTempo(c, lo, hi)));
    batch.forEach(x => { if (x) picks.push(x); });
  }
  return reply({ picks, poolSize: pool.length, ms: Date.now() - started, checked: p.get('debug') ? trace.slice(0, 30) : undefined, sample: p.get('debug') ? pool.slice(0, 8) : undefined });
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
