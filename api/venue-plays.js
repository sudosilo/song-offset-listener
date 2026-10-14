import { encodeGeohash } from '../lib/geohash.js';

export const config = { runtime: 'edge' };

const VENUE_PRECISION = 7;
const MAX_PLAYS = 2000;
const CONSECUTIVE_MS = 15 * 60 * 1000;
const SITE_ID_RE = /^[0-9a-z]{5,12}$/;
const INFO_FIELDS = ['name', 'address', 'kind', 'service', 'notes', 'lat', 'lng', 'createdAt', 'updatedAt'];

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
function clip(v, n) { return v === undefined || v === null ? '' : String(v).slice(0, n); }

function keys(id) {
  const base = 'songsync:venue:' + id;
  return {
    plays: base + ':plays',
    catalog: base + ':catalog',
    meta: base + ':meta',
    info: base + ':info',
    next: (k) => base + ':next:' + encodeURIComponent(k)
  };
}
const VENUES = 'songsync:venues';
const GLOBAL_META = 'songsync:globalmeta';
const globalNext = (k) => 'songsync:globalnext:' + encodeURIComponent(k);

async function redis(commands) {
  if (!commands.length) return [];
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
function hashToObj(flat) {
  const o = {};
  for (let i = 0; flat && i + 1 < flat.length; i += 2) o[flat[i]] = flat[i + 1];
  return o;
}
function parseList(list) {
  return (list || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
}
function distM(aLat, aLng, bLat, bLng) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (bLat - aLat) * toR, dLng = (bLng - aLng) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function resolveSite(b) {
  if (b.siteId && SITE_ID_RE.test(String(b.siteId))) return String(b.siteId);
  const lat = typeof b.lat === 'number' ? b.lat : parseFloat(b.lat);
  const lng = typeof b.lng === 'number' ? b.lng : parseFloat(b.lng);
  if (isNaN(lat) || isNaN(lng)) return null;
  return encodeGeohash(lat, lng, VENUE_PRECISION);
}

async function listSites(lat, lng) {
  const [ids] = await redis([['SMEMBERS', VENUES]]);
  const list = ids || [];
  const cmds = [];
  list.forEach(id => {
    const k = keys(id);
    cmds.push(['HGETALL', k.info], ['LLEN', k.plays], ['ZCARD', k.catalog], ['LINDEX', k.plays, '0']);
  });
  const r = await redis(cmds);
  const sites = list.map((id, i) => {
    const info = hashToObj(r[i * 4]);
    let last = null;
    try { last = r[i * 4 + 3] ? JSON.parse(r[i * 4 + 3]) : null; } catch (e) {}
    const site = {
      id, name: info.name || null, address: info.address || null, kind: info.kind || null, service: info.service || null,
      notes: info.notes || null, lat: info.lat ? Number(info.lat) : null, lng: info.lng ? Number(info.lng) : null,
      saved: !!info.createdAt, plays: Number(r[i * 4 + 1] || 0), catalogSize: Number(r[i * 4 + 2] || 0),
      lastTitle: last ? last.title : null, lastArtist: last ? last.artist : null, lastAt: last ? last.at : null
    };
    if (!isNaN(lat) && !isNaN(lng) && site.lat !== null && site.lng !== null) site.distanceM = Math.round(distM(lat, lng, site.lat, site.lng));
    return site;
  });
  return sites;
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'redis not configured' }, 500);

  try {
    if (request.method === 'POST') {
      const b = await request.json();

      if (b.action === 'save') {
        const id = resolveSite(b);
        if (!id) return json({ error: 'need a site id or lat and lng' }, 400);
        const k = keys(id);
        const [existing] = await redis([['HGETALL', k.info]]);
        const prev = hashToObj(existing);
        const fields = ['updatedAt', String(Date.now())];
        if (!prev.createdAt) fields.push('createdAt', String(Date.now()));
        ['name', 'address', 'kind', 'service', 'notes'].forEach(f => { if (b[f] !== undefined) fields.push(f, clip(b[f], f === 'notes' ? 400 : 120)); });
        if (typeof b.lat === 'number' && typeof b.lng === 'number') fields.push('lat', String(b.lat), 'lng', String(b.lng));
        else if (!prev.lat) return json({ error: 'a new site needs lat and lng' }, 400);
        await redis([['HSET', k.info].concat(fields), ['SADD', VENUES, id]]);
        return json({ ok: true, site: id });
      }

      if (b.action === 'delete') {
        const id = resolveSite(b);
        if (!id) return json({ error: 'need a site id' }, 400);
        await redis([['SREM', VENUES, id], ['DEL', keys(id).info]]);
        return json({ ok: true, removed: id });
      }

      if (!b.title) return json({ error: 'missing title' }, 400);
      const id = resolveSite(b);
      if (!id) return json({ error: 'need a site id or lat and lng' }, 400);
      const k = keys(id);
      const songKey = songKeyOf(b.title, b.artist);
      const at = typeof b.at === 'number' ? b.at : Date.now();

      const [lastRaw, infoLat] = await redis([['LINDEX', k.plays, '0'], ['HGET', k.info, 'lat']]);
      let last = null;
      try { last = lastRaw ? JSON.parse(lastRaw) : null; } catch (e) { last = null; }
      if (last && last.songKey === songKey && at - last.at < CONSECUTIVE_MS) return json({ ok: true, site: id, duplicate: true });

      const meta = JSON.stringify({ title: b.title, artist: b.artist || '', videoId: b.videoId || null, durationSeconds: b.durationSeconds || null });
      const entry = JSON.stringify({ songKey, title: b.title, artist: b.artist || '', videoId: b.videoId || null, at, deviceId: b.deviceId || null });
      const cmds = [
        ['LPUSH', k.plays, entry],
        ['LTRIM', k.plays, '0', String(MAX_PLAYS - 1)],
        ['ZINCRBY', k.catalog, '1', songKey],
        ['HSET', k.meta, songKey, meta],
        ['HSET', GLOBAL_META, songKey, meta],
        ['SADD', VENUES, id]
      ];
      if (!infoLat && typeof b.lat === 'number' && typeof b.lng === 'number') cmds.push(['HSET', k.info, 'lat', String(b.lat), 'lng', String(b.lng)]);
      let linked = false;
      if (last && last.songKey !== songKey && at - last.at < CONSECUTIVE_MS && at > last.at) {
        cmds.push(['ZINCRBY', k.next(last.songKey), '1', songKey]);
        cmds.push(['ZINCRBY', globalNext(last.songKey), '1', songKey]);
        linked = true;
      }
      await redis(cmds);
      return json({ ok: true, site: id, linkedFrom: linked ? last.title : null });
    }

    if (request.method === 'GET') {
      const p = new URL(request.url).searchParams;
      const lat = parseFloat(p.get('lat')), lng = parseFloat(p.get('lng'));

      if (p.get('list') === '1') {
        const sites = await listSites(lat, lng);
        sites.sort((a, b) => {
          if (a.distanceM !== undefined && b.distanceM !== undefined) return a.distanceM - b.distanceM;
          return (b.lastAt || 0) - (a.lastAt || 0);
        });
        return json({ sites });
      }

      const id = resolveSite({ siteId: p.get('site'), lat, lng });
      if (!id) return json({ error: 'need a site id or lat and lng' }, 400);
      const k = keys(id);
      const full = p.get('full') === '1';
      const title = p.get('title');
      const current = title ? songKeyOf(title, p.get('artist') || '') : null;

      const cmds = [
        ['LRANGE', k.plays, '0', full ? String(MAX_PLAYS - 1) : '49'],
        ['ZCARD', k.catalog],
        ['HGETALL', k.info],
        ['ZREVRANGE', k.catalog, '0', full ? '-1' : '9', 'WITHSCORES']
      ];
      if (current) {
        cmds.push(['ZREVRANGE', k.next(current), '0', '4', 'WITHSCORES']);
        cmds.push(['ZREVRANGE', globalNext(current), '0', '4', 'WITHSCORES']);
      }
      const r = await redis(cmds);
      const plays = parseList(r[0]);
      const info = hashToObj(r[2]);
      const top = pairs(r[3]);
      const venueNext = current ? pairs(r[4]) : [];
      const globalNextList = current ? pairs(r[5]) : [];

      let sequences = [];
      if (full && top.length) {
        const seqKeys = top.slice(0, 300).map(x => x.key);
        const seqRes = await redis(seqKeys.map(sk => ['ZREVRANGE', k.next(sk), '0', '2', 'WITHSCORES']));
        seqKeys.forEach((sk, i) => pairs(seqRes[i]).forEach(n => sequences.push({ from: sk, to: n.key, count: n.count })));
        sequences.sort((a, b) => b.count - a.count);
        sequences = sequences.slice(0, 100);
      }

      const wantVenue = Array.from(new Set(top.map(x => x.key).concat(venueNext.map(x => x.key)).concat(sequences.map(x => x.to))));
      const wantGlobal = globalNextList.map(x => x.key);
      const metaCmds = [];
      if (wantVenue.length) metaCmds.push(['HMGET', k.meta].concat(wantVenue));
      if (wantGlobal.length) metaCmds.push(['HMGET', GLOBAL_META].concat(wantGlobal));
      const m = await redis(metaCmds);
      const vMeta = {}, gMeta = {};
      let mi = 0;
      if (wantVenue.length) { (m[mi++] || []).forEach((v, i) => { try { vMeta[wantVenue[i]] = JSON.parse(v); } catch (e) {} }); }
      if (wantGlobal.length) { (m[mi++] || []).forEach((v, i) => { try { gMeta[wantGlobal[i]] = JSON.parse(v); } catch (e) {} }); }
      const label = (key, src) => { const mm = (src || vMeta)[key] || {}; return { title: mm.title || key, artist: mm.artist || '' }; };

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

      const site = {
        id, name: info.name || null, address: info.address || null, kind: info.kind || null, service: info.service || null,
        notes: info.notes || null, lat: info.lat ? Number(info.lat) : null, lng: info.lng ? Number(info.lng) : null,
        saved: !!info.createdAt, createdAt: info.createdAt ? Number(info.createdAt) : null
      };
      return json({
        venue: id,
        site,
        name: site.name,
        catalogSize: Number(r[1] || 0),
        plays,
        topSongs: top.map(x => Object.assign({ key: x.key, count: x.count }, vMeta[x.key] || {})),
        sequences: sequences.map(x => ({ from: label(x.from), to: label(x.to), count: x.count })),
        predictions
      });
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (err) {
    return json({ error: 'redis request failed' }, 502);
  }
}
