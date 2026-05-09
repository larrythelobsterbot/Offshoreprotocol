// ============================================================
// Privacy: never log raw wallet addresses across the codebase.
// `walletLogTag` returns a one-way SHA-256 prefix that lets logs
// distinguish between concurrent wallets (collision-resistant at
// 48 bits) without leaving a recoverable address trail in pm2 /
// disk logs.
//
// Lives in `src/utils/` to be importable by both `wallet-tracker`
// and `loadout-scanner` (and anywhere else that touches wallets)
// without creating a dependency cycle.
// ============================================================

import { createHash } from 'crypto';

export function walletLogTag(addr: string): string {
  if (!addr || typeof addr !== 'string') return 'w_invalid';
  return 'w_' + createHash('sha256').update(addr.toLowerCase()).digest('hex').slice(0, 12);
}
