// Vault folder-name constants, factored out so a future rename (the colinxs/vault
// taxonomy migration — Daily/ → 06-daily/, Inbox/ → 00-inbox/) is a one-line env
// flip per environment instead of a repo-wide grep/replace. Defaults are the
// CURRENT names; the migration hasn't happened yet, so don't flip these.

import type { RtEnv } from "../registry";

/** The daily-note folder (default "Daily"). Override via VAULT_DAILY_DIR. */
export const vaultDailyDir = (env: RtEnv): string => env.VAULT_DAILY_DIR?.trim() || "Daily";

/** The capture/intake folder (default "Inbox"). Override via VAULT_INBOX_DIR. */
export const vaultInboxDir = (env: RtEnv): string => env.VAULT_INBOX_DIR?.trim() || "Inbox";
