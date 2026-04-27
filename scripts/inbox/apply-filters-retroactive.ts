/**
 * Apply existing Gmail filters retroactively to already-received messages.
 *
 * Gmail filters only act on newly-incoming mail. To clean up accumulated
 * unread mail, we:
 *   1. List all filters for the account
 *   2. For each filter, translate its criteria into a Gmail search query
 *   3. Find matching messages (both read and unread)
 *   4. Apply the filter's action (addLabels / removeLabels) via batchModify
 *
 * Usage:
 *   tsx scripts/inbox/apply-filters-retroactive.ts                # dry-run
 *   tsx scripts/inbox/apply-filters-retroactive.ts --apply        # actually modify
 *   tsx scripts/inbox/apply-filters-retroactive.ts --account X --apply
 *   tsx scripts/inbox/apply-filters-retroactive.ts --only-unread  # only touch unread messages
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

interface Args {
  apply: boolean
  account: string | null
  onlyUnread: boolean
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  let apply = false
  let account: string | null = null
  let onlyUnread = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') apply = true
    else if (argv[i] === '--account') account = argv[++i]
    else if (argv[i] === '--only-unread') onlyUnread = true
  }
  return { apply, account, onlyUnread }
}

async function gmailApi<T>(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    throw new Error(`${path} failed: ${resp.status} ${await resp.text()}`)
  }
  const text = await resp.text()
  if (!text) return {} as T
  return JSON.parse(text) as T
}

interface Filter {
  id: string
  criteria?: { from?: string; subject?: string; query?: string }
  action?: { addLabelIds?: string[]; removeLabelIds?: string[] }
}

function criteriaToQuery(criteria: Filter['criteria']): string | null {
  if (!criteria) return null
  const parts: string[] = []
  if (criteria.from) parts.push(`from:${criteria.from}`)
  if (criteria.subject) parts.push(`subject:${criteria.subject}`)
  if (criteria.query) parts.push(criteria.query)
  return parts.length > 0 ? parts.join(' ') : null
}

async function listMessages(token: string, account: string, query: string): Promise<string[]> {
  const ids: string[] = []
  let pageToken: string | undefined
  for (let page = 0; page < 30; page++) {
    const params = new URLSearchParams({ q: query, maxResults: '500' })
    if (pageToken) params.set('pageToken', pageToken)
    const data = await gmailApi<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
      token,
      `/messages?${params}`,
    )
    if (data.messages) ids.push(...data.messages.map(m => m.id))
    if (!data.nextPageToken) break
    pageToken = data.nextPageToken
  }
  return ids
}

async function batchModify(
  token: string,
  account: string,
  ids: string[],
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<void> {
  const BATCH_SIZE = 1000
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = ids.slice(i, i + BATCH_SIZE)
    await gmailApi(token, '/messages/batchModify', {
      method: 'POST',
      body: { ids: chunk, addLabelIds, removeLabelIds },
    })
  }
}

async function main() {
  const args = parseArgs()
  const tokens = await resolveGoogleTokens()
  if (tokens.size === 0) throw new Error('No Google accounts authorized')

  const mode = args.apply ? 'APPLY' : 'DRY-RUN'
  console.log(`\n[${mode}] applying filters retroactively${args.onlyUnread ? ' (only unread)' : ''}\n`)

  const totalStats = { filtersApplied: 0, messagesModified: 0 }

  for (const [account, token] of tokens) {
    if (args.account && account !== args.account) continue

    console.log(`=== ${account} ===`)

    const filters = await gmailApi<{ filter?: Filter[] }>(token, '/settings/filters')
    const filterList = filters.filter ?? []
    console.log(`  ${filterList.length} filters configured`)

    const labels = await gmailApi<{ labels: Array<{ id: string; name: string }> }>(
      token,
      '/labels',
    )
    const labelName = new Map(labels.labels.map(l => [l.id, l.name]))

    // Only process filters that target our Auto/* or Outsource QA labels,
    // so we don't accidentally trigger unrelated user-created filters.
    const relevantFilters = filterList.filter(f => {
      const addIds = f.action?.addLabelIds ?? []
      return addIds.some(id => {
        const name = labelName.get(id) ?? ''
        return name === 'Outsource QA' || name.startsWith('Auto/')
      })
    })

    console.log(`  ${relevantFilters.length} relevant filters (Auto/* or Outsource QA)\n`)

    for (const filter of relevantFilters) {
      const query = criteriaToQuery(filter.criteria)
      if (!query) {
        console.log(`  skip ${filter.id}: no translatable criteria`)
        continue
      }
      const fullQuery = args.onlyUnread ? `${query} is:unread` : query
      const addIds = filter.action?.addLabelIds ?? []
      const removeIds = filter.action?.removeLabelIds ?? []
      const targetLabels = addIds.map(id => labelName.get(id) ?? id).join(', ')

      const ids = await listMessages(token, account, fullQuery)
      if (ids.length === 0) {
        console.log(`  0 msgs  | ${targetLabels.padEnd(22)} | ${query}`)
        continue
      }
      console.log(`  ${String(ids.length).padStart(4)} msgs | ${targetLabels.padEnd(22)} | ${query}`)
      totalStats.filtersApplied++
      if (args.apply) {
        await batchModify(token, account, ids, addIds, removeIds)
        totalStats.messagesModified += ids.length
      } else {
        totalStats.messagesModified += ids.length
      }
    }

    console.log()
  }

  console.log(`\n[${mode}] summary: ${totalStats.filtersApplied} filters, ${totalStats.messagesModified} messages ${args.apply ? 'modified' : 'would be modified'}`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
