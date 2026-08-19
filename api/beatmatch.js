export const config = { runtime: 'edge' };

function resolveCueOut(record) {
  if (typeof record.cueOut === 'number') return record.cueOut;
  if (typeof record.durationSeconds === 'number' && record.durationSeconds > 30) {
    return record.durationSeconds - 15;
  }
  return null;
}

function resolveCueIn(record) {
  if (typeof record.cueIn === 'number') return record.cueIn;
  if (typeof record.durationSeconds === 'number' && record.durationSeconds > 30) {
    return 15;
  }
  return null;
}

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
  const currentCueOut = resolveCueOut(current);
  if (currentCueOut === null) {
    return new Response(JSON.stringify({ error: 'song too short or duration unknown, cannot compute a cue point', bpm: current.bpm }), { status: 200 });
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
      const candidateCueIn = resolveCueIn(candidate);
      if (candidateCueIn === null) continue;
      if (!candidate.videoId) continue;

      return new Response(JSON.stringify({
        found: true,
        currentCueOut: currentCueOut,
        candidate: {
          title: candidate.title || null,
          artist: candidate.artist || null,
          videoId: candidate.videoId,
          bpm: candidate.bpm,
          key: candidate.key || null,
          cueIn: candidateCueIn,
          durationSeconds: candidate.durationSeconds || null
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (err) { /* skip unreadable candidate */ }
  }

  return new Response(JSON.stringify({ found: false, currentCueOut: currentCueOut }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
