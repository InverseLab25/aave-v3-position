import { describe, expect, it, vi } from 'vitest'
import { WaitForTransactionReceiptTimeoutError, type Address, type Hex } from 'viem'
import { RECEIPT_TIMEOUT_MS, settleTransaction, type SettleClient } from './settle'
import { SWAPPED_TOPIC } from './txOutcome'
import { encodeAbiParameters, parseAbiParameters } from 'viem'

const WALLET = '0x253FaC550bae1EE9B4680b3735DC38a3f6eCd600' as Address
const ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' as Address
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const WETH = '0x4200000000000000000000000000000000000006' as Address
const HASH = `0x${'ab'.repeat(32)}` as Hex

const swappedLog = () => ({
  address: ROUTER,
  topics: [SWAPPED_TOPIC] as Hex[],
  data: encodeAbiParameters(
    parseAbiParameters('address, address, address, address, uint256, uint256'),
    [ROUTER, USDC, WETH, WALLET, 1_899_171_711n, 1_003_307_090_025_359_338n],
  ),
})

const client = (
  result: 'success' | 'reverted' | 'timeout' | 'error',
): SettleClient & { waitForTransactionReceipt: ReturnType<typeof vi.fn> } => ({
  waitForTransactionReceipt: vi.fn(async () => {
    if (result === 'timeout') {
      throw new WaitForTransactionReceiptTimeoutError({ hash: HASH })
    }
    if (result === 'error') throw Object.assign(new Error('fetch failed'), { shortMessage: 'HTTP 503' })
    return { status: result, logs: result === 'success' ? [swappedLog()] : [] }
  }),
})

const args = {
  hash: HASH,
  wallet: WALLET,
  pair: { srcToken: USDC, dstToken: WETH },
  expectedOut: 1_003_307_090_025_359_338n,
  basis: 'simulated' as const,
  minOut: 1_000_000_000_000_000_000n,
}

describe('settleTransaction', () => {
  it('reads the fill off a receipt that succeeded', async () => {
    const s = await settleTransaction({ client: client('success'), ...args })

    expect(s.kind).toBe('settled')
    if (s.kind !== 'settled') return
    expect(s.outcome?.swap).toMatchObject({ srcToken: USDC, dstToken: WETH })
  })

  it('separates an included-but-reverted transaction from a failed send', async () => {
    // Included and reverted means the position was NOT opened, and leaving a success on screen
    // tells the user the opposite of what the chain says.
    const s = await settleTransaction({ client: client('reverted'), ...args })

    expect(s.kind).toBe('reverted')
  })

  it('calls a timeout a timeout, not a revert', async () => {
    // These are genuinely different: an MEV-protected RPC includes only transactions that would
    // succeed, so one that would revert never appears at all. Calling that a revert is a guess,
    // and it sends a user to re-do something they may already hold.
    const s = await settleTransaction({ client: client('timeout'), ...args })

    expect(s.kind).toBe('timeout')
  })

  it('separates a receipt that could not be READ from one that says failure', async () => {
    // An RPC error says nothing whatever about the transaction. Quoting the timeout here would
    // send the user off to watch an explorer over something that was never the problem.
    const s = await settleTransaction({ client: client('error'), ...args })

    expect(s.kind).toBe('unreadable')
    if (s.kind !== 'unreadable') return
    expect(s.detail).toBe('HTTP 503')
  })

  it('reports that the screen moved on, rather than reporting a result to nobody', async () => {
    // The user abandoned the flow while this was in flight. Whatever the receipt says belongs to a
    // screen that is gone, and applying it would revive a dismissed modal's state.
    const s = await settleTransaction({ client: client('success'), ...args, isCurrent: () => false })

    expect(s.kind).toBe('abandoned')
  })

  it('waits no longer than the shared timeout', async () => {
    const c = client('success')
    await settleTransaction({ client: c, ...args })

    expect(c.waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: HASH,
      timeout: RECEIPT_TIMEOUT_MS,
    })
  })

  it('still settles when the receipt carried no swap', async () => {
    // A position event with no router fill is unusual but not a failure, and the wallet rows are
    // worth reporting on their own.
    const c: SettleClient = {
      waitForTransactionReceipt: async () => ({ status: 'success', logs: [] }),
    }

    const s = await settleTransaction({ client: c, ...args })

    expect(s.kind).toBe('settled')
  })
})
