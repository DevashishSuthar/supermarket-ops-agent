import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages:[
    "@prisma/client",
    "pdf-lib",
    "pptxgenjs",
  ]
};

export default nextConfig;