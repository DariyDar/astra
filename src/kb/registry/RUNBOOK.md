# Knowledge Registry — Data Collection Runbook

## Purpose
Step-by-step instructions for collecting structured project data from Slack, Notion, Google Drive, and web sources. Used by agents to build project YAML files in `src/kb/registry/projects/`.

## Prerequisites
- SSH access: `clawdbot@91.98.194.94`, dir: `~/personal-assistant`
- DB: `docker exec -i personal-assistant-postgres-1 psql -U astra -d astra`
- Personal Slack tokens in `.env`: `SLACK_AC_USER_TOKEN`, `SLACK_HG_USER_TOKEN` (xoxp-*)
- Bot tokens: `SLACK_AC_BOT_TOKEN`, `SLACK_HG_BOT_TOKEN` (xoxb-*)
- Slack Connect guests can ONLY be resolved via personal (xoxp) tokens, NOT bot tokens

## SQL Query Pattern
```bash
ssh clawdbot@91.98.194.94 bash -s <<'REMOTE'
cat > /tmp/q.sql << 'SQL'
YOUR QUERY HERE;
SQL
cd ~/personal-assistant && docker exec -i personal-assistant-postgres-1 psql -U astra -d astra -t < /tmp/q.sql
REMOTE
```

## Step 1: Find All Project Channels

```sql
SELECT metadata->>'channel' as ch, count(*) as cnt
FROM kb_chunks WHERE source='slack'
AND (metadata->>'channel' LIKE '%PROJECT_KEYWORD%')
GROUP BY ch ORDER BY cnt DESC;
```

Include aliases: e.g., for SpongeBob search `%sponge%`, `%sbkco%`, `%sb%`, `%kco%`.

## Step 2: List All Users in Project Channels

```sql
SELECT metadata->>'user' as u, count(*) as cnt
FROM kb_chunks WHERE source='slack'
AND metadata->>'channel' IN ('channel1', 'channel2', ...)
GROUP BY u ORDER BY cnt DESC;
```

Separate into:
- **Resolved names** (AC/HG team members)
- **Unresolved UIDs** (U-prefixed, external/Slack Connect guests)

## Step 3: Resolve External UIDs

Use PERSONAL Slack tokens (xoxp-*), NOT bot tokens:

```bash
ssh clawdbot@91.98.194.94 bash -s <<'REMOTE'
cd ~/personal-assistant
AC_TOKEN=$(grep SLACK_AC_USER_TOKEN .env | cut -d= -f2)
HG_TOKEN=$(grep SLACK_HG_USER_TOKEN .env | cut -d= -f2)

for uid in UID1 UID2 UID3; do
  result=$(curl -s "https://slack.com/api/users.info?user=$uid" -H "Authorization: Bearer $AC_TOKEN" 2>/dev/null)
  name=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); u=d.get('user',{}); p=u.get('profile',{}); rn=p.get('real_name_normalized','') or u.get('real_name',''); dn=p.get('display_name',''); print(f'{rn} | display:{dn}')" 2>/dev/null)
  if [ -z "$name" ] || echo "$name" | grep -q "^ |"; then
    result=$(curl -s "https://slack.com/api/users.info?user=$uid" -H "Authorization: Bearer $HG_TOKEN" 2>/dev/null)
    name=$(echo "$result" | python3 -c "import json,sys; d=json.load(sys.stdin); u=d.get('user',{}); p=u.get('profile',{}); rn=p.get('real_name_normalized','') or u.get('real_name',''); dn=p.get('display_name',''); print(f'{rn} | display:{dn}')" 2>/dev/null)
  fi
  echo "$uid = $name"
done
REMOTE
```

## Step 4: Determine Roles from Messages

For each external person, read 5-10 of their messages to understand their role:

```sql
SELECT substring(text, 1, 300)
FROM kb_chunks WHERE source='slack'
AND metadata->>'channel' LIKE '%PROJECT%'
AND metadata->>'user' = 'THE_UID'
ORDER BY source_date DESC LIMIT 10;
```

Also check: who mentions them, in what context, what they discuss.

## Step 5: Find Project Resources

### Notion docs
```sql
SELECT DISTINCT metadata->>'title', metadata->>'url'
FROM kb_chunks WHERE source='notion'
AND (text ILIKE '%PROJECT_NAME%' OR metadata->>'title' ILIKE '%PROJECT_KEYWORD%')
LIMIT 20;
```

### Google Drive docs
```sql
SELECT DISTINCT metadata->>'fileName', metadata->>'url', metadata->>'mimeType'
FROM kb_chunks WHERE source='drive'
AND (metadata->>'fileName' ILIKE '%PROJECT_KEYWORD%'
  OR text ILIKE '%PROJECT_NAME%')
LIMIT 20;
```

## Step 6: Find Regular Processes

Search for recurring patterns in messages:
```sql
SELECT substring(text, 1, 300) FROM kb_chunks
WHERE source='slack' AND metadata->>'channel' LIKE '%PROJECT%'
AND (text ILIKE '%standup%' OR text ILIKE '%weekly%' OR text ILIKE '%every monday%'
  OR text ILIKE '%release%' OR text ILIKE '%deploy%' OR text ILIKE '%checklist%'
  OR text ILIKE '%buddy%' OR text ILIKE '%review%')
LIMIT 20;
```

## Step 7: Web Research for External People

For key external people (executives, leads), search the web:
- LinkedIn, ZoomInfo, TheOrg, Wiza
- Confirm title/role at the company
- Note: some may have left the company

## Step 8: Cross-reference with kb-people-v3.txt

Read `kb-people-v3.txt` at `c:\Users\dimsh\Downloads\Personal Assistant\kb-people-v3.txt`.
It contains 88 team members with:
- Full names and aliases
- Company affiliation
- Project assignments with roles
- Status (active/left)
- Historical facts

## Required Output Format

Generate a YAML file following the structure of `star-trek-timelines.yaml`:
- Project metadata (name, aliases, company, client, platform, tech_stack)
- slack_channels with descriptions
- team_internal (our people, with role and status)
- team_external grouped by company (with name, role, slack_uids, status)
- processes (name, cadence, description, participants, channel, docs with URLs)
- resources (name, type, url, description)

## Important Notes
- Do NOT guess roles — derive from message content
- Mark people as `status: left` if they haven't posted in 6+ months or if known to have left
- Some people have 2 UIDs (one per workspace) — always check both AC and HG
- The Jira bug bot (U5DJPRVK9) auto-posts bug creations — exclude from people list
- Slackbot and 'unknown' should be excluded
- Internal teammates may appear with full English names in Slack but Russian names in seed
