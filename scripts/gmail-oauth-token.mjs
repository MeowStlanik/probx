#!/usr/bin/env node
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const clientId = (process.env.GMAIL_OAUTH_CLIENT_ID || "").trim();
const clientSecret = (process.env.GMAIL_OAUTH_CLIENT_SECRET || "").trim();
const port = Number(process.env.GMAIL_OAUTH_PORT || "53682");

if (!clientId || !clientSecret) {
  console.error(
    "Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET locally, then run pnpm gmail:oauth."
  );
  process.exit(1);
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error("GMAIL_OAUTH_PORT must be an integer between 1024 and 65535.");
  process.exit(1);
}

const redirectUri = `http://127.0.0.1:${port}/oauth2/callback`;
const state = randomBytes(24).toString("base64url");
const codeVerifier = randomBytes(64).toString("base64url");
const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authorizeUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: "https://www.googleapis.com/auth/gmail.send",
  access_type: "offline",
  prompt: "consent",
  include_granted_scopes: "true",
  code_challenge: codeChallenge,
  code_challenge_method: "S256",
  state
}).toString();

let settled = false;
const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", redirectUri);
  if (url.pathname !== "/oauth2/callback") {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const returnedState = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  if (returnedState !== state) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("OAuth state mismatch. Close this page and run the command again.");
    finish(1, "OAuth state mismatch.");
    return;
  }
  if (oauthError || !code) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end(`OAuth failed: ${oauthError || "authorization code missing"}`);
    finish(1, `OAuth failed: ${oauthError || "authorization code missing"}`);
    return;
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code_verifier: codeVerifier
      })
    });
    const tokenBody = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenBody.refresh_token) {
      throw new Error(
        tokenBody.error_description ||
          tokenBody.error ||
          `Google token endpoint returned HTTP ${tokenResponse.status}`
      );
    }

    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Authorization complete. Return to the terminal and copy the refresh token to Railway.");
    console.log("\nAdd these variables to Railway:\n");
    console.log(`GMAIL_OAUTH_CLIENT_ID=${clientId}`);
    console.log(`GMAIL_OAUTH_CLIENT_SECRET=${clientSecret}`);
    console.log(`GMAIL_OAUTH_REFRESH_TOKEN=${tokenBody.refresh_token}`);
    console.log("GMAIL_SENDER_EMAIL=your-account@gmail.com");
    console.log("GMAIL_SENDER_NAME=ProbX Arc\n");
    finish(0);
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Token exchange failed. Check the terminal.");
    finish(1, error instanceof Error ? error.message : String(error));
  }
});

function finish(code, message) {
  if (settled) return;
  settled = true;
  if (message) console.error(message);
  server.close(() => process.exit(code));
}

server.listen(port, "127.0.0.1", () => {
  console.log("Open this URL in a browser and authorize the Gmail sender account:\n");
  console.log(authorizeUrl.toString());
  console.log(`\nWaiting for the callback on ${redirectUri} ...`);
});

setTimeout(() => finish(1, "OAuth authorization timed out after 10 minutes."), 10 * 60_000).unref();
