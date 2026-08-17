/**
 * Which transactions on AaveV3Strategies belong to a wallet, read off the chain.
 *
 * `PositionOpened` and `PositionClosed` both declare `address indexed user`, so a topic filter
 * matches this wallet and nothing else — the node does the searching, and the app never downloads
 * a transaction it has no use for. `collateral` and `debtAsset` are indexed too, which means the
 * swap direction is known before any receipt is fetched.
 *
 * The client is a structural interface rather than a viem `PublicClient`, following the rest of
 * `lib`: the scanning rules below are the part worth testing, and they should be testable against
 * a plain object rather than a mocked transport.
 */
import type { Address, Hex } from 'viem'
import { aaveV3StrategiesAbi } from './strategies-sdk/abi'

type StrategiesEvent = Extract<(typeof aaveV3StrategiesAbi)[number], { type: 'event' }>

const eventNamed = (name: string): StrategiesEvent =>
  aaveV3StrategiesAbi.find(
    (item): item is StrategiesEvent => item.type === 'event' && item.name === name,
  )!

export const POSITION_OPENED = eventNamed('PositionOpened')
export const POSITION_CLOSED = eventNamed('PositionClosed')

/** The two events a scan asks for, out of the full contract ABI. */
export const POSITION_EVENTS = [POSITION_OPENED, POSITION_CLOSED] as const

/**
 * How many blocks to ask about at once, before any provider has objected.
 *
 * Deliberately above the common 10,000-block cap. Overshooting costs a few rejected requests on
 * the first scan and then settles at whatever the provider actually allows; undershooting costs
 * every scan on every load, forever, on a chain that produces four blocks a second.
 */
export const INITIAL_CHUNK = 50_000n

/** The window below which a failure is the provider's problem rather than the range's. */
export const MIN_CHUNK = 1_000n

/** One position event, reduced to what building a history row needs. */
export interface PositionEvent {
  hash: Hex
  blockNumber: bigint
  logIndex: number
  kind: 'open' | 'close'
  collateral: Address
  debtAsset: Address
}

/** A decoded log as viem hands it over, with every field it may legitimately answer null for. */
export interface RawPositionLog {
  eventName?: string
  transactionHash: Hex | null
  blockNumber: bigint | null
  logIndex: number | null
  args?: {
    user?: Address
    collateral?: Address
    debtAsset?: Address
  }
}

/**
 * One window's request.
 *
 * Deliberately says WHAT is wanted rather than how to ask for it. Both events have to be fetched
 * in one request narrowed to one `user`, and viem's typed `getLogs` only accepts an `args` filter
 * alongside a single event — so the topic array is built by the adapter, which is the layer that
 * owns viem. What is testable here is the windowing, not the encoding.
 */
export interface LogScanArgs {
  address: Address
  wallet: Address
  fromBlock: bigint
  toBlock: bigint
}

export interface LogScanClient {
  getLogs(args: LogScanArgs): Promise<readonly RawPositionLog[]>
}

export interface ScanOptions {
  address: Address
  wallet: Address
  fromBlock: bigint
  toBlock: bigint
  /** Overridable so a test does not have to script fifty thousand blocks. */
  initialChunk?: bigint
  /** Overridable for the same reason. */
  minChunk?: bigint
  /** The last block confirmed read, after each window. For a progress indicator. */
  onProgress?: (block: bigint) => void
}

/**
 * A log this module can act on, or null.
 *
 * Null for three separate reasons, all of which a correct provider can produce: an event outside
 * the two asked for (a filter answered more loosely than it was given), a log not yet mined
 * (`blockNumber` and `transactionHash` are null while pending), and one missing the addresses the
 * row is built from. Each would otherwise become a history row that says something untrue.
 */
function toPositionEvent(log: RawPositionLog): PositionEvent | null {
  const kind =
    log.eventName === 'PositionOpened' ? 'open' : log.eventName === 'PositionClosed' ? 'close' : null
  if (kind === null) return null
  if (log.transactionHash === null || log.blockNumber === null || log.logIndex === null) return null
  const { collateral, debtAsset } = log.args ?? {}
  if (!collateral || !debtAsset) return null

  return {
    hash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
    kind,
    collateral,
    debtAsset,
  }
}

/**
 * Every position event this wallet produced between two blocks, oldest first.
 *
 * Walks the range in windows, halving on any failure and retrying the same block. Backing off on
 * ANY error rather than on a recognised one is deliberate: the two limits that matter — block
 * range and result count — are worded differently by every provider, and a matcher that fails to
 * recognise one turns a recoverable scan into a broken one.
 *
 * THROWS RATHER THAN RETURNING A PARTIAL RESULT. `mergeHistory` deletes rows a completed scan did
 * not confirm, so a half-finished scan that returned its findings would read as proof that
 * everything it never reached had been reorged out.
 */
export async function scanPositionEvents(
  client: LogScanClient,
  {
    address,
    wallet,
    fromBlock,
    toBlock,
    initialChunk = INITIAL_CHUNK,
    minChunk = MIN_CHUNK,
    onProgress,
  }: ScanOptions,
): Promise<PositionEvent[]> {
  const found = new Map<string, PositionEvent>()
  let cursor = fromBlock
  let chunk = initialChunk

  while (cursor <= toBlock) {
    const end = cursor + chunk - 1n < toBlock ? cursor + chunk - 1n : toBlock
    let logs: readonly RawPositionLog[]
    try {
      logs = await client.getLogs({ address, wallet, fromBlock: cursor, toBlock: end })
    } catch (error) {
      if (chunk <= minChunk) throw error
      const halved = chunk / 2n
      chunk = halved < minChunk ? minChunk : halved
      continue
    }

    for (const raw of logs) {
      const event = toPositionEvent(raw)
      // Keyed rather than pushed: a provider that answers an overlapping range twice, or repeats a
      // log within one answer, must not turn one transaction into two rows.
      if (event) found.set(`${event.hash.toLowerCase()}:${event.logIndex}`, event)
    }

    cursor = end + 1n
    onProgress?.(end)
  }

  return [...found.values()]
}
