import { cacheGet, cacheSet } from '../lib/search-cache.js';

export const config = { runtime: 'edge' };

// Loudness maps of instrumental uploads, made on the seeding phones with yt-dlp and ffmpeg.
// Only numbers are stored: decibels every half second for the whole track and for the voice range.
//   GET  ?vid=ID            the map, or {missing:true} and the video joins the queue
//   GET  ?queue=1&n=4       hands a phone up to n videos to map, refilling the queue from saved instrumental searches
//   POST {vid, step, dur, total:[], voice:[]}   stores a map
//   POST {vid, failed:true, reason}             marks a video that could not be mapped
const HEADERS = { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const VID = /^[A-Za-z0-9_-]{11}$/;

export default async function handler(request) {
  try { return await run(request); } catch (err) { return reply({ error: String(err && err.message || err).slice(0, 300) }, 200); }
}

async function run(request) {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return reply({ error: 'redis not configured' }, 500);
  const r = (args) => redis(url, token, args);

  if (request.method === 'POST') {
    let b = null;
    try { b = await request.json(); } catch (e) {}
    if (!b || !VID.test(b.vid || '')) return reply({ error: 'bad vid' }, 400);
    if (b.failed) {
      await cacheSet('songsync:energyfail:' + b.vid, { reason: String(b.reason || '').slice(0, 120), at: Date.now() }, 60 * 60 * 24 * 14);
      await r(['SREM', 'songsync:energyqueue', b.vid]);
      return reply({ ok: true, failed: true });
    }
    const step = Number(b.step);
    const clean = (a) => Array.isArray(a) ? a.slice(0, 2400).map(x => { const n = Number(x); return isFinite(n) ? Math.max(-120, Math.min(0, Math.round(n * 10) / 10)) : -120; }) : null;
    const total = clean(b.total), voice = clean(b.voice);
    if (!(step > 0.05 && step <= 2) || !total || !voice || total.length < 10) return reply({ error: 'bad map' }, 400);
    await cacheSet('songsync:energy:' + b.vid, { step, dur: Number(b.dur) || total.length * step, total, voice, at: Date.now() }, 0);
    await r(['SREM', 'songsync:energyqueue', b.vid]);
    return reply({ ok: true, points: total.length });
  }

  const p = new URL(request.url).searchParams;
  if (p.get('queue') === '1') {
    const n = Math.min(10, Math.max(1, parseInt(p.get('n'), 10) || 4));
    let size = (await r(['SCARD', 'songsync:energyqueue'])) || 0;
    if (size < n) await refill(url, token, r);
    const vids = (await r(['SPOP', 'songsync:energyqueue', String(n)])) || [];
    size = (await r(['SCARD', 'songsync:energyqueue'])) || 0;
    return reply({ vids, left: size });
  }

  const vid = p.get('vid') || '';
  if (!VID.test(vid)) return reply({ error: 'bad vid' }, 400);
  const map = await cacheGet('songsync:energy:' + vid);
  if (map) return reply(Object.assign({ vid }, map));
  const failed = await cacheGet('songsync:energyfail:' + vid);
  if (!failed) await r(['SADD', 'songsync:energyqueue', vid]);
  return reply({ vid, missing: true, failed: !!failed });
}

/* walk the saved instrumental searches a page at a time and queue the top upload of each that has no map yet */
async function refill(url, token, r) {
  let cursor = (await cacheGet('songsync:energyscan')) || '0';
  for (let round = 0; round < 6; round++) {
    const res = await fetch(url + '/scan/' + cursor + '/match/' + encodeURIComponent('songsync:search:*instrumental') + '/count/200', { headers: { Authorization: 'Bearer ' + token } });
    const out = (await res.json()).result || ['0', []];
    cursor = String(out[0]);
    const keys = out[1] || [];
    if (keys.length) {
      const vals = (await r(['MGET', ...keys])) || [];
      const vids = [];
      vals.forEach(v => { try { const o = JSON.parse(v); const top = o && o.results && o.results[0]; if (top && VID.test(top.videoId)) vids.push(top.videoId); } catch (e) {} });
      if (vids.length) {
        const have = (await r(['MGET', ...vids.map(v => 'songsync:energy:' + v)])) || [];
        const fail = (await r(['MGET', ...vids.map(v => 'songsync:energyfail:' + v)])) || [];
        const need = vids.filter((v, i) => !have[i] && !fail[i]);
        if (need.length) await r(['SADD', 'songsync:energyqueue', ...need]);
      }
    }
    if (cursor === '0') break;
    if (((await r(['SCARD', 'songsync:energyqueue'])) || 0) >= 20) break;
  }
  await cacheSet('songsync:energyscan', cursor, 0);
}

async function redis(url, token, args) {
  const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const d = await res.json();
  return d ? d.result : null;
}
function reply(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers: HEADERS }); }
