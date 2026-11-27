import type { NextConfig } from 'next';
const config: NextConfig = {
  agentRules: false,
  poweredByHeader: false,
  devIndicators: false,
  serverExternalPackages: ['better-sqlite3', 'pdfjs-dist', 'exceljs', 'mammoth', 'pdf-lib'],
  outputFileTracingExcludes: {
    '/*': ['./.local/**/*', './private-storage/**/*'],
  },
  async headers() {
    return [
      {
        // Import source files set their own frame rule so the review screen can show them.
        source: '/((?!api/imports/[^/]+/files/).*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};
export default config;
