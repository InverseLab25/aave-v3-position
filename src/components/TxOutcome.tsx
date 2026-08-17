/**
 * What a transaction settled at, once its receipt is in.
 *
 * Everything else in these flows is a forecast — a quoted `amountOut`, a projected health factor,
 * a `minOut` floor. This is the one panel reporting what happened, so it states the fill against
 * the quote it was sold on rather than on its own.
 *
 * The wallet rows are whatever the caller passes: the flows filter Aave's position tokens out
 * first, since the projection beside this panel already describes the position.
 */
import { formatUnits, type Address } from 'viem'
import type { TokenMeta } from '../lib/tokenMeta'
import type { TxOutcome, WalletDelta } from '../lib/txOutcome'
import { RateLine } from './RateLine'
import { T } from '../styles/theme'

// Defined next to the builders that produce it, and re-exported here because this is where its
// consumers already reach for it.
export type { TokenMeta }

interface TxOutcomePanelProps {
  outcome: TxOutcome | null
  /** Symbol and decimals per token, keyed by LOWER-CASED address. */
  tokens: Record<string, TokenMeta>
}

/**
 * Six is where a balance change stops being worth reading, and it is also every stablecoin's
 * full precision — so a USDC row is exact while an 18-decimal row is merely long.
 */
const MAX_PLACES = 6

/** A token nothing knows about, shown as itself. Guessing 18 decimals prints a plausible lie. */
function shortAddress(token: Address): string {
  return `${token.slice(0, 6)}…${token.slice(-4)}`
}

function amount(value: bigint, decimals: number): string {
  const places = Math.min(decimals, MAX_PLACES)
  return Number(formatUnits(value, decimals)).toLocaleString(undefined, {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  })
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: T.space[3], alignItems: 'baseline' }}>
      <span style={{ color: T.textMuted }}>{label}</span>
      <span style={{ textAlign: 'right' }}>{children}</span>
    </div>
  )
}

/** One token's net movement, signed — the minus is U+2212, which lines up under a digit. */
function DeltaRow({ delta, meta }: { delta: WalletDelta; meta: TokenMeta | undefined }) {
  const sign = delta.delta < 0n ? '−' : '+'
  const magnitude = delta.delta < 0n ? -delta.delta : delta.delta
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: T.space[3] }}>
      <span style={{ color: T.textMuted }}>{meta?.symbol ?? shortAddress(delta.token)}</span>
      <span style={{ color: delta.delta < 0n ? T.text : T.success, fontWeight: 600 }}>
        {meta
          ? `${sign}${amount(magnitude, meta.decimals)} ${meta.symbol}`
          : `${sign}${magnitude} raw units`}
      </span>
    </div>
  )
}

export function TxOutcomePanel({ outcome, tokens }: TxOutcomePanelProps) {
  if (!outcome) return null

  const meta = (token: Address) => tokens[token.toLowerCase()]
  const { swap, fill } = outcome
  const src = swap ? meta(swap.srcToken) : undefined
  const dst = swap ? meta(swap.dstToken) : undefined
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: T.space[2],
        marginTop: T.space[4], padding: T.space[3],
        border: `1px solid ${T.border}`, borderRadius: T.radius.md,
        fontSize: T.fontSize.sm,
      }}
    >
      <div style={{ fontSize: T.fontSize.xs, color: T.textMuted, textTransform: 'uppercase' }}>
        Settled
      </div>

      {swap && (
        // One string rather than three nodes: a reader sees one sentence, and so does a test
        // looking for it.
        <Row label="Swapped">
          {[
            src ? `${amount(swap.spentAmount, src.decimals)} ${src.symbol}` : `${swap.spentAmount} raw units`,
            dst ? `${amount(swap.returnAmount, dst.decimals)} ${dst.symbol}` : `${swap.returnAmount} raw units`,
          ].join(' → ')}
        </Row>
      )}

      {swap && src && dst && (
        <Row label="Rate">
          <RateLine
            srcSymbol={src.symbol}
            srcDecimals={src.decimals}
            dstSymbol={dst.symbol}
            dstDecimals={dst.decimals}
            spentAmount={swap.spentAmount}
            returnAmount={swap.returnAmount}
          />
        </Row>
      )}

      {fill && fill.percent !== null && (
        <Row label="vs quote">
          <span style={{ color: fill.delta < 0n ? T.warning : T.success }}>
            {`${Math.abs(fill.percent).toFixed(4)}% ${fill.delta < 0n ? 'below' : 'above'} the quote`}
            {dst && ` (${amount(fill.delta < 0n ? -fill.delta : fill.delta, dst.decimals)} ${dst.symbol})`}
          </span>
        </Row>
      )}

      {/* Should be unreachable: the contract reverts on an output under `minOut`. Seeing it means
          the floor enforced was not the floor shown, which is worth saying out loud. */}
      {fill?.belowFloor && (
        <div style={{ color: T.danger }}>
          This filled below the floor the transaction was meant to enforce.
        </div>
      )}

      {outcome.deltas.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: T.space[1], marginTop: T.space[1] }}>
          <div style={{ fontSize: T.fontSize.xs, color: T.textMuted, textTransform: 'uppercase' }}>
            Wallet changes
          </div>
          {outcome.deltas.map((d) => (
            <DeltaRow key={d.token} delta={d} meta={meta(d.token)} />
          ))}
        </div>
      )}
    </div>
  )
}
