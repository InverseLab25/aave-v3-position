import { useState, useEffect, useRef, useMemo } from 'react';
import { useAavePositions } from '../hooks/useAavePositions';
import { useAccount, useReadContract } from 'wagmi';
import { parseUnits, formatUnits, erc20Abi } from 'viem';
import { getAdaptersForChain } from '../adapters';
import { getChainConfig } from '../config/chains';
import { ConfirmSwapModal } from './ConfirmSwapModal';
import type { Asset, QuoteResponse, TransactionPayload } from '../adapters';

type Token = Asset & { source?: 'supplied' | 'borrowed' | 'default' };
type KyberHop = { tokenIn: string; tokenOut: string; swapAmount: string; exchange?: string; poolType?: string };

export function DexDiscovery() {
  const { suppliedAssets, borrowedAssets, isConnected, chainId } = useAavePositions();
  const { address } = useAccount();
  const chainConfig = getChainConfig(chainId);

  const adapters = useMemo(() => {
    return getAdaptersForChain(chainConfig?.adapters ?? []);
  }, [chainConfig]);

  const defaultTokens = useMemo<Token[]>(
    () => (chainConfig?.defaultTokens ?? []).map(t => ({ ...t, source: 'default' as const })),
    [chainConfig]
  );

  // Merge Aave positions with default tokens, deduped by address
  const allFromTokens = useMemo<Token[]>(() => {
    const seen = new Set<string>();
    const result: Token[] = [];
    for (const a of suppliedAssets) {
      seen.add(a.underlyingAsset.toLowerCase());
      result.push({ ...a, source: 'supplied' });
    }
    for (const t of defaultTokens) {
      if (!seen.has(t.underlyingAsset.toLowerCase())) {
        seen.add(t.underlyingAsset.toLowerCase());
        result.push(t);
      }
    }
    return result;
  }, [suppliedAssets, defaultTokens]);

  const allToTokens = useMemo<Token[]>(() => {
    const seen = new Set<string>();
    const result: Token[] = [];
    for (const a of borrowedAssets) {
      seen.add(a.underlyingAsset.toLowerCase());
      result.push({ ...a, source: 'borrowed' });
    }
    for (const t of defaultTokens) {
      if (!seen.has(t.underlyingAsset.toLowerCase())) {
        seen.add(t.underlyingAsset.toLowerCase());
        result.push(t);
      }
    }
    return result;
  }, [borrowedAssets, defaultTokens]);

  const [fromAssetOverride, setFromAssetOverride] = useState<Token | null>(null);
  const [toAssetOverride, setToAssetOverride] = useState<Token | null>(null);
  const [amountStr, setAmountStr] = useState<string>('');
  const [slippage, setSlippage] = useState<number>(1);
  const [quoteMap, setQuoteMap] = useState<Record<string, QuoteResponse | null>>({});
  const [, setErrors] = useState<Record<string, string>>({});
  const [builtTxs, setBuiltTxs] = useState<Record<string, TransactionPayload>>({});
  const [isBuildingTx, setIsBuildingTx] = useState<Record<string, boolean>>({});

  const fetchingRef = useRef<Record<string, boolean>>({});
  const lastFetchRef = useRef<Record<string, number>>({});

  // Derive current selection with fallback to the first sensible token.
  // User selections (from the select dropdowns) override the fallback via *Override state.
  const fromAsset: Token | null = fromAssetOverride ?? allFromTokens[0] ?? null;
  const toAsset: Token | null = toAssetOverride
    ?? allToTokens.find(t => t.underlyingAsset.toLowerCase() !== fromAsset?.underlyingAsset.toLowerCase())
    ?? allToTokens[0]
    ?? null;

  // Fetch actual wallet balance for fromAsset via ERC20 balanceOf
  const { data: fromBalanceRaw } = useReadContract({
    address: fromAsset?.underlyingAsset as `0x${string}` | undefined,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!fromAsset?.underlyingAsset },
  });
  const fromBalance = fromBalanceRaw !== undefined && fromAsset
    ? Number(formatUnits(fromBalanceRaw as bigint, fromAsset.decimals))
    : 0;
  const fromBalanceFormatted = fromBalance.toFixed(6);

  // Reset user selections when chain changes (state-adjust pattern — cheaper than an effect).
  const [prevChainId, setPrevChainId] = useState(chainId);
  if (prevChainId !== chainId) {
    setPrevChainId(chainId);
    setFromAssetOverride(null);
    setToAssetOverride(null);
    setAmountStr('');
    setQuoteMap({});
    setBuiltTxs({});
    setErrors({});
  }

  // Invalidate quotes whenever the request signature changes (pair, amount, slippage).
  // Otherwise stale routes from a previous pair would briefly render against new decimals.
  const requestKey = `${chainId}|${fromAsset?.underlyingAsset ?? ''}|${toAsset?.underlyingAsset ?? ''}|${amountStr}|${slippage}`;
  const [prevRequestKey, setPrevRequestKey] = useState(requestKey);
  if (prevRequestKey !== requestKey) {
    setPrevRequestKey(requestKey);
    setQuoteMap({});
    setErrors({});
  }

  const handleSwapAssets = () => {
    // Block direction swap while a confirm modal is open — otherwise the modal keeps
    // rendering with a payload built for the old pair, which the user could execute.
    if (isTxActive) return;
    setFromAssetOverride(toAsset);
    setToAssetOverride(fromAsset);
    setAmountStr('');
  };

  const isValidInput = parseFloat(amountStr) > 0 && !!fromAsset && !!toAsset && adapters.length > 0;

  const fetchAllQuotes = () => {
    if (!isValidInput || !fromAsset || !toAsset) return;

    let amountIn;
    try {
      amountIn = parseUnits(amountStr, fromAsset.decimals).toString();
    } catch {
      return;
    }

    const now = Date.now();

    adapters.forEach(adapter => {
      if (fetchingRef.current[adapter.name]) return;

      const lastFetch = lastFetchRef.current[adapter.name] || 0;
      const throttleMs = adapter.name === 'OpenOcean' ? 5000 : 1000;
      if (now - lastFetch < throttleMs - 100) return; // Allow 100ms jitter

      lastFetchRef.current[adapter.name] = now;
      fetchingRef.current[adapter.name] = true;

      adapter.getQuote(fromAsset, toAsset, amountIn, slippage, chainId)
        .then(res => {
          if (res) {
            setQuoteMap(prev => ({ ...prev, [adapter.name]: res }));
            setErrors(prev => {
              const newErrs = { ...prev };
              delete newErrs[adapter.name];
              return newErrs;
            });
          }
        })
        .catch(err => {
          setErrors(prev => ({ ...prev, [adapter.name]: err.message || 'Failed' }));
        })
        .finally(() => {
          fetchingRef.current[adapter.name] = false;
        });
    });
  };

  const isTxActive = Object.values(builtTxs).some(Boolean) || Object.values(isBuildingTx).some(Boolean);

  useEffect(() => {
    if (!isValidInput || isTxActive) return;
    fetchAllQuotes();
    const intervalId = setInterval(() => {
      fetchAllQuotes();
    }, 1000);
    return () => clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isValidInput, fromAsset, toAsset, amountStr, slippage, isTxActive]);

  // Active aggregator: the modal currently showing (or null).
  const activeAggregator = Object.keys(builtTxs).find(k => builtTxs[k]) ?? null;

  // Track refresh state so the modal can surface "Refreshing…" / "Updated Xs ago".
  const [isRefreshingActive, setIsRefreshingActive] = useState(false);
  const [activeQuoteRefreshedAt, setActiveQuoteRefreshedAt] = useState<number>(0);

  /**
   * Refresh the quote and rebuild the tx for the currently-open aggregator's modal.
   * Called on interval while the modal is open, and on-demand via the modal's Refresh button.
   */
  const refreshActiveQuote = async () => {
    if (!activeAggregator || !address || !fromAsset || !toAsset) return;
    const adapter = adapters.find(a => a.name === activeAggregator);
    if (!adapter) return;
    let amountIn: string;
    try {
      amountIn = parseUnits(amountStr, fromAsset.decimals).toString();
    } catch {
      return;
    }
    setIsRefreshingActive(true);
    try {
      const freshQuote = await adapter.getQuote(fromAsset, toAsset, amountIn, slippage, chainId);
      if (!freshQuote) return;
      setQuoteMap(prev => ({ ...prev, [activeAggregator]: freshQuote }));
      // Rebuild the tx from the fresh quote so slippage/router/deadline are current.
      const freshTx = await adapter.buildTransaction(freshQuote, slippage, address, chainId);
      setBuiltTxs(tPrev => (tPrev[activeAggregator] ? { ...tPrev, [activeAggregator]: freshTx } : tPrev));
      setActiveQuoteRefreshedAt(Date.now());
    } catch {
      // silent — the existing quote/tx remain in place
    } finally {
      setIsRefreshingActive(false);
    }
  };

  // NOTE: intentionally no auto-refresh interval here.
  // A 2s poll used to rebuild builtTxs[activeAggregator] (new router/calldata/minOut/spender)
  // while the confirm modal was open — including *after* the user had reviewed and started
  // approving/executing — so they could sign a payload different from the one they reviewed.
  // Refresh is now manual only (the modal's Refresh button → refreshActiveQuote), which keeps
  // the displayed quote and the executable tx consistent with what the user is looking at.

  const clearTx = (aggregatorName: string) => {
    setBuiltTxs(prev => {
      const newTxs = { ...prev };
      delete newTxs[aggregatorName];
      return newTxs;
    });
  };

  const buildTx = async (aggregatorName: string) => {
    const quote = quoteMap[aggregatorName];
    const adapter = adapters.find(a => a.name === aggregatorName);
    if (!quote || !adapter || !address) return;

    setIsBuildingTx(prev => ({ ...prev, [aggregatorName]: true }));
    try {
      const txData = await adapter.buildTransaction(quote, slippage, address, chainId);
      setBuiltTxs(prev => ({ ...prev, [aggregatorName]: txData }));
      setActiveQuoteRefreshedAt(Date.now());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`Failed to build tx for ${aggregatorName}: ${msg}`);
    } finally {
      setIsBuildingTx(prev => ({ ...prev, [aggregatorName]: false }));
    }
  };

  const formatAddress = (addr: string) => {
    if (!addr) return '';
    if (addr.toLowerCase() === fromAsset?.underlyingAsset.toLowerCase()) return fromAsset.symbol;
    if (addr.toLowerCase() === toAsset?.underlyingAsset.toLowerCase()) return toAsset.symbol;
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  if (!isConnected) {
    return <div className="card" style={{ textAlign: 'center', padding: '40px' }}>Please connect your wallet to use DEX Discovery.</div>;
  }

  const validRoutes = Object.values(quoteMap).filter(Boolean) as QuoteResponse[];
  validRoutes.sort((a, b) => {
    const valA = BigInt(a.amountOut);
    const valB = BigInt(b.amountOut);
    return valA > valB ? -1 : valA < valB ? 1 : 0;
  });

  return (
    <div className="dashboard-container" style={{ maxWidth: '1200px', margin: '0 auto' }}>
      <div className="card">
        <div className="header">
          <h1>Meta-Aggregator Discovery</h1>
        </div>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '30px' }}>
          Compare routes across {adapters.length} Aggregators in real-time. Auto-refreshes every 1s. Sorted by highest asset return.
        </p>

        {/* No adapters on this chain */}
        {adapters.length === 0 && (
          <div style={{ padding: '40px', textAlign: 'center', color: '#d97706', backgroundColor: '#fffbeb', borderRadius: '8px', border: '1px solid #fbbf24' }}>
            <div style={{ fontSize: '18px', fontWeight: 'bold', marginBottom: '8px' }}>⚠️ No DEX Aggregators Available</div>
            <div style={{ fontSize: '14px' }}>
              DEX aggregators are not supported on <strong>{chainConfig?.name ?? 'this network'}</strong>.
              Switch to Ethereum Mainnet to use DEX Discovery.
            </div>
          </div>
        )}

        {/* Main content when adapters exist */}
        {adapters.length > 0 && (
          <div className="dex-grid">

            {/* COLUMN 1: Config */}
            <div style={{ paddingRight: '20px', borderRight: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                {/* Paired From/To cards — visually one unit with the swap toggle floating between */}
                <div style={{ position: 'relative' }}>
                <div style={{ backgroundColor: '#fff', padding: '16px', borderRadius: '12px 12px 4px 4px', border: '1px solid var(--border-color)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', alignItems: 'center' }}>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button onClick={() => setAmountStr(fromBalance.toString())} style={{ backgroundColor: '#f3f4f6', border: '1px solid var(--border-color)', padding: '4px 12px', borderRadius: '16px', fontSize: '11px', cursor: 'pointer' }}>Max</button>
                      <button onClick={() => setAmountStr((fromBalance / 2).toString())} style={{ backgroundColor: '#f3f4f6', border: '1px solid var(--border-color)', padding: '4px 12px', borderRadius: '16px', fontSize: '11px', cursor: 'pointer' }}>Half</button>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontSize: '14px' }}>💼</span> {fromBalanceFormatted}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '8px' }}>
                    <input
                      type="number"
                      value={amountStr}
                      onChange={e => setAmountStr(e.target.value)}
                      disabled={isTxActive}
                      placeholder="0.0"
                      style={{ flex: 1, backgroundColor: 'transparent', border: 'none', fontSize: '24px', outline: 'none', width: '100px', color: 'inherit', cursor: isTxActive ? 'not-allowed' : 'text' }}
                    />
                    <select
                      value={fromAsset?.underlyingAsset || ''}
                      onChange={e => setFromAssetOverride(allFromTokens.find(a => a.underlyingAsset.toLowerCase() === e.target.value.toLowerCase()) ?? null)}
                      disabled={isTxActive}
                      style={{ backgroundColor: '#f3f4f6', padding: '8px 12px', borderRadius: '20px', border: '1px solid var(--border-color)', outline: 'none', cursor: isTxActive ? 'not-allowed' : 'pointer', fontWeight: 'bold', color: 'inherit', minWidth: '120px', opacity: isTxActive ? 0.6 : 1 }}
                    >
                      {allFromTokens.length === 0 && <option value="">No tokens</option>}
                      {allFromTokens.map((asset, i) => (
                        <option key={i} value={asset.underlyingAsset}>{asset.symbol}</option>
                      ))}
                    </select>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>~${(parseFloat(amountStr || '0') * (parseFloat(fromAsset?.priceInUsd || '0'))).toFixed(2)}</div>
                </div>

                <div style={{ height: '4px' }} />

                <div style={{ backgroundColor: '#fff', padding: '16px', borderRadius: '4px 4px 12px 12px', border: '1px solid var(--border-color)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', alignItems: 'center' }}>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Est. Output</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontSize: '14px' }}>💼</span> 0.000000
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '8px' }}>
                    <div style={{ flex: 1, fontSize: '24px', color: amountStr ? 'inherit' : 'var(--text-secondary)' }}>
                      {amountStr && validRoutes.length > 0 ? Number(formatUnits(BigInt(validRoutes[0].amountOut), toAsset.decimals)).toFixed(4) : '0.0'}
                    </div>
                    <select
                      value={toAsset?.underlyingAsset || ''}
                      onChange={e => setToAssetOverride(allToTokens.find(a => a.underlyingAsset.toLowerCase() === e.target.value.toLowerCase()) ?? null)}
                      disabled={isTxActive}
                      style={{ backgroundColor: '#f3f4f6', padding: '8px 12px', borderRadius: '20px', border: '1px solid var(--border-color)', outline: 'none', cursor: isTxActive ? 'not-allowed' : 'pointer', fontWeight: 'bold', color: 'inherit', minWidth: '120px', opacity: isTxActive ? 0.6 : 1 }}
                    >
                      {allToTokens.length === 0 && <option value="">No tokens</option>}
                      {allToTokens
                        .filter(asset => asset.underlyingAsset.toLowerCase() !== fromAsset?.underlyingAsset?.toLowerCase())
                        .map((asset, i) => (
                          <option key={i} value={asset.underlyingAsset}>{asset.symbol}</option>
                        ))}
                    </select>
                  </div>
                  {amountStr && validRoutes.length > 0 && (
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>~${Number(validRoutes[0].amountOutUsd).toFixed(2)}</div>
                  )}
                </div>

                  {/* Swap toggle — floats over the seam between the two cards */}
                  <button
                    onClick={handleSwapAssets}
                    disabled={isTxActive}
                    aria-label="Swap tokens"
                    title={isTxActive ? 'Close the confirm dialog before swapping direction' : 'Swap tokens'}
                    style={{
                      position: 'absolute',
                      top: '50%',
                      left: '50%',
                      transform: 'translate(-50%, -50%)',
                      width: '36px',
                      height: '36px',
                      borderRadius: '50%',
                      backgroundColor: '#fff',
                      border: '1px solid var(--border-color)',
                      boxShadow: '0 2px 6px rgba(0,0,0,0.06)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: isTxActive ? 'not-allowed' : 'pointer',
                      opacity: isTxActive ? 0.5 : 1,
                      padding: 0,
                      zIndex: 2,
                    }}
                  >
                    <span style={{ fontSize: '18px', color: 'var(--text-secondary)', lineHeight: 1 }}>⇅</span>
                  </button>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', marginBottom: '8px' }}>SLIPPAGE TOLERANCE (%)</label>
                  <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
                    {[0.1, 0.5, 1.0].map(val => (
                      <button
                        key={val}
                        onClick={() => setSlippage(val)}
                        style={{
                          padding: '6px 12px',
                          borderRadius: '4px',
                          border: '1px solid var(--border-color)',
                          backgroundColor: slippage === val ? '#111' : '#fff',
                          color: slippage === val ? '#fff' : '#111',
                          cursor: 'pointer',
                          fontSize: '12px',
                          fontWeight: 'bold'
                        }}
                      >
                        {val}%
                      </button>
                    ))}
                  </div>
                  <input
                    type="number"
                    step="0.1"
                    value={slippage}
                    onChange={e => setSlippage(Math.min(50, Math.max(0, parseFloat(e.target.value) || 0)))}
                    placeholder="Custom %"
                    style={{ width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid var(--border-color)' }}
                  />
                </div>
              </div>
            </div>

            {/* COLUMN 2: Results */}
            <div style={{ minWidth: 0 }}>
              {!isValidInput && (
                <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af', backgroundColor: '#f9fafb', borderRadius: '8px', border: '1px dashed #d1d5db' }}>
                  Enter an amount to begin auto-discovery...
                </div>
              )}

              {isValidInput && !isTxActive && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px', fontSize: '14px', color: '#16a34a' }}>
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#16a34a', animation: 'pulse 1.5s infinite' }}></div>
                  Live Streaming Quotes...
                </div>
              )}

              {isValidInput && isTxActive && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px', fontSize: '14px', color: '#d97706' }}>
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#d97706' }}></div>
                  Live streaming paused — executing transaction.
                </div>
              )}

              {validRoutes.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                  {validRoutes.map((route, idx) => {
                    const isBest = idx === 0;
                    const txData = builtTxs[route.aggregator];
                    const isLoadingTx = isBuildingTx[route.aggregator];
                    const adapter = adapters.find(a => a.name === route.aggregator);
                    const canExecute = adapter?.supportsExecution ?? false;

                    const slippageBps = BigInt(Math.floor(slippage * 100));
                    const minOutputBigInt = (BigInt(route.amountOut) * (10000n - slippageBps)) / 10000n;
                    const minOutputFormatted = Number(formatUnits(minOutputBigInt, toAsset.decimals)).toFixed(6);

                    const isInsufficientBalance = parseFloat(amountStr) > fromBalance;

                    return (
                      <div key={route.aggregator} style={{
                        padding: '20px',
                        border: isBest ? '2px solid var(--success-color)' : '1px solid var(--border-color)',
                        borderRadius: '8px',
                        backgroundColor: isBest ? '#f0fdf4' : '#fafafa',
                        position: 'relative'
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                          <div style={{ fontWeight: 'bold', fontSize: '18px' }}>
                            {route.aggregator}
                            {isBest && <span style={{ marginLeft: '10px', fontSize: '12px', backgroundColor: 'var(--success-color)', color: 'white', padding: '3px 8px', borderRadius: '12px' }}>BEST RETURN</span>}
                            {!canExecute && <span style={{ marginLeft: '10px', fontSize: '11px', backgroundColor: '#6b7280', color: 'white', padding: '2px 6px', borderRadius: '4px' }}>Quote Only</span>}
                          </div>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>
                          <div>
                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>You Pay</div>
                            <div style={{ fontSize: '16px', fontWeight: 'bold' }}>
                              {Number(formatUnits(BigInt(route.amountIn), fromAsset.decimals)).toFixed(6)} {fromAsset.symbol}
                            </div>
                          </div>

                          <div>
                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>You Receive</div>
                            <div style={{ fontSize: '16px', fontWeight: 'bold', color: isBest ? 'var(--success-color)' : 'var(--text-primary)' }}>
                              {Number(formatUnits(BigInt(route.amountOut), toAsset.decimals)).toFixed(6)} {toAsset.symbol}
                            </div>
                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>~${Number(route.amountOutUsd).toFixed(2)}</div>
                            <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '6px', fontWeight: '500' }}>
                              Min Output: {minOutputFormatted} {toAsset.symbol}
                            </div>
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: '15px', fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '15px', padding: '10px', backgroundColor: '#fff', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                          <div>⛽ Gas Est: <strong style={{ color: '#dc2626' }}>-${Number(route.gasUsd).toFixed(2)}</strong></div>
                        </div>

                        {route.routeDetails && (
                          <div style={{ marginBottom: '15px' }}>
                            <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>Route Details</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>

                              {route.routeDetails.type === 'kyber' && (
                                <>
                                  {route.routeDetails.paths.map((path: KyberHop[], pathIdx: number) => {
                                    const firstHop = path[0];
                                    const pathAmountIn = BigInt(firstHop.swapAmount);
                                    const totalAmountIn: bigint = route.routeDetails.totalAmountIn;
                                    const percentage = totalAmountIn > 0n
                                      ? Number((pathAmountIn * 10000n) / totalAmountIn) / 100
                                      : 100;

                                    return (
                                      <div key={pathIdx} style={{ fontSize: '13px', display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                                        <div style={{ minWidth: '50px', fontWeight: 'bold', color: '#374151' }}>{percentage}%</div>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' }}>
                                          {path.map((hop, hopIdx) => (
                                            <div key={hopIdx} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                              <span style={{ color: '#4b5563' }}>{formatAddress(hop.tokenIn)}</span>
                                              <span style={{ fontSize: '10px', color: '#9ca3af', backgroundColor: '#f3f4f6', padding: '2px 6px', borderRadius: '4px' }}>
                                                {hop.exchange || hop.poolType}
                                              </span>
                                              {hopIdx === path.length - 1 && (
                                                <span style={{ color: '#4b5563' }}>➔ {formatAddress(hop.tokenOut)}</span>
                                              )}
                                              {hopIdx < path.length - 1 && (
                                                <span style={{ color: '#9ca3af' }}>➔</span>
                                              )}
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </>
                              )}

                              {['openocean', 'paraswap', 'cowswap'].includes(route.routeDetails.type) && (
                                <div style={{ fontSize: '13px', color: '#4b5563' }}>
                                  100% ➔ <span style={{ backgroundColor: '#f3f4f6', padding: '2px 6px', borderRadius: '4px', fontSize: '11px' }}>{route.routeDetails.info}</span>
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Swap Execution Area */}
                        {txData ? (
                          <ConfirmSwapModal
                            quote={route}
                            txPayload={txData}
                            fromAsset={fromAsset}
                            toAsset={toAsset}
                            amountIn={amountStr}
                            slippage={slippage}
                            onClose={() => clearTx(route.aggregator)}
                            isRefreshing={isRefreshingActive}
                            lastRefreshedAt={activeQuoteRefreshedAt}
                            onRefresh={refreshActiveQuote}
                          />
                        ) : (
                          <button
                            onClick={() => buildTx(route.aggregator)}
                            disabled={isLoadingTx || !canExecute || isInsufficientBalance}
                            style={{
                              width: '100%',
                              padding: '10px',
                              backgroundColor: (canExecute && !isInsufficientBalance) ? '#3b82f6' : '#9ca3af',
                              color: '#fff',
                              border: 'none',
                              borderRadius: '4px',
                              fontWeight: 'bold',
                              cursor: (canExecute && !isInsufficientBalance) ? 'pointer' : 'not-allowed',
                              opacity: isLoadingTx ? 0.7 : 1
                            }}
                          >
                            {!canExecute
                              ? 'Execution Not Supported'
                              : isInsufficientBalance
                                ? `Insufficient ${fromAsset.symbol} Balance`
                                : isLoadingTx
                                  ? 'Building Transaction...'
                                  : `Approve & Swap (Slippage: ${slippage}%)`}
                          </button>
                        )}

                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
