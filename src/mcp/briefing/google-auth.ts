import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { log, jsonOrThrow } from './utils.js'

interface GoogleTokens {
  token: string
  refresh_token: string
  token_uri: string
  client_id: string
  client_secret: string
  expiry: string
}

function loadGoogleTokens(account: string): GoogleTokens | null {
  try {
    const path = resolve(homedir(), '.google_workspace_mcp', 'credentials', `${account}.json`)
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    if (!data.token) return null
    return data as GoogleTokens
  } catch {
    return null
  }
}

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/

function parseGoogleAccounts(): string[] {
  const raw = process.env.GOOGLE_ACCOUNTS
  if (!raw) return ['dariy@astrocat.co']
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.every(e => typeof e === 'string')) {
      log('WARN: GOOGLE_ACCOUNTS is not a string array, using default')
      return ['dariy@astrocat.co']
    }
    for (const account of parsed) {
      if (!EMAIL_RE.test(account)) {
        log(`WARN: Invalid GOOGLE_ACCOUNTS entry: "${account}", skipping`)
      }
    }
    return parsed.filter((a: string) => EMAIL_RE.test(a))
  } catch (e) {
    log(`WARN: GOOGLE_ACCOUNTS is not valid JSON: ${e}, using default`)
    return ['dariy@astrocat.co']
  }
}

export const GOOGLE_ACCOUNTS = parseGoogleAccounts()

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60_000 // refresh 5 min before actual expiry

async function refreshGoogleToken(tokens: GoogleTokens, account: string): Promise<string> {
  if (new Date(tokens.expiry).getTime() - TOKEN_EXPIRY_BUFFER_MS > Date.now()) {
    return tokens.token
  }

  const resp = await fetch(tokens.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: tokens.client_id,
      client_secret: tokens.client_secret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10_000),
  })
  const data = await jsonOrThrow<{ access_token?: string; error?: string }>(resp, 'Google token refresh')
  if (!data.access_token) {
    throw new Error(`Google token refresh failed for ${account}: ${data.error ?? 'no access_token'}`)
  }
  tokens.token = data.access_token
  tokens.expiry = new Date(Date.now() + 3500_000).toISOString()
  try {
    const credPath = resolve(homedir(), '.google_workspace_mcp', 'credentials', `${account}.json`)
    const fullData = JSON.parse(readFileSync(credPath, 'utf-8'))
    fullData.token = tokens.token
    fullData.expiry = tokens.expiry
    const tmpPath = credPath + '.tmp'
    writeFileSync(tmpPath, JSON.stringify(fullData, null, 2), 'utf-8')
    renameSync(tmpPath, credPath)
    log(`Google token refreshed for ${account}`)
  } catch (e) {
    log(`WARN: could not persist refreshed Google token for ${account}: ${e}`)
  }
  return data.access_token
}

/** Pre-resolve Google access tokens for all configured accounts. */
export async function resolveGoogleTokens(): Promise<Map<string, string>> {
  const tokenMap = new Map<string, string>()
  for (const account of GOOGLE_ACCOUNTS) {
    const tokens = loadGoogleTokens(account)
    if (tokens) {
      try {
        const accessToken = await refreshGoogleToken(tokens, account)
        tokenMap.set(account, accessToken)
      } catch (e) {
        log(`WARN: failed to resolve token for ${account}: ${e}`)
      }
    }
  }
  return tokenMap
}
