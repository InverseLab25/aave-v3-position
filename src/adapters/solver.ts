import type { Adapter, QuoteResponse, TransactionPayload } from './types';
import type { SimulationResult } from './simulate';
import { AggregatorHttpError } from './http';

/**
 * The solver: one server-side request that quotes every provider, simulates each route from the
 * Strategies contract and returns them ranked, with calldata attached. See ~/project/defi-solver.
 *
 * The only route source, for every flow: the leverage open and close, the flip and the plain
 * swap screen. `caller` names who will execute the route, and the server simulates from there.
 * The frontend still runs `validateSwapTx` on what comes back, so a wrong or compromised server
 * can only hand the wallet calldata the contract would reject anyway.
 *
 * Fails closed: an unreachable solver is reported as an aggregator outage, never worked around
 * by quoting from the browser. The keys live on the server and nowhere else.
 */

const solverUrl = () => import.meta.env.VITE_SOLVER_URL as string | undefined;

/** What the server serves. Anything else answers empty without a request, like Socket does. */
export const SOLVER_CHAINS = new Set([8453, 42161]);

/** Provider ids as the server names them, mapped to the names the rest of the app already uses. */
const NAMES: Record<string, string> = { zerox: '0x', socket: 'Socket', nordstern: 'Nordstern' };

interface SolverRoute {
  provider: string;
  venue?: string;
  to: string;
  data: string;
  value: string;
  spender: string;
  receiver: string;
  quotedOut: string;
  measuredOut: string;
  gasUsed: string;
  /** ms epoch. */
  expiresAt?: number;
  /** Off the PositionClosed event, when the route was run as the whole close. */
  close?: { debtRepaid: string; collateralWithdrawn: string; returnedToUser: string };
}

interface SolverAnswer {
  /** ms epoch: the earliest of every route's window and the server's own max age. */
  expiresAt: number;
  routes: SolverRoute[];
  /** Why each candidate was dropped. Only the codes matter here. */
  rejected?: { code: string }[];
}

/** Rejections that say nothing about the pair: the provider did not answer, or was not asked. */
const STALL = new Set(['TIMEOUT', 'HTTP_ERROR', 'RATE_LIMITED']);

/** What rides in `rawQuote`: the route as served, plus the answer's own deadline. */
type SolverRaw = SolverRoute & { deadline: number };

interface Turnstile {
  render: (el: HTMLElement, opts: {
    sitekey: string;
    callback: (token: string) => void;
    'error-callback'?: () => boolean | void;
  }) => string;
  remove: (widgetId: string) => void;
}

/**
 * One Turnstile token. The script is loaded on first use, the widget rendered into a throwaway
 * element: in invisible mode the user sees nothing and the callback fires on its own.
 */
async function turnstileToken(): Promise<string> {
  const g = globalThis as { turnstile?: Turnstile };
  if (!g.turnstile) {
    await new Promise<void>((ok, fail) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => ok();
      s.onerror = () => fail(new Error('Turnstile failed to load'));
      document.head.append(s);
    });
  }
  return new Promise((ok, fail) => {
    const el = document.body.appendChild(document.createElement('div'));
    // Invisible widgets render nothing here. A Managed one shows a checkbox when Cloudflare wants
    // a click, and it has to be somewhere the user can see it or the challenge just times out.
    el.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:10000';
    // Turnstile keeps retrying a failed widget on its own; tear it down first so it doesn't
    // go looking for a container we've already removed.
    let id: string | undefined = undefined; // the stub in tests calls back before render returns
    const done = () => { if (id) g.turnstile!.remove(id); el.remove(); };
    id = g.turnstile!.render(el, {
      sitekey: (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? '',
      callback: (t) => { done(); ok(t); },
      // Returning true tells Turnstile we handled it, which silences its console error.
      'error-callback': () => { done(); fail(new Error('Turnstile rejected')); return true; },
    });
  });
}

/**
 * The session token, in memory only. Never localStorage: it is a bearer credential against our
 * own quota. One in flight at a time, so a burst of quotes costs one Turnstile pass, not five.
 */
let session: Promise<{ token: string; expiresAt: number }> | null = null;

export function resetSolverSession(): void {
  session = null;
  socket?.then((c) => c.ws.close(), () => {});
  socket = null;
}

/** A fetch whose transport failure reads as the solver being down, which the panel knows how to say. */
async function post(path: string, body: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  const url = `${solverUrl()}${path}`;
  try {
    return await fetch(url, { method: 'POST', body, signal, headers: { 'content-type': 'application/json', ...headers } });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new AggregatorHttpError(503, url);
  }
}

async function sessionToken(): Promise<string> {
  // A minute of slack against clock skew: past that the server would refuse the upgrade, and
  // a refused upgrade looks like the server being down.
  const live = await session?.catch(() => null);
  if (live && live.expiresAt < Date.now() + 60_000) session = null;
  session ??= (async () => {
    const res = await post('/session', JSON.stringify({ turnstileToken: await turnstileToken() }), {});
    if (!res.ok) throw new AggregatorHttpError(res.status, `${solverUrl()}/session`);
    return (await res.json()) as { token: string; expiresAt: number };
  })();
  session.catch(() => { session = null; });
  return (await session).token;
}

/**
 * Quotes ride one websocket per session rather than a POST each: no handshake per quote, and
 * the server shares one in-flight run between every subscriber asking for the same trade.
 * Opened lazily, dropped on close; the next quote reopens it.
 */
type Conn = {
  ws: WebSocket;
  pending: Map<string, { ok: (a: SolverAnswer) => void; fail: (e: Error) => void }>;
  /** Live subscriptions by trade, and the same by request id for the messages that feed them. */
  streams: Map<string, Stream>;
  byId: Map<string, Stream>;
};
let socket: Promise<Conn> | null = null;

/** Told each time a stream lands a pass, so a preview can re-read the field then rather than on a clock. */
const watchers = new Set<() => void>();
export function onSolverUpdate(fn: () => void): () => void {
  watchers.add(fn);
  return () => { watchers.delete(fn); };
}

/**
 * A trade the server keeps re-quoting: each provider runs its own loop, quote, simulate, push,
 * wait STREAM_EVERY_MS, again. Routes arrive one at a time and are swapped in per provider at
 * its `cycle`, so a venue that stopped passing drops out on the next pass rather than lingering.
 * Nobody reading it for STREAM_IDLE_MS stops it.
 */
interface Stream {
  id: string;
  /** Committed routes per provider, with the deadline of the pass that produced them. */
  routes: Map<string, { list: SolverRoute[]; deadline: number }>;
  /** Routes of the pass in progress, per provider. */
  pass: Map<string, SolverRoute[]>;
  idle: ReturnType<typeof setTimeout>;
}
const STREAM_EVERY_MS = 1000;
/** Longer than a pass plus the re-quote it triggers, shorter than a forgotten tab. */
const STREAM_IDLE_MS = 8000;

function stopStream(conn: Conn, key: string): void {
  const s = conn.streams.get(key);
  if (!s) return;
  clearTimeout(s.idle);
  conn.streams.delete(key);
  conn.byId.delete(s.id);
  if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify({ id: s.id, stop: true }));
}

/**
 * The stream for this trade, started here once a one-shot has shown the pair prices at all;
 * null before that. Every ask pushes the idle stop back, so a probe size the sizing loop asked
 * once and moved on from is stopped on the server a few seconds later.
 */
function streamFor(conn: Conn, key: string, body: object, start: boolean): Stream | null {
  let s = conn.streams.get(key);
  if (!s) {
    if (!start) return null;
    const id = `s${++seq}`;
    s = { id, routes: new Map(), pass: new Map(), idle: setTimeout(() => {}, 0) };
    conn.streams.set(key, s);
    conn.byId.set(id, s);
    conn.ws.send(JSON.stringify({ id, ...body, every: STREAM_EVERY_MS }));
  }
  clearTimeout(s.idle);
  s.idle = setTimeout(() => stopStream(conn, key), STREAM_IDLE_MS);
  return s;
}
let gen = 0;
let seq = 0;

function connect(): Promise<Conn> {
  socket ??= (async () => {
    const mine = ++gen;
    const url = `${solverUrl()}/ws`;
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}?token=${encodeURIComponent(await sessionToken())}`);
    // Per connection, so a socket closing late can only fail its own requests, never its successor's.
    const conn: Conn = { ws, pending: new Map(), streams: new Map(), byId: new Map() };
    const { pending } = conn;
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as {
        id?: string; error?: string; done?: boolean; route?: SolverRoute; cycle?: boolean; provider?: string;
      } & Partial<SolverAnswer>;
      const s = m.id ? conn.byId.get(m.id) : undefined;
      if (s) {
        if (m.route) {
          const list = s.pass.get(m.route.provider) ?? [];
          list.push(m.route);
          s.pass.set(m.route.provider, list);
        } else if (m.cycle && m.provider) {
          s.routes.set(m.provider, { list: s.pass.get(m.provider) ?? [], deadline: m.expiresAt ?? Date.now() });
          s.pass.delete(m.provider);
          for (const w of watchers) w();
        } else if (m.error) {
          // Refused (rate limited, bad request): the one-shot path reports why on the next ask.
          for (const [key, x] of conn.streams) if (x === s) stopStream(conn, key);
        }
        return;
      }
      const p = m.id ? pending.get(m.id) : undefined;
      if (!p) return;
      // Per-route pushes ({ id, route }) on a one-shot are skipped: the caller ranks the whole field once, at `done`.
      if (m.error) {
        pending.delete(m.id!);
        p.fail(new AggregatorHttpError(m.error === 'rate limited' ? 429 : m.error === 'bad request' ? 400 : 503, url));
      } else if (m.done) {
        pending.delete(m.id!);
        p.ok(m as SolverAnswer);
      }
    };
    ws.onclose = (e) => {
      if (gen === mine) socket = null;
      // 4001 is the server closing at session expiry; anything else is the transport.
      if (e.code === 4001) session = null;
      for (const p of pending.values()) p.fail(new AggregatorHttpError(e.code === 4001 ? 401 : 503, url));
      pending.clear();
      // The streams died with the socket; the next ask on a fresh one restarts them.
      for (const s of conn.streams.values()) clearTimeout(s.idle);
      conn.streams.clear();
      conn.byId.clear();
    };
    await new Promise<void>((ok, fail) => {
      ws.onopen = () => ok();
      ws.onerror = () => fail(new AggregatorHttpError(503, url));
    });
    return conn;
  })();
  socket.catch(() => { socket = null; });
  return socket;
}

function quoteOverSocket(body: object, signal?: AbortSignal): Promise<SolverAnswer> {
  return new Promise((ok, fail) => {
    connect().then(({ ws, pending }) => {
      if (signal?.aborted) return fail(new DOMException('aborted', 'AbortError'));
      const id = `q${++seq}`;
      pending.set(id, { ok, fail });
      signal?.addEventListener('abort', () => {
        if (!pending.delete(id)) return;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id, stop: true }));
        fail(new DOMException('aborted', 'AbortError'));
      }, { once: true });
      ws.send(JSON.stringify({ id, ...body }));
    }, fail);
  });
}

/**
 * The server's measurement for a solver quote, in the shape the browser's simulator reports.
 * Null for a quote that carries none, which `effectiveOut` reads as "not measured".
 */
export function solverMeasurement(quote: QuoteResponse): SimulationResult | null {
  const r = quote.rawQuote as Partial<SolverRaw> | undefined;
  if (r?.measuredOut === undefined) return null;
  return { ok: true, amountOut: BigInt(r.measuredOut), gasUsed: Number(r.gasUsed) };
}

/** What the whole close did with this route, or null when only the swap was simulated. */
export function solverClose(quote: QuoteResponse): { debtRepaid: bigint; collateralWithdrawn: bigint; returnedToUser: bigint } | null {
  const c = (quote.rawQuote as Partial<SolverRaw> | undefined)?.close;
  if (!c) return null;
  return { debtRepaid: BigInt(c.debtRepaid), collateralWithdrawn: BigInt(c.collateralWithdrawn), returnedToUser: BigInt(c.returnedToUser) };
}

/**
 * The trade's live routes, or null when the stream has none yet (or the socket is down, which
 * the one-shot is left to report). Committed routes only, unexpired, ranked by the server's
 * measurement, since each provider's pass lands on its own clock.
 */
async function streamRoutes(body: object, signal?: AbortSignal): Promise<SolverRaw[] | null> {
  const key = JSON.stringify(body);
  const now = Date.now();
  // Only over a socket the one-shot path has already opened: a stream never dials on its own.
  if (!socket) return null;
  let conn: Conn;
  try { conn = await socket; } catch { return null; }
  if (signal?.aborted) return null;
  const s = streamFor(conn, key, body, false);
  if (!s) return null;
  const live: SolverRaw[] = [];
  for (const { list, deadline } of s.routes.values()) {
    if (deadline <= now) continue;
    for (const r of list) if (!r.expiresAt || r.expiresAt > now) live.push({ ...r, deadline });
  }
  if (!live.length) return null;
  return live.sort((a, b) => (BigInt(b.measuredOut) > BigInt(a.measuredOut) ? 1 : -1));
}

/**
 * This adapter is the `aggregator` (it is what builds the route); the provider and its venue
 * name the ROW. A repeated name gets a suffix rather than silently sharing a key with the
 * route before it.
 */
function toQuotes(routes: SolverRaw[], amountIn: string, toAsset: { decimals: number; priceInUsd?: string | number | null }): QuoteResponse[] {
  const taken = new Set<string>();
  return routes.map((r) => {
    const name = (NAMES[r.provider] ?? r.provider) + (r.venue ? ` · ${r.venue}` : '');
    let routeId = name;
    let n = 2;
    while (taken.has(routeId)) routeId = `${name} ${n++}`;
    taken.add(routeId);
    const outUnits = Number(r.quotedOut) / 10 ** toAsset.decimals;
    const amountOutUsd = toAsset.priceInUsd ? outUnits * Number(toAsset.priceInUsd) : 0;
    return {
      aggregator: 'Solver',
      routeId,
      amountIn,
      // The provider's own claim. What it MEASURED comes back through `solverMeasurement`,
      // so sizing keeps running on the quote and selection on the measurement, as today.
      amountOut: r.quotedOut,
      amountOutUsd: amountOutUsd.toFixed(2),
      gasEstimate: r.gasUsed,
      gasUsd: '0',
      netReturnUsd: amountOutUsd,
      rawQuote: r satisfies SolverRaw,
      routeDetails: { type: 'solver', info: 'Quoted and simulated by the solver' },
    };
  });
}

export const solverAdapter: Adapter = {
  name: 'Solver',
  supportsExecution: true,

  // The placeholder-caller round makes no sense here: every solver quote is built for the
  // contract. Quote through `getQuotes`, which every leverage flow already does.
  getQuote: async () => null,

  getQuotes: async ({ fromAsset, toAsset, amountIn, slippage, chainId, caller, owner, close, signal }): Promise<QuoteResponse[]> => {
    if (!SOLVER_CHAINS.has(chainId)) return [];
    const body = {
      chainId,
      // Socket signs and pays its route for this wallet. Without one connected, the contract
      // stands in, which is exactly the server's own warm-up probe.
      owner: owner ?? caller,
      caller,
      tokenIn: fromAsset.underlyingAsset,
      tokenOut: toAsset.underlyingAsset,
      amountIn,
      slippageBps: Math.round(slippage * 100),
      ...(close ? { close } : {}),
    };
    try {
      // Every ask keeps the trade's stream alive; once it has routes they are what is
      // answered, at most a second and a quote old, with no request made. Until then, and
      // whenever the stream is empty, the one-shot below asks and says why if nothing prices —
      // and once it has priced, starts the stream so the next ask is answered from it.
      const live = await streamRoutes(body, signal);
      if (live) return toQuotes(live, amountIn, toAsset);

      let answer: SolverAnswer;
      try {
        answer = await quoteOverSocket(body, signal);
      } catch (e) {
        // A refused upgrade and a rotated session both surface as the socket dropping. One
        // fresh session, one retry, and no loop. 503 past that is "every provider was rate
        // limited" or the server down, 400 "the pair is unsupported": the existing error types
        // already tell those apart as retryable and not.
        if (!(e instanceof AggregatorHttpError) || (e.status !== 401 && e.status !== 503) || signal?.aborted) throw e;
        session = null;
        answer = await quoteOverSocket(body, signal);
      }
      // Empty because nobody answered in time is the aggregator stalling on this one call, not
      // a pair with no route. Reported the way a down server is, so the close flow keeps its
      // last preview and retries instead of declaring the pair unclosable.
      if (answer.routes.length === 0 && answer.rejected?.length && answer.rejected.every((r) => STALL.has(r.code))) {
        throw new AggregatorHttpError(503, `${solverUrl()}/ws`);
      }

      if (answer.routes.length && socket) socket.then((c) => streamFor(c, JSON.stringify(body), body, true), () => {});
      return toQuotes(answer.routes.map((r) => ({ ...r, deadline: answer.expiresAt })), amountIn, toAsset);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError' || signal?.aborted) return [];
      throw e;
    }
  },

  buildTransaction: async (quote): Promise<TransactionPayload> => {
    const r = quote.rawQuote as SolverRaw;
    // Refused here rather than on chain: past its window a route reverts, and finding that out
    // costs the user the gas. The preview re-quotes every few seconds, so this is rarely hit.
    if (Math.min(r.expiresAt ?? Infinity, r.deadline) <= Date.now()) {
      throw new Error('Solver: route expired before it could be submitted');
    }
    return {
      to: r.to,
      data: r.data,
      value: r.value,
      spender: r.spender,
      amountOut: r.measuredOut,
      gasEstimate: r.gasUsed,
    };
  },
};
