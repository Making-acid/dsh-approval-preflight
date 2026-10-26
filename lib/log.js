/**
 * Minimal file logger.
 *
 * The plugin cannot assume the Harness logger route, and an activation failure in
 * one optional registration must never take the whole plugin down — so the few
 * things worth diagnosing are appended to a file under the DSH home.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const LOG_DIR = path.join(homedir(), '.dsh', 'logs')
const LOG_FILE = path.join(LOG_DIR, 'approval-preflight.log')

let directoryReady = false

/**
 * Append one line to the plugin log; never throws.
 * @param {string} text
 */
export function hostLog(text) {
  try {
    if (!directoryReady) {
      mkdirSync(LOG_DIR, { recursive: true })
      directoryReady = true
    }
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${text}\n`, 'utf8')
  } catch {
    /* diagnostics must never break activation */
  }
}

/** @returns {string} absolute log path */
export function logFilePath() {
  return LOG_FILE
}
