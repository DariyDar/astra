import { classifyEmail, SYSTEM_PATTERNS, KEEP_SENDERS } from '../src/kb/gmail-classifier.js'

const tests: Array<[string, string | undefined, 'system' | 'human']> = [
  ['noreply@apple.com', undefined, 'system'],
  ['testflight@apple.com', undefined, 'system'],
  ['nisha@indium.com', undefined, 'human'],
  ['jijo@indium.co', undefined, 'human'],
  ['andrianne@tiltingpoint.com', undefined, 'human'],
  ['john@example.com', undefined, 'human'],
  ['feedback@mail.slack.com', 'Your Weekly Slack Update', 'system'],
  ['notifications@slack.com', 'Your weekly digest', 'system'],
  ['clockify@notifications.com', undefined, 'system'],
  ['noreply@google.com', undefined, 'system'],
  ['comments-noreply@docs.google.com', undefined, 'system'],
]

let pass = 0
for (const [from, subj, expected] of tests) {
  const result = classifyEmail(from, subj)
  if (result === expected) {
    pass++
  } else {
    process.stderr.write(`FAIL: "${from}" expected ${expected} got ${result}\n`)
  }
}

process.stdout.write(`${pass}/${tests.length} tests passed\n`)
process.stdout.write(`SYSTEM_PATTERNS count: ${SYSTEM_PATTERNS.length}\n`)
process.stdout.write(`KEEP_SENDERS count: ${KEEP_SENDERS.length}\n`)

if (pass < tests.length) process.exit(1)
