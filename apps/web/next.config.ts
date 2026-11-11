import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // SEC-001: never publish browser source maps (also the default).
  productionBrowserSourceMaps: false,
  poweredByHeader: false,
  // Every screen depends on the session cookie and the language cookie, so
  // nothing here is prerenderable. Cache components off keeps pages simple.
  cacheComponents: false,
  transpilePackages: ['@turn/db'],
  // No framing (the /me buttons must not be clickjacked), no MIME sniffing,
  // no referrer leaks. This CSP is the floor for every response; pages get the
  // full nonce policy from the proxy (Part 10, lib/csp.ts). HSTS only in
  // production: on localhost it would pin http://localhost to HTTPS.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          ...(process.env['NODE_ENV'] === 'production'
            ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
            : []),
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
