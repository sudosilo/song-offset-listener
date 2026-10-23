
export const config = { runtime: 'edge' };

const HEADERS = {
  'content-type': 'application/json',
  'Access-Control-Allow-Origin': '*'
};

export default async function handler(request) {
  const params = new URL(request.url).searchParams;
  const title = cleanTitle(params.get('title') || '');
  const artist = (params.get('artist') || '').trim();

  if (!title) return reply({ error: 'missing title', bpm: null }, 400);

  let found = null;
  try { found = await lookup(title, artist); } catch (err) { found = null; }

  return reply({
    title,
    artist,
    bpm: found ? found.bpm : null,
    key: found ? found.key : null,
    source: found ? 'getsongbpm' : null,
    error: found ? null : 'no bpm found'
  });
}

async function lookup(title, artist) {
  const key = process.env.GETSONGBPM_API_KEY;
  if (!key) return null;
  const base = 'https://api.getsongbpm.com/search/?api_key=' + encodeURIComponent(key);
  const want = norm(artist);

  if (artist) {
    const both = await get(base + '&type=both&limit=10&lookup=' + encodeURIComponent('song:' + title + ' artist:' + artist));
    const hit = pick(both, want);
    if (hit) return hit;
  }
  const songOnly = await get(base + '&type=song&limit=30&lookup=' + encodeURIComponent(title));
  return pick(songOnly, want);
}

async function get(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'LyricSmash/1.0' } });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.search) ? data.search : [];
  } catch (err) {
    return [];
  }
}

function pick(rows, wantArtist) {
  const withTempo = rows.filter(r => r && parseFloat(r.tempo) > 0);
  if (!withTempo.length) return null;
  const match = wantArtist ? withTempo.find(r => norm(r.artist && r.artist.name).includes(wantArtist) || wantArtist.includes(norm(r.artist && r.artist.name))) : null;
  const row = match || (wantArtist ? null : withTempo[0]);
  if (!row) return null;
  return { bpm: parseFloat(row.tempo), key: row.key_of || null };
}

function norm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function cleanTitle(raw) {
  return raw
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(instrumental|official|audio|video|lyrics?|hd|hq|remaster(ed)?|beat|prod\.?.*)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function reply(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: HEADERS });
}
