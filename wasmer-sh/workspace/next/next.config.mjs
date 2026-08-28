/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack(config) {
    // The browser workspace is ephemeral, while serializing Webpack's disk
    // cache can exhaust the WASIX process's memory32 address space.
    config.cache = false;
    return config;
  },
};

export default nextConfig;
