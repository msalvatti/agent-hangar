/**
 * Next.js configuration of the web app.
 *
 * Layer: config.
 *
 * Security defaults: every response carries a Content-Security-Policy and the classic hardening
 * headers. The CSP is defence in depth, not a complete XSS mitigation: `script-src` keeps
 * `'unsafe-inline'` (Next.js inline bootstrap scripts; a nonce pipeline is out of scope while the
 * app only serves localhost) and `style-src` keeps `'unsafe-inline'` (Tailwind/shadcn inject
 * inline styles). `'unsafe-eval'` is added in development only, for the dev server's HMR.
 */
import type { NextConfig } from 'next';

const isDevelopment = process.env.NODE_ENV !== 'production';

/** CSP directives shared by development and production. */
const SHARED_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
  "style-src 'self' 'unsafe-inline'",
];

/**
 * Builds the Content-Security-Policy value for the current environment.
 *
 * @param development - Whether the dev server is running (adds `'unsafe-eval'` for HMR).
 * @returns The header value.
 */
function buildContentSecurityPolicy(development: boolean): string {
  const scriptSrc = development
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";
  return [...SHARED_DIRECTIVES, scriptSrc].join('; ');
}

/** Hardening headers applied to every route. */
const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: buildContentSecurityPolicy(isDevelopment) },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  output: 'standalone',
  transpilePackages: ['@agent-hangar/core'],
  serverExternalPackages: [
    'pino',
    'ioredis',
    'bullmq',
    '@prisma/client',
    '@prisma/adapter-pg',
    'pg',
  ],
  headers() {
    return Promise.resolve([{ source: '/:path*', headers: SECURITY_HEADERS }]);
  },
};

export default nextConfig;
