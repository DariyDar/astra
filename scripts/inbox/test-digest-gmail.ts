/**
 * Quick test of the new digest-unread Gmail fetcher.
 * Verifies that:
 *   1. unread-only items are returned for normal senders
 *   2. whitelisted senders are returned regardless of read state
 *   3. whitelisted items have body content (not just snippet)
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
const { fetchGmail, DIGEST_WHITELIST_SENDERS } = await import('../../src/mcp/briefing/gmail.js')

async function main() {
  const tokens = await resolveGoogleTokens()
  console.log(`Whitelist senders: ${DIGEST_WHITELIST_SENDERS.join(', ')}`)
  console.log(`Authorized accounts: ${[...tokens.keys()].join(', ')}\n`)

  const period = {
    after: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),  // last 7 days
    before: new Date(),
  }

  const items = await fetchGmail(
    {
      sources: ['gmail'],
      query_type: 'digest-unread',
      limit_per_source: 100,
    },
    period,
    tokens,
  )

  console.log(`Fetched ${items.length} items in last 7 days\n`)

  // Categorize
  const unread = items.filter(i => i.is_unread)
  const whitelisted = items.filter(i => {
    const from = (i.author as string ?? '').toLowerCase()
    return DIGEST_WHITELIST_SENDERS.some(s => from.includes(s))
  })

  console.log(`Unread: ${unread.length}`)
  console.log(`From whitelisted senders: ${whitelisted.length}`)
  console.log(`Whitelisted but read: ${whitelisted.filter(i => !i.is_unread).length}\n`)

  console.log(`=== Sample whitelisted (first 5) ===\n`)
  for (const item of whitelisted.slice(0, 5)) {
    const preview = (item.text_preview as string ?? '').slice(0, 300)
    console.log(`From: ${item.author}`)
    console.log(`Subject: ${item.subject}`)
    console.log(`Date: ${item.date}`)
    console.log(`Unread: ${item.is_unread}`)
    console.log(`Preview length: ${(item.text_preview as string ?? '').length} chars`)
    console.log(`Preview (300c): ${preview}`)
    console.log()
  }

  console.log(`=== Sample unread non-whitelisted (first 5) ===\n`)
  const unreadNonWl = unread.filter(i => {
    const from = (i.author as string ?? '').toLowerCase()
    return !DIGEST_WHITELIST_SENDERS.some(s => from.includes(s))
  })
  for (const item of unreadNonWl.slice(0, 5)) {
    console.log(`From: ${item.author}`)
    console.log(`Subject: ${item.subject}`)
    console.log()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
