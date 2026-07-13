import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  productionBrowserSourceMaps: process.env.ENABLE_SOURCE_MAPS !== 'false',
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
    // Resolve mina-signer from the postinstall-built esbuild bundle.
    // The tsconfig paths entry handles TypeScript; this alias handles webpack.
    // Only used client-side (web worker); nothing server-side imports mina-signer.
    config.resolve.alias = {
      ...config.resolve.alias,
      'mina-signer': path.resolve(__dirname, 'src/mina-signer-dist/index.js'),
    };
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

export default nextConfig;
