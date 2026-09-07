# DeFi Dashboard

A comprehensive decentralized finance (DeFi) dashboard built with React and Vite. This application allows users to connect their Web3 wallets, track their Aave V3 lending and borrowing portfolio (including real-time historical interest calculations), and discover the best token swap quotes across multiple DEX aggregators.

## Features

- **Web3 Wallet Connection:** Seamless wallet integration using Wagmi and viem.
- **Aave V3 Portfolio Tracker:** 
  - View supplied and borrowed assets in real-time.
  - See detailed metrics including balances, USD values, current APYs, and Liquidation Prices.
  - **Advanced Interest Tracking:** Calculates exact historical interest earned on deposits and interest paid on borrows using Aave's GraphQL API and reserve indexes.
- **DEX Discovery:**
  - Instantly fetch and compare swap quotes for ERC-20 tokens.
  - Integrates with top DEX aggregators: CowSwap, 1inch, KyberSwap, ParaSwap, and 0x API.
  - Automatically factors in slippage and calculates the best execution route.

## Tech Stack

- **Frontend Framework:** React 18, Vite
- **Language:** TypeScript
- **Web3 / Ethereum:** Wagmi, viem
- **Data Fetching:** Apollo Client (GraphQL for Aave Subgraph)
- **Styling:** Custom CSS (Vanilla)

## Getting Started

### Prerequisites

- Node.js (v18 or higher recommended)
- npm or pnpm or yarn

### Installation

1. Clone the repository and navigate into the project directory.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file in the root directory if you need to configure any API keys (e.g., 1inch API key, WalletConnect Project ID).

### Environment Variables

- `VITE_DELEVERAGER_ADDRESS_<chainId>` — **no longer read by the frontend.** The one-click close used to run against a separate `AaveV3Deleverager`; it now runs against `AaveV3Strategies`, which carries `closePositionWithPermit` alongside the open entry points. `contract/src/AaveV3Deleverager.sol` is retained and its Ethereum deployment stays live, but nothing in `src/` references it — one address per chain now drives both open and close. These variables can be dropped from `.env`.

- `VITE_STRATEGIES_ADDRESS_<chainId>` — deployed `AaveV3Strategies` address, one per chain, and read only for the chains that have one: `_1` (Ethereum), `_8453` (Base), `_42161` (Arbitrum). Because the contract is deployed through CreateX/CREATE3 from a single salt, the address is the SAME on every chain — so these all take one value. While a chain's is unset the leverage panel still renders (that is how the feature is found) but says the contract is not deployed there, and Open stays disabled. Vite reads `.env` once at startup: restart the dev server after setting it.

- `VITE_DEFILLAMA_API_KEY` — optional but recommended. Powers the Odos aggregator, which is routed through DefiLlama's swap API (`dexAggregatorQuote?protocol=Odos`) so **no separate Odos key is needed**. Without it the endpoint is rate-limited. Public frontend value.

### Supported networks

Aave V3 position viewing works on: Ethereum, Arbitrum, Optimism, Polygon, Base, Avalanche, BNB Chain (plus Sepolia testnet). The one-click cross-asset close additionally requires a deployed deleverager address for that chain (see above) and a KyberSwap/OpenOcean route.

### Running Locally

To start the development server:
```bash
npm run dev
```
Open your browser and visit `http://localhost:5173`.

### Building for Production

To create an optimized production build:
```bash
npm run build
```
The application chunks are optimized using Rollup manual chunks to ensure high performance and fast loading speeds. 

## Project Structure

- `src/components/`: Contains React components (`WalletConnect`, `AavePosition`, `DexDiscovery`, etc.)
- `src/adapters/`: Contains integration logic for various DEX aggregators.
- `src/hooks/`: Contains custom React hooks (e.g., `useAaveHistoricalInterest` for Aave GraphQL queries).
- `src/config/`: Configuration files (e.g., Wagmi setup).
