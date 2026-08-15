import { writeAnchor, anchorKeyFor } from '../lib/anchor-store.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return new Response(JSON.stringify({ error: 'redis not configured' }), { status: 500 });
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (err) {
      return new Response(JSON.stringify({ error: 'bad json body' }), { status: 400 });
    }

    if (!body.title || typeof body.offsetSeconds !== 'number' || typeof body.epochMs !== 'number') {
      return new Response(JSON.stringify({ error: 'missing title, offsetSeconds, or epochMs' }), { status: 400 });
    }
    if (typeof body.lat !== 'number' || typeof body.lng !== 'number') {
      return new Response(JSON.stringify({ error: 'missing lat or lng, anchors are now region based' }), { status: 400 });
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

    return new Response(JSON.stringify({ ok }), {
      status: ok ? 200 : 502,
      headers: { 'content-type': 'application/json' }
    });
  }

  const params = new URL(request.url).searchParams;

  if (params.get('list') === '1') {
    return await listActiveAnchors(url, token);
  }

  const lat = parseFloat(params.get('lat'));
  const lng = parseFloat(params.get('lng'));
  if (isNaN(lat) || isNaN(lng)) {
    return new Response(JSON.stringify({ error: 'missing lat or lng' }), { status: 400 });
  }
  const precision = parseInt(params.get('precision') || '5', 10);
  const built = anchorKeyFor(lat, lng, precision);

  let res;
  try {
    res = await fetch(`${url}/get/${built.key}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'redis request failed' }), { status: 502 });
  }

  const data = await res.json();
  if (!data.result) {
    return new Response(JSON.stringify({ error: 'no anchor set yet in this region', geohash: built.geohash }), { status: 200 });
  }

  let anchor;
  try {
    anchor = JSON.parse(data.result);
  } catch (err) {
    return new Response(JSON.stringify({ error: 'anchor unreadable' }), { status: 200 });
  }

  return new Response(JSON.stringify(anchor), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

async function listActiveAnchors(url, token) {
  try {
    const keysRes = await fetch(`${url}/smembers/songsync:activekeys`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const keysData = await keysRes.json();
    const keys = keysData.result || [];
    if (keys.length === 0) {
      return new Response(JSON.stringify({ anchors: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
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

    return new Response(JSON.stringify({ anchors }), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'redis request failed' }), { status: 502 });
  }
}
