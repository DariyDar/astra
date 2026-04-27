/**
 * List all remaining unread messages with subject + snippet + date,
 * grouped by sender. Read-only.
 *
 * Usage: tsx scripts/inbox/list-remaining.ts
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

interface Msg {
  account: string
  id: string
  from: string
  fromEmail: string
  subject: string
  date: string
  snippet: string
}

async function listIds(token: string, query: string): Promise<string[]> {
  const ids: string[] = []
  let pageToken: string | undefined
  for (let i = 0; i < 20; i++) {
    const params = new URLSearchParams({ q: query, maxResults: '500' })
    if (pageToken) params.set('pageToken', pageToken)
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    })
    if (!r.ok) throw new Error(`list: ${r.status}`)
    const d = await r.json() as { messages?: Array<{ id: string }>; nextPageToken?: string }
    if (d.messages) ids.push(...d.messages.map(m => m.id))
    if (!d.nextPageToken) break
    pageToken = d.nextPageToken
  }
  return ids
}

async function getMeta(token: string, id: string, account: string): Promise<Msg> {
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}` +
    `?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  })
  const d = await r.json() as {
    id: string
    snippet?: string
    payload?: { headers?: Array<{ name: string; value: string }> }
  }
  const get = (n: string) =>
    d.payload?.headers?.find(h => h.name.toLowerCase() === n.toLowerCase())?.value ?? ''
  const rawFrom = get('From')
  const m = rawFrom.match(/<([^>]+)>/)
  const fromEmail = (m?.[1] ?? rawFrom).trim().toLowerCase()
  return {
    account,
    id: d.id,
    from: rawFrom,
    fromEmail,
    subject: get('Subject'),
    date: get('Date'),
    snippet: (d.snippet ?? '').replace(/\s+/g, ' ').slice(0, 140),
  }
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

function fmtDate(raw: string): string {
  try {
    const d = new Date(raw)
    return d.toISOString().slice(0, 10)
  } catch { return raw.slice(0, 16) }
}

async function main() {
  const tokens = await resolveGoogleTokens()
  const all: Msg[] = []
  for (const [account, token] of tokens) {
    const ids = await listIds(token, 'is:unread -in:chats')
    const metas = await pool(ids, 8, id => getMeta(token, id, account))
    all.push(...metas)
  }

  // Group by fromEmail
  const groups = new Map<string, Msg[]>()
  for (const m of all) {
    const k = m.fromEmail
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(m)
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)

  console.log(`# All ${all.length} remaining unread, grouped by sender\n`)
  for (const [email, msgs] of sorted) {
    const accts = [...new Set(msgs.map(m => m.account.split('@')[0]))].join('+')
    console.log(`\n## ${msgs.length} × ${email}  [${accts}]`)
    msgs.sort((a, b) => b.date.localeCompare(a.date))
    for (const m of msgs.slice(0, 10)) {
      console.log(`  ${fmtDate(m.date)} | ${m.subject}`)
      if (m.snippet && m.snippet.length > 5) console.log(`             ${m.snippet}`)
    }
    if (msgs.length > 10) console.log(`  ... and ${msgs.length - 10} more`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
