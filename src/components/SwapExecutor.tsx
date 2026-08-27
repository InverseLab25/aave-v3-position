import { TxSteps } from './TxSteps';
import { useEffect, useState } from 'react';
import { extractRevertMessage } from '../utils/errors'
import { useConnection, useReadContract, useWriteContract, useSendTransaction, useWaitForTransactionReceipt, useConfig } from 'wagmi';
import { estimateFeesPerGas, estimateGas } from 'wagmi/actions';
import { parseUnits } from 'viem';
import { calculateAdjustedFees, pinnedGasLimit, GasEstimateError } from '../utils/gas';
import { approveErc20 } from '../utils/contract';
import type { TransactionPayload, Asset } from '../adapters/types';
import { isNativeAddress } from '../adapters/native';
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
  }
] as const;

interface SwapExecutorProps {
  txPayload: TransactionPayload;
  fromAsset: Asset;
  amountIn: string;
  onClose: () => void;
  /** Fired the moment the user commits (Approve/Execute) so the parent can freeze quote refresh. */
  onSwapStart?: () => void;
  isEmbedded?: boolean;
  onStepChange?: (step: string, hash?: string) => void;
}

type ExecutionStep = 'check_allowance' | 'needs_approval' | 'approving' | 'approved' | 'executing' | 'success' | 'error';

export function SwapExecutor({ txPayload, fromAsset, amountIn, onClose, onSwapStart, isEmbedded, onStepChange }: SwapExecutorProps) {
  const { address, chainId } = useConnection();
  const config = useConfig();
  const chainConfig = getChainConfig(chainId);
  const explorerUrl = chainConfig?.explorerUrl ?? 'https://etherscan.io';

  const amountInBigInt = parseUnits(amountIn, fromAsset.decimals);

  // Selling native currency (ETH/BNB/…) needs no ERC-20 approval — the amount rides
  // along as tx `value` — so the whole allowance/approve step is skipped.
  const isFromNative = isNativeAddress(fromAsset.underlyingAsset);

  // Error from the pre-flight simulation of the swap tx (before it's sent on-chain).
  const [execError, setExecError] = useState<string | null>(null);

  // 1. Read current allowance
  const { data: allowanceData, refetch: refetchAllowance } = useReadContract({ chainId,
    address: fromAsset.underlyingAsset as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address ? [address, txPayload.spender as `0x${string}`] : undefined,
    query: { enabled: !!address && !isFromNative }
  });

  // 2. Approve hook (async so we can simulate before writing)
  const {
    mutateAsync: writeApproveAsync,
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
    isFromNative || (allowanceData !== undefined && (allowanceData as bigint) >= amountInBigInt);
  const step: ExecutionStep = execError
    ? 'error'
    : swapError
    ? 'error'
    : isSwapConfirmed
    ? 'success'
    : swapHash || isSwapPending
    ? 'executing'
    : approveError
    ? 'error'
    : isApprovePending || (!!approveHash && !isApproveConfirmed)
    ? 'approving'
    : !isFromNative && allowanceData === undefined
    ? 'check_allowance'
    : hasAllowance || isApproveConfirmed
    ? 'approved'
    : 'needs_approval';

  useEffect(() => {
    onStepChange?.(step, swapHash || undefined);
  }, [step, swapHash, onStepChange]);

  const errorMsg = execError
    ? execError
    : swapError
    ? `Swap failed: ${swapError.message.slice(0, 120)}`
    : approveError
    ? `Approval failed: ${approveError.message.slice(0, 120)}`
    : '';

  // Retry clears the failed mutation(s); the step then re-derives back to the
  // right phase (needs_approval / approved).
  const handleRetry = () => {
    setExecError(null);
    resetApprove();
    resetSwap();
  };

  const handleApprove = async () => {
    onSwapStart?.(); // user committed — parent freezes quote auto-refresh so this tx can't change
    // approveErc20: simulate → write, with a zero-reset first for USDT-likes
    await approveErc20(config, writeApproveAsync, {
      token: fromAsset.underlyingAsset as `0x${string}`,
      spender: txPayload.spender as `0x${string}`,
      amount: amountInBigInt,
      // An unresolved allowance read is treated as 0 — the reset path is only
      // needed when we know a non-zero allowance is already in place.
      currentAllowance: (allowanceData as bigint | undefined) ?? 0n,
    });
  };

  const handleExecute = async () => {
    onSwapStart?.(); // user committed — parent freezes quote auto-refresh so this tx can't change
    setExecError(null);
    const value = txPayload.value ? BigInt(txPayload.value) : 0n;

    // Pre-flight the raw swap tx (eth_call-style dry run). Stale/bad aggregator calldata
    // reverts HERE for free instead of on-chain, where it would burn the user's gas.
    let gas: bigint;
    try {
      // Keep the estimate rather than discarding it — aggregator routes can take a
      // costlier path than the one quoted, and an unpinned gas limit leaves that to
      // the wallet's own unbuffered guess. `pinnedGasLimit` also refuses a route that
      // would not fit in one transaction on this chain.
      gas = await pinnedGasLimit(
        () =>
          estimateGas(config, {
            to: txPayload.to as `0x${string}`,
            data: txPayload.data as `0x${string}`,
            value,
            account: address,
          }),
        { chainId, label: 'swap' },
      );
    } catch (e) {
      // Two different failures wear the same catch. A route too big for one transaction has not
      // reverted and refreshing the quote will not shrink it — saying "would revert" there sends
      // the user round a loop that cannot end.
      setExecError(
        e instanceof GasEstimateError && e.overCap
          ? `This route needs more gas than one transaction allows on this chain. Try a smaller amount. (${e.message.slice(0, 120)})`
          : `Swap would revert — refresh the quote and try again: ${extractRevertMessage(e, 'unknown error').slice(0, 120)}`,
      );
      return;
    }

    const { maxFeePerGas, maxPriorityFeePerGas } = await estimateFeesPerGas(config);
    const { adjustedMaxFeePerGas: adjMax, adjustedMaxPriorityFeePerGas: adjPriority } = calculateAdjustedFees(maxFeePerGas, maxPriorityFeePerGas);
    sendTransaction({
      to: txPayload.to as `0x${string}`,
      data: txPayload.data as `0x${string}`,
      value,
      gas,
      maxFeePerGas: adjMax,
      maxPriorityFeePerGas: adjPriority,
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
    if (step === 'success') return null;

    const isBusy = step === 'check_allowance' || step === 'approving' || isApprovePending || step === 'executing' || isSwapPending;
    
    const buttonLabel = 
      step === 'error' ? 'Retry' :
      step === 'check_allowance' ? 'Checking...' :
      (step === 'approving' || isApprovePending) ? 'Processing...' :
      (step === 'executing' || isSwapPending) ? 'Processing...' :
      step === 'needs_approval' ? `Approve ${fromAsset.symbol}` :
      'Confirm';

    const onClick = step === 'error' ? handleRetry : step === 'needs_approval' ? handleApprove : handleExecute;

    // `success` is unreachable here — the early return above took it — so testing for it is dead.
    //
    // An `error` term is dead too, for a subtler reason: `handleRetry` resets the step to
    // `needs_approval`, so a failed send does not remember that the approval had already been
    // granted. Showing the tick through an error would need that memory kept somewhere it is not.
    const hasApproved = step === 'approved' || step === 'executing' || isSwapPending;
    const isSending = step === 'executing' || isSwapPending;


    return (
      <div style={{ marginTop: '20px' }}>
        {!isFromNative && (
          <TxSteps
            steps={[
              { label: 'approved', done: hasApproved },
              { label: 'send', done: false, active: isSending },
            ]}
          />
        )}

        {step === 'error' && (
          <div style={{ marginTop: '12px', marginBottom: '16px', fontSize: '14px', color: '#ef4444' }}>
            {errorMsg}
          </div>
        )}

        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary" style={{ flex: 1, padding: '10px' }} disabled={isBusy}>
            Cancel
          </button>
          <button
            onClick={onClick}
            disabled={isBusy}
            className="btn-primary"
            style={{ flex: 1, padding: '10px' }}
          >
            {buttonLabel}
          </button>
        </div>
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
