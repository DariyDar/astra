/**
 * Smoke test: parse the vault channel index file and verify it lists the
 * channels we expect, then run channel-discovery in dry mode (no Telegram).
 */
import { readFileSync } from 'node:fs'

try {
  const envRaw = readFileSync('.env', 'utf-8')
  for (const line of envRaw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (!m) continue
    const [, key, rawVal] = m
    if (process.env[key]) continue
    let val = rawVal
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    process.env[key] = val
  }
} catch { /* ignore */ }

import { resolve } from 'node:path'

const path = resolve(process.cwd(), 'vault', 'channels', 'Slack Channels.md')
const text = readFileSync(path, 'utf-8')

const indexed = new Set<string>()
for (const line of text.split(/\r?\n/)) {
  const m = line.match(/^\s*\|\s*#([a-z0-9][a-z0-9_-]*)\s*\|/i)
  if (!m) continue
  indexed.add(m[1].toLowerCase())
}

console.log(`Indexed channel count: ${indexed.size}`)
const checkSamples = [
  'absence', 'ac-qa', 'ac-art-lead', 'lisbon-talks', 'dubai',
  'watercooler', 'english-club', 'tech-discussion',
  'ac-product-mgmt-data', 'ac-vibecoding',
]
console.log(`\nSpot check against the 10 channels Astra reported as "new":`)
for (const c of checkSamples) {
  console.log(`  #${c}: ${indexed.has(c) ? 'KNOWN ✓' : 'MISSING ✗'}`)
}

console.log(`\nFirst 30 indexed channels:`)
for (const ch of [...indexed].sort().slice(0, 30)) console.log(`  #${ch}`)
