import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

/**
 * `turbopack.root` / `outputFileTracingRoot` pin Next to this directory.
 * The repo root above has its own tsconfig.json for the Anchor workspace, and
 * without pinning, Next walks up, finds it, and resolves the "@/*" alias
 * against the wrong base.
 *
 * `agentRules: false` stops `next dev` writing AGENTS.md and CLAUDE.md into
 * this directory. The repo root already carries a CLAUDE.md that says what
 * this project is; a second one generated from the framework's own template
 * would be two sources of instruction disagreeing with each other.
 *
 * @type {import('next').NextConfig}
 */
export default {
  reactStrictMode: true,
  agentRules: false,
  outputFileTracingRoot: dir,
  turbopack: { root: dir },
  webpack(config) {
    config.resolve.alias = { ...config.resolve.alias, '@': path.join(dir, 'src') };
    return config;
  },
};
