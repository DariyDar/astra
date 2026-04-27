/**
 * Mark calendar invites as read if their event date has passed (>1 day ago).
 * Only one-off events: skip recurring (subjects with "Weekly from", "Monthly from", etc).
 *
 * Usage:
 *   tsx scripts/inbox/mark-old-invites.ts                 # dry-run
 *   tsx scripts/inbox/mark-old-invites.ts --apply
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

const apply = process.argv.includes('--apply')

interface Msg {
  id: string
  account: string
  subject: string
  date: string
}

async function gmailApi<T>(token: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`)
  const text = await r.text()
  if (!text) return {} as T
  return JSON.parse(text) as T
}

async function listIds(token: string, q: string): Promise<string[]> {
  const ids: string[] = []
  let pageToken: string | undefined
  for (let i = 0; i < 30; i++) {
    const params = new URLSearchParams({ q, maxResults: '500' })
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

async function getMeta(token: string, id: string, account: string): Promise<Msg> {
  const d = await gmailApi<{
    id: string
    payload?: { headers?: Array<{ name: string; value: string }> }
  }>(token, `/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=Date`)
  const get = (n: string) =>
    d.payload?.headers?.find(h => h.name.toLowerCase() === n.toLowerCase())?.value ?? ''
  return { id: d.id, account, subject: get('Subject'), date: get('Date') }
}

/**
 * Parse the event date out of a calendar invite subject.
 * Examples we want to match:
 *   "Invitation: Vector Playtest @ Fri Mar 20, 2026 21:00 - 22:00 (GMT+8) (...)"
 *   "Updated invitation: STT Stand-ups @ Tue Apr 14, 2026 21:30 - 21:55 (GMT+7) (...)"
 *   "Canceled event with note: SBKCO Weekly Sync @ Wed Apr 29, 2026 22:00 - 22:25 (GMT+7) (...)"
 * We extract the absolute date after `@`.
 *
 * Returns null for recurring events (subjects with "Weekly from", "Monthly from",
 * "Daily from", "from <date> to <date>") because those represent ongoing series.
 */
function extractEventDate(subject: string): Date | null {
  // Recurring markers — skip
  if (/@\s+(Weekly|Monthly|Daily|Yearly)\s+from\b/i.test(subject)) return null
  if (/from\s+\w+\s+\w+\s+\d/i.test(subject) && /\bto\s+\w+\s+\w+\s+\d/i.test(subject)) {
    // Pattern like "from Tue Feb 26 to Thu Apr 9" — recurring range
    return null
  }

  // Look for "@ <Day>, <Mon> <D>, <YYYY>"  e.g. "@ Fri Mar 20, 2026"
  // Or "@ <Mon> <D> <Day>, <YYYY>"  e.g. "@ Mar 20, 2026"
  const m = subject.match(/@\s+(\w+)\s+(\w+)\s+(\d+),?\s*(\d{4})?/)
  if (!m) return null
  // m[1] could be weekday or month, m[2] could be month or day
  const dayName = m[1]
  const monthOrDay = m[2]
  const dayNum = m[3]
  const year = m[4] ?? String(new Date().getFullYear())

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  let month: string
  let day: string
  if (monthNames.includes(dayName.slice(0, 3))) {
    // "@ Mar 20, 2026"
    month = dayName.slice(0, 3)
    day = monthOrDay
  } else if (monthNames.includes(monthOrDay.slice(0, 3))) {
    // "@ Fri Mar 20, 2026"
    month = monthOrDay.slice(0, 3)
    day = dayNum
  } else {
    return null
  }

  const parsed = new Date(`${month} ${day}, ${year}`)
  if (isNaN(parsed.getTime())) return null
  return parsed
}

async function main() {
  const tokens = await resolveGoogleTokens()
  // Find all unread mail with calendar-invite-style subjects.
  // These weren't filtered earlier because user asked to keep them.
  const query = '(subject:"Invitation:" OR subject:"Updated invitation" OR subject:"Canceled event") is:unread -in:chats'

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 1)
  console.log(`[${apply ? 'APPLY' : 'DRY-RUN'}] cutoff: ${cutoff.toISOString().slice(0, 10)} (events before this date are stale)\n`)

  const stale: Msg[] = []
  const recurring: Msg[] = []
  const future: Msg[] = []
  const unparseable: Msg[] = []

  for (const [account, token] of tokens) {
    const ids = await listIds(token, query)
    console.log(`[${account}] ${ids.length} unread calendar invites`)
    const metas = await pool(ids, 8, id => getMeta(token, id, account))
    for (const m of metas) {
      const eventDate = extractEventDate(m.subject)
      if (eventDate === null) {
        // Either recurring or we couldn't parse
        if (/@\s+(Weekly|Monthly|Daily|Yearly)/i.test(m.subject)) recurring.push(m)
        else unparseable.push(m)
        continue
      }
      if (eventDate < cutoff) stale.push(m)
      else future.push(m)
    }
  }

  console.log(`\nStale (event > 1d ago):    ${stale.length}`)
  console.log(`Future:                    ${future.length}`)
  console.log(`Recurring (skipped):       ${recurring.length}`)
  console.log(`Couldn't parse (skipped):  ${unparseable.length}\n`)

  if (stale.length > 0 && stale.length <= 80) {
    console.log(`Stale invites that will be marked read:\n`)
    for (const m of stale) {
      console.log(`  [${m.account.split('@')[0].padEnd(12)}] ${m.subject.slice(0, 110)}`)
    }
  } else if (stale.length > 80) {
    console.log(`First 30 stale invites (out of ${stale.length}):\n`)
    for (const m of stale.slice(0, 30)) {
      console.log(`  [${m.account.split('@')[0].padEnd(12)}] ${m.subject.slice(0, 110)}`)
    }
  }

  if (unparseable.length > 0 && unparseable.length <= 20) {
    console.log(`\nCouldn't parse date — review:`)
    for (const m of unparseable) {
      console.log(`  [${m.account.split('@')[0].padEnd(12)}] ${m.subject.slice(0, 110)}`)
    }
  }

  if (apply && stale.length > 0) {
    // Group by account
    const byAccount = new Map<string, string[]>()
    for (const m of stale) {
      if (!byAccount.has(m.account)) byAccount.set(m.account, [])
      byAccount.get(m.account)!.push(m.id)
    }
    for (const [account, ids] of byAccount) {
      const token = tokens.get(account)!
      for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000)
        await gmailApi(token, '/messages/batchModify', {
          method: 'POST',
          body: { ids: chunk, removeLabelIds: ['UNREAD'] },
        })
      }
      console.log(`\n[${account}] marked ${ids.length} stale invites as read`)
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
