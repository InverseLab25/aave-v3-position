// Trimmed to the members this app actually references, plus all errors (needed to decode
// reverts into names). Regenerate with scripts/trim-abis.cjs if a new call is added — a
// missing entry surfaces as a viem "function not found on ABI" error at the call site.
//
// Kept as a TS literal with `as const`: TypeScript cannot apply a const assertion to a JSON
// import (microsoft/TypeScript#33398), so it widens the types and viem loses the literal ABI
// it needs to infer argument and return types.

export const wethGatewayAbi = [
  {
    "inputs": [],
    "name": "WETH",
    "outputs": [
      {
        "internalType": "contract IWETH",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "uint16",
        "name": "referralCode",
        "type": "uint16"
      }
    ],
    "name": "borrowETH",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "onBehalfOf",
        "type": "address"
      },
      {
        "internalType": "uint16",
        "name": "referralCode",
        "type": "uint16"
      }
    ],
    "name": "depositETH",
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "owner",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "onBehalfOf",
        "type": "address"
      }
    ],
    "name": "repayETH",
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      }
    ],
    "name": "withdrawETH",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const
