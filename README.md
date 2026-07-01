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
