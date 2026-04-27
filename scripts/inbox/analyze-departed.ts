/**
 * Analyze mailer-daemon bounces to identify departed colleagues, then look
 * for traces of them in your mail (recent threads / shared mailing lists)
 * to suggest where to remove them.
 *
 * Read-only. Outputs a report.
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

const { resolveGoogleTokens } = await import('../../src/mcp/briefing/google-auth.js')

interface BounceInfo {
  failedAddress: string
  count: number
  lastSeen: string
  account: string
}

async function gmailApi<T>(token: string, path: string): Promise<T> {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`)
  const text = await r.text()
  if (!text) return {} as T
  return JSON.parse(text) as T
}

async function listIds(token: string, query: string, max: number = 1000): Promise<string[]> {
  const ids: string[] = []
  let pageToken: string | undefined
  while (ids.length < max) {
    const params = new URLSearchParams({ q: query, maxResults: '500' })
    if (pageToken) params.set('pageToken', pageToken)
    const d = await gmailApi<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
      token,
      `/messages?${params}`,
    )
    if (d.messages) ids.push(...d.messages.map(m => m.id))
    if (!d.nextPageToken) break
    pageToken = d.nextPageToken
  }
  return ids
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  }))
  return out
}

async function getBounceMeta(token: string, id: string, account: string): Promise<{ failedAddress: string | null; date: string }> {
  const data = await gmailApi<{
    snippet?: string
    payload?: { headers?: Array<{ name: string; value: string }> }
  }>(token, `/messages/${id}?format=metadata&metadataHeaders=Date&metadataHeaders=Subject`)
  const date = data.payload?.headers?.find(h => h.name === 'Date')?.value ?? ''
  const snippet = data.snippet ?? ''
  // Snippet pattern: "Address not found Your message wasn't delivered to <email> because..."
  const m = snippet.match(/wasn['#39;]+t delivered to ([\w._%+-]+@[\w.-]+\.\w+)/i)
    ?? snippet.match(/Address not found.*?to ([\w._%+-]+@[\w.-]+\.\w+)/i)
  return { failedAddress: m?.[1] ?? null, date }
}

async function findRecentInteractions(token: string, address: string): Promise<{ count: number; lastDate: string }> {
  const escaped = address.replace(/"/g, '\\"')
  const ids = await listIds(token, `"${escaped}" newer_than:180d`, 50)
  if (ids.length === 0) return { count: 0, lastDate: '' }
  const first = await gmailApi<{
    payload?: { headers?: Array<{ name: string; value: string }> }
  }>(token, `/messages/${ids[0]}?format=metadata&metadataHeaders=Date`)
  const date = first.payload?.headers?.find(h => h.name === 'Date')?.value ?? ''
  return { count: ids.length, lastDate: date }
}

async function main() {
  const tokens = await resolveGoogleTokens()
  const bounces = new Map<string, BounceInfo>()

  for (const [account, token] of tokens) {
    const ids = await listIds(token, 'from:mailer-daemon@googlemail.com OR from:mailer-daemon@gmail.com', 500)
    console.error(`[${account}] ${ids.length} bounce messages`)
    const metas = await pool(ids, 8, id => getBounceMeta(token, id, account))
    for (const m of metas) {
      if (!m.failedAddress) continue
      const key = m.failedAddress.toLowerCase()
      const existing = bounces.get(key)
      if (existing) {
        existing.count++
        if (m.date > existing.lastSeen) existing.lastSeen = m.date
      } else {
        bounces.set(key, {
          failedAddress: key,
          count: 1,
          lastSeen: m.date,
          account,
        })
      }
    }
  }

  const sorted = [...bounces.values()].sort((a, b) => b.count - a.count)
  console.log(`# Departed colleagues (from mailer-daemon bounces)\n`)
  console.log(`Found ${sorted.length} unique addresses that bounced.\n`)

  for (const b of sorted) {
    console.log(`\n## ${b.failedAddress} (${b.count} bounces, last: ${b.lastSeen.slice(0, 16)})`)

    // Find traces of this person in mail
    for (const [account, token] of tokens) {
      const interactions = await findRecentInteractions(token, b.failedAddress)
      if (interactions.count > 0) {
        console.log(`  [${account}] ${interactions.count} mentions in last 180d, latest: ${interactions.lastDate.slice(0, 16)}`)
      } else {
        console.log(`  [${account}] no recent mentions`)
      }
    }
  }

  console.log(`\n## Where they could be lurking\n`)
  console.log(`Look for these addresses in:`)
  console.log(`- Google Calendar recurring events (you'll need to remove them as guests)`)
  console.log(`- Email lists/aliases you control (e.g. team@astrocat.co)`)
  console.log(`- Google Groups where you're admin`)
  console.log(`- Slack DMs (separate cleanup)`)
  console.log(`\nNote: this tool can identify but can't auto-remove from external lists/calendars.`)
}

main().catch(e => { console.error(e); process.exit(1) })
