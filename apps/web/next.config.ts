import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Every screen depends on the session cookie and the language cookie, so
  // nothing here is prerenderable. Cache components off keeps pages simple.
  cacheComponents: false,
  transpilePackages: ['@turn/db'],
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
