export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405 });
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return new Response(JSON.stringify({ error: 'redis not configured' }), { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'bad json body' }), { status: 400 });
  }

  const title = body.title;
  const artist = body.artist;
  const cueIn = body.cueIn;
  const cueOut = body.cueOut;

  if (!title || !artist || typeof cueIn !== 'number' || typeof cueOut !== 'number') {
    return new Response(JSON.stringify({ error: 'missing title, artist, cueIn, or cueOut' }), { status: 400 });
  }
  if (cueOut <= cueIn) {
    return new Response(JSON.stringify({ error: 'cueOut must be after cueIn' }), { status: 400 });
  }

  const cacheKey = 'songsync:ytcache:' + encodeURIComponent((title + '|' + artist).toLowerCase());

  let existing = {};
  try {
    const res = await fetch(`${url}/get/${cacheKey}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.result) existing = JSON.parse(data.result);
  } catch (err) {
    existing = {};
  }

  existing.title = existing.title || title;
  existing.artist = existing.artist || artist;
  existing.cueIn = cueIn;
  existing.cueOut = cueOut;

  try {
    await fetch(`${url}/set/${cacheKey}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(existing)
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'failed to write cue points' }), { status: 502 });
  }

  return new Response(JSON.stringify({ ok: true, title, artist, cueIn, cueOut }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
