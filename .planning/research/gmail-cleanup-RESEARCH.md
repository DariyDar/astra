# Gmail Cleanup - Research

**Researched:** 2026-03-03
**Domain:** Gmail ingestion cleanup, system/human email classification
**Confidence:** HIGH

## Summary

Gmail ingestion produced 113,016 chunks from 2 accounts (~1228 emails, ~642 system). The cleanup goal: keep last 200 emails per account deep-indexed (full content), tag all emails as system vs human, convert rest to metadata-only stubs.

**Primary recommendation:** Create a classifier module for system sender patterns, a CLI cleanup script with `--dry-run`, and modify `toChunks()` to classify new emails inline.

## Key Findings

1. **No new dependencies needed.** Uses only existing: `@qdrant/js-client-rest`, `drizzle-orm`, `pg`, `pino`.

2. **Data model is well-suited.** Each email produces chunks with `source='gmail'`, `sourceId='{account}:{gmail_msg_id}'`, `metadata` JSONB containing `{account, gmail_id, from, to, subject}`. Chunk_index=0 has all metadata needed for classification.

3. **Three files to create/modify:**
   - `src/kb/gmail-classifier.ts` — shared classification logic (system sender patterns, keep-sender allowlist)
   - `src/kb/gmail-cleanup.ts` — standalone CLI script for one-time bulk cleanup with `--dry-run`
   - `src/kb/ingestion/gmail.ts` — modify `toChunks()` to classify new emails, metadata-only for system senders

4. **Metadata-only approach:** Keep chunk_index=0 as a stub. Replace body text with headers-only, set `qdrantId=null`, add `emailType` to metadata. Delete chunks with `chunk_index > 0` and Qdrant vectors for that sourceId.

5. **Expected impact:** ~75K chunks freed from both PostgreSQL and Qdrant. Gmail goes from 113K chunks to ~37K. Keeps 400 deep-indexed emails (200/account) and ~828 metadata stubs.

## System Sender Patterns

11 patterns for system senders (case-insensitive partial match on From header):

| Pattern | Matches |
|---------|---------|
| `noreply@` or `no-reply@` | Generic system senders |
| `testflight@apple.com` | TestFlight (207) |
| `appstoreconnect@apple.com` | App Store Connect (91) |
| `clockify` | Clockify (75) |
| `noreply@google` | Google Play Console (71) + Analytics (46) |
| `atlassian` | Atlassian (31) |
| `slack` + `weekly` | Slack weekly digests (27) |
| `clickup` | ClickUp (23) |
| `pagerduty` | PagerDuty (12) |
| `comments-noreply@docs.google.com` | Google Docs comments (19) |
| `spaces-noreply@google.com` | Spaces (10) |

### Keep-senders (NOT system — keep for project digests):
- Nisha / Jijo (Indium QA reports, 117 total)
- Andrianne Gamulo (Tilting Point EOD reports, 62 total)

## Classification Approach

```typescript
function classifyEmail(from: string): 'system' | 'human' {
  // 1. Check keep-senders first (Indium, Tilting Point reporters)
  if (KEEP_SENDERS.some(k => from.toLowerCase().includes(k))) return 'human'
  // 2. Check system patterns
  if (SYSTEM_PATTERNS.some(p => from.toLowerCase().includes(p))) return 'system'
  // 3. Default: human
  return 'human'
}
```

## Cleanup Execution Order

1. **Identify emails to downgrade:** Query distinct sourceIds, classify each, determine which are outside top-200-per-account
2. **Delete Qdrant vectors FIRST** (orphans are harmless)
3. **Delete PostgreSQL chunks** with chunk_index > 0
4. **Update chunk_index=0** stubs: replace text with headers-only, add `emailType` to metadata

## Common Pitfalls

### Pitfall 1: Qdrant/PG Inconsistency
Delete Qdrant first, then PG. If process crashes mid-way, orphan Qdrant vectors are harmless (wasted space, no wrong results). Orphan PG rows pointing to deleted Qdrant IDs would cause search errors.

### Pitfall 2: `from` Field Format Variation
Gmail `From` header can be `"Name <email@example.com>"` or just `email@example.com`. Use `.includes()` for pattern matching, not exact match.

### Pitfall 3: OOM During Bulk Operations
Don't load all 113K chunks at once. Process in batches of 100-500 sourceIds.

### Pitfall 4: "Last 200" Window Ambiguity
Sort by `sourceDate DESC` to get the 200 most recent emails per account, not by ingestion order.

### Pitfall 5: Entity Extraction Data
Check if any Gmail chunks have been entity-extracted before cleanup. If yes, preserve entity relations.

## Implementation Guidance

### Files to Create/Modify

| File | Change | Lines |
|------|--------|-------|
| `src/kb/gmail-classifier.ts` | NEW: system sender patterns, classify function | ~60 lines |
| `src/kb/gmail-cleanup.ts` | NEW: CLI script with --dry-run | ~150 lines |
| `src/kb/ingestion/gmail.ts` | MODIFY: inline classification in toChunks() | ~20 lines changed |

### Suggested Task Sequence

1. Create `gmail-classifier.ts` with patterns and classify function
2. Create `gmail-cleanup.ts` CLI script with --dry-run mode
3. Run with --dry-run to verify counts
4. Run actual cleanup
5. Modify `gmail.ts` toChunks() to classify new emails inline
6. Verify results

## Open Questions

1. Have any Gmail chunks been entity-extracted yet? (Likely not)
2. Should "last 200" be a constant or config? (Recommend: constant)
3. Will periodic re-pruning be needed? (Recommend: idempotent script, run manually)
4. Qdrant deletion performance for 800+ calls? (Estimate: 40-80s, acceptable)
