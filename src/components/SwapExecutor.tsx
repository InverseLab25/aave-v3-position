import { useEffect } from 'react';
import { useAccount, useReadContract, useWriteContract, useSendTransaction, useWaitForTransactionReceipt } from 'wagmi';
import { parseUnits } from 'viem';
import type { TransactionPayload, Asset } from '../adapters/types';
import { getChainConfig } from '../config/chains';

const ERC20_ABI = [
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  }
] as const;

interface SwapExecutorProps {
  txPayload: TransactionPayload;
  fromAsset: Asset;
  amountIn: string;
  onClose: () => void;
  isEmbedded?: boolean;
}

type ExecutionStep = 'check_allowance' | 'needs_approval' | 'approving' | 'approved' | 'executing' | 'success' | 'error';

export function SwapExecutor({ txPayload, fromAsset, amountIn, onClose, isEmbedded }: SwapExecutorProps) {
  const { address, chainId } = useAccount();
  const chainConfig = getChainConfig(chainId);
  const explorerUrl = chainConfig?.explorerUrl ?? 'https://etherscan.io';

  const amountInBigInt = parseUnits(amountIn, fromAsset.decimals);

  // 1. Read current allowance
  const { data: allowanceData, refetch: refetchAllowance } = useReadContract({
    address: fromAsset.underlyingAsset as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address ? [address, txPayload.spender as `0x${string}`] : undefined,
    query: { enabled: !!address }
  });

  // 2. Approve hook
  const {
    mutate: writeApprove,
    data: approveHash,
    isPending: isApprovePending,
    error: approveError,
    reset: resetApprove
  } = useWriteContract();

  // 3. Wait for approve confirmation
  const { isSuccess: isApproveConfirmed } = useWaitForTransactionReceipt({
    hash: approveHash,
  });

  // 4. Send swap tx hook
  const {
    mutate: sendTransaction,
    data: swapHash,
    isPending: isSwapPending,
    error: swapError,
    reset: resetSwap
  } = useSendTransaction();

  // 5. Wait for swap confirmation
  const { isSuccess: isSwapConfirmed } = useWaitForTransactionReceipt({
    hash: swapHash,
  });

  // Keep the on-chain allowance fresh once an approval confirms.
  // Pure side effect (a refetch) — no setState, so the UI step stays derived below.
  useEffect(() => {
    if (isApproveConfirmed) refetchAllowance();
  }, [isApproveConfirmed, refetchAllowance]);

  // Derive the UI step from wallet/tx state rather than mirroring it into state via
  // effects. Ordered most-advanced-first so the latest phase wins each render.
  const hasAllowance =
    allowanceData !== undefined && (allowanceData as bigint) >= amountInBigInt;
  const step: ExecutionStep = swapError
    ? 'error'
    : isSwapConfirmed
    ? 'success'
    : swapHash || isSwapPending
    ? 'executing'
    : approveError
    ? 'error'
    : isApprovePending || (!!approveHash && !isApproveConfirmed)
    ? 'approving'
    : allowanceData === undefined
    ? 'check_allowance'
    : hasAllowance || isApproveConfirmed
    ? 'approved'
    : 'needs_approval';

  const errorMsg = swapError
    ? `Swap failed: ${swapError.message.slice(0, 120)}`
    : approveError
    ? `Approval failed: ${approveError.message.slice(0, 120)}`
    : '';

  // Retry clears the failed mutation(s); the step then re-derives back to the
  // right phase (needs_approval / approved).
  const handleRetry = () => {
    resetApprove();
    resetSwap();
  };

  const handleApprove = () => {
    writeApprove({
      address: fromAsset.underlyingAsset as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [txPayload.spender as `0x${string}`, amountInBigInt]
    });
  };

  const handleExecute = () => {
    sendTransaction({
      to: txPayload.to as `0x${string}`,
      data: txPayload.data as `0x${string}`,
      value: txPayload.value ? BigInt(txPayload.value) : 0n
    });
  };

  const stepStyles: Record<string, { bg: string; border: string; text: string }> = {
    check_allowance: { bg: '#f9fafb', border: '#d1d5db', text: '#6b7280' },
    needs_approval: { bg: '#fffbeb', border: '#fbbf24', text: '#92400e' },
    approving: { bg: '#fffbeb', border: '#fbbf24', text: '#92400e' },
    approved: { bg: '#f0fdf4', border: '#22c55e', text: '#166534' },
    executing: { bg: '#eff6ff', border: '#3b82f6', text: '#1e40af' },
    success: { bg: '#f0fdf4', border: '#22c55e', text: '#166534' },
    error: { bg: '#fef2f2', border: '#ef4444', text: '#991b1b' },
  };

  const s = stepStyles[step];

  if (isEmbedded) {
    return (
      <div style={{ marginTop: '20px' }}>
        {step === 'check_allowance' && (
          <button style={{
            width: '100%', padding: '16px', backgroundColor: '#e5e7eb', color: '#6b7280',
            border: 'none', borderRadius: '12px', fontWeight: '600', fontSize: '16px',
            cursor: 'not-allowed'
          }} disabled>
            Checking Allowance...
          </button>
        )}
        {step === 'needs_approval' && (
          <button onClick={handleApprove} style={{
            width: '100%', padding: '16px', backgroundColor: '#3b82f6', color: '#fff',
            border: 'none', borderRadius: '12px', fontWeight: '600', fontSize: '16px',
            cursor: 'pointer', boxShadow: '0 4px 6px -1px rgba(59, 130, 246, 0.2)'
          }}>
            Approve {fromAsset.symbol}
          </button>
        )}
        {(step === 'approving' || isApprovePending) && (
          <button style={{
            width: '100%', padding: '16px', backgroundColor: '#93c5fd', color: '#fff',
            border: 'none', borderRadius: '12px', fontWeight: '600', fontSize: '16px',
            cursor: 'wait'
          }} disabled>
            Approving...
          </button>
        )}
        {step === 'approved' && (
          <button onClick={handleExecute} style={{
            width: '100%', padding: '16px', backgroundColor: '#10b981', color: '#fff',
            border: 'none', borderRadius: '12px', fontWeight: '600', fontSize: '16px',
            cursor: 'pointer', boxShadow: '0 4px 6px -1px rgba(16, 185, 129, 0.2)'
          }}>
            Execute Swap
          </button>
        )}
        {(step === 'executing' || isSwapPending) && (
          <button style={{
            width: '100%', padding: '16px', backgroundColor: '#6ee7b7', color: '#fff',
            border: 'none', borderRadius: '12px', fontWeight: '600', fontSize: '16px',
            cursor: 'wait'
          }} disabled>
            Executing Swap...
          </button>
        )}
        {step === 'success' && (
          <div style={{ textAlign: 'center' }}>
            <button onClick={onClose} style={{
              width: '100%', padding: '16px', backgroundColor: '#10b981', color: '#fff',
              border: 'none', borderRadius: '12px', fontWeight: '600', fontSize: '16px',
              cursor: 'pointer', marginBottom: '8px'
            }}>
              Swap Complete! Close
            </button>
            {swapHash && (
              <a href={`${explorerUrl}/tx/${swapHash}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: '13px', color: '#3b82f6', textDecoration: 'underline' }}>
                View on Explorer →
              </a>
            )}
          </div>
        )}
        {step === 'error' && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ color: '#ef4444', fontSize: '13px', marginBottom: '12px', padding: '8px', backgroundColor: '#fee2e2', borderRadius: '8px' }}>
              {errorMsg}
            </div>
            <button onClick={handleRetry} style={{
              width: '100%', padding: '16px', backgroundColor: '#ef4444', color: '#fff',
              border: 'none', borderRadius: '12px', fontWeight: '600', fontSize: '16px',
              cursor: 'pointer'
            }}>
              Retry
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ 
      marginTop: '15px', 
      padding: '16px', 
      backgroundColor: s.bg, 
      border: `1px solid ${s.border}`, 
      borderRadius: '8px' 
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ fontWeight: 'bold', fontSize: '13px', color: s.text }}>
          {step === 'check_allowance' && '⏳ Checking Allowance...'}
          {step === 'needs_approval' && '🔐 Approval Required'}
          {step === 'approving' && '⏳ Approving...'}
          {step === 'approved' && '✅ Approved — Ready to Swap'}
          {step === 'executing' && '⏳ Executing Swap...'}
          {step === 'success' && '🎉 Swap Successful!'}
          {step === 'error' && '❌ Error'}
        </div>
        <button 
          onClick={onClose} 
          style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: '12px', cursor: 'pointer', fontWeight: 'bold' }}
        >
          Close ✖
        </button>
      </div>

      {/* Tx Payload Summary */}
      <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '12px', padding: '8px', backgroundColor: '#fff', borderRadius: '4px', border: '1px solid #e5e7eb' }}>
        <div><strong>Token Contract:</strong> {fromAsset.underlyingAsset} ({fromAsset.symbol})</div>
        <div><strong>Approve Spender:</strong> {txPayload.spender}</div>
        <div><strong>Swap Router:</strong> {txPayload.to}</div>
        <div style={{ wordBreak: 'break-all' }}><strong>Calldata:</strong> {txPayload.data.slice(0, 66)}...</div>
      </div>

      {/* Step 1: Needs Approval */}
      {step === 'needs_approval' && (
        <button
          onClick={handleApprove}
          style={{
            width: '100%',
            padding: '12px',
            backgroundColor: '#f59e0b',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            fontWeight: 'bold',
            fontSize: '14px',
            cursor: 'pointer'
          }}
        >
          Approve {fromAsset.symbol} for Spending
        </button>
      )}

      {/* Step 2: Approving */}
      {(step === 'approving' || isApprovePending) && (
        <div style={{ textAlign: 'center', padding: '10px', color: '#92400e' }}>
          <div style={{ marginBottom: '6px' }}>⏳ Waiting for approval confirmation...</div>
          {approveHash && (
            <a href={`${explorerUrl}/tx/${approveHash}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: '12px', color: '#3b82f6' }}>
              View on Explorer →
            </a>
          )}
        </div>
      )}

      {/* Step 3: Approved — Execute */}
      {step === 'approved' && (
        <button
          onClick={handleExecute}
          style={{
            width: '100%',
            padding: '12px',
            backgroundColor: '#22c55e',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            fontWeight: 'bold',
            fontSize: '14px',
            cursor: 'pointer'
          }}
        >
          Execute Swap
        </button>
      )}

      {/* Step 4: Executing */}
      {(step === 'executing' || isSwapPending) && (
        <div style={{ textAlign: 'center', padding: '10px', color: '#1e40af' }}>
          <div style={{ marginBottom: '6px' }}>⏳ Waiting for swap confirmation...</div>
          {swapHash && (
            <a href={`${explorerUrl}/tx/${swapHash}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: '12px', color: '#3b82f6' }}>
              View on Explorer →
            </a>
          )}
        </div>
      )}

      {/* Step 5: Success */}
      {step === 'success' && swapHash && (
        <div style={{ textAlign: 'center', padding: '10px' }}>
          <div style={{ fontSize: '16px', marginBottom: '8px' }}>🎉 Swap Complete!</div>
          <a 
            href={`${explorerUrl}/tx/${swapHash}`} 
            target="_blank" 
            rel="noopener noreferrer" 
            style={{ 
              display: 'inline-block',
              padding: '8px 16px', 
              backgroundColor: '#22c55e', 
              color: '#fff', 
              borderRadius: '6px', 
              textDecoration: 'none',
              fontWeight: 'bold',
              fontSize: '13px'
            }}
          >
            View Transaction on Explorer →
          </a>
        </div>
      )}

      {/* Error */}
      {step === 'error' && (
        <div style={{ fontSize: '12px', color: '#991b1b', padding: '8px', backgroundColor: '#fee2e2', borderRadius: '4px' }}>
          {errorMsg}
          <button 
            onClick={handleRetry}
            style={{ display: 'block', marginTop: '8px', padding: '6px 12px', backgroundColor: '#ef4444', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
