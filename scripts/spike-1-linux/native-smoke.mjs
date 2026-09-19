/**
 * Spike 1 (task 1.1): Linux native-module feasibility smoke.
 *
 * Runs on a Linux machine (or CI) inside a scratch npm project that has
 * node-pty@1.2.0-beta.15 and koffi@3.1.1 installed (the exact versions the
 * upstream dsh desktop-host closure pins, upstream commit c36ba648).
 *
 * Phases:
 *   1. inventory  — record which prebuilds ship in the installed node-pty.
 *   2. koffi      — load libc through koffi and resolve getpid().
 *   3. pty-bare   — pty.spawn() with no spawn-helper provisioned (expected to
 *                   fail: the published linux prebuilds lack spawn-helper).
 *   4. pty-helper — compile spawn-helper from the shipped sources with
 *                   node-gyp, point DSH_NODE_PTY_SPAWN_HELPER at it, and
 *                   re-run the pty smoke (expected to pass).
 *
 * Emits one JSON line per phase prefixed with `SPIKE_RESULT ` so the CI log is
 * machine-greppable.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const report = (phase, data) => {
  console.log(`SPIKE_RESULT ${JSON.stringify({ phase, platform: process.platform, arch: process.arch, node: process.versions.node, ...data })}`)
}

const ptyRoot = dirname(require.resolve('node-pty/package.json'))

// ---- Phase 1: prebuild inventory -------------------------------------------------
const prebuildsDir = join(ptyRoot, 'prebuilds')
const prebuilds = existsSync(prebuildsDir)
  ? Object.fromEntries(readdirSync(prebuildsDir).map((platform) => {
      const files = readdirSync(join(prebuildsDir, platform))
      return [platform, files]
    }))
  : null
report('inventory', { prebuilds })

// ---- Phase 2: koffi ---------------------------------------------------------------
try {
  const koffi = require('koffi')
  const library = koffi.load(null) // default process (libc on Linux)
  const getpid = library.func('int getpid(void)')
  assert.equal(getpid(), process.pid)
  library.unload()
  report('koffi', { ok: true, version: require('koffi/package.json').version })
} catch (error) {
  report('koffi', { ok: false, error: String(error) })
  process.exitCode = 1
}

// ---- pty smoke body ---------------------------------------------------------------
async function ptySmoke() {
  const pty = require('node-pty')
  const script = join(process.cwd(), 'pty-probe.cjs')
  const { writeFileSync, rmSync } = require('node:fs')
  writeFileSync(script, "process.stdout.write('spike-pty-ok\\n')\n")
  try {
    const terminal = pty.spawn(process.execPath, [script], { cwd: process.cwd(), cols: 80, rows: 24, env: { ...process.env, TERM: 'xterm' } })
    let output = ''
    const exit = new Promise((resolve, reject) => {
      const subscription = terminal.onExit((event) => { subscription?.dispose?.(); resolve(event) })
      terminal.onData((data) => { output += data })
      setTimeout(() => reject(new Error('pty probe timed out after 30s')), 30_000)
    })
    const event = await exit
    if (event.exitCode !== 0) throw new Error(`pty probe exited with code ${String(event.exitCode)} signal ${String(event.signal)}`)
    if (!/spike-pty-ok/u.test(output)) throw new Error(`pty probe produced no marker output: ${JSON.stringify(output)}`)
    return true
  } finally {
    rmSync(script, { force: true })
  }
}

// ---- Phase 3: pty without spawn-helper ---------------------------------------------
try {
  delete process.env.DSH_NODE_PTY_SPAWN_HELPER
  await ptySmoke()
  // Reaching here means the bare prebuild alone is sufficient on this platform.
  report('pty-bare', { ok: true, note: 'spawn succeeded without provisioning spawn-helper' })
} catch (error) {
  report('pty-bare', { ok: false, error: String(error) })
}

// ---- Phase 4: compile spawn-helper and retry ----------------------------------------
let helperBuilt = false
try {
  execFileSync('npx', ['--yes', 'node-gyp', 'configure', '--release'], { cwd: ptyRoot, stdio: 'pipe', timeout: 300_000 })
  execFileSync('npx', ['--yes', 'node-gyp', 'build', '--release', 'spawn_helper'], { cwd: ptyRoot, stdio: 'pipe', timeout: 300_000 })
  helperBuilt = existsSync(join(ptyRoot, 'build', 'Release', 'spawn-helper'))
} catch (error) {
  report('pty-helper', { ok: false, stage: 'build', error: String(error) })
}
if (helperBuilt) {
  const helperBytes = statSync(join(ptyRoot, 'build', 'Release', 'spawn-helper')).size
  try {
    process.env.DSH_NODE_PTY_SPAWN_HELPER = join(ptyRoot, 'build', 'Release', 'spawn-helper')
    // node-pty resolves the helper at module load; clear the cache for a fresh resolve.
    for (const key of Object.keys(require.cache)) delete require.cache[key]
    await ptySmoke()
    report('pty-helper', { ok: true, helperBytes })
  } catch (error) {
    report('pty-helper', { ok: false, stage: 'run', error: String(error) })
    process.exitCode = 1
  }
}

// ---- Size data -----------------------------------------------------------------------
function treeBytes(root, skip) {
  let total = 0
  const visit = (dir, relParts) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const parts = [...relParts, entry.name]
      if (skip?.(parts)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) visit(full, parts)
      else if (entry.isFile()) total += statSync(full).size
    }
  }
  visit(root, [])
  return total
}

const perPlatform = {}
if (prebuilds) {
  for (const platform of Object.keys(prebuilds)) {
    perPlatform[platform] = treeBytes(join(prebuildsDir, platform), (parts) => parts.at(-1)?.endsWith('.pdb') ?? false)
  }
}
const total = treeBytes(ptyRoot)
report('size-node-pty', {
  totalBytes: total,
  perPlatformBytes: perPlatform,
  linuxTrimmedBytes: treeBytes(ptyRoot, (parts) => {
    const [prefix, platform] = parts
    if (prefix === 'prebuilds' && platform !== undefined && platform !== `${process.platform}-${process.arch}`) return true
    if (parts.at(-1)?.endsWith('.pdb')) return true
    return false
  }),
})
