import { encodeGeohash } from './geohash.js';

export function anchorKeyFor(lat, lng, precision) {
  const geohash = encodeGeohash(lat, lng, precision);
  return { key: `songsync:anchor:${geohash}`, geohash };
}

export async function writeAnchor(anchor) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  if (typeof anchor.lat !== 'number' || typeof anchor.lng !== 'number') return false;

  const precision = anchor.precision || 5;
  const built = anchorKeyFor(anchor.lat, anchor.lng, precision);
  const key = built.key;
  const geohash = built.geohash;
  const payload = JSON.stringify(Object.assign({}, anchor, { geohash }));

  try {
    const setRes = await fetch(`${url}/set/${key}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: payload
    });
    await fetch(`${url}/sadd/songsync:activekeys/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return setRes.ok;
  } catch (err) {
    return false;
  }
}
