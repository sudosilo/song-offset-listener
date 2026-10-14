export const config = { runtime: 'edge' };

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json' }
  });
}

function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export default async function handler(request) {
  const params = new URL(request.url).searchParams;
  const title = params.get('title');
  const artist = params.get('artist') || '';
  if (!title) return json({ error: 'missing title' }, 400);

  let data;
  try {
    const term = encodeURIComponent((artist + ' ' + title).trim());
    const res = await fetch('https://itunes.apple.com/search?media=music&entity=song&limit=10&term=' + term);
    data = await res.json();
  } catch (err) {
    return json({ error: 'catalog search failed' }, 502);
  }

  const results = (data.results || []).filter(r => r.previewUrl);
  if (results.length === 0) return json({ error: 'no preview found' }, 404);

  const nt = norm(title);
  const na = norm(artist);
  const scored = results.map(r => {
    const rt = norm(r.trackName);
    const ra = norm(r.artistName);
    let s = 0;
    if (rt && rt === nt) s += 3;
    else if (rt && nt && (rt.includes(nt) || nt.includes(rt))) s += 2;
    if (ra && ra === na) s += 2;
    else if (ra && na && (ra.includes(na) || na.includes(ra))) s += 1;
    return { r, s };
  }).sort((a, b) => b.s - a.s);

  const best = scored[0].r;

  let audio;
  try {
    audio = await fetch(best.previewUrl);
  } catch (err) {
    return json({ error: 'preview fetch failed' }, 502);
  }
  if (!audio.ok) return json({ error: 'preview fetch failed' }, 502);

  return new Response(audio.body, {
    status: 200,
    headers: {
      'content-type': audio.headers.get('content-type') || 'audio/mp4',
      'cache-control': 'public, max-age=86400',
      'x-preview-track': encodeURIComponent(best.trackName || ''),
      'x-preview-artist': encodeURIComponent(best.artistName || ''),
      'x-preview-track-ms': String(best.trackTimeMillis || ''),
      'x-preview-id': String(best.trackId || ''),
      'x-preview-score': String(scored[0].s)
    }
  });
}
