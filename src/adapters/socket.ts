import type { Adapter, Asset, QuoteResponse, TransactionPayload } from './types';
import { fetchQuoteJson, limitedFetch } from './http';

/**
 * Socket (formerly Bungee), quoting same-chain swaps only.
 *
 * Socket is a router over routers: one request returns several routes across DEXs, bridges and
 * solvers. Setting `originChainId` equal to `destinationChainId` keeps it entirely on-chain
 * through DEX liquidity, which is the only shape this app has any use for.
 *
 * In `COMPATIBLE_ADAPTERS`. The approval spender and the call target are the same contract —
 * Socket's AllowanceHolder, with the router call wrapped inside the returned calldata — so it
 * passes `validateSwapTx`, and that AllowanceHolder is allowlisted on Base and Arbitrum.
 * What is NOT settled is whether a contract can execute one of these routes. The public
 * endpoint signs every quote for an EOA and ignores `contractCaller` outright — the calldata it
 * returns is byte-identical with and without the parameter, quoteId aside — so a route run by
 * AaveV3Strategies reverts with `CallerNotSignedUser()` (0x85132e0f). Measured on Base at
 * 25,243 USDC via scripts/socket-sim.mjs: all three top routes reverted. The parameter is
 * therefore not sent at all; sending a flag the endpoint discards only made it look handled.
 * Whether the keyed `dedicated-backend.socket.tech` host signs for a contract is untested.
 * Quote-and-swap from the user's own wallet is unaffected and works.
 */

/** Attribution, when one is configured. The public host allows this header through CORS. */
const SOCKET_AFFILIATE = import.meta.env.VITE_SOCKET_AFFILIATE as string | undefined;

/**
 * Where the quotes come from: a same-origin proxy when there is one, the public host otherwise.
 *
 * There is no third option. The keyed host, `dedicated-backend.socket.tech`, answers a CORS
 * preflight with 403 and no `access-control-allow-*` headers at all, so no browser request can
 * reach it whatever headers it carries — and `public-backend` allows only `affiliate` through
 * CORS, never `x-api-key`. So the key cannot live in this file under any spelling; it lives on
 * whatever serves `/api/socket` (the Vite dev proxy locally, a serverless function deployed),
 * which adds `x-api-key` and `affiliate` on the way through.
 *
 * Worth doing because the unkeyed host takes 20bps of the input out of every route — 50 USDC on
 * a 25k swap, to 0xe3D091bcb9406Ddb9a121e37f4eb1345336AFBBf — which leaves Socket permanently
 * behind Nordstern on the same trade. Keyed, that fee is gone.
 *
 * Automatic in dev, where vite.config.ts always serves that path. Opt-in for a build, because
 * pointing at `/api/socket` where nothing serves it turns every quote into an HTML 404 that
 * reads as Socket being down — set `VITE_SOCKET_PROXY` once something answers it there.
 * `VITE_SOCKET_BASE` overrides both.
 */
const SOCKET_BASE =
  (import.meta.env.VITE_SOCKET_BASE as string | undefined) ??
  (import.meta.env.DEV || import.meta.env.VITE_SOCKET_PROXY
    ? '/api/socket'
    : 'https://public-backend.socket.tech');

/** Chains this app configures that Socket serves. */
const SOCKET_CHAINS = new Set([1, 10, 137, 8453, 42161]);

/**
 * The address a quote is taken for, before the real caller is known.
 *
 * Socket requires both `userAddress` and `receiverAddress` and bakes them into the calldata, so
 * a quote is addressed to one caller the way Nordstern's is. This is the address Socket's own
 * same-chain example uses; the zero address is not documented as accepted, and only `amount` is
 * read from the placeholder round anyway. `buildTransaction` re-asks with the real caller.
 */
const QUOTE_PLACEHOLDER = '0x1111111111111111111111111111111111111111';

/** The subset of a route this adapter reads. */
interface SocketRoute {
  quoteId?: string;
  /** Unix seconds. A route past it fails on chain, so it is never built. */
  expiresAt?: number;
  output?: { amount: string; valueInUsd?: number };
  /** `dexDetails` on a same-chain route; the protocol underneath is the only label worth showing. */
  routeDetails?: { dexDetails?: { protocol?: { name?: string; displayName?: string } } | null };
  approval?: { spenderAddress: string } | null;
  txData?: { kind: string; object?: { to: string; data: string; value: string | number } };
  /** A string on most routes and a bare number on others, so both are read. */
  gasFee?: { gasLimit?: string | number; feeInUsd?: number };
}

/**
 * The live response wraps everything in an envelope the published example omits.
 *
 * Reading `routes` off the top level finds nothing, and an adapter that always answers null is
 * an aggregator that silently never appears.
 */
interface SocketQuoteResponse {
  success?: boolean;
  result?: {
    input?: { amount: string; valueInUsd?: number };
    routes?: SocketRoute[];
  };
}

/** What `buildTransaction` needs to re-ask for the same trade, addressed to the real caller. */
interface SocketQuote {
  chainId: number;
  inputToken: string;
  outputToken: string;
  inputAmount: string;
  /**
   * Where the quote asked for the output, when that was not the caller.
   *
   * Carried on the quote because `buildTransaction` is handed only the sender and has to re-ask
   * for the same trade — without this the build would quietly pay the caller instead, and the
   * calldata it returns is what actually executes.
   */
  receiver?: string;
  /**
   * The transaction `getQuotes` already fetched, and who it was signed for.
   *
   * Absent from a `getQuote` result, whose round used a placeholder caller.
   */
  prebuilt?: {
    caller: string;
    to: string;
    data: string;
    value: string;
    spender: string;
    amountOut: string;
    gasEstimate?: string;
    expiresAt?: number;
  };
}

const quoteUrl = (q: SocketQuote, slippage: number, caller: string, receiver = caller) =>
  `${SOCKET_BASE}/v3/swap/quote?` +
  new URLSearchParams({
    userOps: 'tx',
    // Socket's default, sent explicitly: the input is the amount we hold and the output is
    // whatever it fetches. Every sizing loop in this app solves for an exact INPUT, so a quote
    // pinned to an exact output would answer a question nothing here asks.
    quoteType: 'EXACT_INPUT',
    // Same chain on both sides: no bridge leg, no destination to wait on, no status to poll.
    originChainId: String(q.chainId),
    destinationChainId: String(q.chainId),
    inputToken: q.inputToken,
    outputToken: q.outputToken,
    inputAmount: q.inputAmount,
    // Two different questions: who the route is signed for, and who the output is paid to.
    userAddress: caller,
    receiverAddress: receiver,
    // A decimal percentage, not basis points.
    slippage: String(slippage),
    // Off. Socket simulates each route and drops the ones that revert, but it does it serially
    // before answering: the same quote takes 2.5-5s with this on against well under a second
    // without. This app simulates its own top candidates through `selectBuildableRoute` and
    // ranks on what it measures, so paying Socket's latency to be told the same thing twice
    // only slows every sizing round down.
    simulatedQuotesRequired: 'false',
  }).toString();

// No `x-api-key` here, ever: CORS forbids it on both hosts, and the proxy adds it where it can.
const headers = (): HeadersInit =>
  SOCKET_AFFILIATE ? { affiliate: SOCKET_AFFILIATE } : {};

/** The route with the most output. Socket ranks its own with tags; this app ranks on output. */
const bestRoute = (routes: SocketRoute[] | undefined): SocketRoute | null => {
  let best: SocketRoute | null = null;
  // The winner's amount is carried alongside it rather than re-parsed each time round. Socket
  // returns a route per underlying aggregator, so the list is not short — and holding the value
  // also retires the non-null assertion that reaching back into `best.output` needed.
  let bestOut = 0n;
  for (const route of routes ?? []) {
    if (!route.output?.amount) continue;
    const out = BigInt(route.output.amount);
    if (best === null || out > bestOut) {
      best = route;
      bestOut = out;
    }
  }
  return best;
};

/**
 * One route as a quote, with the transaction attached when it is executable as returned.
 *
 * `prebuilt` is only set by `getQuotes`, which quotes for the real caller. `getQuote` uses a
 * placeholder, so its calldata belongs to nobody and must be re-asked for at build time.
 */
const toQuote = (
  route: SocketRoute,
  json: SocketQuoteResponse,
  q: SocketQuote,
  toAsset: Asset,
  amountIn: string,
  caller?: string,
  /** Names already taken by earlier routes in the same answer, so this one can stay unique. */
  taken?: Set<string>,
): QuoteResponse | null => {
  if (!route.output?.amount) return null;

  const outUnits = Number(route.output.amount) / 10 ** toAsset.decimals;
  // Re-priced against the Aave oracle where the caller has a price, exactly as KyberSwap's
  // is; Socket's own figure is the fallback rather than the default.
  const amountOutUsd = toAsset.priceInUsd
    ? outUnits * Number(toAsset.priceInUsd)
    : route.output.valueInUsd ?? 0;
  const gasUsd = route.gasFee?.feeInUsd ?? 0;
  const tx = route.txData?.object;

  // The venue underneath is what the row is called and what it is keyed by. Socket returns one
  // route per venue and they can repeat, so a name already used gets a suffix rather than
  // silently sharing a key with the route before it.
  const venue = route.routeDetails?.dexDetails?.protocol?.displayName
    ?? route.routeDetails?.dexDetails?.protocol?.name;
  let routeId = venue ? `${venue}` : undefined;
  if (routeId && taken) {
    let n = 2;
    while (taken.has(routeId)) routeId = `${venue} ${n++}`;
    taken.add(routeId);
  }

  return {
    aggregator: 'Socket',
    routeId,
    amountIn,
    amountOut: route.output.amount,
    // Socket prices both sides itself, so `routeCostPercent` works here — unlike the
    // aggregators that report no USD at all and leave it null.
    rawAmountInUsd: json.result?.input?.valueInUsd?.toString(),
    rawAmountOutUsd: route.output.valueInUsd?.toString(),
    amountOutUsd: amountOutUsd.toFixed(2),
    gasEstimate: route.gasFee?.gasLimit?.toString(),
    gasUsd: gasUsd.toFixed(2),
    netReturnUsd: amountOutUsd - gasUsd,
    rawQuote: {
      ...q,
      ...(caller && tx && route.txData?.kind === 'evm_tx'
        ? {
            prebuilt: {
              caller,
              to: tx.to,
              data: tx.data,
              value: String(tx.value ?? '0'),
              spender: route.approval?.spenderAddress ?? tx.to,
              amountOut: route.output.amount,
              gasEstimate: route.gasFee?.gasLimit?.toString(),
              expiresAt: route.expiresAt,
            },
          }
        : {}),
    },
    routeDetails: {
      type: 'socket',
      // The venue is the row's own title now, so this says how it is reached rather than
      // repeating the name directly above it.
      info: 'Routed via Socket',
    },
  };
};

/** Routes this app could actually submit: an EVM transaction, still inside its window. */
const submittable = (route: SocketRoute): boolean =>
  route.txData?.kind === 'evm_tx' &&
  Boolean(route.txData.object?.data) &&
  (route.expiresAt === undefined || route.expiresAt * 1000 > Date.now());

export const socketAdapter: Adapter = {
  name: 'Socket',
  supportsExecution: true,
  // The public endpoint shares one quota across everyone using it, and answers a per-second
  // poll with 429s. The shared HTTP gate cannot help: it meters per origin, and the limit here
  // is not ours to spend. Left at the unkeyed figure on purpose — the keyed host allows 20-100
  // rps, but the interval is a build-time constant and the credentials may not be set.
  minQuoteIntervalMs: 5_000,

  getQuote: async (fromAsset, toAsset, amountIn, slippage, chainId, signal): Promise<QuoteResponse | null> => {
    if (!SOCKET_CHAINS.has(chainId)) return null;
    const q: SocketQuote = {
      chainId,
      inputToken: fromAsset.underlyingAsset,
      outputToken: toAsset.underlyingAsset,
      inputAmount: amountIn,
    };
    try {
      const json = await fetchQuoteJson<SocketQuoteResponse>(
        quoteUrl(q, slippage, QUOTE_PLACEHOLDER),
        { headers: headers(), signal },
      );
      const route = bestRoute(json.result?.routes);
      return route ? toQuote(route, json, q, toAsset, amountIn) : null;
    } catch (e) {
      // An abort is the caller withdrawing interest, not a fault. Same reading as KyberSwap's.
      if ((e as Error)?.name === 'AbortError' || signal?.aborted) return null;
      throw e;
    }
  },

  getQuotes: async ({
    fromAsset, toAsset, amountIn, slippage, chainId, caller, receiver, signal,
  }): Promise<QuoteResponse[]> => {
    if (!SOCKET_CHAINS.has(chainId)) return [];
    const q: SocketQuote = {
      chainId,
      inputToken: fromAsset.underlyingAsset,
      outputToken: toAsset.underlyingAsset,
      inputAmount: amountIn,
      ...(receiver && receiver !== caller ? { receiver } : {}),
    };
    try {
      const json = await fetchQuoteJson<SocketQuoteResponse>(
        quoteUrl(q, slippage, caller, receiver ?? caller),
        { headers: headers(), signal },
      );
      // Best output first, so a caller taking the top few takes the best few. It ranks again on
      // measured output afterwards, but the quote is what decides which ones are worth measuring.
      return (json.result?.routes ?? [])
        .filter(submittable)
        .map(((taken) => (route: SocketRoute) =>
          toQuote(route, json, q, toAsset, amountIn, caller, taken))(new Set<string>()))
        .filter((quote): quote is QuoteResponse => quote !== null)
        .sort((a, b) => (BigInt(a.amountOut) < BigInt(b.amountOut) ? 1 : -1));
    } catch (e) {
      if ((e as Error)?.name === 'AbortError' || signal?.aborted) return [];
      throw e;
    }
  },

  buildTransaction: async (quote, slippage, walletAddress, chainId): Promise<TransactionPayload> => {
    if (!SOCKET_CHAINS.has(chainId)) throw new Error(`Socket: unsupported chain ${chainId}`);
    const raw = quote.rawQuote as SocketQuote;

    // A route from `getQuotes` arrives already built for its caller, so there is nothing to
    // ask for. Reused only when the caller matches, because Socket bakes the caller into the
    // calldata and reverts with `CallerNotSignedUser` for anyone else, and only while the
    // route is still inside its window — an expired one is documented to fail on chain.
    const prebuilt = raw.prebuilt;
    if (
      prebuilt &&
      prebuilt.caller.toLowerCase() === walletAddress.toLowerCase() &&
      (prebuilt.expiresAt === undefined || prebuilt.expiresAt * 1000 > Date.now())
    ) {
      return {
        to: prebuilt.to,
        data: prebuilt.data,
        value: prebuilt.value,
        spender: prebuilt.spender,
        amountOut: prebuilt.amountOut,
        gasEstimate: prebuilt.gasEstimate,
      };
    }
    // Re-asked rather than carried over: the quote was addressed to a placeholder, and both the
    // caller and the recipient are inside the calldata.
    const res = await limitedFetch(
      quoteUrl(
        quote.rawQuote as SocketQuote,
        slippage,
        walletAddress,
        (quote.rawQuote as SocketQuote).receiver ?? walletAddress,
      ),
      { headers: headers() },
    );
    if (!res.ok) throw new Error(`Socket: build failed (HTTP ${res.status})`);
    const route = bestRoute(((await res.json()) as SocketQuoteResponse).result?.routes);
    if (!route) throw new Error('Socket: no route to build');

    // Anything but a plain EVM transaction belongs to a chain family this app does not reach.
    if (route.txData?.kind !== 'evm_tx' || !route.txData.object?.data) {
      throw new Error(`Socket: route is not an EVM transaction (${route.txData?.kind ?? 'none'})`);
    }
    // Checked here rather than left to the chain: an expired quote is documented to fail on
    // chain, and finding that out costs the user the gas.
    if (route.expiresAt !== undefined && route.expiresAt * 1000 <= Date.now()) {
      throw new Error('Socket: route expired before it could be submitted');
    }

    const tx = route.txData.object;
    return {
      to: tx.to,
      // Submitted exactly as returned. Socket wraps the router call inside the AllowanceHolder's
      // calldata, so anything rebuilt here would not be the route that was quoted.
      data: tx.data,
      value: String(tx.value ?? '0'),
      // The AllowanceHolder, which is also the call target. Absent for a native input, which
      // needs no approval at all.
      spender: route.approval?.spenderAddress ?? tx.to,
      amountOut: route.output?.amount,
      gasEstimate: route.gasFee?.gasLimit?.toString(),
    };
  },
};
