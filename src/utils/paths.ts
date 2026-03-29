import { join } from 'node:path';

// Use /tmp on Vercel (read-only filesystem), local .dexter otherwise
const DEXTER_DIR = process.env.VERCEL ? '/tmp/.dexter' : '.dexter';

export function getDexterDir(): string {
  return DEXTER_DIR;
}

export function dexterPath(...segments: string[]): string {
  return join(getDexterDir(), ...segments);
}
