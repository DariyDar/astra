# Features Research: AI PM Assistant Products

**Project:** Astra — AI PM Assistant for Gamedev Company
**Dimension:** Features
**Date:** 2026-02-23
**Milestone:** Greenfield — What features do AI PM assistant products have?
**Researcher:** GSD Project Researcher Agent

---

## Research Scope

Products analyzed:
- **Lindy.ai** — AI-native workflow automation assistant (email, calendar, Slack, CRMs)
- **Dust.tt** — Enterprise AI assistant platform with RAG and custom agents
- **Reclaim.ai** — AI scheduling and time-block optimization
- **Motion** — AI-powered task/project planning with automatic scheduling
- **Custom-built PM bots** — Slack/Telegram bots with ClickUp, Notion, Jira integrations (open-source and bespoke builds)

Target context: Astra is a bilingual (Russian + English) AI PM assistant living in Telegram and Slack, integrating with ClickUp, Gmail, Google Calendar, Google Drive. Core capabilities include email triage, report generation, task management, ghost-writing, company knowledge base (RAG), self-learning, and self-extension.

---

## Feature Landscape Overview

### How competitors carve up the space

| Product | Core Positioning | Primary Surface | Strengths |
|---|---|---|---|
| Lindy.ai | Personal AI assistant + workflow automation | Email, Slack, web | Multi-step automations, meeting follow-ups, email drafting |
| Dust.tt | Enterprise knowledge + agent platform | Slack, web app | RAG quality, multi-source connectors, agent builder |
| Reclaim.ai | AI calendar/scheduling optimization | Google Calendar | Smart scheduling, habit protection, team coordination |
| Motion | AI task + project planning | Web app (own) | Auto-schedule tasks against calendar, priority sorting |
| Custom PM bots | Bespoke integrations for specific workflows | Slack, Telegram | Tight domain fit, no vendor lock-in |

---

## Table Stakes Features

> Must-have features. If Astra is missing these, users will immediately feel the product is incomplete or will not adopt it at all.

### 1. Natural Language Task Creation and Lookup
**What it is:** User sends a message like "create task: prepare GDD review by Friday, assign to Masha" and the bot creates it in the task tracker (ClickUp). User can also ask "what tasks are assigned to me today?"

**Why table stakes:** Every PM bot from the simplest to the most advanced does this. It is the entry-point interaction. Without it, there is no reason to talk to the bot at all.

**Complexity:** Low-Medium. Requires NLP intent parsing + ClickUp API. Edge cases: ambiguous assignees, date parsing across locales, Cyrillic names.

**Dependencies:** ClickUp integration, intent classifier, bilingual NLP.

---

### 2. Daily Standup / Status Digest
**What it is:** Bot proactively delivers a morning digest: tasks due today, overdue items, upcoming meetings, unread high-priority emails, and blockers.

**Why table stakes:** Reclaim, Motion, Lindy all have morning briefings. PMs context-switch constantly — a digest saves 15-30 min per day. Absence of this is felt immediately.

**Complexity:** Medium. Requires aggregating data from ClickUp + Google Calendar + Gmail. Needs scheduling (cron), template rendering, bilingual output.

**Dependencies:** ClickUp integration, Google Calendar integration, Gmail integration, message templating, scheduler.

---

### 3. Meeting Summary and Action Item Extraction
**What it is:** After a Google Meet / Zoom call, bot summarizes the transcript or notes and creates follow-up tasks in ClickUp.

**Why table stakes:** Lindy.ai's killer feature. Motion and Reclaim both integrate with meeting tools. PMs spend 40-60% of time in meetings — any tool that doesn't address meeting overhead is leaving the biggest pain untouched.

**Complexity:** Medium-High. Requires either Google Meet transcript access (via Google Workspace API) or user pasting notes. LLM summarization + task extraction + ClickUp task creation.

**Dependencies:** Google Calendar integration, ClickUp integration, LLM summarization pipeline.

---

### 4. Email Triage and Prioritization
**What it is:** Bot reads Gmail inbox, labels/categorizes emails (urgent, FYI, actionable, newsletter), surfaces the top 3-5 that need response today.

**Why table stakes:** Lindy.ai leads here. Any AI assistant for PMs that ignores email is incomplete — PMs receive 80-150 emails/day in gamedev (publisher comms, vendor negotiations, team updates, investor reports).

**Complexity:** Medium. Gmail API read access, LLM classification, priority scoring. Sensitive: reading email requires explicit user trust.

**Dependencies:** Gmail integration, LLM classification, user permission/trust model.

---

### 5. Task Status Updates via Natural Language
**What it is:** User says "mark task X as done" or "update progress on sprint review to 80%" and bot writes it to ClickUp.

**Why table stakes:** Read-only task lookup without write capability is frustrating. Users quickly abandon bots that can't act.

**Complexity:** Low. ClickUp API write + intent parsing.

**Dependencies:** ClickUp integration, intent classifier.

---

### 6. Calendar Event Lookup and Creation
**What it is:** "What do I have tomorrow?" or "Schedule a 1:1 with Dima on Thursday at 3pm" — bot reads/writes Google Calendar.

**Why table stakes:** Reclaim and Motion have trained users to expect calendar intelligence from AI tools. Missing this breaks the "assistant" promise.

**Complexity:** Low-Medium. Google Calendar API read/write. Conflict detection is medium complexity.

**Dependencies:** Google Calendar integration, bilingual date/time parsing.

---

### 7. Bilingual Interaction (Russian + English)
**What it is:** Bot understands and responds in both Russian and English, auto-detects language per message, maintains consistency within a conversation.

**Why table stakes:** Astra's target is a Russian-language gamedev company. A bot that stumbles on Cyrillic task names, mixed-language messages, or translates poorly between contexts is dead on arrival.

**Complexity:** Medium. LLM handles this well but requires: Cyrillic name/entity handling, locale-aware date formats (DD.MM.YYYY vs MM/DD/YYYY), bilingual prompt templates, proper Telegram/Slack encoding.

**Dependencies:** All features — bilingual is a cross-cutting concern.

---

### 8. ClickUp Project/Space Navigation
**What it is:** Bot knows the company's ClickUp structure (spaces, folders, lists) and can navigate it without the user specifying IDs. "Show me all tasks in the GDD Sprint" works without knowing the list ID.

**Why table stakes:** If users must look up IDs or use complex queries to get basic info, they'll go back to ClickUp directly.

**Complexity:** Medium. Requires ClickUp hierarchy sync + fuzzy name matching.

**Dependencies:** ClickUp integration, local state/cache of ClickUp structure.

---

## Differentiating Features

> Features that create competitive advantage for Astra. Not every competitor does these, or they do them poorly. Getting these right builds loyalty and word-of-mouth.

### 9. Ghost-Writing for Slack DMs and Gmail
**What it is:** User describes what they want to say ("tell Andrey the build is delayed, be diplomatic, mention we'll compensate with extra polish time") and bot drafts the full message in the appropriate tone, style, and language. User reviews and sends.

**Why differentiating:** Lindy.ai does email drafting but with generic tone. Dust.tt does not do outbound ghost-writing. No competitor does this for Slack DMs + Gmail in one place with company-context awareness (knowing who Andrey is, what project is being discussed, what tone is appropriate).

**Complexity:** High. Requires: user persona/relationship graph, company context from RAG, multi-turn refinement, tone calibration, bilingual drafting with style matching.

**Dependencies:** RAG knowledge base, user relationship context, Gmail integration, Slack integration.

**Gamedev specificity:** PMs in gamedev write a lot of sensitive stakeholder comms — publisher updates, investor reports, team morale messages. Ghost-writing with context is extremely high-value.

---

### 10. Company Knowledge Base (RAG)
**What it is:** Astra ingests Google Drive documents (GDDs, postmortems, sprint reports, wikis) and answers questions like "what was the decision on the combat system rewrite?" or "find the latest publisher deliverables schedule."

**Why differentiating:** Dust.tt does this best in the market, but it requires significant setup and is not Telegram/Slack-native in the same way. Astra can own this for gamedev companies by making it zero-friction to query drive docs from where PMs already work.

**Complexity:** High. Requires: Google Drive sync pipeline, chunking strategy, embedding model, vector store, retrieval pipeline, LLM synthesis, citation of source documents, incremental updates.

**Dependencies:** Google Drive integration, vector database, embedding pipeline, LLM.

**Gamedev specificity:** Gamedev companies accumulate large amounts of design documentation, build logs, postmortems, and creative briefs. This is unusually high-density institutional knowledge that PMs regularly need to reference.

---

### 11. Weekly/Sprint Report Auto-Generation
**What it is:** Bot pulls data from ClickUp (completed tasks, velocity, blockers), Gmail (key decisions, stakeholder updates), and Calendar (meetings held) and drafts a structured weekly or sprint report.

**Why differentiating:** No competitor does this with multi-source aggregation + draft delivery to Google Docs or Slack. Motion and Reclaim have basic productivity summaries but nothing report-quality. This saves PMs 2-4 hours per week.

**Complexity:** High. Requires: ClickUp data aggregation, Gmail context extraction, Calendar event analysis, structured LLM generation, Google Docs write API.

**Dependencies:** ClickUp integration, Gmail integration, Google Calendar integration, Google Drive/Docs integration, report template system.

---

### 12. Self-Learning from User Corrections
**What it is:** When a user edits a bot-drafted message, the bot learns the correction ("I prefer more formal tone with publishers" or "always CC the producer"). Over time, drafts require less editing.

**Why differentiating:** No current off-the-shelf product does genuine preference learning from corrections in a PM assistant context. Lindy.ai has memory but it is manual. This is a key moat.

**Complexity:** Very High. Requires: correction detection pipeline, preference extraction from diffs, user preference store, preference injection into prompts, feedback loop validation.

**Dependencies:** Ghost-writing feature, RAG, user profile store.

**Risk:** Preference drift, conflicting signals, privacy (storing corrections).

---

### 13. Self-Extension via Natural Language
**What it is:** User says "I want you to automatically notify me whenever a ClickUp task is marked overdue for more than 2 days" — and Astra creates a new automation without code.

**Why differentiating:** Lindy.ai has a visual workflow builder but requires significant setup. Dust.tt has an agent builder but it is technical. Astra's differentiator is conversational automation creation — no UI needed.

**Complexity:** Very High. Requires: intent-to-automation parser, automation DSL or runtime, trigger management (webhooks, polling), storage, execution engine, testing/validation of user-defined rules.

**Dependencies:** All integrations, scheduler/automation engine, user trust/permission model.

**Risk:** Runaway automations, permission escalation, user errors creating broken rules.

---

### 14. Cross-Integration Context Linking
**What it is:** Astra connects signals across systems. Example: "The meeting with Anton on Tuesday mentioned the auth bug — here's the related ClickUp task, and the email thread about it."

**Why differentiating:** Every tool provides data in isolation. No competitor synthesizes cross-system context automatically. This is the "second brain" capability that PMs describe wanting but don't have.

**Complexity:** Very High. Requires: entity extraction across all systems (people, projects, topics), cross-system linking logic, temporal correlation, context graph.

**Dependencies:** All integrations, RAG, entity resolution.

---

### 15. Gamedev-Specific Report Templates
**What it is:** Pre-built templates for common gamedev PM artifacts: GDD progress reports, milestone delivery summaries, publisher status updates, postmortem digests, gold submission checklists.

**Why differentiating:** Generic PM tools have generic report structures. Astra can ship with templates that match how gamedev PMs think and what publishers/stakeholders expect. No horizontal tool does this.

**Complexity:** Low (template design) + Medium (integration to populate them).

**Dependencies:** Report generation feature, ClickUp integration, Google Docs integration.

---

### 16. Proactive Blocker Detection
**What it is:** Astra monitors ClickUp task dependencies and flags when a task that blocks others has been sitting "in progress" for more than N days. It then drafts a Slack message to the assignee asking for a status update.

**Why differentiating:** Reclaim detects scheduling conflicts. No competitor detects project-level blockers proactively and then acts on them. This is high-value for gamedev where milestone slippage is a major risk.

**Complexity:** Medium-High. Requires: ClickUp dependency graph traversal, configurable threshold rules, Slack message drafting, user approval flow.

**Dependencies:** ClickUp integration, Slack integration, ghost-writing, automation engine.

---

### 17. Onboarding Knowledge Capture
**What it is:** When a new team member joins, Astra can give them a curated knowledge briefing: "Here are the 5 most important Drive docs for your role, the active ClickUp tasks, and the recurring meetings you'll be in."

**Why differentiating:** No competitor addresses team onboarding as a PM assistant use case. In gamedev, project context is deep and onboarding is slow.

**Complexity:** Medium. Requires: RAG + ClickUp query + Calendar query + role-based filtering.

**Dependencies:** RAG knowledge base, ClickUp integration, Google Calendar integration.

---

## Anti-Features

> Things Astra should deliberately NOT build, at least in the initial phases. These are either complexity sinks, outside the target use case, or traps that distract from core value.

### Anti-Feature 1: Own Task Tracker / Project Board
**Do not build:** A custom Kanban board or task management UI inside Astra.

**Why not:** ClickUp already exists and users are invested in it. Building a competing UI creates a migration problem and doubles the maintenance burden. Astra's value is as a layer on top of existing tools, not a replacement. Competitors like Motion that try to replace the task tracker end up with adoption friction because users don't want to move their data.

---

### Anti-Feature 2: Voice / Audio Transcription (Phase 1)
**Do not build:** Own meeting recording, voice transcription, or audio processing pipeline.

**Why not:** This is a specialized, expensive domain (Whisper API costs, storage, legal compliance around recording). Better to integrate with existing tools (Otter.ai, Google Meet transcripts) when transcription already exists. Scope creep risk is high.

---

### Anti-Feature 3: Mobile App (Phase 1)
**Do not build:** Native iOS/Android app.

**Why not:** Telegram and Slack already have excellent mobile apps. Astra lives inside them. A standalone mobile app requires separate auth flows, push notification infrastructure, UI/UX design, and app store compliance — none of which add value if the bot interface already works on mobile.

---

### Anti-Feature 4: HR / Performance Management Features
**Do not build:** Employee performance tracking, 1:1 note templates tied to HR records, salary/compensation tooling.

**Why not:** This is a separate product category (Lattice, Leapsome). Mixing PM workflow tooling with HR tooling creates role confusion, privacy concerns, and takes focus away from project execution. Gamedev PMs do not want their project tool near HR data.

---

### Anti-Feature 5: Public-Facing Integration Marketplace
**Do not build:** A public plugin store or marketplace for third-party integrations.

**Why not:** Building a marketplace requires: partner program, API stability guarantees, security review of third-party code, documentation, and support. This is appropriate at scale (post-PMF). For Astra's initial scope, the defined integrations (ClickUp, Gmail, Google Calendar, Google Drive, Slack, Telegram) are sufficient.

---

### Anti-Feature 6: Multi-Tenant SaaS with Self-Serve Billing
**Do not build:** Multi-tenant cloud product with public signup, subscription billing, and tenant isolation.

**Why not:** Astra is being built for a specific gamedev company first. Prematurely building SaaS infrastructure (billing, tenant isolation, compliance certifications, support tiers) before validating the core product is a classic premature scaling trap. If Astra proves value and goes to market, this can be added.

---

### Anti-Feature 7: Full Email Client UI
**Do not build:** Inbox view, email composer UI, thread management inside Telegram or Slack.

**Why not:** Users have Gmail for this. Astra's email role is triage + drafting assistance, not replacing the email client. Building a full email UI inside a chat bot would be terrible UX and a massive scope expansion.

---

## Feature Dependency Map

```
Core Infrastructure
├── Bilingual NLP (cross-cutting — all features depend on this)
├── ClickUp Integration
│   ├── Task Creation/Lookup [Table Stakes #1, #5]
│   ├── ClickUp Navigation [Table Stakes #8]
│   ├── Sprint Report Generation [Differentiator #11]
│   ├── Proactive Blocker Detection [Differentiator #16]
│   └── Self-Extension Automations [Differentiator #13]
├── Gmail Integration
│   ├── Email Triage [Table Stakes #4]
│   ├── Ghost-Writing Gmail [Differentiator #9]
│   └── Sprint Report Generation [Differentiator #11]
├── Google Calendar Integration
│   ├── Daily Digest [Table Stakes #2]
│   ├── Calendar Event Lookup/Create [Table Stakes #6]
│   ├── Meeting Summary + Action Items [Table Stakes #3]
│   └── Sprint Report Generation [Differentiator #11]
├── Google Drive Integration
│   ├── RAG Knowledge Base [Differentiator #10]
│   │   ├── Ghost-Writing (needs company context) [Differentiator #9]
│   │   ├── Cross-Integration Context Linking [Differentiator #14]
│   │   └── Onboarding Knowledge Capture [Differentiator #17]
│   └── Report Auto-Generation (writes to Docs) [Differentiator #11]
├── Slack Integration
│   ├── Ghost-Writing Slack DMs [Differentiator #9]
│   └── Proactive Blocker Detection (sends via Slack) [Differentiator #16]
└── Telegram Integration
    ├── All user interaction (primary interface)
    └── Daily Digest delivery [Table Stakes #2]

Advanced (Phase 2+)
├── Self-Learning from Corrections [Differentiator #12]
│   └── Depends on: Ghost-writing, RAG, User Profile Store
└── Self-Extension via Natural Language [Differentiator #13]
    └── Depends on: All integrations, Automation Engine
```

---

## Complexity Summary

| Feature | Category | Complexity | Phase |
|---|---|---|---|
| Natural Language Task Creation/Lookup | Table Stakes | Low-Medium | Phase 1 |
| Daily Standup / Status Digest | Table Stakes | Medium | Phase 1 |
| Meeting Summary + Action Items | Table Stakes | Medium-High | Phase 1 |
| Email Triage and Prioritization | Table Stakes | Medium | Phase 1 |
| Task Status Updates | Table Stakes | Low | Phase 1 |
| Calendar Event Lookup/Create | Table Stakes | Low-Medium | Phase 1 |
| Bilingual Interaction (RU+EN) | Table Stakes | Medium (cross-cutting) | Phase 1 |
| ClickUp Project/Space Navigation | Table Stakes | Medium | Phase 1 |
| Ghost-Writing for Slack/Gmail | Differentiator | High | Phase 1-2 |
| Company Knowledge Base (RAG) | Differentiator | High | Phase 1-2 |
| Weekly/Sprint Report Auto-Generation | Differentiator | High | Phase 2 |
| Self-Learning from Corrections | Differentiator | Very High | Phase 3 |
| Self-Extension via Natural Language | Differentiator | Very High | Phase 3 |
| Cross-Integration Context Linking | Differentiator | Very High | Phase 3 |
| Gamedev-Specific Report Templates | Differentiator | Low-Medium | Phase 1-2 |
| Proactive Blocker Detection | Differentiator | Medium-High | Phase 2 |
| Onboarding Knowledge Capture | Differentiator | Medium | Phase 2 |

---

## Key Insight: The Differentiation Stack

Horizontal AI assistants (Lindy, Dust) are **general-purpose**. Their differentiation is breadth. Astra's opportunity is **depth + domain specificity**:

1. **Gamedev language and context** — GDDs, milestones, publisher comms, build pipelines. No horizontal tool speaks this natively.
2. **Russian-first bilingual** — No competitor optimizes for Russian-language gamedev teams. This is a geographic and linguistic moat.
3. **Lives where the team works** — Telegram + Slack, not a new app. This is underrated. PM tools that require context-switching die.
4. **Ghost-writing with organizational memory** — Lindy drafts generic emails. Astra drafts knowing who Anton is, what project is at risk, and what tone the company uses with that publisher.
5. **Self-extension** — The ability for the PM to teach the bot new automations conversationally is a compounding moat. The longer they use it, the more it fits their workflow.

The risk is over-building differentiators before table stakes are solid. Users will leave if the basic task management and digest functions are unreliable, regardless of how impressive the RAG or ghost-writing is.

---

## Sources

This analysis is based on training knowledge (cutoff August 2025) covering:
- Lindy.ai product documentation and feature announcements
- Dust.tt product documentation and GitHub (open-source components)
- Reclaim.ai feature pages and user reviews (G2, Product Hunt)
- Motion.so feature pages and user reviews
- Custom PM bot implementations documented on GitHub, Hacker News, and community forums (Slack API community, Telegram Bot API community)
- PM community discussions on Reddit (r/projectmanagement), Lenny's Newsletter, and Shreyas Doshi's frameworks on PM tooling
