import { encodeGeohash } from '../lib/geohash.js';

export const config = { runtime: 'edge' };

const VENUE_PRECISION = 7;
const MAX_PLAYS = 2000;
const CONSECUTIVE_MS = 15 * 60 * 1000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type'
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json' }, CORS_HEADERS)
  });
}

function norm(s) {
  return (s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '');
}
function songKeyOf(title, artist) { return norm(title) + '|' + norm(artist); }

function keys(gh) {
  const base = 'songsync:venue:' + gh;
  return {
    plays: base + ':plays',
    catalog: base + ':catalog',
    meta: base + ':meta',
    info: base + ':info',
    next: (k) => base + ':next:' + encodeURIComponent(k)
  };
}
const GLOBAL_META = 'songsync:globalmeta';
const globalNext = (k) => 'songsync:globalnext:' + encodeURIComponent(k);

async function redis(commands) {
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.UPSTASH_REDIS_REST_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(commands)
  });
  const out = await res.json();
  return out.map(r => (r ? r.result : null));
}

function pairs(flat) {
  const out = [];
  for (let i = 0; flat && i + 1 < flat.length; i += 2) out.push({ key: flat[i], count: Number(flat[i + 1]) });
  return out;
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'redis not configured' }, 500);

  try {
    if (request.method === 'POST') {
      const b = await request.json();
      if (typeof b.lat !== 'number' || typeof b.lng !== 'number' || !b.title) return json({ error: 'missing lat, lng, or title' }, 400);
      const gh = encodeGeohash(b.lat, b.lng, VENUE_PRECISION);
      const k = keys(gh);
      const songKey = songKeyOf(b.title, b.artist);
      const at = typeof b.at === 'number' ? b.at : Date.now();

      const [lastRaw] = await redis([['LINDEX', k.plays, '0']]);
      let last = null;
      try { last = lastRaw ? JSON.parse(lastRaw) : null; } catch (e) { last = null; }
      if (last && last.songKey === songKey && at - last.at < CONSECUTIVE_MS) {
        if (b.siteName) await redis([['HSET', k.info, 'name', String(b.siteName).slice(0, 40)]]);
        return json({ ok: true, venue: gh, duplicate: true });
      }

      const meta = JSON.stringify({ title: b.title, artist: b.artist || '', videoId: b.videoId || null, durationSeconds: b.durationSeconds || null });
      const entry = JSON.stringify({ songKey, title: b.title, artist: b.artist || '', videoId: b.videoId || null, at, deviceId: b.deviceId || null });
      const cmds = [
        ['LPUSH', k.plays, entry],
        ['LTRIM', k.plays, '0', String(MAX_PLAYS - 1)],
        ['ZINCRBY', k.catalog, '1', songKey],
        ['HSET', k.meta, songKey, meta],
        ['HSET', GLOBAL_META, songKey, meta],
        ['SADD', 'songsync:venues', gh]
      ];
      let linked = false;
      if (last && last.songKey !== songKey && at - last.at < CONSECUTIVE_MS && at > last.at) {
        cmds.push(['ZINCRBY', k.next(last.songKey), '1', songKey]);
        cmds.push(['ZINCRBY', globalNext(last.songKey), '1', songKey]);
        linked = true;
      }
      if (b.siteName) cmds.push(['HSET', k.info, 'name', String(b.siteName).slice(0, 40)]);
      await redis(cmds);
      return json({ ok: true, venue: gh, linkedFrom: linked ? last.title : null });
    }

    if (request.method === 'GET') {
      const p = new URL(request.url).searchParams;
      const lat = parseFloat(p.get('lat')), lng = parseFloat(p.get('lng'));
      if (isNaN(lat) || isNaN(lng)) return json({ error: 'missing lat or lng' }, 400);
      const gh = encodeGeohash(lat, lng, VENUE_PRECISION);
      const k = keys(gh);
      const title = p.get('title');
      const current = title ? songKeyOf(title, p.get('artist') || '') : null;

      const cmds = [
        ['LRANGE', k.plays, '0', '49'],
        ['ZCARD', k.catalog],
        ['HGET', k.info, 'name'],
        ['ZREVRANGE', k.catalog, '0', '9', 'WITHSCORES']
      ];
      if (current) {
        cmds.push(['ZREVRANGE', k.next(current), '0', '4', 'WITHSCORES']);
        cmds.push(['ZREVRANGE', globalNext(current), '0', '4', 'WITHSCORES']);
      }
      const r = await redis(cmds);
      const plays = (r[0] || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
      const top = pairs(r[3]);
      const venueNext = current ? pairs(r[4]) : [];
      const globalNextList = current ? pairs(r[5]) : [];

      const wantVenue = Array.from(new Set(top.map(x => x.key).concat(venueNext.map(x => x.key))));
      const wantGlobal = globalNextList.map(x => x.key);
      const metaCmds = [];
      if (wantVenue.length) metaCmds.push(['HMGET', k.meta].concat(wantVenue));
      if (wantGlobal.length) metaCmds.push(['HMGET', GLOBAL_META].concat(wantGlobal));
      const m = metaCmds.length ? await redis(metaCmds) : [];
      const vMeta = {}, gMeta = {};
      let mi = 0;
      if (wantVenue.length) { (m[mi++] || []).forEach((v, i) => { try { vMeta[wantVenue[i]] = JSON.parse(v); } catch (e) {} }); }
      if (wantGlobal.length) { (m[mi++] || []).forEach((v, i) => { try { gMeta[wantGlobal[i]] = JSON.parse(v); } catch (e) {} }); }

      const predictions = [];
      const vTotal = venueNext.reduce((s, x) => s + x.count, 0);
      venueNext.forEach(x => {
        const meta = vMeta[x.key] || {};
        predictions.push({ key: x.key, title: meta.title || x.key, artist: meta.artist || '', videoId: meta.videoId || null, count: x.count, share: vTotal ? +(x.count / vTotal).toFixed(3) : 0, source: 'here' });
      });
      const gTotal = globalNextList.reduce((s, x) => s + x.count, 0);
      globalNextList.forEach(x => {
        if (predictions.length >= 5 || predictions.some(y => y.key === x.key)) return;
        const meta = gMeta[x.key] || {};
        predictions.push({ key: x.key, title: meta.title || x.key, artist: meta.artist || '', videoId: meta.videoId || null, count: x.count, share: gTotal ? +(x.count / gTotal).toFixed(3) : 0, source: 'elsewhere' });
      });

      return json({
        venue: gh,
        name: r[2] || null,
        catalogSize: Number(r[1] || 0),
        plays,
        topSongs: top.map(x => Object.assign({ key: x.key, count: x.count }, vMeta[x.key] || {})),
        predictions
      });
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (err) {
    return json({ error: 'redis request failed' }, 502);
  }
}
