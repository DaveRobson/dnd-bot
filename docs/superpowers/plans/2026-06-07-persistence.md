# Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Railway Postgres persistence so all campaign state, character data, gameplay history, story arcs, relationships, and lore survive bot restarts.

**Architecture:** A new `db.js` module owns all Postgres interaction via the `pg` package. `index.js` calls named db functions — it never writes SQL. In-memory Maps remain the runtime source of truth; the DB backs them via write-through with a full load on startup. The existing `summariseSession()` is upgraded to a four-section structured prompt that also extracts and persists story arcs, NPC relationships, and lore updates every 10 turns.

**Tech Stack:** Node.js (ESM), `pg` (Postgres client), Railway Postgres (DATABASE_URL injected automatically).

---

## File Structure

- **Create:** `db.js` — Postgres pool, schema init, all load/save/clear functions
- **Modify:** `index.js` — import db, startup wiring, save calls at each mutation point, enhanced summarisation, updated `buildSystemPrompt`
- **Modify:** `package.json` — add `pg` dependency

---

## Task 1: Create db.js with schema, save, and clear functions

**Files:**
- Create: `/Users/drobson/Developer/code/dnd-bot/db.js`
- Modify: `/Users/drobson/Developer/code/dnd-bot/package.json`

- [ ] **Step 1: Install pg**

```bash
cd /Users/drobson/Developer/code/dnd-bot && npm install pg
```
Expected: `added N packages` with no errors.

- [ ] **Step 2: Create db.js**

Create `/Users/drobson/Developer/code/dnd-bot/db.js` with the full content below:

```javascript
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

export async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS channel_state (
            channel_id TEXT PRIMARY KEY,
            theme      TEXT,
            turn_count INTEGER DEFAULT 0
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS campaign (
            channel_id    TEXT PRIMARY KEY,
            status        TEXT,
            brief         TEXT,
            lore          TEXT,
            story_arcs    JSONB,
            relationships JSONB
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS characters (
            channel_id     TEXT,
            user_id        TEXT,
            character_name TEXT,
            display_name   TEXT,
            sheet          TEXT,
            PRIMARY KEY (channel_id, user_id)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_sessions (
            channel_id TEXT PRIMARY KEY,
            history    JSONB DEFAULT '[]'
        )
    `);
}

export async function saveChannelState(channelId, theme, turnCount) {
    await pool.query(
        `INSERT INTO channel_state (channel_id, theme, turn_count)
         VALUES ($1, $2, $3)
         ON CONFLICT (channel_id) DO UPDATE SET theme = $2, turn_count = $3`,
        [channelId, theme, turnCount]
    );
}

export async function saveCampaign(channelId, { status, brief, lore, storyArcs, relationships }) {
    await pool.query(
        `INSERT INTO campaign (channel_id, status, brief, lore, story_arcs, relationships)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (channel_id) DO UPDATE SET
             status        = COALESCE($2, campaign.status),
             brief         = COALESCE($3, campaign.brief),
             lore          = COALESCE($4, campaign.lore),
             story_arcs    = COALESCE($5, campaign.story_arcs),
             relationships = COALESCE($6, campaign.relationships)`,
        [
            channelId,
            status ?? null,
            brief ?? null,
            lore ?? null,
            storyArcs != null ? JSON.stringify(storyArcs) : null,
            relationships != null ? JSON.stringify(relationships) : null,
        ]
    );
}

export async function saveCharacter(channelId, userId, { characterName, displayName, sheet }) {
    await pool.query(
        `INSERT INTO characters (channel_id, user_id, character_name, display_name, sheet)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (channel_id, user_id) DO UPDATE SET
             character_name = $3,
             display_name   = $4,
             sheet          = COALESCE($5, characters.sheet)`,
        [channelId, userId, characterName, displayName, sheet ?? null]
    );
}

export async function deleteCampaignAndChars(channelId) {
    await pool.query('DELETE FROM campaign WHERE channel_id = $1', [channelId]);
    await pool.query('DELETE FROM characters WHERE channel_id = $1', [channelId]);
}

export async function saveChatSession(channelId, history) {
    await pool.query(
        `INSERT INTO chat_sessions (channel_id, history)
         VALUES ($1, $2)
         ON CONFLICT (channel_id) DO UPDATE SET history = $2`,
        [channelId, JSON.stringify(history)]
    );
}

export async function clearChannel(channelId) {
    await pool.query('DELETE FROM channel_state  WHERE channel_id = $1', [channelId]);
    await pool.query('DELETE FROM campaign        WHERE channel_id = $1', [channelId]);
    await pool.query('DELETE FROM characters      WHERE channel_id = $1', [channelId]);
    await pool.query('DELETE FROM chat_sessions   WHERE channel_id = $1', [channelId]);
}
```

- [ ] **Step 3: Verify syntax**

```bash
node --check /Users/drobson/Developer/code/dnd-bot/db.js && echo "Syntax OK"
```
Expected: `Syntax OK`

- [ ] **Step 4: Commit**

```bash
cd /Users/drobson/Developer/code/dnd-bot && git add db.js package.json package-lock.json && git commit -m "feat: add db.js with Postgres schema and save/clear functions"
```

---

## Task 2: Add loadAll() to db.js

**Files:**
- Modify: `/Users/drobson/Developer/code/dnd-bot/db.js`

- [ ] **Step 1: Add loadAll export at the bottom of db.js**

Append the following function to the end of `db.js`:

```javascript
export async function loadAll(chatSessions, channelThemes, characterNames, turnCounts, campaignConfig, readyCharacters) {
    const [channelRows, campaignRows, charRows, sessionRows] = await Promise.all([
        pool.query('SELECT * FROM channel_state'),
        pool.query('SELECT * FROM campaign'),
        pool.query('SELECT * FROM characters'),
        pool.query('SELECT * FROM chat_sessions'),
    ]);

    for (const row of channelRows.rows) {
        if (row.theme) channelThemes.set(row.channel_id, row.theme);
        turnCounts.set(row.channel_id, row.turn_count ?? 0);
    }

    for (const row of campaignRows.rows) {
        campaignConfig.set(row.channel_id, {
            status:        row.status,
            brief:         row.brief,
            lore:          row.lore,
            storyArcs:     row.story_arcs,
            relationships: row.relationships,
            history:       [], // Q&A history is not persisted
        });
    }

    for (const row of charRows.rows) {
        if (!characterNames.has(row.channel_id)) characterNames.set(row.channel_id, new Map());
        characterNames.get(row.channel_id).set(row.user_id, row.character_name);

        if (row.sheet) {
            if (!readyCharacters.has(row.channel_id)) readyCharacters.set(row.channel_id, new Map());
            readyCharacters.get(row.channel_id).set(row.user_id, {
                displayName:   row.display_name,
                characterName: row.character_name,
                sheet:         row.sheet,
            });
        }
    }

    for (const row of sessionRows.rows) {
        chatSessions.set(row.channel_id, row.history ?? []);
    }
}
```

- [ ] **Step 2: Verify syntax**

```bash
node --check /Users/drobson/Developer/code/dnd-bot/db.js && echo "Syntax OK"
```
Expected: `Syntax OK`

- [ ] **Step 3: Commit**

```bash
git add db.js && git commit -m "feat: add loadAll to db.js"
```

---

## Task 3: Wire startup in index.js

**Files:**
- Modify: `/Users/drobson/Developer/code/dnd-bot/index.js`

- [ ] **Step 1: Add db import at the top of index.js**

After the existing imports (after `import dotenv from 'dotenv';`), add:

```javascript
import * as db from './db.js';
```

- [ ] **Step 2: Replace the client.once('ready') handler**

Find:
```javascript
client.once('ready', () => {
    console.log(`Dungeon Master online as ${client.user.tag}`);
});
```

Replace with:
```javascript
client.once('ready', async () => {
    try {
        await db.initDb();
        await db.loadAll(chatSessions, channelThemes, characterNames, turnCounts, campaignConfig, readyCharacters);
        console.log(`Dungeon Master online as ${client.user.tag} — state loaded from DB`);
    } catch (error) {
        console.error('DB startup failed:', error.message);
        console.log(`Dungeon Master online as ${client.user.tag} — running without persistence`);
    }
});
```

- [ ] **Step 3: Verify syntax**

```bash
node --check /Users/drobson/Developer/code/dnd-bot/index.js && echo "Syntax OK"
```

- [ ] **Step 4: Test startup (requires DATABASE_URL)**

If `.env` has `DATABASE_URL` set, run:
```bash
npm run dev
```
Expected terminal output: `Dungeon Master online as <BotName> — state loaded from DB`

If no `DATABASE_URL`, expected: `DB startup failed: ... — running without persistence` (non-fatal).

- [ ] **Step 5: Commit**

```bash
git add index.js && git commit -m "feat: wire DB startup in client.once(ready)"
```

---

## Task 4: Wire save points for commands

**Files:**
- Modify: `/Users/drobson/Developer/code/dnd-bot/index.js`

- [ ] **Step 1: Add db.clearChannel() to !set_theme**

Find the `!set_theme` handler. After the Map mutations and before the `return message.channel.send(...)`, add:

```javascript
            await db.clearChannel(channelId).catch(err => console.error('clearChannel failed:', err.message));
```

The full handler should end:
```javascript
            channelThemes.set(channelId, theme);
            chatSessions.set(channelId, []);
            characterNames.set(channelId, new Map());
            turnCounts.set(channelId, 0);
            campaignConfig.delete(channelId);
            readyCharacters.delete(channelId);
            for (const [threadId, s] of creationSessions) {
                if (s.channelId === channelId) creationSessions.delete(threadId);
            }
            await db.clearChannel(channelId).catch(err => console.error('clearChannel failed:', err.message));
            return message.channel.send(`**Theme set: ${theme.toUpperCase()}**\n*The universe shifts. Set your character name with \`!character <name>\`, then just type to play.*`);
```

- [ ] **Step 2: Add db.clearChannel() to !wipe_memory**

Find the `!wipe_memory` handler. After the Map mutations and before the `return message.reply(...)`, add:

```javascript
            await db.clearChannel(channelId).catch(err => console.error('clearChannel failed:', err.message));
```

- [ ] **Step 3: Add db.saveCharacter() to !character**

Find the `!character` handler. After `characterNames.get(channelId).set(message.author.id, name);` and before `return message.reply(...)`, add:

```javascript
            await db.saveCharacter(channelId, message.author.id, {
                characterName: name,
                displayName: message.member?.displayName ?? message.author.username,
                sheet: null,
            }).catch(err => console.error('saveCharacter failed:', err.message));
```

- [ ] **Step 4: Add db.deleteCampaignAndChars() to !setup_campaign**

Find the `!setup_campaign` handler. After the creationSessions cleanup loop and before `const config = campaignConfig.get(channelId);`, add:

```javascript
            await db.deleteCampaignAndChars(channelId).catch(err => console.error('deleteCampaignAndChars failed:', err.message));
```

- [ ] **Step 5: Add db.saveCampaign() to handleCampaignSetup when campaign is ready**

In `handleCampaignSetup`, find the `if (isReady)` block:
```javascript
        if (isReady) {
            const briefMatch = clean.match(/## CAMPAIGN BRIEF[\s\S]*/);
            const brief = briefMatch ? briefMatch[0] : clean;
            campaignConfig.set(channelId, { status: 'ready', brief, history });
            await message.channel.send(...)
        }
```

Replace with:
```javascript
        if (isReady) {
            const briefMatch = clean.match(/## CAMPAIGN BRIEF[\s\S]*/);
            const brief = briefMatch ? briefMatch[0] : clean;
            campaignConfig.set(channelId, { status: 'ready', brief, lore: null, storyArcs: null, relationships: null, history: [] });
            await db.saveCampaign(channelId, { status: 'ready', brief }).catch(err => console.error('saveCampaign failed:', err.message));
            await message.channel.send(
                '✅ **Campaign configured!**\n' +
                'Each player: run `!create_character` to build your character in a private thread.\n' +
                'When everyone is ready, run `!start_campaign` to begin.'
            );
        }
```

- [ ] **Step 6: Verify syntax and commit**

```bash
node --check /Users/drobson/Developer/code/dnd-bot/index.js && echo "Syntax OK"
git add index.js && git commit -m "feat: wire DB save points for commands and campaign setup"
```

---

## Task 5: Wire save points for character creation and !start_campaign

**Files:**
- Modify: `/Users/drobson/Developer/code/dnd-bot/index.js`

- [ ] **Step 1: Add db.saveCharacter() to handleCharacterCreation when character is ready**

In `handleCharacterCreation`, find the `if (isReady)` block. After the two Map sets (`readyCharacters`, `characterNames`) and before `creationSessions.delete(threadId)`, add:

```javascript
            await db.saveCharacter(channelId, userId, { characterName, displayName, sheet: clean })
                .catch(err => console.error('saveCharacter failed:', err.message));
```

- [ ] **Step 2: Add initial lore generation and save calls to !start_campaign**

In the `!start_campaign` handler, find the try block that calls Gemini for the opening narration. Just before `await message.channel.sendTyping();`, add the initial lore generation:

```javascript
            // Generate initial lore document
            const characterSheets = [...characters.values()].map(({ sheet }) => sheet).join('\n\n');
            let initialLore = '';
            try {
                const loreResponse = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: [{ role: 'user', parts: [{ text:
                        `Campaign Brief:\n${config.brief}\n\nParty:\n${characterSheets}\n\nGenerate a concise world overview for this campaign.`
                    }] }],
                    config: {
                        systemInstruction: 'You are a D&D world-building expert. Generate a concise world overview (under 400 words) covering: setting atmosphere, key factions or powers, notable locations, and the general tone of the world. Be specific and vivid. Only include what is established in the brief.',
                        temperature: 0.5,
                        topP: 0.9,
                        topK: 50,
                    },
                });
                initialLore = loreResponse.text ?? '';
            } catch (loreErr) {
                console.error('Initial lore generation failed:', loreErr.message);
            }

            const configWithLore = { ...config, lore: initialLore, storyArcs: null, relationships: null };
            campaignConfig.set(channelId, configWithLore);
```

- [ ] **Step 3: Add DB save calls inside !start_campaign try block after state is committed**

In `!start_campaign`, find the section after `chatSessions.set(channelId, history)` (inside the try block, after the narration succeeds). Add three saves:

```javascript
                channelThemes.set(channelId, 'fantasy');
                turnCounts.set(channelId, 0);
                chatSessions.set(channelId, history);

                await db.saveChannelState(channelId, 'fantasy', 0).catch(err => console.error('saveChannelState failed:', err.message));
                await db.saveCampaign(channelId, {
                    status: configWithLore.status,
                    brief:  configWithLore.brief,
                    lore:   configWithLore.lore,
                    storyArcs: null,
                    relationships: null,
                }).catch(err => console.error('saveCampaign failed:', err.message));
                await db.saveChatSession(channelId, history).catch(err => console.error('saveChatSession failed:', err.message));
```

Note: `characterSheets` was already declared above for the lore call — remove the duplicate declaration that was there before this step (find `const characterSheets = [...characters.values()]...` and keep only the one added in Step 2).

- [ ] **Step 4: Verify syntax and commit**

```bash
node --check /Users/drobson/Developer/code/dnd-bot/index.js && echo "Syntax OK"
git add index.js && git commit -m "feat: wire character creation and start_campaign DB saves, add initial lore generation"
```

---

## Task 6: Wire gameplay saves and upgrade summariseSession

**Files:**
- Modify: `/Users/drobson/Developer/code/dnd-bot/index.js`

- [ ] **Step 1: Add db.saveChatSession() after each gameplay response**

In the gameplay handler (inside `client.on('messageCreate', ...)`), find the section after the narration is pushed to history:

```javascript
        history.push({ role: 'model', parts: [{ text: narration }] });

        // Discord message limit is 2000 chars
        for (let i = 0; i < narration.length; i += 2000) {
```

After the `history.push(...)` line and before the `for` loop, add:

```javascript
        await db.saveChatSession(channelId, history).catch(err => console.error('saveChatSession failed:', err.message));
```

- [ ] **Step 2: Add the SUMMARISATION_PROMPT constant**

Before the `buildSystemPrompt` function, add a new constant:

```javascript
const SUMMARISATION_PROMPT = `You are a precise campaign historian for an ongoing D&D session. Analyse the conversation and produce a structured update in exactly four sections with these exact headers:

## HISTORY SUMMARY
Write a compressed narrative context (3-5 sentences) covering the most recent session events. Write it so a new DM could pick up exactly where the session left off.

## STORY ARCS
Output a JSON array of narrative arcs. Each arc: { "name": string, "status": "active" | "resolved", "summary": string }. Include newly introduced arcs and update existing ones. Output only valid JSON, no prose.

## RELATIONSHIPS
Output a JSON object mapping character and NPC names to their relationships. Structure: { "Name": { "OtherName": "relationship description" } }. Output only valid JSON, no prose.

## LORE UPDATES
Plain text. Any new world details established in the session: locations discovered, factions encountered, history revealed, rules of this world clarified.

Focus on narrative significance — story beats, alliances, betrayals, revelations, character moments. Only record what is explicitly in the conversation. Do not invent.`;
```

- [ ] **Step 3: Add parseSummarisationSections helper function**

After the `SUMMARISATION_PROMPT` constant and before `buildSystemPrompt`, add:

```javascript
function parseSummarisationSections(text) {
    const extract = (header) => {
        const match = text.match(new RegExp(`## ${header}\\n([\\s\\S]*?)(?=## |$)`));
        return match ? match[1].trim() : '';
    };

    const storyArcsRaw  = extract('STORY ARCS');
    const relationshipsRaw = extract('RELATIONSHIPS');

    let storyArcs = null;
    let relationships = null;
    try { storyArcs = JSON.parse(storyArcsRaw); } catch {}
    try { relationships = JSON.parse(relationshipsRaw); } catch {}

    return {
        historySummary: extract('HISTORY SUMMARY'),
        storyArcs,
        relationships,
        loreUpdates: extract('LORE UPDATES'),
    };
}
```

- [ ] **Step 4: Replace summariseSession with the enhanced version**

Find the full `async function summariseSession(channelId, history)` and replace it entirely with:

```javascript
async function summariseSession(channelId, history) {
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: history,
            config: {
                systemInstruction: SUMMARISATION_PROMPT,
                temperature: 0.1,
                topP: 0.8,
                topK: 40,
            },
        });

        const text = response.text;
        if (!text) return;

        const { historySummary, storyArcs, relationships, loreUpdates } = parseSummarisationSections(text);

        // Compress history (existing behaviour, now using historySummary section)
        const recentTurns = history.splice(-6);
        history.length = 0;
        history.push(
            { role: 'user', parts: [{ text: `[AUTO CAMPAIGN STATE — Ground Truth — treat this as authoritative]\n\n${historySummary}` }] },
            { role: 'model', parts: [{ text: 'Campaign state acknowledged. Continuing the session with this as ground truth.' }] },
            ...recentTurns
        );

        // Update campaignConfig Map with new narrative state
        const config = campaignConfig.get(channelId);
        if (config) {
            if (storyArcs)     config.storyArcs     = storyArcs;
            if (relationships) config.relationships = relationships;
            if (loreUpdates)   config.lore = config.lore ? `${config.lore}\n\n${loreUpdates}` : loreUpdates;

            await db.saveCampaign(channelId, {
                status:        config.status,
                brief:         config.brief,
                lore:          config.lore,
                storyArcs:     config.storyArcs,
                relationships: config.relationships,
            }).catch(err => console.error('saveCampaign (summarise) failed:', err.message));
        }

        await db.saveChatSession(channelId, history)
            .catch(err => console.error('saveChatSession (summarise) failed:', err.message));

    } catch (error) {
        console.error('Summarisation failed:', error.message);
        // Non-fatal — session continues with untrimmed history
    }
}
```

- [ ] **Step 5: Verify syntax and commit**

```bash
node --check /Users/drobson/Developer/code/dnd-bot/index.js && echo "Syntax OK"
git add index.js && git commit -m "feat: wire gameplay saves and upgrade summariseSession with narrative tracking"
```

---

## Task 7: Update buildSystemPrompt to inject campaign state

**Files:**
- Modify: `/Users/drobson/Developer/code/dnd-bot/index.js`

- [ ] **Step 1: Update buildSystemPrompt signature and inject campaign state**

Find `function buildSystemPrompt(themeKey)` and replace it with:

```javascript
function buildSystemPrompt(themeKey, campaignState = null) {
    const file = THEME_FILES[themeKey] ?? '5esrd.md';
    let rules = '';
    try {
        rules = fs.readFileSync(file, 'utf-8');
    } catch {
        rules = 'Rules file not found. Use baseline RPG logic.';
    }

    let campaignContext = '';
    if (campaignState?.storyArcs || campaignState?.relationships) {
        campaignContext = '[CAMPAIGN STATE]\n';
        if (campaignState.storyArcs) {
            campaignContext += `Story Arcs: ${JSON.stringify(campaignState.storyArcs)}\n`;
        }
        if (campaignState.relationships) {
            campaignContext += `Relationships: ${JSON.stringify(campaignState.relationships)}\n`;
        }
        campaignContext += '\n';
    }

    return `You are a professional Game Master running a gritty multiplayer text adventure.

CORE PROTOCOLS:
1. RULES ENGINE: The static rules for this universe are loaded below. Follow them for all mechanics, lore, and tone.
2. WORLD STATE: Track all characters, their stats, inventory, location, and status dynamically via the chat history.
3. MULTIPLAYER: Inputs are formatted as "[Character Name (Player)]: Action" or "[Player]: Action" if no character name is set. Track every character in the party individually — maintain their distinct voice, situation, and relationships.
4. OOC (OUT OF CHARACTER): If a message is wrapped in parentheses or prefixed with "OOC:", step outside the narrative, answer clearly, then offer to continue. Do not narrate fictional events for OOC messages.
5. SAVE: Only when a player says "Save campaign", output a raw copy-pasteable # CURRENT CAMPAIGN STATE block listing every character (name, class, HP, inventory, status) and current location and recent events.

CRITICAL PROCESSING ORDER:
Every time a player declares an action, respond in two strict steps:
- STEP 1 — MECHANICAL VERIFICATION: Look up the exact rule, weapon, spell, or ability in the UNIVERSE RULES below. Write out the matching rule and calculate any dice or math explicitly before narrating anything.
- STEP 2 — NARRATION: Only after the mechanics are resolved, describe the outcome atmospherically.

STRICT GUARDRAILS:
- If a player attempts to cast a spell or use a feature NOT found in the UNIVERSE RULES, refuse the action and state: "That power does not exist in this world."
- Never invent enemy stat blocks. Use only monster parameters explicitly written in the rules reference.
- If an action requires a specific item (e.g. Thieves' Tools) and the chat history does not show the player possessing it, the action automatically fails. Do not assume they acquired it off-screen.
- Never retcon established facts. If a character took damage, that HP loss persists.

${campaignContext}UNIVERSE RULES:
${rules}`;
}
```

- [ ] **Step 2: Update the gameplay Gemini call to pass campaignState**

In the main gameplay handler, find:
```javascript
                systemInstruction: buildSystemPrompt(channelThemes.get(channelId)),
```
Replace with:
```javascript
                systemInstruction: buildSystemPrompt(channelThemes.get(channelId), campaignConfig.get(channelId)),
```

- [ ] **Step 3: Update the !start_campaign Gemini call to pass campaignState**

In `!start_campaign`, find:
```javascript
                    systemInstruction: buildSystemPrompt('fantasy'),
```
Replace with:
```javascript
                    systemInstruction: buildSystemPrompt('fantasy', campaignConfig.get(channelId)),
```

- [ ] **Step 4: Verify syntax and commit**

```bash
node --check /Users/drobson/Developer/code/dnd-bot/index.js && echo "Syntax OK"
git add index.js && git commit -m "feat: inject story arcs and relationships into gameplay system prompt"
```

---

## Task 8: Update CLAUDE.md, push, and deploy

**Files:**
- Modify: `/Users/drobson/Developer/code/dnd-bot/CLAUDE.md`

- [ ] **Step 1: Update Architecture section in CLAUDE.md**

In `CLAUDE.md`, find the line:
```
All logic lives in `index.js`. There are no modules or subdirectories.
```
Replace with:
```
All bot logic lives in `index.js`. Database interaction is isolated in `db.js`. There are no other modules.
```

Find the **State** section and replace the existing bullet list with:
```markdown
**State** is held in seven in-memory Maps (runtime source of truth) backed by Railway Postgres via `db.js` (write-through persistence). Maps are populated from the DB on startup.

- `chatSessions` — Gemini gameplay history (≤50 turns, auto-summarised)
- `channelThemes` — active theme/rulebook per channel
- `characterNames` — channelId → Map(userId → characterName); populated by `!character` and `!create_character`
- `turnCounts` — auto-summarisation counter per channel
- `campaignConfig` — campaign state: status, brief, lore, storyArcs, relationships (+ in-memory Q&A history)
- `creationSessions` — per-thread character creation state (keyed by threadId, not persisted)
- `readyCharacters` — completed character sheets per channel
```

Add a new **Persistence** section after the State section:
```markdown
**Persistence (db.js)** — four Postgres tables: `channel_state`, `campaign`, `characters`, `chat_sessions`. All writes are fire-and-forget (`.catch(console.error)`) so DB failures are non-fatal. `DATABASE_URL` is injected automatically by Railway's Postgres plugin.
```

Add to the **Summarisation** section:
```markdown
The enhanced summarisation prompt (every `SUMMARY_INTERVAL = 10` turns) returns four structured sections: `## HISTORY SUMMARY`, `## STORY ARCS` (JSON), `## RELATIONSHIPS` (JSON), `## LORE UPDATES`. Story arcs and relationships are saved to the `campaign` table and injected into the gameplay system prompt via `buildSystemPrompt(themeKey, campaignState)`.
```

- [ ] **Step 2: Add DATABASE_URL to .env.example**

In `/Users/drobson/Developer/code/dnd-bot/.env.example`, add:
```
DATABASE_URL=
```

- [ ] **Step 3: Verify bot starts and DB tables are created**

```bash
npm run dev
```
Expected: `Dungeon Master online as <BotName> — state loaded from DB` (if DATABASE_URL is set), or the non-fatal fallback message.

- [ ] **Step 4: Final commit and push**

```bash
git add index.js CLAUDE.md .env.example && git commit -m "feat: complete persistence implementation with narrative tracking"
git push
```

---

## Railway Setup (manual steps after deploy)

1. In Railway dashboard → your project → **Add Plugin** → **PostgreSQL**
2. Railway automatically sets `DATABASE_URL` on your service — no manual copy needed
3. Redeploy the service — tables are created automatically on startup
4. Verify in Railway logs: `Dungeon Master online as <BotName> — state loaded from DB`

---

## Known Limitation

`turn_count` in `channel_state` is saved at `!start_campaign` and `!set_theme` but not on every gameplay turn (avoiding a DB write per message). After a bot restart mid-session, the summarisation counter resets to 0 — the first summarisation may fire up to `SUMMARY_INTERVAL` turns late. Non-critical.

---

## Temperature Reference (unchanged)

| Call | Testing | Production |
|---|---|---|
| Gameplay | `0.4` | `0.2` |
| `!start_campaign` opening | `0.7` | `0.4` |
| Campaign setup / char creation | `0.5` | `0.5` |
| Summarisation | `0.1` | `0.1` |
| Initial lore generation | `0.5` | `0.5` |
