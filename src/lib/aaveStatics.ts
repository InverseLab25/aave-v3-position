import type { Address, PublicClient } from 'viem'

/**
 * Aave reserve wiring that never changes for a deployed market, cached across previews.
 *
 * `buildPlan` used to re-read all of it on every quote, every slippage change and every
 * Refresh, in three sequential batches: the data provider, then the reserve token addresses
 * that need it, then the balances that need those. Only the last batch is actually live —
 * a reserve's aToken and variable-debt token addresses are fixed once the market is
 * deployed, and the data provider is fixed for the whole market.
 *
 * Caching them collapses the waterfall: a warm preview issues ONE batch (pause flag, router
 * allowlist, both balances) instead of three, removing two round-trips from every refresh.
 *
 * Deliberately NOT cached here: `paused()` and `getAllowedRouters()`, which the owner can
 * change, and which cost nothing anyway — they ride along in the live batch.
 */

const PROVIDER_ABI = [
  {
    type: 'function',
    name: 'getPoolDataProvider',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const

const DATA_PROVIDER_ABI = [
  {
    type: 'function',
    name: 'getReserveTokensAddresses',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'aTokenAddress', type: 'address' },
      { name: 'stableDebtTokenAddress', type: 'address' },
      { name: 'variableDebtTokenAddress', type: 'address' },
    ],
  },
] as const

const NAME_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const

/** Only the one method these helpers call, so any viem/wagmi client shape satisfies it. */
type Reader = Pick<PublicClient, 'readContract'>

interface ReserveTokens {
  aToken: Address
  vDebt: Address
}

const dataProviders = new Map<string, Promise<Address>>()
const reserveTokens = new Map<string, Promise<ReserveTokens>>()

/**
 * Promises are cached, not values, so concurrent first-callers share one request rather
 * than racing to issue the same read.
 */
const memo = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key)
  if (hit) return hit
  const pending = load()
  cache.set(key, pending)
  // A failed read must not be remembered as the answer.
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key)
  })
  return pending
}

/** The market's data provider. Fixed for the life of the deployment. */
export function getPoolDataProvider(
  client: Reader,
  chainId: number,
  poolAddressesProvider: Address,
): Promise<Address> {
  return memo(dataProviders, `${chainId}|${poolAddressesProvider.toLowerCase()}`, () =>
    client.readContract({
      address: poolAddressesProvider,
      abi: PROVIDER_ABI,
      functionName: 'getPoolDataProvider',
    }),
  )
}

/** A reserve's aToken and variable-debt token. Fixed once the reserve is listed. */
export function getReserveTokens(
  client: Reader,
  chainId: number,
  dataProvider: Address,
  asset: Address,
): Promise<ReserveTokens> {
  return memo(reserveTokens, `${chainId}|${asset.toLowerCase()}`, async () => {
    const [aToken, , vDebt] = await client.readContract({
      address: dataProvider,
      abi: DATA_PROVIDER_ABI,
      functionName: 'getReserveTokensAddresses',
      args: [asset],
    })
    return { aToken, vDebt }
  })
}

const aTokenNames = new Map<string, Promise<string>>()

/**
 * An aToken's ERC-20 name, needed for the EIP-712 permit domain. Fixed for the token's
 * lifetime, so reading it again on every close is pure latency in front of a wallet prompt.
 */
export function getATokenName(client: Reader, chainId: number, aToken: Address): Promise<string> {
  return memo(aTokenNames, `${chainId}|${aToken.toLowerCase()}`, () =>
    client.readContract({ address: aToken, abi: NAME_ABI, functionName: 'name' }),
  )
}
