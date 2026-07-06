import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  async redirects() {
    return [
      { source: "/groups", destination: "/tasks", permanent: true },
      {
        source: "/groups/:id",
        destination: "/tasks?group=:id",
        permanent: true,
      },
      { source: "/inbox", destination: "/tasks?group=inbox", permanent: true },
    ];
  },
};

export default nextConfig;
