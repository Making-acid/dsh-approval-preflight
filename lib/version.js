/**
 * The plugin's own identity, in one place.
 *
 * The running Host caches an ESM module per specifier, so "which build is
 * actually loaded?" is a real question after an in-place edit: the log line, the
 * panel footer and `preflight_status` all quote this constant, and
 * `scripts/selftest.mjs` asserts it still matches `package.json`.
 */

export const PLUGIN_NAME = 'dsh-approval-preflight'

export const VERSION = '2.1.0'
