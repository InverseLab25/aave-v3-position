import { useState } from 'react'
import { useConfig, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { getChainConfig } from '../config/chains'
import { simulateAndWrite } from '../utils/contract'
import { ExplorerLink } from './ExplorerLink'
import aavePoolAbi from '../config/aavev3Abi.json'
import { T, modalStyle, modalHeaderStyle, modalTitleStyle, closeButtonStyle, alertStyle, primaryBtnStyle } from '../styles/theme'

interface EModeModalProps {
  chainId: number
  currentCategoryId: number
  currentLabel: string
  onClose: () => void
}

const EMODE_CATEGORIES = [
  { id: 0, label: 'Disabled (Standard Mode)', description: 'Standard LTV and liquidation threshold applied across all assets.' },
  { id: 1, label: 'Category 1: ETH Correlated', description: 'Higher capital efficiency (~90%+ LTV) when collateral and borrows are both ETH-correlated assets (e.g., WETH, stETH).' },
  { id: 2, label: 'Category 2: Stablecoins', description: 'Higher capital efficiency (~93%+ LTV) when collateral and borrows are both stablecoins (e.g., USDC, USDT, DAI).' },
]

export function EModeModal({ chainId, currentCategoryId, currentLabel, onClose }: EModeModalProps) {
  const [selectedCat, setSelectedCat] = useState<number>(currentCategoryId)
  const [statusMsg, setStatusMsg] = useState<string>('')
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const config = useConfig()
  const { mutateAsync: writeContractAsync } = useWriteContract()
  const { isLoading: isWaitingTx } = useWaitForTransactionReceipt({ hash: txHash })

  const chainConfig = getChainConfig(chainId)
  const poolAddress = chainConfig?.aave?.poolAddress as `0x${string}`

  const handleSetEMode = async () => {
    if (!poolAddress) return
    try {
      setIsSubmitting(true)
      setStatusMsg('Simulating setUserEMode transaction…')

      const hash = await simulateAndWrite(config, writeContractAsync, {
        address: poolAddress,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        abi: aavePoolAbi as any,
        functionName: 'setUserEMode',
        args: [selectedCat],
      })

      setTxHash(hash)
      setStatusMsg('E-Mode transaction sent!')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      let reason = e?.cause?.reason ?? e?.shortMessage ?? e?.message ?? 'Transaction failed'
      
      if (String(e).includes('0x2c906631') || reason.includes('0x2c906631') || reason.includes('execution reverted')) {
        reason = selectedCat === 0
          ? 'Cannot disable E-Mode: Your current position health factor would fall below 1.0 under standard LTV.'
          : `Inconsistent E-Mode assets: To enable Category ${selectedCat}, all your supplied collateral and borrowed debt must belong exclusively to this category.`
      }

      setStatusMsg(`Error: ${reason}`)
    } finally {
      setIsSubmitting(false)
    }
  }

  const isProcessing = isSubmitting || isWaitingTx
  const isError = statusMsg.startsWith('Error')

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-content" style={{ ...modalStyle, maxWidth: '520px' }}>
        <div style={modalHeaderStyle}>
          <h2 style={modalTitleStyle}>Aave V3 Efficiency Mode (E-Mode)</h2>
          <button style={closeButtonStyle} onClick={onClose}>×</button>
        </div>

        <div style={{ padding: T.space[5] }}>
          <p style={{ margin: `0 0 ${T.space[4]}`, fontSize: T.fontSize.sm, color: T.textMuted }}>
            Efficiency Mode (E-Mode) allows you to borrow with higher Loan-to-Value (LTV) and higher liquidation threshold when collateral and borrowed assets belong to the same category.
          </p>

          <div style={{ ...alertStyle('info'), marginBottom: T.space[4], fontSize: T.fontSize.xs, lineHeight: 1.5 }}>
            <strong>Aave E-Mode Rule:</strong> To enable an E-Mode category, <em>all</em> currently supplied collateral and borrowed debt in your account must belong to that specific category. If you hold any non-category assets, Aave will revert the transaction.
          </div>

          <div style={{ marginBottom: T.space[4] }}>
            <div style={{ fontSize: T.fontSize.xs, textTransform: 'uppercase', letterSpacing: '0.05em', color: T.textMuted, marginBottom: T.space[2] }}>
              Current Status
            </div>
            <div style={{ padding: T.space[3], background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius.md, fontSize: T.fontSize.sm, fontWeight: 600 }}>
              {currentCategoryId > 0 ? (
                <span className="text-success">⚡ Active: {currentLabel} (Category {currentCategoryId})</span>
              ) : (
                <span style={{ color: T.textMuted }}>Disabled</span>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: T.space[3], marginBottom: T.space[5] }}>
            {EMODE_CATEGORIES.map(cat => (
              <label
                key={cat.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: T.space[3],
                  padding: T.space[3],
                  borderRadius: T.radius.md,
                  border: `1px solid ${selectedCat === cat.id ? T.primary : T.border}`,
                  background: selectedCat === cat.id ? '#f0f9ff' : T.surface,
                  cursor: 'pointer',
                  transition: T.transition
                }}
              >
                <input
                  type="radio"
                  name="emode-cat"
                  checked={selectedCat === cat.id}
                  onChange={() => setSelectedCat(cat.id)}
                  style={{ marginTop: '3px' }}
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: T.fontSize.sm, color: T.text }}>{cat.label}</div>
                  <div style={{ fontSize: T.fontSize.xs, color: T.textMuted, marginTop: '2px', lineHeight: 1.4 }}>{cat.description}</div>
                </div>
              </label>
            ))}
          </div>

          {statusMsg && (
            <div style={{ ...alertStyle(isError ? 'danger' : isWaitingTx ? 'info' : 'success'), marginBottom: T.space[4] }}>
              {statusMsg}
            </div>
          )}
          {txHash && <ExplorerLink hash={txHash} chainId={chainId} />}

          <div style={{ display: 'flex', gap: T.space[3], justifyContent: 'flex-end', marginTop: T.space[4] }}>
            <button className="btn-secondary" onClick={onClose} disabled={isProcessing}>
              Cancel
            </button>
            <button
              style={primaryBtnStyle(isProcessing || selectedCat === currentCategoryId)}
              onClick={handleSetEMode}
              disabled={isProcessing || selectedCat === currentCategoryId}
            >
              {isProcessing ? 'Processing…' : selectedCat === currentCategoryId ? 'Already Active' : 'Update E-Mode'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
