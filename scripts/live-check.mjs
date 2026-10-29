/**
 * "Is the running Host the build in this checkout?"
 *
 * The Host half is cached per process, so after an in-place edit the answer can be
 * "no" even though `package.json` says otherwise. This script reads the plugin log
 * (`<dsh-home>/logs/approval-preflight.log`) and compares the version the last
 * activation reported with the version in `package.json`.
 *
 * Run: node scripts/live-check.mjs
 * Exit: 0 = the last activation is this build and its route is up; 1 = stale/missing.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const here = new URL('../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', here), 'utf8'))
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const logPath = join(dshHome, 'logs', 'approval-preflight.log')

const VERSION_PATTERN = /\bv(\d+\.\d+\.\d+)\b/

function readLog() {
  try {
    return readFileSync(logPath, 'utf8').split(/\r?\n/).filter((line) => line.length > 0)
  } catch {
    return null
  }
}

function lastIndexOf(lines, pattern) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (pattern.test(lines[index])) return index
  }
  return -1
}

const lines = readLog()

if (lines === null) {
  console.log(`✗ 没有找到日志：${logPath}`)
  console.log('  说明 Host 半从未在这个 DSH 安装里激活过，或者 DSH_HOME 指向了别处。')
  process.exitCode = 1
} else {
  const startAt = lastIndexOf(lines, / apply: start\b/)
  const wiredAt = lastIndexOf(lines, / apply: wired\b/)
  const routeAt = lastIndexOf(lines, / channel: prefix route installed/)
  const lastStart = startAt === -1 ? '' : lines[startAt]
  const wired = startAt === -1 ? '' : lines.slice(startAt).find((line) => / apply: wired\b/.test(line)) ?? ''
  const match = VERSION_PATTERN.exec(`${wired}\n${lastStart}`)
  const loaded = match?.[1]
  const wiredVersionMatch = VERSION_PATTERN.exec(wired)
  const wiredVersion = wiredVersionMatch?.[1]

  console.log(`checkout 版本：${pkg.version}`)
  console.log(`日志：${logPath}`)
  console.log(`最后一次激活：${lastStart || '（日志里没有 apply: start）'}`)
  console.log(`最后一次装配：${wired || '（日志里没有 apply: wired）'}`)

  const routeUp = routeAt !== -1 && routeAt > startAt

  if (loaded === undefined) {
    console.log('\n✗ 日志里的激活行没有版本号：这是 2.0.1 之前的构建，Host 还没重启。')
    console.log('  退出并重新打开 DSH NEXT 后再跑一次本脚本。')
    process.exitCode = 1
  } else if (wiredVersion !== pkg.version) {
    console.log(`\n✗ 正在跑的是 v${wiredVersion}，checkout 是 v${pkg.version}：Host 需要重启。`)
    process.exitCode = 1
  } else if (!routeUp) {
    console.log(`\n✗ v${loaded} 已装配，但面板路由没有装成（看日志里的 channel: 行）。`)
    process.exitCode = 1
  } else {
    console.log(`\n✓ 正在跑的就是 v${loaded}，面板路由已在 ${new Date(lines[routeAt].slice(0, 24)).toLocaleString()} 装好。`)
    console.log('  接下来按 docs/verify.md 第 3 节跑一遍端到端场景。')
  }
}
