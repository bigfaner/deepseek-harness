/**
 * Spike 1 (task 1.1): Linux desktop-host boot smoke.
 *
 * Runs at the root of the upstream monorepo (commit c36ba648) after a filtered
 * install of the desktop-host dependency closure. Boots
 * apps/desktop-host/src/index.ts headless via tsx with a scratch project
 * directory and a stub office payload, waits for the IPC `ready` message, then
 * requests shutdown. Records the outcome as a `SPIKE_RESULT` JSON line.
 *
 * Usage: node host-smoke.mjs <upstreamRoot>
 */

import { spawn } from 'node:child_process'
import { mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? '.')
const scratch = join(tmpdir(), `dsh-spike-host-${String(process.pid)}`)
rmSync(scratch, { recursive: true, force: true })

const projectDir = join(scratch, 'project')
const payloadDir = join(scratch, 'payload')
mkdirSync(projectDir, { recursive: true })
mkdirSync(payloadDir, { recursive: true })
mkdirSync(join(payloadDir, 'primary-runtime'), { recursive: true })
// office.ts resolves the skill asset root as dirname(source)/office-skills.
symlinkSync(join(root, 'packages', 'skill', 'skill-office', 'assets'), join(payloadDir, 'office-skills'), 'dir')

// The install anchor desktop-host resolves its runtime from.
const runtimeDir = join(root, 'apps', 'desktop-host')

const host = spawn(process.execPath, [
  '--import', 'tsx/esm',
  'apps/desktop-host/src/index.ts',
  runtimeDir,       // argv[2] runtimeDir — node_modules/@deepseek-ai/dsh anchor
  projectDir,       // argv[3] projectDir — empty profile
  join(payloadDir, 'primary-runtime'), // argv[4] office payload source
], {
  cwd: root,
  stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
  env: {
    ...process.env,
    HOME: scratch,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_DISABLE_UPDATE_CHECK: '1',
  },
})

let stdout = ''
let stderr = ''
let result = null
const deadline = Date.now() + 180_000

host.stdout.on('data', (chunk) => { stdout += String(chunk) })
host.stderr.on('data', (chunk) => { stderr += String(chunk) })

const done = new Promise((resolveDone) => {
  host.on('message', (message) => {
    if (message?.type === 'ready') { result = { phase: 'desktop-host-boot', ok: true, url: message.url }; host.send({ type: 'shutdown' }) }
    if (message?.type === 'fatal') { result = { phase: 'desktop-host-boot', ok: false, error: message.message }; host.disconnect?.() }
  })
  host.on('exit', (code, signal) => resolveDone({ code, signal }))
  setTimeout(() => { result ??= { phase: 'desktop-host-boot', ok: false, error: 'timeout waiting for ready message' }; try { host.kill('SIGKILL') } catch { /* already gone */ } }, 180_000)
})

const exit = await done
const tail = (text) => text.split(/\r?\n/u).slice(-40).join('\n')
console.log('SPIKE_RESULT ' + JSON.stringify({
  ...result,
  platform: process.platform,
  arch: process.arch,
  node: process.versions.node,
  exit,
  stderrTail: tail(stderr),
  stdoutTail: tail(stdout),
}))
rmSync(scratch, { recursive: true, force: true, maxRetries: 10 })
process.exit(result?.ok ? 0 : 1)
