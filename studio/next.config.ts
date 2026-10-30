import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    // @mujoco/mujoco's Emscripten glue imports Node's `module` behind a runtime Node check; the
    // robot worker never takes that branch, but the bundler still has to resolve it.
    resolveAlias: { module: { browser: false } },
  },
};

export default nextConfig;
