export const deleveragerAbi = [
  {
    type: 'function',
    name: 'closePositionWithPermit',
    inputs: [
      { internalType: 'address', name: 'collateral', type: 'address' },
      { internalType: 'address', name: 'debtAsset', type: 'address' },
      { internalType: 'uint256', name: 'collateralToWithdraw', type: 'uint256' },
      { internalType: 'uint256', name: 'minOut', type: 'uint256' },
      { internalType: 'address', name: 'router', type: 'address' },
      { internalType: 'bytes', name: 'swapData', type: 'bytes' },
      {
        internalType: 'struct AaveV3Deleverager.Permit',
        name: 'permit',
        type: 'tuple',
        components: [
          { internalType: 'uint256', name: 'value', type: 'uint256' },
          { internalType: 'uint256', name: 'deadline', type: 'uint256' },
          { internalType: 'uint8', name: 'v', type: 'uint8' },
          { internalType: 'bytes32', name: 'r', type: 'bytes32' },
          { internalType: 'bytes32', name: 's', type: 'bytes32' },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'paused',
    inputs: [],
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;
