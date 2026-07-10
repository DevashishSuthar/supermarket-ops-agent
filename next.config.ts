import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages:[
    "@prisma/client",
    "pdf-lib",
  ],
  transpilePackages: ["pptxgenjs"],
};

export default nextConfig;