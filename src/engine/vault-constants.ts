// ============================================================
// Swiss Vault simulator constants — extracted from the in-game JS
// bundle and validated to match the in-game cycle output UI to
// ±0.01% across multiple loadout configurations (see /tmp/optimize2.py
// for the reference impl).
//
// Single source of truth. Both `feeds/loadout-scanner::computeVaultProjection`
// (live, chain-anchored projection) and `engine/loadout-simulator`
// (pure, hypothetical projection used by the optimizer) consume these.
// Keeping them here means a change to the in-game math touches one file.
// ============================================================

export const VAULT_TOTAL_TICKS    = 900;
export const VAULT_BASE_DAMAGE    = 3333;
export const VAULT_HEAT_COEFF     = 20;
export const VAULT_DISC_CAP_BP    = 7000;     // 70% Discretion cap in basis points
export const VAULT_DAMAGE_SCALE   = 10000;

/** Cycle is 8 hours wall-clock; the 900-tick simulation maps onto this window. */
export const VAULT_CYCLE_SECONDS  = 8 * 3600;

/**
 * UI scale: simulator output × UI_SCALE / 1e6 = in-game M-cash display.
 * Calibrated against a live loadout scoring 184.63M with simulator output 179,397.
 */
export const VAULT_UI_SCALE = 1029;
