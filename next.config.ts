import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // package-lock.json exists further up this machine's home directory, and without
  // an explicit root Turbopack picks that as the workspace and ignores ours.
  turbopack: { root: __dirname },
  // The dev badge sits exactly where the sticky CTA does; it made a screenshot
  // look like a layout bug during review.
  devIndicators: false,
};

export default nextConfig;
