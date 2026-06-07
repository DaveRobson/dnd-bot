# Campaign & Character Creation Flow — Design Spec
_2026-06-07_

## Overview

Add a guided pre-session flow to the D&D bot: a Gemini-driven campaign setup conversation in the main channel, followed by per-player character creation in private Discord threads, capped by a `!start_campaign` command that compiles everything and kicks off the opening narration.

---

## Commands

| Command | Available when | Behaviour |
|---|---|---|
| `!setup_campaign` | Any time | Posts onboarding message, starts campaign Q&A in main channel |
| `!create_character` | After campaign is configured | Opens a private thread, starts character creation for that player |
| `!party` | Any time | Lists all ready characters for this channel |
| `!start_campaign` | Campaign ready + ≥1 character ready | Posts public briefing, then kicks off opening narration |

---

## Phase Flow

```
!setup_campaign
  → bot posts onboarding message explaining the full flow
  → Gemini Q&A runs in main channel (campaign designer persona)
  → bot detects [CAMPAIGN READY] sentinel
  → stores campaign brief, marks status 'ready'
  → announces: "Campaign configured. Players: run !create_character to build your character."

!create_character (each player, after campaign is ready)
  → bot creates a private thread: "Character Creation — <DisplayName>"
  → Gemini character guide runs in that thread
  → player chooses lightweight (3–4 questions) or full 5e (8–12 questions)
  → bot detects [CHARACTER READY] sentinel
  → stores character sheet in readyCharacters
  → announces in main channel: "⚔️ <CharacterName> is ready."

!start_campaign (any player, once campaign + ≥1 character ready)
  → validates prerequisites, replies with specific error if not met
  → posts public briefing in main channel (title, tone, setting, party roster)
  → compiles opening context (campaign brief + all character sheets)
  → makes first Gemini narration call
  → session is live
```

---

## State

Three new Maps added alongside existing ones in `index.js`:

```javascript
const campaignConfig = new Map();
// channelId -> { status: 'configuring'|'ready', brief: string, history: [] }

const creationSessions = new Map();
// threadId -> { userId, channelId, history: [] }

const readyCharacters = new Map();
// channelId -> Map(userId -> { displayName, sheet })
```

`!set_theme` and `!wipe_memory` reset all three Maps for the channel.

---

## Message Routing

```
messageCreate
  → ignore bots
  → if !command → command handler
  → if channel message AND campaignConfig.status === 'configuring' → campaign setup handler
  → if thread message AND threadId in creationSessions → character creation handler
  → if channel message AND theme set → gameplay handler (existing)
```

Thread detection uses `message.channel.isThread()` — no new Discord intents required, but the bot needs `CREATE_PUBLIC_THREADS` and `SEND_MESSAGES_IN_THREADS` permissions in the channel. Threads are public (visible to anyone who can see the parent channel) — this avoids the extra `USE_PRIVATE_THREADS` permission and is sufficient since creation threads are separate from the main channel flow.

---

## Gemini Prompts

### Campaign Setup (`CAMPAIGN_SETUP_PROMPT`)
- Persona: enthusiastic campaign designer
- Asks 4–5 questions, one or two at a time: adventure type, tone, difficulty, themes to include/avoid, starting hook
- Outputs `## CAMPAIGN BRIEF` block with: Title, Tone, Setting, Hook, Opening Scene, Key Threats, Objectives
- Ends with sentinel: `[CAMPAIGN READY]`
- Parameters: `temperature: 0.5, topP: 0.9, topK: 50`

### Character Creation (`CHARACTER_CREATION_PROMPT`)
- Persona: friendly 5e guide
- Opens with concept question, then offers lightweight vs full 5e path
- **Lightweight:** name, concept, class — 3–4 exchanges
- **Full 5e:** race, class, background, ability scores (standard array or rolled), equipment — 8–12 exchanges
- Both paths output `## CHARACTER SHEET` block with: Name, Race, Class, Background, Ability Scores, HP, Proficiencies, Starting Equipment, Backstory
- Ends with sentinel: `[CHARACTER READY]`
- Parameters: `temperature: 0.5, topP: 0.9, topK: 50`

Sentinels are stripped before sending responses to Discord — players never see them.

---

## `!start_campaign` Compilation

Opening context injected as first history entry:

```
[CAMPAIGN CONFIGURATION]
<full campaign brief>

[PARTY]
<character sheet 1>
<character sheet 2>
...

Begin the session. Narrate the opening scene. Address each character by name. Set the tone immediately.
```

**Testing temperatures:**
- Opening narration: `temperature: 0.7` (stress-test guardrails, assess narrative quality)
- Gameplay: `temperature: 0.4` (surface hallucination weaknesses)

**Production temperatures (after testing):**
- Opening narration: `0.4`
- Gameplay: `0.2`

Theme is automatically set to `'fantasy'` when `!start_campaign` runs, making the session live immediately.

---

## Public Briefing Format (`!start_campaign`)

```
📜 CAMPAIGN: <Title>
Tone: <Tone>
Setting: <Setting>

PARTY
──────────────────
<CharacterName> — <Race> <Class>, Level 1
<CharacterName> — <Race> <Class>, Level 1

The adventure begins...
```

---

## Onboarding Message (`!setup_campaign`)

```
Starting campaign setup. I'll ask a few questions to design your adventure.

Once we're done:
• Each player runs !create_character to build their character in a private thread
• When everyone's ready, any player runs !start_campaign to begin

Let's build your world.
```

---

## Error States

| Situation | Response |
|---|---|
| `!create_character` before campaign configured | "Set up the campaign first with `!setup_campaign`." |
| `!create_character` when player already has an active thread | "You already have a character creation thread: <#threadId>." |
| `!setup_campaign` when campaign already configured | Resets config and starts fresh (same behaviour as `!set_theme`) |
| `!start_campaign` with no campaign | "No campaign configured. Run `!setup_campaign` first." |
| `!start_campaign` with no characters | "No characters ready yet. Players should run `!create_character`." |
| Thread creation fails | Reply in channel with error, do not create session entry |

---

## What Doesn't Change

- All existing gameplay commands (`!set_theme`, `!wipe_memory`, `!character`) remain unchanged
- `!help` is updated to include the four new commands
- The chain-of-thought prompts, guardrails, and auto-summarisation all apply once the session starts
- `MAX_HISTORY` and `SUMMARY_INTERVAL` are unchanged
