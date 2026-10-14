import { writeAnchor, anchorKeyFor } from '../lib/anchor-store.js';

export const config = { runtime: 'edge' };

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

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return json({ error: 'redis not configured' }, 500);
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (err) {
      return json({ error: 'bad json body' }, 400);
    }

    if (!body.title || typeof body.offsetSeconds !== 'number' || typeof body.epochMs !== 'number') {
      return json({ error: 'missing title, offsetSeconds, or epochMs' }, 400);
    }
    if (typeof body.lat !== 'number' || typeof body.lng !== 'number') {
      return json({ error: 'missing lat or lng, anchors are now region based' }, 400);
    }

    const ok = await writeAnchor({
      title: body.title,
      artist: body.artist || '',
      offsetSeconds: body.offsetSeconds,
      epochMs: body.epochMs,
      videoId: body.videoId || null,
      videoDurationSeconds: body.videoDurationSeconds || null,
      lat: body.lat,
      lng: body.lng,
      precision: body.precision || 5
    });

    return json({ ok }, ok ? 200 : 502);
  }

  const params = new URL(request.url).searchParams;

  if (params.get('list') === '1') {
    return await listActiveAnchors(url, token);
  }

  const lat = parseFloat(params.get('lat'));
  const lng = parseFloat(params.get('lng'));
  if (isNaN(lat) || isNaN(lng)) {
    return json({ error: 'missing lat or lng' }, 400);
  }
  const precision = parseInt(params.get('precision') || '5', 10);
  const built = anchorKeyFor(lat, lng, precision);

  let res;
  try {
    res = await fetch(`${url}/get/${built.key}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (err) {
    return json({ error: 'redis request failed' }, 502);
  }

  const data = await res.json();
  if (!data.result) {
    return json({ error: 'no anchor set yet in this region', geohash: built.geohash }, 200);
  }

  let anchor;
  try {
    anchor = JSON.parse(data.result);
  } catch (err) {
    return json({ error: 'anchor unreadable' }, 200);
  }

  return json(anchor, 200);
}

async function listActiveAnchors(url, token) {
  try {
    const keysRes = await fetch(`${url}/smembers/songsync:activekeys`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const keysData = await keysRes.json();
    const keys = keysData.result || [];
    if (keys.length === 0) {
      return json({ anchors: [] }, 200);
    }

    const anchors = [];
    for (const key of keys) {
      try {
        const res = await fetch(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        if (!data.result) continue;
        const parsed = JSON.parse(data.result);
        anchors.push(parsed);
      } catch (err) { /* skip unreadable entry */ }
    }

    return json({ anchors }, 200);
  } catch (err) {
    return json({ error: 'redis request failed' }, 502);
  }
}
