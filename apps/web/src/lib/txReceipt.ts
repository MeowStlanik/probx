/**
 * waitForTransactionReceipt returns even when the tx reverted.
 * Always use this helper for user-facing success paths.
 */
import type { PublicClient, TransactionReceipt } from "viem";

export async function waitSuccessfulReceipt(
  publicClient: Pick<PublicClient, "waitForTransactionReceipt">,
  hash: `0x${string}`,
  opts?: { timeout?: number }
): Promise<TransactionReceipt> {
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: opts?.timeout
  });
  if (receipt.status !== "success") {
    throw new Error(`Transaction reverted: ${hash}`);
  }
  return receipt;
}
