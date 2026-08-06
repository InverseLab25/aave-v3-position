import { describe, expect, it } from "vitest";
import { getAbiItem } from "viem";
import { aaveV3LeverageAbi, FULL_CLOSE, PAUSE_CLOSE, PAUSE_OPEN } from "./abi";

describe("aaveV3LeverageAbi", () => {
  it("exposes openPosition and closePosition with the deployed shapes", () => {
    const open = getAbiItem({ abi: aaveV3LeverageAbi, name: "openPosition" });
    const close = getAbiItem({ abi: aaveV3LeverageAbi, name: "closePosition" });
    expect(open && "inputs" in open && open.inputs).toHaveLength(10);
    expect(close && "inputs" in close && close.inputs).toHaveLength(9);
  });

  it("sentinels match the contract", () => {
    expect(FULL_CLOSE).toBe(2n ** 256n - 1n);
    expect(PAUSE_OPEN | PAUSE_CLOSE).toBe(3n);
  });
});
