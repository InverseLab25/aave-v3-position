# DeFi Dashboard

A comprehensive decentralized finance (DeFi) dashboard built with React and Vite. This application allows users to connect their Web3 wallets, track their Aave V3 lending and borrowing portfolio (including real-time historical interest calculations), and swap through the route solver, which quotes every aggregator server-side.

## Features

- **Web3 Wallet Connection:** Seamless wallet integration using Wagmi and viem.
- **Aave V3 Portfolio Tracker:** 
  - View supplied and borrowed assets in real-time.
  - See detailed metrics including balances, USD values, current APYs, and Liquidation Prices.
  - **Advanced Interest Tracking:** Calculates exact historical interest earned on deposits and interest paid on borrows using Aave's GraphQL API and reserve indexes.
- **DEX Discovery:**
  - Instantly fetch and compare swap quotes for ERC-20 tokens.
  - Every route comes from the solver (`~/project/defi-solver`): quoted across 0x, Socket and Nordstern, simulated from your wallet, ranked by measured output.
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

- `VITE_SOLVER_URL` — the route solver (`~/project/defi-solver`), e.g. `http://localhost:8787`. Required: every quote in the app goes through it, over its `/ws` websocket. The server holds the Socket and 0x keys, quotes every provider and simulates each route from the Strategies contract. There is deliberately no browser fallback — with the solver down or this unset, the panel says the aggregator is unavailable and Open/Close stay disabled. Base and Arbitrum only. The server's `CORS_ORIGIN` must name this site's origin. The flip and the swap screen pass their own `caller` (the Flipper, or the wallet) and the server simulates from there.

- `VITE_TURNSTILE_SITE_KEY` — Cloudflare Turnstile site key, required alongside `VITE_SOLVER_URL`. The solver verifies one Turnstile pass per session (`POST /session`), then the token is held in memory for the hour. Locally, Cloudflare's always-pass pair works: site key `1x00000000000000000000AA` here, secret `1x0000000000000000000000000000000AA` in the solver's `TURNSTILE_SECRET`. Configure the widget as invisible in the Cloudflare dashboard; managed mode would draw a checkbox at the bottom of the page.

### Supported networks

Aave V3 position viewing works on: Ethereum, Arbitrum, Optimism, Polygon, Base, Avalanche, BNB Chain (plus Sepolia testnet). The one-click cross-asset close additionally requires a deployed deleverager address for that chain (see above) and a solver route.

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
- `src/adapters/`: The solver adapter, the app's only quote source.
- `src/hooks/`: Contains custom React hooks (e.g., `useAaveHistoricalInterest` for Aave GraphQL queries).
- `src/config/`: Configuration files (e.g., Wagmi setup).
