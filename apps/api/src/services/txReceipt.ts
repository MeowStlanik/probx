/**
 * waitForTransactionReceipt returns even when the tx reverted.
 * Always use this for server-side write success paths.
 */
import type { PublicClient, TransactionReceipt } from "viem";

export class TransactionRevertedError extends Error {
  readonly hash: `0x${string}`;
  constructor(hash: `0x${string}`) {
    super(`Transaction reverted: ${hash}`);
    this.name = "TransactionRevertedError";
    this.hash = hash;
  }
}

export function isTransactionRevertedError(e: unknown): e is TransactionRevertedError {
  return e instanceof TransactionRevertedError || (
    e instanceof Error && e.message.startsWith("Transaction reverted:")
  );
}

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
    throw new TransactionRevertedError(hash);
  }
  return receipt;
}
