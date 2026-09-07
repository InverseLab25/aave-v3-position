/**
 * Same-origin proxy for Socket's keyed host, which refuses browser requests outright: its CORS
 * preflight answers 403 with no allow headers. The key and affiliate live here, in the
 * function's environment, and never reach the bundle. Without both it forwards to the public
 * host, which works unkeyed but takes 20bps of the input.
 */
const key = process.env.SOCKET_API_KEY
const affiliate = process.env.SOCKET_AFFILIATE
const host = key && affiliate ? 'https://dedicated-backend.socket.tech' : 'https://public-backend.socket.tech'

async function proxy(request) {
  const url = new URL(request.url)
  const target = host + url.pathname.replace(/^\/api\/socket/, '') + url.search
  const headers = new Headers({ accept: 'application/json' })
  if (affiliate) headers.set('affiliate', affiliate)
  if (key && affiliate) headers.set('x-api-key', key)
  const type = request.headers.get('content-type')
  if (type) headers.set('content-type', type)
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
  })
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  })
}

export const GET = proxy
export const POST = proxy
