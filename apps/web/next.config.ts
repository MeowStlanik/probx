import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const configDir = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Allow importing apps/api services into Next route handlers
  experimental: {
    externalDir: true
  },
  serverExternalPackages: ["@circle-fin/developer-controlled-wallets", "nodemailer"],
  outputFileTracingRoot: path.join(configDir, "../.."),
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"]
    };
    return config;
  }
};

export default nextConfig;
