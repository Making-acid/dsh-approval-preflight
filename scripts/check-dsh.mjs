#!/usr/bin/env node
/**
 * DSH 契约检查（`npm run test:dsh`）。
 *
 * 用「本机 DSH 宿主自己的」`@deepseek-ai/dsh-tools` 校验本插件的五个模型侧工具，
 * 并用宿主自带的 semver 检查 `engines.dsh` 是否覆盖当前 DSH 版本。检查项与 Host
 * 在 `tools.register()` 时执行的完全一致，所以它能在升级 DSH 后第一时间回答
 * 「插件还能不能加载」，而不需要真的重启宿主。
 *
 * 另外校验 Bundle 清单本身：`dsh.bundle.patch` 指向的文件必须存在，`lib/version.js`
 * 的版本必须与 `package.json` 一致（selftest 也断言这一点）。
 *
 * 只读取、不安装、不修改任何东西。找不到 DSH 安装（例如 CI）时报告 skipped
 * 并以 0 退出；加 `--require` 可让「找不到」也算失败。
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REQUIRED = process.argv.includes('--require')

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** 从候选目录里找一份装了 @deepseek-ai/dsh-tools 的 node_modules。 */
function locateDsh() {
  const home = os.homedir()
  const roots = [
    process.env.DSH_APP_DIR,
    process.env.DSH_PROFILE_DIR,
    'C:\\Program Files\\DSH NEXT\\resources\\app',
    'C:\\Program Files\\DSH\\resources\\app',
    path.join(home, 'AppData', 'Local', 'Programs', 'DSH NEXT', 'resources', 'app')
  ].filter((value) => typeof value === 'string' && value.length > 0)

  const profiles = path.join(home, '.dsh', 'profiles')
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles)) {
      roots.push(path.join(profiles, name))
      roots.push(path.join(profiles, name, 'node_modules'))
    }
  }

  for (const root of roots) {
    for (const base of [path.join(root, 'node_modules'), root]) {
      const toolsDir = path.join(base, '@deepseek-ai', 'dsh-tools')
      const manifest = path.join(toolsDir, 'package.json')
      if (!existsSync(manifest)) continue
      const ownManifest = path.join(base, '@deepseek-ai', 'dsh', 'package.json')
      return {
        base,
        toolsDir,
        manifest,
        coreManifest: existsSync(ownManifest) ? ownManifest : manifest
      }
    }
  }
  return undefined
}

/** 读取宿主自带或全局可解析的 semver；拿不到时返回 undefined。 */
function loadSemver(dsh) {
  const anchors = [dsh.coreManifest, dsh.manifest, path.join(ROOT, 'package.json')]
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)('semver')
    } catch {
      /* 试下一个锚点 */
    }
  }
  return undefined
}

function validateTools(definitions, assertSupportedJsonSchema, assertObjectJsonSchema) {
  const problems = []
  for (const definition of definitions) {
    const label = definition?.name ?? '<unnamed>'
    const fail = (message) => problems.push(`${label}: ${message}`)
    if (typeof label !== 'string' || label.length === 0) fail('name must be a non-empty string')
    if (typeof definition?.description !== 'string' || definition.description.length === 0) fail('description must be a non-empty string')
    if (typeof definition?.execute !== 'function') fail('execute must be a function')
    if (definition?.parameters === undefined) fail('parameters must be declared')
    else {
      try {
        assertObjectJsonSchema(definition.parameters)
        assertSupportedJsonSchema(definition.parameters)
      } catch (error) {
        fail(`parameters: ${error.message}`)
      }
    }
    const output = definition?.output
    if (output === undefined || typeof output !== 'object') fail('output { schema, render } must be declared')
    else {
      if (typeof output.render !== 'function') fail('output.render must be a function')
      try {
        assertSupportedJsonSchema(output.schema)
      } catch (error) {
        fail(`output.schema: ${error.message}`)
      }
    }
  }
  return problems
}

async function main() {
  const pkg = readJson(path.join(ROOT, 'package.json'))
  const failures = []
  const notes = []

  // 1. 清单本身：bundle patch 必须真的存在，engines 必须声明。
  const patch = pkg?.dsh?.bundle?.patch
  const patches = Array.isArray(patch) ? patch : patch === undefined ? [] : [patch]
  if (patches.length === 0) failures.push('package.json: dsh.bundle.patch is not declared')
  for (const rel of patches) {
    if (!existsSync(path.join(ROOT, rel))) failures.push(`package.json: bundle patch "${rel}" does not exist`)
  }
  const dshRange = pkg?.engines?.dsh
  if (typeof dshRange !== 'string' || dshRange.length === 0) {
    failures.push('package.json: engines.dsh is missing (DSH >= 0.2.1 prefers it for compatibility)')
  }
  if (typeof pkg?.engines?.node !== 'string') failures.push('package.json: engines.node is missing')

  // 2. 代码版本与清单版本保持一致（面板、日志、preflight_status 三处同源）。
  const { VERSION } = await import(pathToFileURL(path.join(ROOT, 'lib', 'version.js')).href)
  if (VERSION !== pkg.version) failures.push(`lib/version.js: VERSION ${VERSION} !== package.json ${pkg.version}`)

  // 3. 用宿主自己的契约校验工具定义。
  const dsh = locateDsh()
  if (dsh === undefined) {
    console.log('[dsh-check] 未找到本机 DSH 安装，跳过契约检查（CI 环境可忽略；需要强制时报 --require）')
    console.log('[dsh-check] 可设置 DSH_APP_DIR 指向 DSH 的 resources/app 目录')
    if (REQUIRED) process.exitCode = 1
    return
  }
  const hostVersion = readJson(dsh.coreManifest).version
  let tools
  try {
    tools = await import(pathToFileURL(path.join(dsh.toolsDir, 'lib', 'index.js')).href)
  } catch (error) {
    console.log(`[dsh-check] 无法加载宿主 dsh-tools（${error.message}），跳过契约检查`)
    if (REQUIRED) process.exitCode = 1
    return
  }

  const { createTools } = await import(pathToFileURL(path.join(ROOT, 'lib', 'tools.js')).href)
  const { normalizeConfig } = await import(pathToFileURL(path.join(ROOT, 'lib', 'config.js')).href)
  const definitions = createTools({}, normalizeConfig({}))
  failures.push(...validateTools(definitions, tools.assertSupportedJsonSchema, tools.assertObjectJsonSchema))

  // 4. engines.dsh 必须覆盖宿主版本（含 rc 预发布）。
  const semver = loadSemver(dsh)
  if (semver !== undefined && typeof dshRange === 'string') {
    try {
      if (!semver.satisfies(hostVersion, dshRange, { includePrerelease: true })) {
        failures.push(`engines.dsh "${dshRange}" does not cover the installed DSH ${hostVersion}`)
      }
    } catch (error) {
      failures.push(`engines.dsh "${dshRange}" is not a valid semver range: ${error.message}`)
    }
  } else {
    notes.push('宿主未提供 semver，跳过 engines.dsh 覆盖检查')
  }

  console.log(`DSH ${hostVersion} · ${dsh.base}`)
  console.log(`${definitions.length} 个工具定义通过宿主 dsh-tools 契约校验`)
  for (const note of notes) console.log(`note: ${note}`)
  if (failures.length > 0) {
    for (const failure of failures) console.log(`FAIL ${failure}`)
    console.log(`\n${failures.length} 项不兼容`)
    process.exitCode = 1
    return
  }
  console.log('ALL DSH CONTRACT CHECKS PASSED')
}

await main()
