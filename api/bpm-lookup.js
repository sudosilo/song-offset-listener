
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
    source: found ? found.source : null,
    error: found ? null : (lastReason || 'no matching artist in results'),
    v: 2
  });
}

let lastReason = null;
let deezerSeen = '';

async function lookup(title, artist) {
  lastReason = null;
  const dz = await deezer(title, artist);
  if (dz) return dz;
  return getsongbpm(title, artist);
}

async function deezer(title, artist) {
  try {
    const q = artist ? 'artist:"' + artist + '" track:"' + title + '"' : title;
    const res = await fetch('https://api.deezer.com/search?limit=8&q=' + encodeURIComponent(q));
    if (!res.ok) { lastReason = 'deezer http ' + res.status; return null; }
    const data = await res.json();
    if (data && data.error) { lastReason = 'deezer: ' + JSON.stringify(data.error).slice(0, 140); return null; }
    let rows = Array.isArray(data.data) ? data.data : [];
    deezerSeen = rows.length + ' strict';
    if (!rows.length && artist) {
      const loose = await fetch('https://api.deezer.com/search?limit=8&q=' + encodeURIComponent(artist + ' ' + title));
      const ld = loose.ok ? await loose.json() : {};
      rows = Array.isArray(ld.data) ? ld.data : [];
    }
    const want = norm(artist);
    const wantTitle = norm(title);
    const ranked = rows.filter(r => !want || norm(r.artist && r.artist.name).includes(want) || want.includes(norm(r.artist && r.artist.name)));
    ranked.sort((a, b) => (norm(b.title).startsWith(wantTitle) ? 1 : 0) - (norm(a.title).startsWith(wantTitle) ? 1 : 0));
    for (const r of ranked.slice(0, 3)) {
      const tr = await fetch('https://api.deezer.com/track/' + r.id);
      if (!tr.ok) continue;
      const t = await tr.json();
      const bpm = parseFloat(t.bpm);
      if (bpm > 0) return { bpm: Math.round(bpm * 10) / 10, key: null, source: 'deezer' };
    }
    lastReason = ranked.length ? 'deezer has no bpm for this track' : 'deezer found no matching track (' + deezerSeen + ', ' + rows.length + ' rows)';
    return null;
  } catch (err) {
    lastReason = 'deezer unreachable';
    return null;
  }
}

async function getsongbpm(title, artist) {
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
    if (!res.ok) { lastReason = 'getsongbpm http ' + res.status; return []; }
    const data = await res.json();
    if (!Array.isArray(data.search)) { lastReason = 'getsongbpm: ' + JSON.stringify(data.search || data.error || data).slice(0, 120); return []; }
    if (!data.search.length) lastReason = 'getsongbpm returned no songs';
    return data.search;
  } catch (err) {
    lastReason = 'getsongbpm unreachable';
    return [];
  }
}

function pick(rows, wantArtist) {
  const withTempo = rows.filter(r => r && parseFloat(r.tempo) > 0);
  if (!withTempo.length) return null;
  const match = wantArtist ? withTempo.find(r => norm(r.artist && r.artist.name).includes(wantArtist) || wantArtist.includes(norm(r.artist && r.artist.name))) : null;
  const row = match || (wantArtist ? null : withTempo[0]);
  if (!row) return null;
  return { bpm: parseFloat(row.tempo), key: row.key_of || null, source: 'getsongbpm' };
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
