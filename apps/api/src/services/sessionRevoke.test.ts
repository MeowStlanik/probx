/**
 * Integration-style unit test: revoked session must fail financial paths.
 * Run: pnpm --filter @probx/api exec tsx src/services/sessionRevoke.test.ts
 */
import assert from "node:assert/strict";
import {
  issueSignedSession,
  isSessionRevoked,
  revokeSignedSession,
  verifySignedSession
} from "./signedSession.js";

// Local/dev: allow revoke without KV
(process.env as { NODE_ENV?: string }).NODE_ENV = "development";
delete process.env.VERCEL;

async function main() {
  const token = issueSignedSession({
    email: "revoke-test@example.com",
    address: "0x4604a582B66431481D5320fed67C785bdb4D7Fe0",
    walletId: "test-wallet-id",
    provider: "circle",
    ttlSec: 3600
  });

  assert.ok(verifySignedSession(token), "token should verify before revoke");
  assert.equal(await isSessionRevoked(token), false, "not revoked yet");

  // requireDurableKv is skipped when not shared runtime
  await revokeSignedSession(token);

  assert.equal(await isSessionRevoked(token), true, "token should be revoked");
  // HMAC still valid but revoke list blocks
  assert.ok(verifySignedSession(token), "HMAC still structurally valid");
  assert.equal(await isSessionRevoked(token), true, "async path still revoked");

  // Invalid token cannot fill revoke store
  await assert.rejects(
    () => revokeSignedSession("not-a-real-token"),
    /Invalid session/
  );

  console.log("sessionRevoke tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
