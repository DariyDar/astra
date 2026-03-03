import { classifyEmail, SYSTEM_PATTERNS, KEEP_SENDERS } from '../src/kb/gmail-classifier.js'

// Tests use real sender addresses from production data (2026-03-04)
const tests: Array<[string, string | undefined, 'system' | 'human']> = [
  // System senders — real addresses
  ['TestFlight <no_reply@email.apple.com>', undefined, 'system'],
  ['App Store Connect <no_reply@email.apple.com>', undefined, 'system'],
  ['Clockify <clockify@mail.cake.com>', undefined, 'system'],
  ['noreply-play-developer-console@google.com', undefined, 'system'],
  ['noreply-analytics@google.com', undefined, 'system'],
  ['Atlassian <info@e.atlassian.com>', undefined, 'system'],
  ['ClickUp Team <team@mail.clickup.com>', undefined, 'system'],
  ['"Dariy Shatskikh (Google Docs)" <comments-noreply@docs.google.com>', undefined, 'system'],
  ['PagerDuty <no-reply@account.pagerduty.com>', undefined, 'system'],
  ['Mail Delivery Subsystem <mailer-daemon@googlemail.com>', undefined, 'system'],
  ['Slack <feedback@slack.com>', undefined, 'system'],
  ['Slack <no-reply@email.slackhq.com>', undefined, 'system'],
  ['Confluence <confluence@tiltingpoint.atlassian.net>', undefined, 'system'],
  ['Apple Developer <developer@insideapple.apple.com>', undefined, 'system'],
  ['Google Play Support <no-reply-googleplay-developer@google.com>', undefined, 'system'],
  // Slack weekly digest (special case)
  ['notifications@slack.com', 'Your weekly digest', 'system'],
  // Keep-senders — must be human despite indium/tiltingpoint
  ['Nisha  Ubaid <nisha.ubaid@indium.tech>', undefined, 'human'],
  ['Jijo M Mathews <jijo.m@indium.tech>', undefined, 'human'],
  ['Andrianne Gamulo <agamulo@tiltingpoint.com>', undefined, 'human'],
  // Regular human senders
  ['Arsen Chatalian <arsen@astrocat.co>', undefined, 'human'],
  ['Joseph Rousseau <jrousseau@tiltingpoint.com>', undefined, 'human'],
  ['john@example.com', undefined, 'human'],
  // Edge cases
  ['', undefined, 'human'],
  ['NOREPLY@APPLE.COM', undefined, 'system'],
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
