#!/usr/bin/env bash
#
# A local Base fork to exercise the leverage flows without spending anything.
#
# Forks Base mainnet, so every address the app already knows resolves unchanged: Aave's pool, the
# routers, and AaveV3Strategies at 0x75B1AB12… (verified deployed, 22kB of code). Anvil inherits
# the fork's chain id, so the app stays on 8453 and `getChainConfig(8453)` needs no special case.
#
# Usage:
#   scripts/fork-base.sh start                 # run the fork (leave it running)
#   scripts/fork-base.sh fund <address>        # give that address ETH, WETH and USDC
#   scripts/fork-base.sh setup                 # print what to change in .env and MetaMask
#
# Requires foundry (anvil, cast) on PATH.
set -euo pipefail

RPC_UPSTREAM="${BASE_RPC_URL:-https://mainnet.base.org}"
LOCAL_RPC="http://127.0.0.1:8545"

# Aave V3 on Base. The data provider is discovered from the addresses provider rather than pinned,
# because Aave redeploys peripheral contracts and a stale constant fails as a confusing revert.
ADDRESSES_PROVIDER=0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D
WETH=0x4200000000000000000000000000000000000006
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

die() { echo "error: $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found — install foundry (foundryup)"; }

case "${1:-}" in

start)
  need anvil
  echo "forking Base from $RPC_UPSTREAM"
  # No --block-time: mine on demand, so a transaction confirms the moment it is sent and the UI
  # never sits on a pending state that a real chain would have cleared.
  #
  # --auto-impersonate so `fund` can move tokens out of Aave's aTokens without a separate
  # impersonation call per transfer.
  exec anvil \
    --fork-url "$RPC_UPSTREAM" \
    ${FORK_BLOCK:+--fork-block-number "$FORK_BLOCK"} \
    --auto-impersonate \
    --host 127.0.0.1 \
    --port 8545
  ;;

fund)
  need cast
  TARGET="${2:-}"
  [ -n "$TARGET" ] || die "usage: $0 fund <address>"

  cast chain-id --rpc-url "$LOCAL_RPC" >/dev/null 2>&1 || die "no fork on $LOCAL_RPC — run '$0 start' first"

  echo "→ 100 ETH"
  cast rpc anvil_setBalance "$TARGET" 0x56BC75E2D63100000 --rpc-url "$LOCAL_RPC" >/dev/null

  # Aave's aToken custodies the underlying, which makes it the largest reliable holder of every
  # listed asset on the fork. Verified live: aUSDC held 19.1M USDC, aWETH held 17,169 WETH.
  DP=$(cast call "$ADDRESSES_PROVIDER" "getPoolDataProvider()(address)" --rpc-url "$LOCAL_RPC")

  fund_token() {
    local token="$1" amount="$2" label="$3"
    local holder
    holder=$(cast call "$DP" "getReserveTokensAddresses(address)(address,address,address)" \
      "$token" --rpc-url "$LOCAL_RPC" | head -1)
    # The impersonated account pays its own gas, so it needs a balance of its own.
    cast rpc anvil_setBalance "$holder" 0x56BC75E2D63100000 --rpc-url "$LOCAL_RPC" >/dev/null
    cast send "$token" "transfer(address,uint256)" "$TARGET" "$amount" \
      --from "$holder" --unlocked --rpc-url "$LOCAL_RPC" >/dev/null
    echo "→ $label (from aToken $holder)"
  }

  fund_token "$WETH" 50000000000000000000 "50 WETH"
  fund_token "$USDC" 200000000000 "200,000 USDC"

  echo
  echo "balances for $TARGET:"
  echo "  ETH   $(cast balance "$TARGET" --rpc-url "$LOCAL_RPC" --ether)"
  echo "  WETH  $(cast call "$WETH" 'balanceOf(address)(uint256)' "$TARGET" --rpc-url "$LOCAL_RPC" | head -1)"
  echo "  USDC  $(cast call "$USDC" 'balanceOf(address)(uint256)' "$TARGET" --rpc-url "$LOCAL_RPC" | head -1)"
  ;;

setup)
  cat <<'EOF'
1. Point the app's Base RPC at the fork, in .env:

     VITE_RPC_URL_8453=http://127.0.0.1:8545

   wagmi.ts already reads that per-chain override, so nothing else changes — and every OTHER
   chain keeps its real RPC, so you can compare against live Base by switching networks.
   Restart `pnpm dev` afterwards: Vite inlines env at build time, not per request.

2. Point MetaMask's Base network at the fork.

   Settings -> Networks -> Base -> add http://127.0.0.1:8545 as an RPC endpoint and select it.
   Keep the chain id at 8453. Do NOT add a second network with the same id.

3. After every anvil restart, clear MetaMask's nonce cache:

     Settings -> Advanced -> Clear activity tab data

   The fork resets to its start block, so MetaMask's remembered nonce runs ahead of the chain and
   every send fails with "nonce too high" until this is cleared. This is the single most common
   way a fork session looks broken when it is not.
EOF
  ;;

*)
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
  ;;
esac
