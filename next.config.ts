import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages:[
      "@prisma/client",
      "pdfkit",
      "pptxgenjs",
    ]
};

export default nextConfig;