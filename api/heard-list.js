export const config = { runtime: 'edge' };

// Every song Offset Listener has recognized, one "Title|Artist" per line, for the cache seed script.
export default async function handler() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return new Response('redis not configured\n', { status: 500 });
  const auth = { Authorization: 'Bearer ' + token };
  const seen = new Map();
  const add = (title, artist) => {
    title = (title || '').replace(/[|\r\n]/g, ' ').trim();
    artist = (artist || '').replace(/[|\r\n]/g, ' ').trim();
    if (!title || !artist) return;
    const k = (title + '|' + artist).toLowerCase();
    if (!seen.has(k)) seen.set(k, title + '|' + artist);
  };

  try {
    const res = await fetch(url + '/hgetall/songsync:globalmeta', { headers: auth });
    const flat = (await res.json()).result || [];
    for (let i = 1; i < flat.length; i += 2) {
      try { const m = JSON.parse(flat[i]); add(m.title, m.artist); } catch (e) {}
    }
  } catch (e) {}

  try {
    let cursor = '0', rounds = 0;
    do {
      const res = await fetch(url + '/scan/' + cursor + '/match/songsync:ytcache:*/count/500', { headers: auth });
      const out = (await res.json()).result || ['0', []];
      cursor = String(out[0]);
      for (const key of out[1] || []) {
        try {
          const pair = decodeURIComponent(key.slice('songsync:ytcache:'.length));
          const cut = pair.lastIndexOf('|');
          if (cut > 0) add(pair.slice(0, cut), pair.slice(cut + 1));
        } catch (e) {}
      }
      rounds++;
    } while (cursor !== '0' && rounds < 200);
  } catch (e) {}

  return new Response([...seen.values()].join('\n') + '\n', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
