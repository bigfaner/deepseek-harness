/** Apply the upstream runtime-file-policy trim to a flat file list. Runs via tsx. */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { desktopRuntimeFileExclusion } from './runtime-file-policy.ts'

const files = JSON.parse(readFileSync(process.argv[2], 'utf8'))
let kept = 0
let dropped = 0
for (const [name, entry, bytes] of files) {
  if (desktopRuntimeFileExclusion(`node_modules/${name}/${entry}`, { platform: process.argv[3] ?? 'linux', arch: process.argv[4] ?? 'x64' }, 'wasm') === undefined) kept += bytes
  else dropped += bytes
}
console.log(JSON.stringify({ kept, dropped }))
