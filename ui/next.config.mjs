import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { PHASE_PRODUCTION_BUILD } from 'next/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build stamp for the footer: version from package.json, short commit from git
// (or NEXT_PUBLIC_COMMIT_SHA in CI). git is best-effort — a build without a
// working tree (e.g. Docker layer) just omits the commit.
const appVersion = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
let commitSha = process.env.NEXT_PUBLIC_COMMIT_SHA ?? '';
if (!commitSha) {
  try {
    commitSha = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
  } catch {
    commitSha = '';
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  env: {
    NEXT_PUBLIC_APP_VERSION: appVersion,
    NEXT_PUBLIC_COMMIT_SHA: commitSha,
  },
  productionBrowserSourceMaps: process.env.ENABLE_SOURCE_MAPS !== 'false',
  // Workspace root — ensures standalone tracing follows workspace-linked
  // contracts one level above ui/.
  outputFileTracingRoot: path.resolve(__dirname, '..'),
  webpack(config, { isServer }) {
    // Disable minification: SWC/terser minifiers are known to mangle BigInt
    // operations (see terser/terser#546, terser/terser#525). o1js relies on
    // BigInt for field arithmetic and Poseidon hashing; minified builds
    // silently produce wrong transaction commitments, causing the Mina node
    // to reject signatures with Invalid_signature.
    config.optimization = {
      ...config.optimization,
      minimize: false,
    };
    // o1js uses top-level await and WASM
    config.experiments = {
      ...config.experiments,
      topLevelAwait: true,
      asyncWebAssembly: true,
    };
    // Ignore node-specific modules in browser
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        child_process: false,
      };
    }
    return config;
  },
  // Headers for SharedArrayBuffer (required by o1js WASM)
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
        ],
      },
    ];
  },
};

export default function configForPhase(phase) {
  if (phase === PHASE_PRODUCTION_BUILD) {
    const network = process.env.NEXT_PUBLIC_MINA_NETWORK;
    const nodeDomain = process.env.MINA_NETWORK_DOMAIN;
    if (!['mainnet', 'testnet', 'devnet'].includes(network)
      || (nodeDomain !== undefined && nodeDomain !== network)) {
      throw new Error(
        'Production UI build requires NEXT_PUBLIC_MINA_NETWORK '
        + '(mainnet, testnet, or devnet); '
        + 'MINA_NETWORK_DOMAIN, if set, must match too.',
      );
    }
  }
  return nextConfig;
}
