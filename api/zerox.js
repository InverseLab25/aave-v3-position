/**
 * Same-origin proxy for 0x's Swap API, so the key lives in the function's environment and
 * never reaches the bundle. Without a key 0x answers 401 and the adapter shows no route.
 */
const key = process.env.ZEROX_API_KEY
const host = 'https://api.0x.org'

async function proxy(request) {
  // vercel.json rewrites /api/zerox/<path> here as ?path=<path>, with the original query kept.
  const url = new URL(request.url)
  const path = url.searchParams.get('path') ?? ''
  url.searchParams.delete('path')
  const target = `${host}/${path}${url.search}`
  const headers = new Headers({ accept: 'application/json', '0x-version': 'v2' })
  if (key) headers.set('0x-api-key', key)
  const upstream = await fetch(target, { method: 'GET', headers })
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  })
}

export const GET = proxy
