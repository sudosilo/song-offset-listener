export const config = { runtime: 'edge' };

export default async function handler(request) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return new Response(JSON.stringify({ error: 'redis not configured' }), { status: 500 });
  }

  const params = new URL(request.url).searchParams;
  const title = params.get('title');
  const artist = params.get('artist');
  const tolerance = parseFloat(params.get('tolerance') || '2');

  if (!title || !artist) {
    return new Response(JSON.stringify({ error: 'missing title or artist' }), { status: 400 });
  }

  const cacheKey = 'songsync:ytcache:' + encodeURIComponent((title + '|' + artist).toLowerCase());

  let current;
  try {
    const res = await fetch(`${url}/get/${cacheKey}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (!data.result) {
      return new Response(JSON.stringify({ error: 'no archive record for this song yet' }), { status: 200 });
    }
    current = JSON.parse(data.result);
  } catch (err) {
    return new Response(JSON.stringify({ error: 'redis request failed' }), { status: 502 });
  }

  if (typeof current.bpm !== 'number') {
    return new Response(JSON.stringify({ error: 'no bpm on file for this song yet' }), { status: 200 });
  }
  if (typeof current.cueOut !== 'number') {
    return new Response(JSON.stringify({ error: 'no cue points tagged for this song yet', bpm: current.bpm }), { status: 200 });
  }

  const min = current.bpm - tolerance;
  const max = current.bpm + tolerance;

  let candidateKeys = [];
  try {
    const res = await fetch(`${url}/zrangebyscore/songsync:bpmindex/${min}/${max}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    candidateKeys = data.result || [];
  } catch (err) {
    return new Response(JSON.stringify({ error: 'redis request failed' }), { status: 502 });
  }

  for (const key of candidateKeys) {
    if (key === cacheKey) continue;
    try {
      const res = await fetch(`${url}/get/${key}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!data.result) continue;
      const candidate = JSON.parse(data.result);
      if (typeof candidate.cueIn !== 'number' || typeof candidate.cueOut !== 'number') continue;
      if (!candidate.videoId) continue;

      return new Response(JSON.stringify({
        found: true,
        currentCueOut: current.cueOut,
        candidate: {
          title: candidate.title || null,
          artist: candidate.artist || null,
          videoId: candidate.videoId,
          bpm: candidate.bpm,
          key: candidate.key || null,
          cueIn: candidate.cueIn,
          durationSeconds: candidate.durationSeconds || null
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (err) { /* skip unreadable candidate */ }
  }

  return new Response(JSON.stringify({ found: false, currentCueOut: current.cueOut }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
