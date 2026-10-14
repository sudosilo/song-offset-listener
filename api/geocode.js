export const config = { runtime: 'edge' };

const UA = 'HalvardZoneDirector/1.0 (offset-listener site lookup)';

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function shape(r) {
  const a = r.address || {};
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const town = a.city || a.town || a.village || a.hamlet || '';
  return {
    name: r.name || (r.namedetails && r.namedetails.name) || '',
    address: [street, town, a.state, a.postcode].filter(Boolean).join(', ') || r.display_name || '',
    display: r.display_name || '',
    kind: r.type || r.category || '',
    lat: Number(r.lat),
    lng: Number(r.lon)
  };
}

export default async function handler(request) {
  const p = new URL(request.url).searchParams;
  const q = p.get('q');
  const lat = parseFloat(p.get('lat')), lng = parseFloat(p.get('lng'));
  try {
    if (q) {
      let url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&q=' + encodeURIComponent(q);
      if (!isNaN(lat) && !isNaN(lng)) {
        const d = 0.6;
        url += '&viewbox=' + (lng - d) + ',' + (lat + d) + ',' + (lng + d) + ',' + (lat - d);
      }
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
      const data = await res.json();
      return json({ results: (Array.isArray(data) ? data : []).map(shape) });
    }
    if (!isNaN(lat) && !isNaN(lng)) {
      const res = await fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=' + lat + '&lon=' + lng, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
      const data = await res.json();
      return json({ result: data && !data.error ? shape(data) : null });
    }
    return json({ error: 'need q, or lat and lng' }, 400);
  } catch (err) {
    return json({ error: 'lookup failed' }, 502);
  }
}
