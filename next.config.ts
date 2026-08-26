import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dashboard is self-hosted next to an admin API key. Nothing here should
  // reach a soif-operated service, so there is no telemetry and no remote
  // image loader.
  reactStrictMode: true,
  serverExternalPackages: ["better-sqlite3", "postgres"],
  // Pin the trace root to this package. Without it Next walks up and finds an
  // unrelated lockfile in the home directory, and the standalone output traces
  // the wrong tree.
  outputFileTracingRoot: import.meta.dirname,
};

export default nextConfig;
