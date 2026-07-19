import {
  createOrResumeSession,
  getSessionPublic,
  walletModeInfo,
  writeContractForSession,
  transferUsdcForSession,
  type WriteContractBody
} from "../services/sessionWalletService.js";
import { getTx, listTxForOwner, recordTx, type TxKind } from "../services/txTrackerService.js";
import { getAddress } from "viem";

function getAddressSafe(value: string): `0x${string}` | undefined {
  try {
    return getAddress(value);
  } catch {
    return undefined;
  }
}
import {
  cctpPublicConfig,
  fetchIrisMessage,
  quoteForwardingBurn,
  type CctpSourceKey,
  CCTP
} from "../services/cctpService.js";
import { cctpSourceAddress, cctpSourceConfigured, demoFundViaCctp } from "../services/cctpDemoFundService.js";
import { requestEmailOtp, consumeEmailOtp, otpDevEchoEnabled } from "../services/emailOtpService.js";

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
    if (hash.startsWith("0x")) {
      const record = await getTx(hash as `0x${string}`);
      if (!record) return { status: 404, body: { error: "tx not found" } };
      return { status: 200, body: record };
    }
    const owner =
      (headers["x-session-email"] ?? "").trim() ||
      (searchParams.get("owner") ?? "").trim();
    if (!owner) return { status: 400, body: { error: "hash or owner required" } };
    const records = await listTxForOwner(owner);
    return { status: 200, body: { records } };
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
    if (!txHash.startsWith("0x")) {
      return { status: 400, body: { error: "txHash required" } };
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

export async function handleWalletPost(path: string, body: Record<string, unknown>) {
  if (path === "/api/wallet/session/request-otp") {
    try {
      const result = await requestEmailOtp(String(body.email ?? ""));
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
      const email = consumeEmailOtp(
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
        const verified = consumeEmailOtp(email, code);
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
      if (!hash.startsWith("0x")) return { status: 400, body: { error: "hash required" } };
      const record = await recordTx({
        hash: hash as `0x${string}`,
        kind: (String(body.kind ?? "other") || "other") as TxKind,
        owner: String(body.owner ?? ""),
        from: getAddressSafe(String(body.from ?? "")),
        to: getAddressSafe(String(body.to ?? "")),
        label: body.label ? String(body.label) : undefined,
        amountUsdc: body.amountUsdc ? String(body.amountUsdc) : undefined
      });
      return { status: 200, body: record };
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

  if (path === "/api/cctp/demo-fund") {
    try {
      if (!cctpSourceConfigured()) {
        return { status: 400, body: { error: "CCTP_SOURCE_PRIVATE_KEY not configured" } };
      }
      const mintTo = String(body.mintTo ?? body.address ?? "");
      const amountUsdc = body.amountUsdc !== undefined ? String(body.amountUsdc) : "2";
      const result = await demoFundViaCctp({ mintTo, amountUsdc });
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
