import { useEffect, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import { useAccount } from 'wagmi';
import type { QuoteResponse, TransactionPayload, Asset } from '../adapters/types';
import { SwapExecutor } from './SwapExecutor';

interface ConfirmSwapModalProps {
  quote: QuoteResponse;
  txPayload: TransactionPayload;
  fromAsset: Asset;
  toAsset: Asset;
  amountIn: string;
  slippage: number;
  onClose: () => void;
  /** True while the parent is fetching a fresh quote for this adapter. */
  isRefreshing?: boolean;
  /** Epoch ms of the last successful quote refresh. Used to show "Updated Xs ago". */
  lastRefreshedAt?: number;
  /** Trigger an on-demand quote refresh (Refresh button in the modal). */
  onRefresh?: () => void;
}

export function ConfirmSwapModal({
  quote,
  txPayload,
  fromAsset,
  toAsset,
  amountIn,
  slippage,
  onClose,
  isRefreshing = false,
  lastRefreshedAt = 0,
  onRefresh,
}: ConfirmSwapModalProps) {
  const { address } = useAccount();

  const amountOutFormatted = Number(formatUnits(BigInt(quote.amountOut), toAsset.decimals));
  const amountInNum = parseFloat(amountIn);

  const rate = amountInNum > 0 ? (amountOutFormatted / amountInNum).toFixed(4) : '0';

  const slippageBps = BigInt(Math.floor(slippage * 100));
  const minOutputBigInt = (BigInt(quote.amountOut) * (10000n - slippageBps)) / 10000n;
  const minOutputFormatted = Number(formatUnits(minOutputBigInt, toAsset.decimals)).toFixed(6);

  const inputUsdNum = amountInNum * parseFloat(fromAsset.priceInUsd || '0');
  const outputUsdNum = Number(quote.amountOutUsd);
  const inputUsd = inputUsdNum.toFixed(2);
  const outputUsd = outputUsdNum.toFixed(2);

  // Price impact = spread between USD-in and USD-out, as a % of USD-in.
  // Positive = user loses value on the swap (typical for AMM slippage/fees).
  // We only compute when both USD legs are available and non-trivial.
  const priceImpactPct = inputUsdNum > 0 && outputUsdNum > 0
    ? ((inputUsdNum - outputUsdNum) / inputUsdNum) * 100
    : null;
  const priceImpactColor = priceImpactPct === null
    ? '#111'
    : priceImpactPct >= 3 ? '#dc2626'
    : priceImpactPct >= 1 ? '#d97706'
    : '#111';

  // Detect a mid-modal quote change so we can flash a "Quote updated" indicator.
  const prevAmountOutRef = useRef<string>(quote.amountOut);
  const [flashUpdated, setFlashUpdated] = useState(false);
  useEffect(() => {
    if (prevAmountOutRef.current !== quote.amountOut) {
      prevAmountOutRef.current = quote.amountOut;
      setFlashUpdated(true);
      const t = setTimeout(() => setFlashUpdated(false), 1500);
      return () => clearTimeout(t);
    }
  }, [quote.amountOut]);

  // Human "Xs ago" for the refresh timestamp — recomputes each render (parent re-renders on interval).
  const secondsSinceRefresh = lastRefreshedAt > 0 ? Math.max(0, Math.floor((Date.now() - lastRefreshedAt) / 1000)) : null;

  const formatAddress = (addr: string) => {
    if (!addr) return '';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  return (
    <div className="modal-overlay">
      <div 
        className="modal-content" 
        style={{ 
          backgroundColor: '#fff', 
          color: '#111', 
          borderRadius: '16px',
          padding: '24px',
          width: '100%',
          maxWidth: '420px',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          boxShadow: '0 10px 25px rgba(0,0,0,0.1)'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <h2 style={{ margin: 0, fontSize: '20px', fontWeight: '600' }}>Confirm Swap Details</h2>
              <button
                onClick={onClose}
                style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: '20px', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', marginTop: '4px' }}>
              <span style={{ color: '#6b7280', fontSize: '13px' }}>
                Route via <strong style={{ color: '#111' }}>{quote.aggregator}</strong>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
                {isRefreshing ? (
                  <span style={{ color: '#2563eb' }}>Refreshing quote…</span>
                ) : flashUpdated ? (
                  <span style={{ color: '#10b981' }}>✓ Quote updated</span>
                ) : secondsSinceRefresh !== null ? (
                  <span style={{ color: '#6b7280' }}>Updated {secondsSinceRefresh}s ago</span>
                ) : null}
                {onRefresh && (
                  <button
                    onClick={onRefresh}
                    disabled={isRefreshing}
                    style={{
                      fontSize: '12px', padding: '4px 10px', cursor: isRefreshing ? 'not-allowed' : 'pointer',
                      border: '1px solid #e5e7eb', background: '#fff', color: '#111',
                      borderRadius: '6px', fontWeight: 500, opacity: isRefreshing ? 0.6 : 1,
                    }}
                  >
                    Refresh
                  </button>
                )}
              </span>
            </div>

            <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '16px' }}>
              Rate: <span style={{ color: '#111', fontWeight: '500' }}>1 {fromAsset.symbol} = {rate} {toAsset.symbol} ⇌</span>
            </div>

            <div style={{ 
              border: '1px solid #e5e7eb', 
              borderRadius: '12px', 
              padding: '16px',
              position: 'relative',
              backgroundColor: '#f9fafb'
            }}>
              {/* Input Amount */}
              <div style={{ marginBottom: '24px' }}>
                <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '8px' }}>Input Amount</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: '24px', fontWeight: '500' }}>{amountIn}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {inputUsd !== '0.00' && inputUsd !== 'NaN' && <span style={{ color: '#6b7280', fontSize: '14px' }}>~${inputUsd}</span>}
                    <div style={{ 
                      backgroundColor: '#3b82f6', 
                      color: 'white', 
                      width: '24px', 
                      height: '24px', 
                      borderRadius: '50%', 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'center',
                      fontSize: '10px',
                      fontWeight: 'bold'
                    }}>{fromAsset.symbol.slice(0, 1)}</div>
                    <span style={{ fontSize: '18px', fontWeight: '500' }}>{fromAsset.symbol}</span>
                  </div>
                </div>
              </div>

              {/* Arrow Divider */}
              <div style={{ 
                position: 'absolute', 
                left: '50%', 
                top: '50%', 
                transform: 'translate(-50%, -50%)',
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                backgroundColor: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid #e5e7eb',
                boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
              }}>
                <span style={{ fontSize: '12px', color: '#6b7280' }}>↓</span>
              </div>

              {/* Output Amount */}
              <div>
                <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '8px', marginTop: '8px' }}>Output Amount</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: '24px', fontWeight: '500' }}>{amountOutFormatted.toFixed(6)}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {outputUsd !== '0.00' && outputUsd !== 'NaN' && <span style={{ color: '#6b7280', fontSize: '14px' }}>~${outputUsd}</span>}
                    <div style={{ 
                      backgroundColor: '#10b981', 
                      color: 'white', 
                      width: '24px', 
                      height: '24px', 
                      borderRadius: '50%', 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'center',
                      fontSize: '10px',
                      fontWeight: 'bold'
                    }}>{toAsset.symbol.slice(0, 1)}</div>
                    <span style={{ fontSize: '18px', fontWeight: '500' }}>{toAsset.symbol}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Details Box */}
            <div style={{ 
              border: '1px solid #e5e7eb', 
              borderRadius: '12px', 
              padding: '16px',
              marginTop: '16px',
              fontSize: '13px'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span style={{ color: '#6b7280' }}>Minimum Receiving</span>
                <span style={{ fontWeight: '500' }}>{minOutputFormatted} {toAsset.symbol}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span style={{ color: '#6b7280' }}>Maximum Receiving</span>
                <span style={{ fontWeight: '500' }}>{amountOutFormatted.toFixed(6)} {toAsset.symbol}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span style={{ color: '#6b7280' }}>Price Impact</span>
                <span style={{ fontWeight: '500', color: priceImpactColor }}>
                  {priceImpactPct === null
                    ? 'n/a'
                    : Math.abs(priceImpactPct) < 0.01
                      ? '< 0.01%'
                      : `${priceImpactPct >= 0 ? '-' : '+'}${Math.abs(priceImpactPct).toFixed(2)}%`}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span style={{ color: '#6b7280' }}>Estimated Total Gas</span>
                <span style={{ fontWeight: '500' }}>${Number(quote.gasUsd).toFixed(2)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span style={{ color: '#6b7280' }}>Max Slippage</span>
                <span style={{ fontWeight: '500' }}>{slippage}%</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '16px' }}>
                <span style={{ color: '#6b7280' }}>Slippage Buffer</span>
                <span style={{ fontWeight: '500' }}>
                  {Number(formatUnits(BigInt(quote.amountOut) - minOutputBigInt, toAsset.decimals)).toFixed(6)} {toAsset.symbol}
                  <span style={{ color: '#6b7280', marginLeft: '6px', fontSize: '12px' }}>({slippage}% of max)</span>
                </span>
              </div>

              <div style={{ borderTop: '1px solid #e5e7eb', margin: '0 -16px 12px -16px' }}></div>

              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span style={{ color: '#6b7280' }}>Recipient</span>
                <span style={{ color: '#3b82f6', textDecoration: 'underline' }}>{formatAddress(address as string)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#6b7280' }}>Contract Address</span>
                <span style={{ textDecoration: 'underline', color: '#111' }}>{formatAddress(txPayload.to)}</span>
              </div>
            </div>

            <SwapExecutor 
              txPayload={txPayload}
              fromAsset={fromAsset}
              amountIn={amountIn}
              onClose={onClose}
              isEmbedded={true}
            />
      </div>
    </div>
  );
}
