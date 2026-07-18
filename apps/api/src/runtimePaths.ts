import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// apps/api/src -> ../../.. = monorepo root
const monorepoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Writable runtime dir: /tmp on Vercel, .runtime locally. */
export function getRuntimeDir(): string {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const dir = join("/tmp", "probx-runtime");
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dir = join(monorepoRoot, ".runtime");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function runtimeFile(name: string): string {
  return join(getRuntimeDir(), name);
}

export function getMonorepoRoot(): string {
  return monorepoRoot;
}
