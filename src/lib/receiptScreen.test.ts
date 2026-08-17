import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { POSITION_OPENED_TOPIC, POSITION_CLOSED_TOPIC, positionEventFromReceipt } from './receiptScreen'

const STRATEGIES = '0x75B1AB12e47AaEe4E1033100dE1992E735c32C9c' as Address
const WALLET = '0x253FaC550bae1EE9B4680b3735DC38a3f6eCd600' as Address
const WETH = '0x4200000000000000000000000000000000000006' as Address
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' as Address

const HASH = `0x${'ab'.repeat(32)}` as Hex
const topicOf = (a: Address) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}` as Hex

const positionLog = (topic: Hex, over: { address?: Address } = {}) => ({
  address: over.address ?? STRATEGIES,
  topics: [topic, topicOf(WALLET), topicOf(WETH), topicOf(USDC)] as Hex[],
  data: '0x' as Hex,
})

/** A supply straight to Aave — the shape every non-leveraged row in the indexer has. */
const plainAaveLog = () => ({
  address: POOL,
  topics: [`0x${'cd'.repeat(32)}` as Hex],
  data: '0x' as Hex,
})

const receipt = (over: Partial<Parameters<typeof positionEventFromReceipt>[0]> = {}) => ({
  hash: HASH,
  to: STRATEGIES as Address | null,
  status: 'success' as const,
  blockNumber: 500n,
  logs: [positionLog(POSITION_OPENED_TOPIC)],
  ...over,
})

describe('positionEventFromReceipt', () => {
  it('recognises a leveraged open by the contract that emitted its event', () => {
    const event = positionEventFromReceipt(receipt(), STRATEGIES)

    expect(event).toMatchObject({ hash: HASH, kind: 'open', collateral: WETH, debtAsset: USDC })
  })

  it('reads a close from the event rather than guessing', () => {
    const event = positionEventFromReceipt(
      receipt({ logs: [positionLog(POSITION_CLOSED_TOPIC)] }),
      STRATEGIES,
    )

    expect(event?.kind).toBe('close')
  })

  it('rejects an ordinary Aave transaction', () => {
    // The indexer reports these identically — a supply is a supply whether or not a contract
    // arranged it — so the screen is the only thing separating them.
    const event = positionEventFromReceipt(
      receipt({ to: POOL, logs: [plainAaveLog()] }),
      STRATEGIES,
    )

    expect(event).toBeNull()
  })

  it('still recognises one routed through a smart account', () => {
    // A Safe or a 7702-delegated wallet puts ITSELF in `to`, with the strategies call internal.
    // The event is emitted BY the strategies contract either way, so the log is the surer signal.
    const event = positionEventFromReceipt(
      receipt({ to: '0x9999999999999999999999999999999999999999' as Address }),
      STRATEGIES,
    )

    expect(event?.kind).toBe('open')
  })

  it('ignores a position event emitted by some other contract', () => {
    // `to` matching is not enough on its own: an impostor log claiming to be a PositionOpened
    // would otherwise name whatever collateral it liked.
    const event = positionEventFromReceipt(
      receipt({
        to: '0x9999999999999999999999999999999999999999' as Address,
        logs: [positionLog(POSITION_OPENED_TOPIC, { address: POOL })],
      }),
      STRATEGIES,
    )

    expect(event).toBeNull()
  })

  it('refuses a reverted transaction', () => {
    expect(positionEventFromReceipt(receipt({ status: 'reverted' }), STRATEGIES)).toBeNull()
  })

  it('refuses a transaction sent to the contract that emitted no position event', () => {
    // A read, a failed path, or an admin call. Nothing to record.
    expect(positionEventFromReceipt(receipt({ logs: [plainAaveLog()] }), STRATEGIES)).toBeNull()
  })

  it('is not confused by contract creation, where there is no `to` at all', () => {
    expect(positionEventFromReceipt(receipt({ to: null, logs: [plainAaveLog()] }), STRATEGIES)).toBeNull()
  })
})
