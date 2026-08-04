import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// apps/api/src -> ../../.. = monorepo root
const monorepoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Writable runtime dir. Set RUNTIME_DIR to a mounted volume path when desired. */
export function getRuntimeDir(): string {
  const configured = (process.env.RUNTIME_DIR || "").trim();
  const dir = configured ? resolve(configured) : join(monorepoRoot, ".runtime");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function runtimeFile(name: string): string {
  return join(getRuntimeDir(), name);
}

export function getMonorepoRoot(): string {
  return monorepoRoot;
}
