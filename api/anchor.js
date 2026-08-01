export const config = { runtime: 'edge' };

export default async function handler(request) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return new Response(JSON.stringify({ error: 'redis not configured' }), { status: 500 });
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
