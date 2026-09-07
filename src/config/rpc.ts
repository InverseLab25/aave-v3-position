/**
 * Per-chain RPC overrides, `VITE_RPC_URL_<chainId>`.
 *
 * Written out one line per chain rather than looked up by id, because Vite only substitutes
 * literal `import.meta.env.X` accesses at build time — a computed key reads as undefined in a
 * production bundle, which fails the same silent way as having no entry at all. `chains.ts`
 * spells its `VITE_STRATEGIES_ADDRESS_*` reads out for the same reason.
 *
 * Lives here rather than in `wagmi.ts` because the swap simulator needs the same endpoints and
 * must not import the wallet config to get them.
 */
export const RPC_URLS: Partial<Record<number, string>> = {
  // `VITE_RPC_URL` is the original, pre-per-chain name for this one. Still honoured so an
  // existing env keeps working; `VITE_RPC_URL_1` wins where both are set.
  1: import.meta.env.VITE_RPC_URL_1 ?? import.meta.env.VITE_RPC_URL,
  10: import.meta.env.VITE_RPC_URL_10,
  137: import.meta.env.VITE_RPC_URL_137,
  8453: import.meta.env.VITE_RPC_URL_8453,
  42161: import.meta.env.VITE_RPC_URL_42161,
  11155111: import.meta.env.VITE_RPC_URL_11155111,
  84532: import.meta.env.VITE_RPC_URL_84532,
};

/**
 * The endpoint to simulate a swap against, or undefined where there is none.
 *
 * No public fallback, deliberately. A simulation is not broadcast, so there is nothing in it to
 * front-run directly, but it does hand whoever runs the node the exact trade you are about to
 * make, at full size, before you make it. On the sizes this app deals in that is worth more to
 * them than it is to us, so an unconfigured chain gets no simulation and the caller falls back
 * to the aggregator's own quoted output.
 */
export const simulationRpc = (chainId: number): string | undefined => RPC_URLS[chainId];
