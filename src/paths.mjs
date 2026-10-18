import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIR = path.join(ROOT, 'web');
export const CONFIG_DIR = path.join(ROOT, 'config');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');
export const ALLOWLIST_FILE = path.join(CONFIG_DIR, 'dm-allowlist.json');
export const ALLOWLIST_EXAMPLE = path.join(CONFIG_DIR, 'dm-allowlist.example.json');
export const CHROME_PROFILE = path.join(ROOT, 'chrome-profile');
export const RUNTIME_DIR = path.join(ROOT, 'runtime');

/** Resolve the paths block from config.yaml into absolute filesystem paths. */
export function runtimePaths(config) {
  const block = config?.paths ?? {};
  const home = block.home ? path.resolve(ROOT, block.home) : RUNTIME_DIR;
  const resolve = (value, fallback) => path.resolve(home, value ?? fallback);
  return {
    home,
    memory: resolve(block.memory, 'memory/'),
    drafts: resolve(block.drafts, 'drafts/'),
    audit: resolve(block.audit, 'audit/audit.jsonl'),
    logs: resolve(block.logs, 'duty.log'),
  };
}
