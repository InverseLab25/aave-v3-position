/**
 * Throwaway: ask Socket for a swap route and measure what it actually returns.
 *
 *   SOCKET_AFFILIATE=<id> node scripts/socket-sim.mjs [chainId] [tokenIn] [tokenOut] [amount] [from]
 *
 * Socket's `output.amount` is a quote — on a simulated route it is Socket's own simulation,
 * on the rest it is the underlying aggregator's arithmetic. Nordstern's /simulate runs the
 * built calldata against live chain state with balance and allowance overridden, so its
 * `amountOut` is a measured balance delta: router fees, token taxes and all.
 *
 * `amount` is in whole tokens (1000 USDC, not 1000000000). Defaults are Base USDC -> WETH.
 */
const [chainId = '8453',
       tokenIn = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
       tokenOut = '0x4200000000000000000000000000000000000006',
       amount = '1000',
       // Any address works: the simulator overrides its balance and allowance. Socket bakes it
       // into the calldata though, so the quote and the simulation must name the same one.
       from = '0x253FaC550bae1EE9B4680b3735DC38a3f6eCd600'] = process.argv.slice(2)

// Node reads no dotenv file on its own, so without this the keys have to be typed on every
// invocation and a missing one looks like an unkeyed run rather than a mistake. Ignored when
// the file is absent, which is the normal case in CI.
try { process.loadEnvFile() } catch { /* nothing to load */ }

const AFFILIATE = process.env.SOCKET_AFFILIATE
// The dedicated host wants `x-api-key` alongside `affiliate`, and answers an unkeyed request
// with {"message":"Forbidden"}. Its address is dedicated-backend.socket.tech — plain
// backend.socket.tech is not a Socket endpoint and serves someone else's HTML.
const API_KEY = process.env.SOCKET_API_KEY
const DEDICATED = 'https://dedicated-backend.socket.tech'
const SOCKET = process.env.SOCKET_BASE ?? (API_KEY ? DEDICATED : 'https://public-backend.socket.tech')
const SLIPPAGE = process.env.SLIPPAGE ?? '0.1'
// Your own fee, and only on the dedicated host — the public API rejects these outright with
// "Fee params (feeBps / feeTakerAddress) are not allowed on the public API", while quietly
// taking 20bps of its own to Socket's address. Both must be set together or neither.
const FEE_BPS = process.env.SOCKET_FEE_BPS
const FEE_TAKER = process.env.SOCKET_FEE_TAKER
/**
 * Whoever sends the transaction: quoted for, and simulated as, the same address.
 *
 * To measure a route one of our contracts will run, pass the contract as `from` — Socket signs
 * the calldata for `userAddress` and its AllowanceHolder reverts with `CallerNotSignedUser` for
 * anyone else, so the quote and the simulation must name one address and the same one.
 *
 * There is no separate contractCaller knob here any more, and its absence is the point. The
 * parameter is a no-op — Socket returns byte-identical calldata with and without it, quoteId
 * aside — so a knob that set it while leaving `userAddress` on the wallet quoted for the wallet
 * and simulated as the contract, and produced a CallerNotSignedUser that looked like Socket
 * refusing contracts when it was only this script asking the wrong question.
 */
const SENDER = from
// Nordstern defaults to half the block limit, under which a big route comes back as a bare
// "Call failed" that reads exactly like a revert and is not one.
const SIM_GAS = '60000000'
/**
 * Per-transaction gas cap, where the chain has one. Base's is 2^24; a route quoting more than
 * that cannot execute, so simulating it only spends a slot in the simulator's queue.
 *
 * Only Base is listed because Base is the only one I have checked. A chain absent here is
 * treated as uncapped rather than guessed at — a wrong cap would silently drop good routes.
 */
const GAS_CAP = { 8453: 16_777_216 }[chainId] ?? Infinity
/**
 * How many routes get simulated, best-quoted first.
 *
 * Nordstern's simulator answers one request at a time, so every extra route is another whole
 * second of wall clock. The quotes here land within half a percent of each other and the
 * measured drift from quote to reality is usually under 0.05%, so the top quote wins almost
 * every time — the tail is a second each spent confirming a loser. Raise it when you actually
 * distrust the ranking, not by default.
 */
const TOP_N = Number(process.env.TOP_N ?? 3)
/**
 * Whether Socket simulates each route before answering.
 *
 * Off by default, because this script measures every route itself and Socket's simulation is
 * work thrown away. Measured on the same query: `true` answered in 2.30s cold and ~0.50s on a
 * repeat, `false` in 0.39s — and `false` returned six routes against five, picking up OpenOcean
 * that the simulated path had dropped. Turn it on to see which routes Socket itself rejects.
 */
const SIMULATED = process.env.SOCKET_SIMULATED === 'true'
// Nordstern attributes API traffic by Referer, and nothing sets one off-browser.
const NORDSTERN_HEADERS = { Referer: 'https://defiroute.siddhnathbrass.in' }
/**
 * A public RPC per chain, used only to read `decimals()`.
 *
 * This replaces a throwaway 1-unit Socket quote that existed purely to learn the input token's
 * decimals from the response. That quote measured 1427ms, a quarter of the whole run, to
 * discover that USDC has six. An `eth_call` is one small round trip and, unlike the quote, it
 * does not block the real quotes behind it.
 */
const RPCS = {
  1: 'https://ethereum-rpc.publicnode.com',
  10: 'https://optimism-rpc.publicnode.com',
  137: 'https://polygon-bor-rpc.publicnode.com',
  8453: 'https://base-rpc.publicnode.com',
  42161: 'https://arbitrum-one-rpc.publicnode.com',
}
const RPC = process.env.RPC_URL ?? RPCS[chainId]
/**
 * Where `eth_simulateV1` runs. Point it at Alchemy or QuickNode; publicnode works but queues.
 *
 * The comparison this enables is the whole reason the script has two simulators. Nordstern's
 * /simulate answers one request at a time — six fired together came back at 922, 2327, 3177,
 * 4144, 4801 and 5545ms, a queue in single file — so on their service more routes always costs
 * more wall clock. Whether a paid RPC does better is the thing to measure, not assume.
 */
const SIM_RPC = process.env.SIM_RPC ?? RPC

console.log(`${SOCKET}  key:${API_KEY ? 'yes' : 'no'}  affiliate:${AFFILIATE ? AFFILIATE.slice(0, 8) + '…' : 'none'}` +
  (FEE_BPS && FEE_TAKER ? `  own fee:${FEE_BPS}bps -> ${FEE_TAKER}` : '') +
  '')

/**
 * The revert reasons this comparison actually produces, by selector.
 *
 * `CallerNotSignedUser` is the interesting one: it means the route was signed for a different
 * caller than the one executing it — in practice, a quote taken for one address and simulated
 * from another.
 */
const SELECTORS = {
  '0x85132e0f': 'CallerNotSignedUser()',
  '0xbb2875c3': 'InsufficientOutput()',
  '0x8199f5f3': 'SlippageExceeded()',
  '0x8727a7f9': 'QuoteExpired()',
}
const reason = (r = '') => {
  const hit = Object.keys(SELECTORS).find((sel) => r.includes(sel))
  return hit ? `${SELECTORS[hit]} (${hit})` : r || 'no reason'
}

/**
 * What the transaction really costs, from the simulator's execution gas.
 *
 * `gasUsed` is the call alone. A transaction also pays the 21,000 intrinsic and for every byte
 * of calldata — 4 for a zero byte, 16 otherwise — and that last part is not small here:
 * KyberSwap routes carry tens of kilobytes, which is hundreds of thousands of gas before the
 * first opcode runs. Judging a route against the cap on `gasUsed` alone lets one through that
 * cannot be mined.
 */
const txGas = (gasUsed, data) => {
  let calldata = 0
  for (let i = 2; i < data.length; i += 2) calldata += data.slice(i, i + 2) === '00' ? 4 : 16
  return 21_000 + calldata + gasUsed
}

const fmt = (v, dec, places = 6) => (Number(v) / 10 ** dec).toFixed(places)

const { keccak256, encodeAbiParameters } = await import('viem')
const rpc = (url, method, params) =>
  fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((r) => r.json())

/** Storage key for `mapping(address => T)` at `slot`, and for one nested a level deeper. */
const slot1 = (k, n) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [k, BigInt(n)]))
const slot2 = (a, b, n) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [b, slot1(a, n)]))
const HUGE = '0x' + (10n ** 30n).toString(16).padStart(64, '0')
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const pad32 = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0')

/**
 * Token storage layouts we have already established, so the probe never runs for them.
 *
 * A deployed token's layout cannot change — the slots are fixed by the contract's source, and
 * an upgradeable proxy has to preserve them or its own storage breaks — so this is a cache with
 * no invalidation problem. The probe below costs around 6.7 seconds against a public RPC, which
 * was half the run before this table existed.
 *
 * Every entry here was produced by that probe and agreed with the token. Add to it by running
 * once with a new pair and copying what it prints.
 */
const KNOWN_SLOTS = {
  // Base USDC (FiatTokenV2). Verified by probe.
  '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { bal: 9, allow: 10 },
  // Base WETH (WETH9: name, symbol, decimals, balanceOf, allowance). Verified by probe.
  '8453:0x4200000000000000000000000000000000000006': { bal: 3, allow: 4 },
}

/**
 * Which storage slots hold the input token's balances and allowances, found rather than known.
 *
 * This is the real cost of simulating yourself, and the thing Nordstern's /simulate does for
 * free. Every token picks its own layout, so the only portable answer is to write a value into
 * a candidate slot and ask the token whether it agrees. All candidates go at once, because
 * sixteen probes in series against a public RPC is slower than the simulation they enable.
 *
 * Standard Solidity mappings only. A Vyper token or an unusual proxy will find nothing, and
 * that is reported rather than guessed around — a wrong slot means the swap reverts on an
 * empty balance, which reads as a bad route when it is a bad override.
 */
async function findSlots(token, owner, spender) {
  const known = KNOWN_SLOTS[`${chainId}:${token.toLowerCase()}`]
  if (known) return known
  const balanceOf = '0x70a08231' + owner.slice(2).toLowerCase().padStart(64, '0')
  const allowance = '0xdd62ed3e' + owner.slice(2).toLowerCase().padStart(64, '0') + spender.slice(2).toLowerCase().padStart(64, '0')
  const probe = async (n, key, data) => {
    const j = await rpc(SIM_RPC, 'eth_call', [{ to: token, data }, 'latest', { [token]: { stateDiff: { [key]: HUGE } } }])
    return j.result && BigInt(j.result) === BigInt(HUGE) ? n : -1
  }
  const range = [...Array(20).keys()]
  const bal = (await Promise.all(range.map((n) => probe(n, slot1(owner, n), balanceOf)))).find((n) => n >= 0)
  if (bal === undefined) return null
  const allow = (await Promise.all(range.map((n) => probe(n, slot2(owner, spender, n), allowance)))).find((n) => n >= 0)
  return allow === undefined ? null : { bal, allow }
}

/**
 * The same measurement as Nordstern's /simulate, run on an RPC we control.
 *
 * Output is read off the destination token's Transfer logs rather than any balance field, so
 * router fees and token taxes are inside it exactly as they are in Nordstern's figure — the
 * two numbers are comparable, which is the point.
 */
async function simulateOnRpc(tx, spender, slots) {
  const j = await rpc(SIM_RPC, 'eth_simulateV1', [{
    blockStateCalls: [{
      stateOverrides: {
        [tokenIn]: { stateDiff: { [slot1(SENDER, slots.bal)]: HUGE, [slot2(SENDER, spender, slots.allow)]: HUGE } },
        [SENDER]: { balance: '0x56BC75E2D63100000' },
      },
      calls: [{ from: SENDER, to: tx.to, data: tx.data, gas: '0x' + Number(SIM_GAS).toString(16) }],
    }],
    // Off for the same reason as src/adapters/simulate.ts: the output is measured off
    // `log.address === tokenOut`, and a traced native transfer carries the zero address.
    traceTransfers: false, validation: false,
  }, 'latest'])
  if (j.error) return { error: j.error.message?.slice(0, 80) }
  const call = j.result?.[0]?.calls?.[0]
  if (!call) return { error: 'no call result' }
  if (call.status !== '0x1') return { reverted: true, error: reason(call.error?.data ?? call.error?.message ?? '') }
  const out = (call.logs ?? [])
    .filter((l) => l.address.toLowerCase() === tokenOut.toLowerCase() && l.topics[0] === TRANSFER && l.topics[2] === pad32(SENDER))
    .reduce((sum, l) => sum + BigInt(l.data), 0n)
  return { amountOut: out, gasUsed: parseInt(call.gasUsed, 16) }
}

/**
 * Every network call, timed.
 *
 * The point of the breakdown at the end is that almost none of the wall clock is ours. Each
 * entry is one HTTP round trip including the remote service thinking, so a slow line names a
 * service to complain about rather than code to optimise. The first call to a host also pays
 * DNS, TCP and TLS — measured at roughly 220ms cold against these Cloudflare-fronted APIs —
 * which is why the same endpoint looks faster the second time within one run.
 */
const marks = []
const timed = async (label, fn) => {
  const at = Date.now()
  try {
    return await fn()
  } finally {
    marks.push({ label, ms: Date.now() - at })
  }
}
const START = Date.now()

const ask = async (inputAmount) => (await timed(`socket quote (${inputAmount})`, () => fetch(`${SOCKET}/v3/swap/quote?` + new URLSearchParams({
  userOps: 'tx', quoteType: 'EXACT_INPUT',
  originChainId: chainId, destinationChainId: chainId,
  inputToken: tokenIn, outputToken: tokenOut, inputAmount,
  userAddress: from, receiverAddress: from,
  slippage: SLIPPAGE, simulatedQuotesRequired: String(SIMULATED),
  ...(FEE_BPS && FEE_TAKER ? { feeBps: FEE_BPS, feeTakerAddress: FEE_TAKER } : {}),
}), { headers: {
  ...(AFFILIATE ? { affiliate: AFFILIATE } : {}),
  ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
} }))).json().catch(() => ({ message: 'response was not JSON' }))

/** `decimals()`. One eth_call, both tokens in flight together. */
const decimalsOf = (token) => timed(`decimals ${token.slice(0, 8)}`, () =>
  fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: token, data: '0x313ce567' }, 'latest'] }),
  }).then((r) => r.json()).then((j) => Number(BigInt(j.result))))

const [inDec, outDecRpc] = await Promise.all([decimalsOf(tokenIn), decimalsOf(tokenOut)])
if (!Number.isFinite(inDec)) { console.error(`could not read decimals from ${RPC}`); process.exit(1) }

const inputAmount = BigInt(Math.round(Number(amount) * 10 ** inDec)).toString()

// Socket and Nordstern know nothing about each other, so asking them one after the other spends
// the slower one's time twice. Measured serial: 2518ms + 686ms. Together it is just the 2518.
const [res, ns] = await Promise.all([
  ask(inputAmount),
  timed('nordstern quote', () =>
    fetch(`https://api.nordstern.finance/aggregator/${chainId}` +
      `?src=${tokenIn}&dst=${tokenOut}&amount=${inputAmount}&from=${SENDER}&slippage=${SLIPPAGE}`,
      { headers: NORDSTERN_HEADERS }).then((r) => r.json())).catch(() => null),
])

const socketRoutes = res.result?.routes ?? []
if (!socketRoutes.length) { console.error('socket: no routes —', JSON.stringify(res).slice(0, 400)); process.exit(1) }

/** Every route flattened to the four things the loop below needs, whoever quoted it. */
const rows = socketRoutes.map((r) => {
  const fee = r.routeDetails?.feeDetails
  return {
    label: r.routeDetails?.dexDetails?.protocol?.displayName ?? 'unknown',
    quoted: BigInt(r.output.amount),
    tx: r.txData?.kind === 'evm_tx' ? r.txData.object : null,
    gas: Number(r.gasFee?.gasLimit ?? 0),
    // Socket's docs say a route past `expiresAt` fails on chain, so simulating one measures
    // nothing. Seconds, not milliseconds.
    expired: r.expiresAt !== undefined && r.expiresAt * 1000 <= Date.now(),
    // Socket wraps the router call inside the AllowanceHolder, which is also the call target.
    spender: r.approval?.spenderAddress ?? r.txData?.object?.to,
    note: fee?.feeAmount && fee.feeAmount !== '0'
      // Whose fee it is matters as much as its size: unattributed, the taker is Socket's own
      // address rather than yours.
      ? `fee ${fee.feeBps}bps = ${fmt(fee.feeAmount, fee.feeToken.decimals)} ${fee.feeToken.symbol} -> ${fee.feeTakerAddress?.slice(0, 10)}`
      : '',
  }
})

/**
 * Nordstern quotes and builds in one GET, and takes no fee off the input — so its row is
 * the honest floor to judge Socket's 20bps against, not just another aggregator.
 */
if (ns?.toAmount && ns.tx?.data) {
  rows.push({
    label: 'Nordstern',
    quoted: BigInt(ns.toAmount),
    tx: ns.tx,
    gas: Number(ns.gasEstimate ?? 0),
    // The Guard is both call target and approval target: it pulls with transferFrom(msg.sender).
    spender: ns.tx.to,
    note: 'direct, no socket fee',
  })
} else {
  console.warn('nordstern: no route\n')
}

const outDec = socketRoutes[0].output.token.decimals ?? outDecRpc
/**
 * KyberSwap last, whatever it quotes.
 *
 * It is the only aggregator here shipping tens of kilobytes of calldata, and on this pair it
 * has already measured over Base's cap while quoting comfortably under it. Ranking it on
 * output alone puts a route at the top that may not be mineable, so it sorts to the bottom and
 * wins only when nothing else is left.
 */
const isKyber = (r) => /kyber/i.test(r.label)
rows.sort((a, b) => (isKyber(a) !== isKyber(b) ? (isKyber(a) ? 1 : -1) : a.quoted < b.quoted ? 1 : -1))
console.log(`${amount} ${res.result.input.token.symbol} -> ${socketRoutes[0].output.token.symbol} on chain ${chainId}, ` +
  `${rows.length} route(s), simulating top ${TOP_N}\n`)

// One probe for the whole run: the slots belong to the input token, not to a route.
const known = Boolean(KNOWN_SLOTS[`${chainId}:${tokenIn.toLowerCase()}`])
const slots = await timed(known ? 'known token slots' : 'probe token slots', () =>
  findSlots(tokenIn, SENDER, rows[0]?.spender ?? SENDER))
if (!slots) console.warn(`could not find storage slots for ${tokenIn} — skipping the RPC simulation\n`)
else {
  console.log(`${tokenIn.slice(0, 8)} balances at slot ${slots.bal}, allowances at ${slots.allow}` +
    (known ? '' : `  <- add to KNOWN_SLOTS as '${chainId}:${tokenIn.toLowerCase()}': { bal: ${slots.bal}, allow: ${slots.allow} }`) + '\n')
}

let simulated = 0
for (const r of rows) {
  let line = `${r.label.padEnd(14)} quoted ${fmt(r.quoted, outDec)}`
  if (r.note) line += `  (${r.note})`
  // Counted on rows that reach the simulator, not on position in the list: a route skipped for
  // its gas or its calldata has cost nothing, so it must not use up one of the slots.
  if (simulated >= TOP_N) { console.log(`${line}  [outside the top ${TOP_N}, not simulated]`); continue }
  if (r.expired) { console.log(`${line}  [expired before it could be simulated]`); continue }
  // Both aggregators under-report gas — Kyber by roughly half in my samples — so a quote UNDER
  // the cap proves nothing. A quote over it is still conclusive, and that is all this skips on.
  if (r.gas > GAS_CAP) { console.log(`${line}  [quote wants ${r.gas} gas, over the ${GAS_CAP} cap]`); continue }
  // KyberSwap only. Every other route here is a kilobyte or two, so the same test on all of
  // them would be noise — Kyber's is the one whose calldata turns into hundreds of thousands
  // of gas and pushes an otherwise fine route past the cap. Skipped rather than measured: the
  // simulator answers one call at a time, and this one is a second spent on a loser.
  const KB = r.tx.data.length / 2048
  if (isKyber(r) && KB > 20) { console.log(`${line}  [${Math.round(KB)}KB calldata, not simulated]`); continue }
  if (!r.tx?.data) { console.log(`${line}  [no transaction to simulate]`); continue }

  simulated++
  const simAt = Date.now()
  const sim = await timed(`simulate ${r.label}`, () =>
    fetch(`https://api.nordstern.finance/simulate/${chainId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...NORDSTERN_HEADERS },
      body: JSON.stringify({
        from: SENDER, to: r.tx.to, spender: r.spender,
        data: r.tx.data, tokenIn, amountIn: inputAmount, tokenOut, gas: SIM_GAS,
      }),
    }).then(x => x.json())).catch(() => null)
  const simMs = Date.now() - simAt

  if (!sim || sim.amountOut === undefined) { console.log(`${line}  actual ?  [simulator gave nothing]`); continue }
  if (!sim.success) { console.log(`${line}  REVERTED: ${reason(sim.revertReason)}`); continue }

  const actual = BigInt(sim.amountOut)
  const drift = (Number(actual - r.quoted) / Number(r.quoted)) * 100
  // Quoted gas next to measured gas, because the gap between them is the point: a route can
  // quote comfortably under the cap and still need half again as much to run.
  const total = txGas(sim.gasUsed, r.tx.data)
  // The quote is kept alongside because the gap between the two is the finding: every
  // aggregator but 0x under-reports, and the cap has to be judged on the measured figure.
  const gas = `gas ${r.gas || '?'} quoted / ${total} real${total > GAS_CAP ? ` — OVER THE ${GAS_CAP} CAP` : ''}`
  console.log(`${line}  actual ${fmt(actual, outDec)}  (${drift >= 0 ? '+' : ''}${drift.toFixed(3)}%, ${gas}, sim ${simMs}ms)`)

  // The same route, measured again on our own RPC. Printed underneath rather than beside so the
  // two numbers line up: a gap between them is either price moving between the calls or one of
  // the simulators being wrong, and both are worth seeing.
  if (!slots) continue
  const ourAt = Date.now()
  const ours = await timed(`eth_simulateV1 ${r.label}`, () => simulateOnRpc(r.tx, r.spender, slots))
  const ourMs = Date.now() - ourAt
  if (ours.error) { console.log(`${' '.repeat(14)} eth_simulateV1: ${ours.reverted ? 'REVERTED ' : ''}${ours.error}  (${ourMs}ms)`); continue }
  const diff = (Number(ours.amountOut - actual) / Number(actual)) * 100
  console.log(`${' '.repeat(14)} eth_simulateV1 ${fmt(ours.amountOut, outDec)}  ` +
    `(${diff >= 0 ? '+' : ''}${diff.toFixed(3)}% vs nordstern, gas ${ours.gasUsed}, ${ourMs}ms)`)
}

/**
 * Where the wall clock went.
 *
 * The simulations run one after another on purpose: Nordstern's simulator answers a single
 * request at a time, so firing them together only moves the queue from this script into their
 * server. Measured six at once, they came back at 922, 2327, 3177, 4144, 4801 and 5545ms —
 * the same total as running them in series. That total is the number worth attacking, and it
 * is why simulating fewer routes beats making the client faster.
 */
const total = Date.now() - START
const sum = (pred) => marks.filter(pred).reduce((s, m) => s + m.ms, 0)
const simTotal = sum((m) => m.label.startsWith('simulate'))
const rpcTotal = sum((m) => m.label.startsWith('eth_simulateV1'))
const quoteTotal = sum((m) => !m.label.startsWith('simulate') && !m.label.startsWith('eth_simulateV1'))
console.log(`\n--- timing (${total}ms total)`)
for (const m of marks) console.log(`  ${m.label.padEnd(28)} ${String(m.ms).padStart(6)}ms`)
console.log(`  ${'quotes'.padEnd(28)} ${String(quoteTotal).padStart(6)}ms`)
console.log(`  ${'nordstern /simulate'.padEnd(28)} ${String(simTotal).padStart(6)}ms  ${(100 * simTotal / total).toFixed(0)}% of the run`)
if (rpcTotal) {
  console.log(`  ${'eth_simulateV1'.padEnd(28)} ${String(rpcTotal).padStart(6)}ms  ${(simTotal / rpcTotal).toFixed(1)}x faster than nordstern`)
}
