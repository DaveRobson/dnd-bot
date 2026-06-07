# Persistence — Design Spec
_2026-06-07_

## Overview

Add Railway Postgres persistence to the D&D bot so all campaign state, character data, gameplay history, story arcs, NPC/party relationships, and campaign lore survive bot restarts. The in-memory Maps remain the runtime source of truth; the database backs them via a write-through pattern with a full load on startup.

---

## Architecture

A new `db.js` module owns all Postgres interaction. `index.js` calls named functions from `db.js` — it never writes SQL directly. The seven in-memory Maps are unchanged; persistence is an explicit layer around them.

**New file:** `db.js`
**Modified file:** `index.js`

---

## Database Schema

Four tables, created automatically via `initDb()` on bot startup:

```sql
CREATE TABLE IF NOT EXISTS channel_state (
  channel_id TEXT PRIMARY KEY,
  theme      TEXT,
  turn_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS campaign (
  channel_id    TEXT PRIMARY KEY,
  status        TEXT,       -- 'configuring' | 'ready'
  brief         TEXT,       -- raw ## CAMPAIGN BRIEF output, immutable after setup
  lore          TEXT,       -- living world document, seeded at !start_campaign
  story_arcs    JSONB,      -- active/resolved narrative arcs
  relationships JSONB       -- NPC and party relationships
);

CREATE TABLE IF NOT EXISTS characters (
  channel_id     TEXT,
  user_id        TEXT,
  character_name TEXT,
  display_name   TEXT,
  sheet          TEXT,      -- NULL if set via !character only, populated after !create_character
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  channel_id TEXT PRIMARY KEY,
  history    JSONB DEFAULT '[]'
);
```

### Notes
- Campaign setup Q&A history is **discarded** once `[CAMPAIGN READY]` fires — only the brief is saved
- `characters` covers both `readyCharacters` and `characterNames` Maps: all rows populate `characterNames`; rows with non-null `sheet` also populate `readyCharacters`
- `chat_sessions.history` is the already-trimmed (≤50 turns) and auto-summarised Gemini history — never raw unbounded growth
- `story_arcs` and `relationships` are updated by the summarisation call every 10 turns, not by raw gameplay turns

---

## db.js Exports

```javascript
initDb()                   // CREATE TABLE IF NOT EXISTS for all tables
loadAll(Maps...)           // load all rows into the seven in-memory Maps
saveChannelState(channelId, theme, turnCount)
saveCampaign(channelId, fields)  // upsert: status, brief, lore, story_arcs, relationships
saveCharacter(channelId, userId, { characterName, displayName, sheet })
deleteCampaignAndChars(channelId)  // used by !setup_campaign re-run
saveChatSession(channelId, history)
clearChannel(channelId)    // delete all rows for channel (used by !set_theme, !wipe_memory)
```

Postgres connection via `pg` package reading `DATABASE_URL` from Railway's injected environment variable.

---

## Startup Behaviour

In `client.once('ready', ...)`:
1. `await db.initDb()` — creates tables if they don't exist
2. `await db.loadAll(chatSessions, channelThemes, characterNames, turnCounts, campaignConfig, readyCharacters)` — populates all Maps from DB
3. Bot logs ready — state fully restored, players see no interruption

---

## Save Points

| Event | DB call |
|---|---|
| `!set_theme` | `clearChannel()` |
| `!wipe_memory` | `clearChannel()` |
| `!setup_campaign` re-run | `deleteCampaignAndChars()` |
| `[CAMPAIGN READY]` detected | `saveCampaign()` — status + brief only; Q&A history discarded |
| `[CHARACTER READY]` detected | `saveCharacter()` — full sheet |
| `!character <name>` | `saveCharacter()` — name + displayName, sheet: null |
| `!start_campaign` success | `saveChannelState()` + `saveCampaign()` (initial lore) + `saveChatSession()` |
| After each gameplay response | `saveChatSession()` |
| Every 10 turns (summarisation) | `saveChatSession()` + `saveCampaign()` (story_arcs, relationships, lore) |

---

## Enhanced Summarisation

The existing `summariseSession()` function (triggered every 10 turns) gets a new dedicated prompt. It replaces the current mechanical-state-only prompt with one that returns four clearly delimited sections:

```
## HISTORY SUMMARY
[Compressed Gemini history context — replaces raw turns in chatSessions]

## STORY ARCS
[Active arcs with current status, resolved arcs, new developments]

## RELATIONSHIPS
[Party members and NPCs — alliances, tensions, history between characters]

## LORE UPDATES
[New locations discovered, factions encountered, world details established]
```

**Prompt principles:**
- Focus on narrative significance: story beats, character moments, betrayals, alliances — not just HP and inventory
- Only record what is explicitly established in the conversation — no invention
- Each section concise but complete enough to fully brief a new DM

**After the call**, the bot:
1. Parses the four sections by `## HEADER`
2. Replaces compressed history in `chatSessions` (existing behaviour)
3. Saves `story_arcs`, `relationships`, and updated `lore` to the `campaign` table
4. Injects current `story_arcs` and `relationships` into the gameplay system prompt so the DM has full narrative context on every response

---

## Initial Lore Generation

At `!start_campaign`, before the opening narration, a lightweight dedicated Gemini call takes the campaign brief + all character sheets and generates the opening `lore` document: world overview, key factions, starting location detail, and tone. This seeds the `campaign.lore` column before the first gameplay turn.

---

## Gameplay System Prompt Changes

`buildSystemPrompt()` is updated to accept an optional `campaignState` parameter `{ lore, storyArcs, relationships }`. When present, a `[CAMPAIGN STATE]` block is prepended to the rules content:

```
[CAMPAIGN STATE]
Story Arcs: <story_arcs>
Relationships: <relationships>
```

Call sites in the gameplay handler and `!start_campaign` pass `campaignConfig.get(channelId)` data through. When no campaign state exists (e.g. manual `!set_theme` flow), the prompt falls back to rules-only as before.

---

## What Doesn't Change

- The seven in-memory Maps remain the runtime source of truth
- `MAX_HISTORY = 50` and `SUMMARY_INTERVAL = 10` are unchanged
- `creationSessions` is not persisted (tied to Discord thread IDs that may be archived)
- All existing commands and handlers work identically — persistence is additive
