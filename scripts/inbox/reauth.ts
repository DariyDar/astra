/**
 * Re-authorize a Google account with scopes needed for inbox triage.
 *
 * Usage:  tsx scripts/inbox/reauth.ts <email>
 *
 * Flow: prints a URL to paste in browser → user authorizes → Google redirects
 * to an out-of-band page with a code → user pastes code here → new tokens
 * (with all required scopes) are written to ~/.google_workspace_mcp/credentials/<email>.json
 *
 * The client_id/client_secret are read from the existing credentials file for the
 * account (so we reuse the GCP project you already set up).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
]

const REDIRECT_PORT = 8765
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function main() {
  const email = process.argv[2]
  if (!email) {
    console.error('Usage: tsx scripts/inbox/reauth.ts <email>')
    process.exit(1)
  }

  const credPath = resolve(homedir(), '.google_workspace_mcp', 'credentials', `${email}.json`)
  const cred = JSON.parse(readFileSync(credPath, 'utf-8'))
  const clientId = cred.client_id as string
  const clientSecret = cred.client_secret as string
  if (!clientId || !clientSecret) throw new Error('client_id/client_secret missing in existing credentials file')

  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', SCOPES.join(' '))
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('prompt', 'consent')
  authUrl.searchParams.set('login_hint', email)
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', state)

  console.log(`\nOpen this URL in a browser (on a machine that can reach 127.0.0.1:${REDIRECT_PORT}):\n`)
  console.log(authUrl.toString())
  console.log(`\nIf running on a remote server, forward the port first:`)
  console.log(`  ssh -L ${REDIRECT_PORT}:127.0.0.1:${REDIRECT_PORT} <server>\n`)
  console.log(`Make sure ${REDIRECT_URI} is added as an authorized redirect URI`)
  console.log(`for OAuth client ${clientId} in the Google Cloud Console.\n`)

  const code = await new Promise<string>((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${REDIRECT_PORT}`)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const returnedState = url.searchParams.get('state')
      const returnedCode = url.searchParams.get('code')
      const err = url.searchParams.get('error')
      if (err) {
        res.writeHead(400, { 'content-type': 'text/html' }).end(`<h1>Error: ${err}</h1>`)
        server.close()
        reject(new Error(err))
        return
      }
      if (returnedState !== state || !returnedCode) {
        res.writeHead(400, { 'content-type': 'text/html' }).end('<h1>Bad state or missing code</h1>')
        server.close()
        reject(new Error('state mismatch or missing code'))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(
        '<h1>Authorization captured. You can close this tab.</h1>',
      )
      server.close()
      resolvePromise(returnedCode)
    })
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      console.log(`Waiting for Google to redirect to ${REDIRECT_URI} ...`)
    })
    server.on('error', reject)
  })

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  })
  if (!tokenResp.ok) {
    const body = await tokenResp.text()
    throw new Error(`Token exchange failed: ${tokenResp.status} ${body}`)
  }
  const tokenData = await tokenResp.json() as {
    access_token: string
    refresh_token?: string
    expires_in: number
    scope: string
    token_type: string
  }

  if (!tokenData.refresh_token) {
    throw new Error('No refresh_token returned — remove app from https://myaccount.google.com/permissions and retry')
  }

  const expiry = new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
  const updated = {
    token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    token_uri: 'https://oauth2.googleapis.com/token',
    client_id: clientId,
    client_secret: clientSecret,
    expiry,
    scopes: tokenData.scope.split(' '),
  }
  writeFileSync(credPath, JSON.stringify(updated, null, 2))
  console.log(`\nTokens written to ${credPath}`)
  console.log(`Granted scopes: ${tokenData.scope}`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
