import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Every screen depends on the session cookie and the language cookie, so
  // nothing here is prerenderable. Cache components off keeps pages simple.
  cacheComponents: false,
  transpilePackages: ['@turn/db'],
  // No framing (the /me buttons must not be clickjacked), no MIME sniffing,
  // no referrer leaks. Scripts are first-party only.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
        ],
      },
    ];
  },
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
