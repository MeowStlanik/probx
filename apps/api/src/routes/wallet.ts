import {
  createOrResumeSession,
  getSessionPublic,
  logoutSession,
  walletModeInfo,
  writeContractForSession,
  transferUsdcForSession,
  type WriteContractBody
} from "../services/sessionWalletService.js";
import {
  getTx,
  isValidTxHash,
  listTxForOwner,
  publicTxView,
  recordTx,
  type TxKind
} from "../services/txTrackerService.js";
import { getAddress } from "viem";
import {
  cctpPublicConfig,
  fetchIrisMessage,
  quoteForwardingBurn,
  type CctpSourceKey,
  CCTP
} from "../services/cctpService.js";
import {
  cctpSourceAddress,
  cctpSourceConfigured,
  demoFundViaCctp,
  verifyInjectedDemoFundAuth
} from "../services/cctpDemoFundService.js";
import { requestEmailOtp, consumeEmailOtp, otpDevEchoEnabled } from "../services/emailOtpService.js";

function getAddressSafe(value: string): `0x${string}` | undefined {
  try {
    return getAddress(value);
  } catch {
    return undefined;
  }
}

export async function handleWalletGet(
  path: string,
  searchParams: URLSearchParams,
  headers: Record<string, string | undefined> = {}
) {
  if (path === "/api/wallet/mode") {
    return {
      status: 200,
      body: {
        ...(await walletModeInfo()),
        cctpDemoFund: {
          enabled: cctpSourceConfigured(),
          sourceAddress: cctpSourceAddress()
        }
      }
    };
  }

  if (path === "/api/wallet/tx") {
    const hash = (searchParams.get("hash") ?? "").trim();
    if (hash) {
      if (!isValidTxHash(hash)) {
        return { status: 400, body: { error: "invalid transaction hash" } };
      }
      const record = await getTx(hash);
      if (!record) return { status: 404, body: { error: "tx not found" } };
      // Never leak owner (email/address) via public hash lookup.
      return { status: 200, body: publicTxView(record) };
    }
    // Listing requires a verified session (email) or an explicit address owner
    // that matches the session wallet address.
    const email = (headers["x-session-email"] ?? "").trim();
    const sessionToken = (headers["x-session-token"] ?? "").trim();
    const ownerParam = (searchParams.get("owner") ?? "").trim();
    if (email && sessionToken) {
      try {
        const session = await getSessionPublic(email, sessionToken);
        // Prefer address-scoped listing; fall back to email only for legacy records.
        const byAddress = session.address ? await listTxForOwner(session.address) : [];
        const byEmail = await listTxForOwner(email);
        const merged = [...byAddress];
        for (const r of byEmail) {
          if (!merged.some((x) => x.hash === r.hash)) merged.push(r);
        }
        return { status: 200, body: { records: merged.map(publicTxView) } };
      } catch (error) {
        return { status: 401, body: { error: error instanceof Error ? error.message : "unauthorized" } };
      }
    }
    if (ownerParam && /^0x[a-fA-F0-9]{40}$/i.test(ownerParam)) {
      // Address listing is allowed (no email PII); still strip owner field from rows.
      const records = await listTxForOwner(ownerParam);
      return { status: 200, body: { records: records.map(publicTxView) } };
    }
    return {
      status: 400,
      body: { error: "hash, or session headers, or owner=0x address required" }
    };
  }

  if (path === "/api/cctp/config") {
    return {
      status: 200,
      body: {
        ...cctpPublicConfig(),
        demoFund: {
          enabled: cctpSourceConfigured(),
          sourceAddress: cctpSourceAddress(),
          note: "Server burns Base Sepolia USDC from treasury key → mints to your Arc address via CCTP Forwarding."
        }
      }
    };
  }

  if (path === "/api/cctp/quote") {
    const source = (searchParams.get("source") ?? "baseSepolia") as CctpSourceKey;
    const amountRaw = searchParams.get("amount") ?? "1000000";
    let amount: bigint;
    try {
      amount = BigInt(amountRaw);
    } catch {
      return { status: 400, body: { error: "amount must be an integer in USDC base units" } };
    }
    if (amount <= 0n) return { status: 400, body: { error: "amount must be > 0" } };
    const domain =
      source === "ethereumSepolia" ? CCTP.domains.ethereumSepolia : CCTP.domains.baseSepolia;
    return quoteForwardingBurn(amount, domain).then((quote) => ({
      status: 200,
      body: { source, destination: "arcTestnet", ...quote }
    }));
  }

  if (path === "/api/cctp/status") {
    const domain = Number(searchParams.get("domain") ?? "6");
    const txHash = searchParams.get("txHash") ?? "";
    if (!isValidTxHash(txHash)) {
      return { status: 400, body: { error: "invalid transaction hash" } };
    }
    return fetchIrisMessage(domain, txHash).then((result) => ({ status: 200, body: result }));
  }

  if (path === "/api/wallet/session") {
    // Prefer headers (keeps the token out of URLs/logs); query kept for backward compat.
    const email = (headers["x-session-email"] ?? "").trim() || (searchParams.get("email") ?? "");
    const sessionToken =
      (headers["x-session-token"] ?? "").trim() || (searchParams.get("sessionToken") ?? "");
    if (!email || !sessionToken) {
      return { status: 400, body: { error: "email and sessionToken required" } };
    }
    try {
      return { status: 200, body: await getSessionPublic(email, sessionToken) };
    } catch (error) {
      return { status: 401, body: { error: error instanceof Error ? error.message : "unauthorized" } };
    }
  }

  return null;
}

/** Best-effort client IP from reverse-proxy headers (Vercel / Cloudflare). */
export function clientIpFromHeaders(headers: Record<string, string | undefined>): string | undefined {
  const xff = (headers["x-forwarded-for"] ?? headers["x-real-ip"] ?? "").trim();
  if (!xff) return undefined;
  // x-forwarded-for may be a chain: client, proxy1, proxy2
  const first = xff.split(",")[0]?.trim();
  return first || undefined;
}

export async function handleWalletPost(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string | undefined> = {}
) {
  if (path === "/api/wallet/session/request-otp") {
    try {
      const ip = clientIpFromHeaders(headers);
      const fingerprint =
        body.fingerprint !== undefined
          ? String(body.fingerprint).slice(0, 80)
          : headers["x-client-fingerprint"]
            ? String(headers["x-client-fingerprint"]).slice(0, 80)
            : undefined;
      const result = await requestEmailOtp(String(body.email ?? ""), { ip, fingerprint });
      return {
        status: 200,
        body: {
          ...result,
          devEcho: otpDevEchoEnabled(),
          next: "POST /api/wallet/session/verify-otp with { email, code }"
        }
      };
    } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : "otp failed" } };
    }
  }

  if (path === "/api/wallet/session/verify-otp") {
    try {
      const email = await consumeEmailOtp(
        String(body.email ?? ""),
        String(body.code ?? ""),
        body.otpToken !== undefined ? String(body.otpToken) : undefined
      );
      const session = await createOrResumeSession(email, { otpVerified: true });
      return { status: 201, body: { ...session, emailVerified: true } };
    } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : "verify failed" } };
    }
  }

  if (path === "/api/wallet/session") {
    // Legacy: blocked unless EMAIL_OTP_REQUIRED=0
    const email = String(body.email ?? "");
    const code = body.code !== undefined ? String(body.code) : "";
    try {
      if (code) {
        const verified = await consumeEmailOtp(email, code);
        const session = await createOrResumeSession(verified, { otpVerified: true });
        return { status: 201, body: { ...session, emailVerified: true } };
      }
      const session = await createOrResumeSession(email);
      return { status: 201, body: session };
    } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : "session failed" } };
    }
  }

  if (path === "/api/wallet/write-contract") {
    try {
      const result = await writeContractForSession(body as unknown as WriteContractBody);
      // Persist a tracked record so the UI can poll pending -> confirmed / failed.
      const owner = String(body.email ?? "") || result.from;
      const kind = (String(body.txKind ?? "") || "other") as TxKind;
      await recordTx({
        hash: result.hash,
        kind,
        owner,
        from: result.from,
        to: (body.address as `0x${string}`) ?? undefined,
        label: body.txLabel ? String(body.txLabel) : undefined,
        circleTxId: result.circleTxId
      }).catch(() => undefined);
      return { status: 200, body: result };
    } catch (error) {
      return {
        status: 400,
        body: { error: error instanceof Error ? error.message : "write failed" }
      };
    }
  }

  if (path === "/api/wallet/tx/record") {
    try {
      const hash = String(body.hash ?? "");
      if (!isValidTxHash(hash)) {
        return { status: 400, body: { error: "invalid transaction hash" } };
      }
      // Prefer Arc address as owner; never store raw email when address is present.
      let owner = String(body.owner ?? body.from ?? "").trim();
      const email = String(body.email ?? "").trim();
      const sessionToken = String(body.sessionToken ?? "").trim();
      if (email && sessionToken) {
        try {
          const session = await getSessionPublic(email, sessionToken);
          if (session.address) owner = session.address;
        } catch {
          /* unauthenticated record still allowed for injected wallets with address owner */
        }
      }
      if (!owner || owner.includes("@")) {
        // Reject email-as-owner to avoid PII indexes; require 0x address.
        const from = getAddressSafe(String(body.from ?? ""));
        if (!from) return { status: 400, body: { error: "owner must be a 0x address" } };
        owner = from;
      }
      const record = await recordTx({
        hash: hash as `0x${string}`,
        kind: (String(body.kind ?? "other") || "other") as TxKind,
        owner,
        from: getAddressSafe(String(body.from ?? "")),
        to: getAddressSafe(String(body.to ?? "")),
        label: body.label ? String(body.label) : undefined,
        amountUsdc: body.amountUsdc ? String(body.amountUsdc) : undefined,
        createOnly: true,
        verifyFromRpc: true
      });
      return { status: 200, body: publicTxView(record) };
    } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : "record failed" } };
    }
  }

  if (path === "/api/wallet/transfer") {
    try {
      const result = await transferUsdcForSession({
        email: String(body.email ?? ""),
        sessionToken: String(body.sessionToken ?? ""),
        to: String(body.to ?? body.destinationAddress ?? ""),
        amount: String(body.amount ?? "")
      });
      await recordTx({
        hash: result.hash,
        kind: "transfer",
        owner: String(body.email ?? "") || result.from,
        from: result.from,
        to: getAddressSafe(String(body.to ?? body.destinationAddress ?? "")),
        label: `Send ${String(body.amount ?? "")} USDC`,
        amountUsdc: String(body.amount ?? ""),
        circleTxId: result.circleTxId
      }).catch(() => undefined);
      return { status: 200, body: result };
    } catch (error) {
      return {
        status: 400,
        body: { error: error instanceof Error ? error.message : "transfer failed" }
      };
    }
  }

  if (path === "/api/cctp/quote") {
    try {
      const source = String(body.source ?? "baseSepolia") as CctpSourceKey;
      let amount: bigint;
      try {
        amount = BigInt(String(body.amount ?? "0"));
      } catch {
        return { status: 400, body: { error: "amount must be an integer in USDC base units" } };
      }
      if (amount <= 0n) return { status: 400, body: { error: "amount must be > 0" } };
      const domain =
        source === "ethereumSepolia" ? CCTP.domains.ethereumSepolia : CCTP.domains.baseSepolia;
      const quote = await quoteForwardingBurn(amount, domain);
      return { status: 200, body: { source, destination: "arcTestnet", ...quote } };
    } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : "quote failed" } };
    }
  }

  if (path === "/api/wallet/logout") {
    try {
      const token = String(body.sessionToken ?? "").trim();
      if (!token) return { status: 400, body: { error: "sessionToken required" } };
      await logoutSession(token);
      return { status: 200, body: { ok: true } };
    } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : "logout failed" } };
    }
  }

  if (path === "/api/cctp/demo-fund") {
    try {
      if (!cctpSourceConfigured()) {
        return { status: 400, body: { error: "CCTP_SOURCE_PRIVATE_KEY not configured" } };
      }
      const mintTo = String(body.mintTo ?? body.address ?? "");
      const amountUsdc = body.amountUsdc !== undefined ? String(body.amountUsdc) : "2";
      const email = String(body.email ?? "").trim();
      const sessionToken = String(body.sessionToken ?? "").trim();
      const signature = String(body.signature ?? "").trim();
      const nonce = String(body.nonce ?? "").trim();

      let destination: string;
      if (email && sessionToken) {
        // Embedded / Circle: session proves control of the wallet.
        const session = await getSessionPublic(email, sessionToken);
        if (!session.address) {
          return { status: 400, body: { error: "session has no wallet address" } };
        }
        if (mintTo && getAddressSafe(mintTo) && getAddress(mintTo) !== getAddress(session.address)) {
          return { status: 403, body: { error: "mintTo must match session wallet" } };
        }
        destination = session.address;
      } else if (signature && nonce && getAddressSafe(mintTo)) {
        // Verify signature only — nonce is consumed inside demoFundViaCctp after op-store miss
        // so a lost HTTP response can retry and still recover the burnTxHash.
        destination = await verifyInjectedDemoFundAuth({
          mintTo,
          amountUsdc,
          nonce,
          signature,
          expiresAt: body.expiresAt !== undefined ? String(body.expiresAt) : "",
          consumeNonce: false
        });
      } else {
        return {
          status: 401,
          body: {
            error:
              "Auth required: email+sessionToken (Circle) or mintTo+signature+nonce+expiresAt (injected EIP-191)"
          }
        };
      }

      const idempotencyKey = String(body.idempotencyKey ?? "").trim();
      if (!idempotencyKey || idempotencyKey.length < 8) {
        return {
          status: 400,
          body: { error: "idempotencyKey required (client UUID per user action)" }
        };
      }
      // Principal must differ from mintTo when identity is an email session:
      // addresses are free to mint; binding only to mintTo makes principal checks dead code.
      // Session path → email identity; EIP-191 path → signer address (= mintTo).
      const principal = email && sessionToken ? `email:${email.trim().toLowerCase()}` : destination;
      const result = await demoFundViaCctp({
        mintTo: destination,
        amountUsdc,
        idempotencyKey,
        principal,
        // claim nonce only when starting a new burn (after op-store check inside service)
        claimNonce: signature && nonce ? nonce : undefined
      });
      return { status: 200, body: result };
    } catch (error) {
      return {
        status: 400,
        body: { error: error instanceof Error ? error.message : "demo fund failed" }
      };
    }
  }

  return null;
}
