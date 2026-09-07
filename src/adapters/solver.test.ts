import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AggregatorHttpError } from './http'
import { resetSolverSession, solverAdapter, solverMeasurement } from './solver'

const OWNER = '0x1111111111111111111111111111111111111111'
const CONTRACT = '0x2222222222222222222222222222222222222222'
const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const args = {
  fromAsset: { underlyingAsset: WETH, symbol: 'WETH', decimals: 18 },
  toAsset: { underlyingAsset: USDC, symbol: 'USDC', decimals: 6 },
  amountIn: '1000000000000000000',
  slippage: 0.5,
  chainId: 8453,
  caller: CONTRACT,
  owner: OWNER,
}

const route = (over: Record<string, unknown> = {}) => ({
  provider: 'socket',
  venue: '0x',
  to: '0x3333333333333333333333333333333333333333',
  data: '0xdeadbeef',
  value: '0',
  spender: '0x3333333333333333333333333333333333333333',
  receiver: OWNER,
  quotedOut: '2500000000',
  measuredOut: '2499000000',
  gasUsed: '180000',
  ...over,
})

const answer = (routes: unknown[]) => ({
  requestId: 'q_1', generatedAt: 1, expiresAt: Date.now() + 30_000, blockNumber: '1',
  cached: false, routes, rejected: [], timings: { total: 1, rpcQueue: 0, simulate: 0 },
})

const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body })

/**
 * The solver's websocket. Opens on the next tick and answers each { id, ...body } with the next
 * queued reply, stamped with that id — or holds it, for the tests about cancelling.
 */
class FakeSocket {
  static OPEN = 1
  static instances: FakeSocket[] = []
  static replies: object[] = []
  static hold = false
  static refuse = false
  readyState = 0
  sent: Record<string, unknown>[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  url: string
  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
    queueMicrotask(() => {
      if (FakeSocket.refuse) return this.onerror?.()
      this.readyState = 1
      this.onopen?.()
    })
  }
  send(raw: string) {
    const m = JSON.parse(raw) as Record<string, unknown>
    this.sent.push(m)
    if (m.stop || FakeSocket.hold) return
    const reply = FakeSocket.replies.shift() ?? { error: 'nothing queued' }
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: m.id, ...reply }) }))
  }
  close(code = 1000) {
    this.readyState = 3
    queueMicrotask(() => this.onclose?.({ code }))
  }
  /** The server closing the socket because the session behind it expired. */
  expire() {
    this.readyState = 3
    this.onclose?.({ code: 4001 })
  }
}
const done = (routes: unknown[]) => ({ done: true, ...answer(routes) })
const sockets = () => FakeSocket.instances
const flush = () => new Promise((r) => setTimeout(r, 0))

/** A fetch that answers /session with a token, and a socket that answers with whatever the test queued. */
function stubServer(replies: object[]) {
  const calls: { url: string; init: RequestInit }[] = []
  let session = 0
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (url.endsWith('/session')) return json(200, { token: `s${++session}`, expiresAt: Date.now() + 3_600_000 })
    return json(404, {})
  })
  vi.stubGlobal('fetch', fetchMock)
  FakeSocket.replies = replies
  return calls
}

beforeEach(() => {
  vi.stubEnv('VITE_SOLVER_URL', 'https://solver.test')
  vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'site')
  // Turnstile's script is already "loaded": the widget calls back with a token straight away.
  FakeSocket.instances = []
  FakeSocket.replies = []
  FakeSocket.hold = false
  FakeSocket.refuse = false
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('turnstile', {
    render: (_el: HTMLElement, opts: { callback: (t: string) => void }) => { opts.callback('tt-1'); return 'w1' },
    reset: vi.fn(),
  })
  resetSolverSession()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('solverAdapter.getQuotes', () => {
  it('sends the trade over a session-scoped socket, with the wallet as owner and the contract as caller', async () => {
    const calls = stubServer([done([route()])])
    await solverAdapter.getQuotes!(args)

    expect(sockets()).toHaveLength(1)
    expect(sockets()[0].url).toBe('wss://solver.test/ws?token=s1')
    expect(sockets()[0].sent[0]).toEqual({
      id: expect.any(String), chainId: 8453, owner: OWNER, caller: CONTRACT, tokenIn: WETH, tokenOut: USDC,
      amountIn: '1000000000000000000', slippageBps: 50,
    })
    const session = calls.find((c) => c.url.endsWith('/session'))!
    expect(JSON.parse(session.init.body as string)).toEqual({ turnstileToken: 'tt-1' })
  })

  it('maps each route onto a quote the existing pipeline can rank, pin and build', async () => {
    stubServer([done([route(), route({ provider: 'nordstern', venue: undefined, receiver: CONTRACT, quotedOut: '2400000000', measuredOut: '2401000000' })])])
    const quotes = await solverAdapter.getQuotes!(args)

    expect(quotes.map((q) => [q.aggregator, q.routeId, q.amountOut])).toEqual([
      ['Solver', 'Socket · 0x', '2500000000'],
      ['Solver', 'Nordstern', '2400000000'],
    ])
    expect(quotes[0].amountIn).toBe(args.amountIn)
    // Measured on the server, so the browser never simulates: the result is read back off the quote.
    expect(solverMeasurement(quotes[0])).toEqual({ ok: true, amountOut: 2499000000n, gasUsed: 180000 })

    const tx = await solverAdapter.buildTransaction(quotes[0], 0.5, CONTRACT, 8453)
    expect(tx).toEqual({
      to: '0x3333333333333333333333333333333333333333', data: '0xdeadbeef', value: '0',
      spender: '0x3333333333333333333333333333333333333333', amountOut: '2499000000', gasEstimate: '180000',
    })
  })

  it('keeps one socket across quotes, and reconnects on a fresh session once the server closes it at expiry', async () => {
    const calls = stubServer([done([route()]), done([route()]), done([route()])])
    await solverAdapter.getQuotes!(args)
    await solverAdapter.getQuotes!(args)
    expect(sockets()).toHaveLength(1)
    expect(sockets()[0].sent).toHaveLength(2)

    sockets()[0].expire()
    const again = await solverAdapter.getQuotes!(args)

    expect(again).toHaveLength(1)
    expect(sockets()).toHaveLength(2)
    expect(sockets()[1].url).toBe('wss://solver.test/ws?token=s2')
    expect(calls.filter((c) => c.url.endsWith('/session'))).toHaveLength(2)
  })

  it('retries a refused upgrade once on a fresh session, then reports it as retryable', async () => {
    // A stale token and a server that is down look the same from here: the socket never opens.
    const calls = stubServer([])
    FakeSocket.refuse = true
    const err = await solverAdapter.getQuotes!(args).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(AggregatorHttpError)
    expect((err as AggregatorHttpError).retryable).toBe(true)
    expect(calls.filter((c) => c.url.endsWith('/session'))).toHaveLength(2)
    expect(sockets()).toHaveLength(2)
  })

  it('maps the server refusing a quote onto the existing error types', async () => {
    stubServer([{ error: 'rate limited' }])
    const err = await solverAdapter.getQuotes!(args).catch((e: unknown) => e)
    expect((err as AggregatorHttpError).status).toBe(429)
    expect((err as AggregatorHttpError).retryable).toBe(true)
  })

  it('tells the server to stop a quote the caller abandoned, and answers empty', async () => {
    stubServer([])
    FakeSocket.hold = true
    const ac = new AbortController()
    const p = solverAdapter.getQuotes!({ ...args, signal: ac.signal })
    await flush()
    ac.abort()

    expect(await p).toEqual([])
    const [asked, stopped] = sockets()[0].sent
    expect(stopped).toEqual({ id: asked.id, stop: true })
  })

  it('reports an unreachable solver as a retryable aggregator failure, not as no route', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const err = await solverAdapter.getQuotes!(args).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AggregatorHttpError)
    expect((err as AggregatorHttpError).retryable).toBe(true)
  })

  it('answers nothing on a chain the solver does not serve, without asking it', async () => {
    const calls = stubServer([])
    expect(await solverAdapter.getQuotes!({ ...args, chainId: 1 })).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('refuses to build a route whose window has closed', async () => {
    stubServer([done([route({ expiresAt: Date.now() - 1 })])])
    const [q] = await solverAdapter.getQuotes!(args)
    await expect(solverAdapter.buildTransaction(q, 0.5, CONTRACT, 8453)).rejects.toThrow(/expired/)
  })
})
