/**
 * Spike 1 (task 1.1): preliminary runtime size data.
 *
 * Runs at the root of the upstream monorepo after `pnpm install --filter
 * @deepseek-ai/dsh-desktop-host... --frozen-lockfile`. Measures the installed
 * dependency closure of apps/desktop-host (pnpm virtual-store real package
 * directories) and simulates the upstream desktop runtime-file-policy trim
 * (apps/desktop/scripts/runtime-file-policy.ts) for a linux-x64 target by
 * invoking the real policy implementation through tsx.
 *
 * Usage: node size-report.mjs <upstreamRoot>
 */

import { readdirSync, statSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(process.argv[2] ?? '.')
const virtualStore = join(root, 'node_modules', '.pnpm')

// Real package directories: .pnpm/<entry>/node_modules/<name>(/@scope/name)
const packages = []
for (const entry of readdirSync(virtualStore, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const inner = join(virtualStore, entry.name, 'node_modules')
  for (const pkg of readdirSync(inner, { withFileTypes: true })) {
    const pkgDir = join(inner, pkg.name)
    if (pkg.name.startsWith('@')) {
      for (const nested of readdirSync(pkgDir, { withFileTypes: true })) packages.push([join(pkgDir, nested.name), `${pkg.name}/${nested.name}`])
    } else {
      packages.push([pkgDir, pkg.name])
    }
  }
}

// Flat file list for the policy pass.
const fileRecords = []
let totalBytes = 0
for (const [pkgDir, name] of packages) {
  const visit = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel2 = rel.length === 0 ? entry.name : `${rel}/${entry.name}`
      const full = join(dir, entry.name)
      if (entry.isDirectory()) visit(full, rel2)
      else if (entry.isFile()) {
        const bytes = statSync(full).size
        totalBytes += bytes
        fileRecords.push([name, rel2, bytes])
      }
    }
  }
  visit(pkgDir, '')
}

// Materialize the upstream policy beside the helper and invoke it with tsx.
const spikeDir = fileURLToPath(new URL('.', import.meta.url))
const policyCopy = join(spikeDir, 'runtime-file-policy.ts')
rmSync(policyCopy, { force: true })
const policySource = readFileSync(join(root, 'apps', 'desktop', 'scripts', 'runtime-file-policy.ts'), 'utf8')
writeFileSync(policyCopy, policySource)
const listFile = join(spikeDir, 'size-file-list.json')
writeFileSync(listFile, JSON.stringify(fileRecords))
const policyOut = execFileSync(process.execPath, [
  '--import', 'tsx/esm', join(spikeDir, 'policy-apply.mjs'), listFile, 'linux', 'x64',
], { cwd: root, encoding: 'utf8' })
const { kept, dropped } = JSON.parse(policyOut.split(/\r?\n/u).filter((line) => line.startsWith('{')).at(-1))
rmSync(listFile, { force: true })
rmSync(policyCopy, { force: true })

const dshVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
console.log('SPIKE_RESULT ' + JSON.stringify({
  phase: 'size-report',
  dshVersion,
  closurePackages: packages.length,
  closureFiles: fileRecords.length,
  totalBytes,
  policyKeptBytes: kept,
  policyDroppedBytes: dropped,
  note: 'preliminary: whole filtered-install virtual store incl. some dev tooling; policy simulated for linux-x64',
}))
