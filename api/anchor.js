import { writeAnchor } from '../lib/anchor-store.js';

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

    const ok = await writeAnchor({
      title: body.title,
      artist: body.artist || '',
      offsetSeconds: body.offsetSeconds,
      epochMs: body.epochMs,
      videoId: body.videoId || null,
      videoDurationSeconds: body.videoDurationSeconds || null
    });

    return new Response(JSON.stringify({ ok }), {
      status: ok ? 200 : 502,
      headers: { 'content-type': 'application/json' }
    });
  }

  let res;
  try {
    res = await fetch(`${url}/get/songsync:anchor`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'redis request failed' }), { status: 502 });
  }

  const data = await res.json();
  if (!data.result) {
    return new Response(JSON.stringify({ error: 'no anchor set yet' }), { status: 200 });
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
