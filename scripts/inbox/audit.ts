/**
 * Inbox audit: list unread messages from all configured Google accounts,
 * group by sender, and classify as likely-noise (has List-Id / List-Unsubscribe)
 * vs human.
 *
 * Usage:
 *   tsx scripts/inbox/audit.ts                  # last 30 days, both accounts
 *   tsx scripts/inbox/audit.ts --days 7
 *   tsx scripts/inbox/audit.ts --account dariy@astrocat.co
 *   tsx scripts/inbox/audit.ts --all            # all unread, no date cutoff
 *   tsx scripts/inbox/audit.ts --json out.json  # dump raw data for next step
 *
 * Output: a Markdown-ish table printed to stdout; optional JSON dump for
 * the classification/triage step.
 */
import { writeFileSync, readFileSync } from 'node:fs'

// Load .env before importing google-auth so GOOGLE_ACCOUNTS is populated
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
} catch { /* .env missing is fine */ }

const { resolveGoogleTokens } = await import('../../src/mcp/briefing/google-auth.js')

interface Args {
  days: number | null
  account: string | null
  jsonOut: string | null
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  let days: number | null = 30
  let account: string | null = null
  let jsonOut: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--days') days = Number(argv[++i])
    else if (a === '--all') days = null
    else if (a === '--account') account = argv[++i]
    else if (a === '--json') jsonOut = argv[++i]
  }
  return { days, account, jsonOut }
}

interface MessageMeta {
  id: string
  account: string
  from: string
  fromEmail: string
  fromDomain: string
  subject: string
  date: string
  listId: string | null
  listUnsubscribe: string | null
  labels: string[]
  snippet: string
}

function parseFrom(raw: string): { name: string; email: string; domain: string } {
  const m = raw.match(/<([^>]+)>/)
  const email = (m?.[1] ?? raw).trim().toLowerCase()
  const name = m ? raw.slice(0, raw.indexOf('<')).trim().replace(/^"|"$/g, '') : ''
  const domain = email.includes('@') ? email.split('@')[1] : ''
  return { name, email, domain }
}

async function fetchUnreadIds(
  token: string,
  account: string,
  query: string,
): Promise<string[]> {
  const headers = { Authorization: `Bearer ${token}` }
  const ids: string[] = []
  let pageToken: string | undefined
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ q: query, maxResults: '500' })
    if (pageToken) params.set('pageToken', pageToken)
    const resp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
      { headers, signal: AbortSignal.timeout(30_000) },
    )
    if (!resp.ok) throw new Error(`[${account}] list failed: ${resp.status} ${await resp.text()}`)
    const data = await resp.json() as { messages?: Array<{ id: string }>; nextPageToken?: string }
    if (data.messages) ids.push(...data.messages.map(m => m.id))
    if (!data.nextPageToken) break
    pageToken = data.nextPageToken
  }
  return ids
}

async function fetchMessageMeta(
  token: string,
  account: string,
  id: string,
): Promise<MessageMeta> {
  const headers = { Authorization: `Bearer ${token}` }
  const url =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}` +
    `?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date` +
    `&metadataHeaders=List-Id&metadataHeaders=List-Unsubscribe`
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  if (!resp.ok) throw new Error(`[${account}] msg ${id}: ${resp.status}`)
  const data = await resp.json() as {
    id: string
    snippet?: string
    labelIds?: string[]
    payload?: { headers?: Array<{ name: string; value: string }> }
  }
  const get = (name: string) =>
    data.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
  const rawFrom = get('From')
  const { name, email, domain } = parseFrom(rawFrom)
  return {
    id: data.id,
    account,
    from: name || email,
    fromEmail: email,
    fromDomain: domain,
    subject: get('Subject'),
    date: get('Date'),
    listId: get('List-Id') || null,
    listUnsubscribe: get('List-Unsubscribe') || null,
    labels: data.labelIds ?? [],
    snippet: data.snippet ?? '',
  }
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: n }, worker))
  return results
}

interface SenderGroup {
  key: string
  email: string
  domain: string
  displayName: string
  count: number
  hasListId: boolean
  hasListUnsub: boolean
  categoryLabels: Set<string>
  sampleSubjects: string[]
  messageIds: Array<{ account: string; id: string }>
  accounts: Set<string>
}

function groupBySender(messages: MessageMeta[]): SenderGroup[] {
  const groups = new Map<string, SenderGroup>()
  for (const m of messages) {
    const key = m.fromEmail || m.fromDomain || '(unknown)'
    let g = groups.get(key)
    if (!g) {
      g = {
        key,
        email: m.fromEmail,
        domain: m.fromDomain,
        displayName: m.from,
        count: 0,
        hasListId: false,
        hasListUnsub: false,
        categoryLabels: new Set(),
        sampleSubjects: [],
        messageIds: [],
        accounts: new Set(),
      }
      groups.set(key, g)
    }
    g.count++
    g.accounts.add(m.account)
    if (m.listId) g.hasListId = true
    if (m.listUnsubscribe) g.hasListUnsub = true
    for (const label of m.labels) {
      if (label.startsWith('CATEGORY_')) g.categoryLabels.add(label.replace('CATEGORY_', ''))
    }
    if (g.sampleSubjects.length < 3 && m.subject && !g.sampleSubjects.includes(m.subject)) {
      g.sampleSubjects.push(m.subject)
    }
    g.messageIds.push({ account: m.account, id: m.id })
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
}

function classify(g: SenderGroup): 'noise' | 'likely-noise' | 'human' | 'mixed' {
  if (g.hasListId || g.hasListUnsub) return 'noise'
  if (g.categoryLabels.has('PROMOTIONS') || g.categoryLabels.has('SOCIAL') || g.categoryLabels.has('UPDATES')) {
    return 'likely-noise'
  }
  const e = g.email
  if (/noreply|no-reply|notifications?@|updates?@|alerts?@|mailer|notify@/i.test(e)) {
    return 'likely-noise'
  }
  return 'human'
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

async function main() {
  const args = parseArgs()
  const tokens = await resolveGoogleTokens()
  if (tokens.size === 0) throw new Error('No Google accounts authorized')

  const queryParts = ['is:unread', '-in:chats']
  if (args.days) queryParts.push(`newer_than:${args.days}d`)
  const query = queryParts.join(' ')

  console.error(`Query: "${query}"`)
  console.error(`Accounts: ${[...tokens.keys()].join(', ')}\n`)

  const allMessages: MessageMeta[] = []
  for (const [account, token] of tokens) {
    if (args.account && account !== args.account) continue
    console.error(`[${account}] listing unread...`)
    const ids = await fetchUnreadIds(token, account, query)
    console.error(`[${account}] ${ids.length} unread messages. Fetching metadata...`)
    const metas = await pool(ids, 8, id => fetchMessageMeta(token, account, id))
    allMessages.push(...metas)
  }

  const groups = groupBySender(allMessages)
  console.error(`\nTotal: ${allMessages.length} unread, ${groups.length} unique senders\n`)

  const noise = groups.filter(g => classify(g) === 'noise')
  const likelyNoise = groups.filter(g => classify(g) === 'likely-noise')
  const human = groups.filter(g => classify(g) === 'human')

  const fmtRow = (g: SenderGroup) => {
    const cls = classify(g)
    const marker = cls === 'noise' ? '🔕' : cls === 'likely-noise' ? '⚠️' : '👤'
    const accts = [...g.accounts].map(a => a.split('@')[0]).join('+')
    const cats = g.categoryLabels.size > 0 ? ` [${[...g.categoryLabels].join(',')}]` : ''
    const subj = truncate(g.sampleSubjects[0] ?? '', 60)
    return `${marker} ${String(g.count).padStart(3)} | ${accts.padEnd(12)} | ${truncate(g.email, 45).padEnd(45)} | ${subj}${cats}`
  }

  console.log('## NOISE (has List-Id / List-Unsubscribe header)')
  console.log(`Total: ${noise.reduce((s, g) => s + g.count, 0)} messages from ${noise.length} senders\n`)
  for (const g of noise.slice(0, 50)) console.log(fmtRow(g))
  if (noise.length > 50) console.log(`... +${noise.length - 50} more`)

  console.log('\n## LIKELY NOISE (category/name heuristic)')
  console.log(`Total: ${likelyNoise.reduce((s, g) => s + g.count, 0)} messages from ${likelyNoise.length} senders\n`)
  for (const g of likelyNoise.slice(0, 50)) console.log(fmtRow(g))
  if (likelyNoise.length > 50) console.log(`... +${likelyNoise.length - 50} more`)

  console.log('\n## HUMAN (manual review)')
  console.log(`Total: ${human.reduce((s, g) => s + g.count, 0)} messages from ${human.length} senders\n`)
  for (const g of human.slice(0, 100)) console.log(fmtRow(g))
  if (human.length > 100) console.log(`... +${human.length - 100} more`)

  if (args.jsonOut) {
    const dump = {
      query,
      generated_at: new Date().toISOString(),
      accounts: [...tokens.keys()].filter(a => !args.account || a === args.account),
      total_unread: allMessages.length,
      groups: groups.map(g => ({
        email: g.email,
        domain: g.domain,
        display_name: g.displayName,
        count: g.count,
        classification: classify(g),
        has_list_id: g.hasListId,
        has_list_unsubscribe: g.hasListUnsub,
        category_labels: [...g.categoryLabels],
        accounts: [...g.accounts],
        sample_subjects: g.sampleSubjects,
        message_ids: g.messageIds,
      })),
    }
    writeFileSync(args.jsonOut, JSON.stringify(dump, null, 2))
    console.error(`\nRaw data → ${args.jsonOut}`)
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
