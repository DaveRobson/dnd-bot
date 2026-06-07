# Campaign & Character Creation Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add guided campaign setup and per-player character creation flows to the Discord D&D bot, capped by a `!start_campaign` command that compiles everything and kicks off the opening narration.

**Architecture:** All changes are in `index.js`. Three new in-memory Maps track campaign config, per-thread character creation sessions, and ready character sheets. Campaign setup runs as a Gemini conversation in the main channel; character creation runs in bot-created public threads. A `channelId` fix ensures thread messages resolve to their parent channel for all state lookups.

**Tech Stack:** Node.js (ESM), discord.js v14, @google/genai v1, no test framework (manual Discord testing).

---

## File Structure

**Modify only:** `index.js`

Changes by section:
- Line 117: fix `channelId` to resolve parent channel for thread messages
- After existing Maps (~line 29): add 3 new Maps
- After `!wipe_memory` and `!set_theme`: add resets for new Maps
- Before `buildSystemPrompt`: add `CAMPAIGN_SETUP_PROMPT` and `CHARACTER_CREATION_PROMPT` constants
- Before `client.once('ready')`: add `handleCampaignSetup` and `handleCharacterCreation` functions
- Inside command handler: add `!setup_campaign`, `!create_character`, `!party`, `!start_campaign`, update `!help`
- After command handler: add campaign setup and character creation routing branches
- After character creation routing: add `if (message.channel.isThread()) return;` guard

---

## Task 1: Fix channelId and add new state Maps

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Fix channelId to resolve parent for thread messages**

In `index.js`, find line 117:
```javascript
const channelId = message.channel.id;
```
Replace with:
```javascript
const channelId = message.channel.isThread() ? message.channel.parentId : message.channel.id;
```

- [ ] **Step 2: Add three new state Maps after the existing ones**

Find the existing Maps block (~line 25-29):
```javascript
// Per-channel state
const chatSessions = new Map();   // channelId -> history[]
const channelThemes = new Map();  // channelId -> themeKey
const characterNames = new Map(); // channelId -> Map(userId -> characterName)
const turnCounts = new Map();     // channelId -> number
```
Replace with:
```javascript
// Per-channel state
const chatSessions = new Map();    // channelId -> history[]
const channelThemes = new Map();   // channelId -> themeKey
const characterNames = new Map();  // channelId -> Map(userId -> characterName)
const turnCounts = new Map();      // channelId -> number
const campaignConfig = new Map();  // channelId -> { status: 'configuring'|'ready', brief: string, history: [] }
const creationSessions = new Map();// threadId  -> { userId, channelId, history: [] }
const readyCharacters = new Map(); // channelId -> Map(userId -> { displayName, characterName, sheet })
```

- [ ] **Step 3: Reset new Maps in !set_theme**

Find the `!set_theme` handler and add three resets:
```javascript
if (command === 'set_theme') {
    const theme = args[0]?.toLowerCase();
    if (!theme || !THEME_FILES[theme]) {
        return message.reply(`Unknown theme. Available: ${Object.keys(THEME_FILES).join(', ')}`);
    }
    channelThemes.set(channelId, theme);
    chatSessions.set(channelId, []);
    characterNames.set(channelId, new Map());
    turnCounts.set(channelId, 0);
    campaignConfig.delete(channelId);
    readyCharacters.delete(channelId);
    return message.channel.send(`**Theme set: ${theme.toUpperCase()}**\n*The universe shifts. Set your character name with \`!character <name>\`, then just type to play.*`);
}
```

- [ ] **Step 4: Reset new Maps in !wipe_memory**

```javascript
if (command === 'wipe_memory') {
    chatSessions.set(channelId, []);
    characterNames.set(channelId, new Map());
    turnCounts.set(channelId, 0);
    campaignConfig.delete(channelId);
    readyCharacters.delete(channelId);
    return message.reply('Session memory, character names, and campaign data cleared.');
}
```

- [ ] **Step 5: Start the bot and verify existing commands still work**

```bash
npm run dev
```
In Discord: run `!help`, `!set_theme fantasy`, `!wipe_memory` — all should respond as before with no errors in the terminal.

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat: add campaign/character state maps and fix channelId for threads"
```

---

## Task 2: Add Gemini prompt constants

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Add CAMPAIGN_SETUP_PROMPT and CHARACTER_CREATION_PROMPT**

Insert both constants immediately before the `buildSystemPrompt` function definition:

```javascript
const CAMPAIGN_SETUP_PROMPT = `You are an enthusiastic D&D campaign designer helping a group of friends set up their adventure. Understand what kind of campaign they want through 4-5 natural conversational exchanges.

Ask about these topics one or two at a time:
- Type of adventure (dungeon crawl, political intrigue, mystery, wilderness exploration, heist, etc.)
- Tone and mood (gritty/dark, heroic/epic, lighthearted, horror, swashbuckling)
- Difficulty preference (challenging and punishing vs narrative-focused)
- Themes to include or avoid
- Starting scenario or hook if they have ideas

Give inspiring examples. Be enthusiastic and collaborative.

Once you have enough to work with, output this exact block:

## CAMPAIGN BRIEF
**Title:** [Campaign name]
**Tone:** [Tone descriptor]
**Setting:** [Where and when]
**Hook:** [The situation that draws players in — 2-3 sentences]
**Opening Scene:** [Vivid description of exactly where the session starts — 3-4 sentences]
**Key Threats:** [Main antagonists or dangers]
**Objectives:** [What the players need to accomplish]

End your final message with exactly: [CAMPAIGN READY]`;

const CHARACTER_CREATION_PROMPT = `You are a friendly D&D 5e character creation guide. Walk the player through building their character in a natural conversation. Focus on the fantasy concept first, mechanics second.

Start by asking what kind of character they imagine. Then offer:
"Do you want to go **lightweight** (name, concept, class — 3-4 quick questions) or **full 5e** (race, class, background, ability scores, equipment — more detailed)?"

Lightweight path: concept → class suggestion → name and brief backstory (3-4 exchanges total)
Full 5e path: concept → race → class → background → ability scores using standard array (15,14,13,12,10,8) → starting equipment → name and backstory (8-12 exchanges total)

Be encouraging and give vivid descriptions. Make it feel like building a real character, not filling a form.

Once complete, output this exact block:

## CHARACTER SHEET
**Name:** 
**Race:** 
**Class:** (Level 1)
**Background:** 
**Ability Scores:** STR X | DEX X | CON X | INT X | WIS X | CHA X
**HP:** X
**Proficiencies:** [key skills and weapons]
**Starting Equipment:** [list]
**Backstory:** [1-2 sentences]
**Personality:** [1 sentence]

End your final message with exactly: [CHARACTER READY]`;
```

- [ ] **Step 2: Verify bot still starts cleanly**

```bash
npm run dev
```
Expected: `Dungeon Master online as <BotName>` with no errors.

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: add campaign setup and character creation Gemini prompts"
```

---

## Task 3: Add handleCampaignSetup and !setup_campaign command

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Add handleCampaignSetup function**

Insert immediately before `client.once('ready', ...)`:

```javascript
async function handleCampaignSetup(message, channelId) {
    const config = campaignConfig.get(channelId);
    const { history } = config;

    history.push({ role: 'user', parts: [{ text: message.content }] });
    await message.channel.sendTyping();

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: history,
            config: {
                systemInstruction: CAMPAIGN_SETUP_PROMPT,
                temperature: 0.5,
                topP: 0.9,
                topK: 50,
            },
        });

        const text = response.text;
        if (!text) throw new Error('Empty response from Gemini');

        const isReady = text.includes('[CAMPAIGN READY]');
        const clean = text.replace('[CAMPAIGN READY]', '').trim();

        history.push({ role: 'model', parts: [{ text }] });

        for (let i = 0; i < clean.length; i += 2000) {
            await message.channel.send(clean.slice(i, i + 2000));
        }

        if (isReady) {
            const briefMatch = clean.match(/## CAMPAIGN BRIEF[\s\S]*/);
            const brief = briefMatch ? briefMatch[0] : clean;
            campaignConfig.set(channelId, { status: 'ready', brief, history });
            await message.channel.send(
                '✅ **Campaign configured!**\n' +
                'Each player: run `!create_character` to build your character in a private thread.\n' +
                'When everyone is ready, run `!start_campaign` to begin.'
            );
        }
    } catch (error) {
        console.error(error);
        await message.channel.send(`**Error:** ${error.message}`);
    }
}
```

- [ ] **Step 2: Add !setup_campaign command**

Inside the `if (message.content.startsWith('!'))` block, before the final `return;`, add:

```javascript
if (command === 'setup_campaign') {
    campaignConfig.set(channelId, { status: 'configuring', brief: null, history: [] });
    readyCharacters.delete(channelId);
    characterNames.set(channelId, new Map());
    const config = campaignConfig.get(channelId);

    await message.channel.send(
        'Starting campaign setup. I\'ll ask a few questions to design your adventure.\n\n' +
        'Once we\'re done:\n' +
        '• Each player runs `!create_character` to build their character in a private thread\n' +
        '• When everyone\'s ready, any player runs `!start_campaign` to begin\n\n' +
        'Let\'s build your world.'
    );

    const kickoff = 'A group of friends want to set up a D&D campaign. Welcome them and ask your first question.';
    try {
        const opening = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [{ text: kickoff }] }],
            config: {
                systemInstruction: CAMPAIGN_SETUP_PROMPT,
                temperature: 0.5,
                topP: 0.9,
                topK: 50,
            },
        });
        const openingText = opening.text;
        config.history.push(
            { role: 'user', parts: [{ text: kickoff }] },
            { role: 'model', parts: [{ text: openingText }] }
        );
        await message.channel.send(openingText);
    } catch (error) {
        console.error(error);
        await message.channel.send(`**Error starting campaign setup:** ${error.message}`);
        campaignConfig.delete(channelId);
    }
    return;
}
```

- [ ] **Step 3: Add campaign setup routing**

After the `if (message.content.startsWith('!'))` block closes (after the existing `return;`), and before the `if (!channelThemes.has(channelId))` check, insert:

```javascript
// Route to campaign setup handler if active in this channel
if (!message.channel.isThread() && campaignConfig.get(channelId)?.status === 'configuring') {
    return handleCampaignSetup(message, channelId);
}
```

- [ ] **Step 4: Test !setup_campaign in Discord**

Run `!setup_campaign`. Expected:
1. Bot posts onboarding message
2. Bot asks first campaign question
3. Answer a few questions
4. Bot eventually outputs the `## CAMPAIGN BRIEF` block and posts the ✅ confirmation
5. `campaignConfig` for the channel is now `status: 'ready'`

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat: add !setup_campaign command and campaign setup handler"
```

---

## Task 4: Add handleCharacterCreation and !create_character command

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Add handleCharacterCreation function**

Insert immediately after `handleCampaignSetup` (still before `client.once('ready', ...)`):

```javascript
async function handleCharacterCreation(message, threadId) {
    const session = creationSessions.get(threadId);
    const { userId, channelId, history } = session;

    history.push({ role: 'user', parts: [{ text: message.content }] });
    await message.channel.sendTyping();

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: history,
            config: {
                systemInstruction: CHARACTER_CREATION_PROMPT,
                temperature: 0.5,
                topP: 0.9,
                topK: 50,
            },
        });

        const text = response.text;
        if (!text) throw new Error('Empty response from Gemini');

        const isReady = text.includes('[CHARACTER READY]');
        const clean = text.replace('[CHARACTER READY]', '').trim();

        history.push({ role: 'model', parts: [{ text }] });

        for (let i = 0; i < clean.length; i += 2000) {
            await message.channel.send(clean.slice(i, i + 2000));
        }

        if (isReady) {
            const nameMatch = clean.match(/\*\*Name:\*\*\s*(.+)/);
            const characterName = nameMatch ? nameMatch[1].trim() : 'Unknown Hero';
            const displayName = message.member?.displayName ?? message.author.username;

            if (!readyCharacters.has(channelId)) readyCharacters.set(channelId, new Map());
            readyCharacters.get(channelId).set(userId, { displayName, characterName, sheet: clean });

            if (!characterNames.has(channelId)) characterNames.set(channelId, new Map());
            characterNames.get(channelId).set(userId, characterName);

            creationSessions.delete(threadId);

            await message.channel.send('✅ Character creation complete! Head back to the main channel.');

            const mainChannel = await message.client.channels.fetch(channelId);
            await mainChannel.send(
                `⚔️ **${characterName}** is ready! ` +
                `Run \`!party\` to see the roster, or \`!start_campaign\` when everyone's set.`
            );
        }
    } catch (error) {
        console.error(error);
        await message.channel.send(`**Error:** ${error.message}`);
    }
}
```

- [ ] **Step 2: Add !create_character command**

Inside the `if (message.content.startsWith('!'))` block, add before the final `return;`:

```javascript
if (command === 'create_character') {
    const config = campaignConfig.get(channelId);
    if (!config || config.status !== 'ready') {
        return message.reply('Set up the campaign first with `!setup_campaign`.');
    }

    const existingEntry = [...creationSessions.entries()].find(
        ([, s]) => s.userId === message.author.id && s.channelId === channelId
    );
    if (existingEntry) {
        return message.reply(`You already have a character creation thread: <#${existingEntry[0]}>.`);
    }

    let thread;
    try {
        thread = await message.channel.threads.create({
            name: `Character Creation — ${message.member?.displayName ?? message.author.username}`,
            autoArchiveDuration: 60,
        });
    } catch (error) {
        return message.reply(`Failed to create thread: ${error.message}. Make sure I have \`Create Public Threads\` permission.`);
    }

    creationSessions.set(thread.id, { userId: message.author.id, channelId, history: [] });
    const session = creationSessions.get(thread.id);

    await thread.members.add(message.author.id);

    const kickoff = 'A player wants to create a D&D character. Welcome them and start the character creation process.';
    try {
        const opening = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [{ text: kickoff }] }],
            config: {
                systemInstruction: CHARACTER_CREATION_PROMPT,
                temperature: 0.5,
                topP: 0.9,
                topK: 50,
            },
        });
        const openingText = opening.text;
        session.history.push(
            { role: 'user', parts: [{ text: kickoff }] },
            { role: 'model', parts: [{ text: openingText }] }
        );
        await thread.send(openingText);
    } catch (error) {
        creationSessions.delete(thread.id);
        await thread.delete().catch(() => {});
        return message.reply(`Failed to start character creation: ${error.message}`);
    }

    return message.reply(`Your character creation thread is ready: <#${thread.id}>`);
}
```

- [ ] **Step 3: Add character creation routing and thread guard**

After the campaign setup routing (added in Task 3, Step 3), insert:

```javascript
// Route to character creation handler if message is in an active creation thread
if (message.channel.isThread() && creationSessions.has(message.channel.id)) {
    return handleCharacterCreation(message, message.channel.id);
}

// Ignore all other thread messages — gameplay only happens in the main channel
if (message.channel.isThread()) return;
```

- [ ] **Step 4: Add CREATE_PUBLIC_THREADS permission to bot invite**

In Discord Developer Portal → your app → OAuth2 → URL Generator:
- Scopes: `bot`
- Permissions: tick `Create Public Threads` and `Send Messages in Threads` in addition to existing permissions

Re-invite the bot (or update permissions on the existing server) before testing.

- [ ] **Step 5: Test !create_character in Discord**

After running `!setup_campaign` to completion:
1. Run `!create_character` — bot should reply with a thread link and create the thread
2. Open the thread — bot should have posted its opening character creation question
3. Answer all questions through to completion
4. Bot should output `## CHARACTER SHEET`, post ✅ in the thread, and announce `⚔️ CharacterName is ready!` in the main channel
5. Running `!create_character` again should reply with the existing thread link

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat: add !create_character command and character creation handler"
```

---

## Task 5: Add !party, !start_campaign, and update !help

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Add !party command**

Inside the `if (message.content.startsWith('!'))` block, add before the final `return;`:

```javascript
if (command === 'party') {
    const characters = readyCharacters.get(channelId);
    if (!characters || characters.size === 0) {
        return message.reply('No characters ready yet. Players should run `!create_character`.');
    }
    const roster = [...characters.values()]
        .map(({ characterName, displayName }) => `• **${characterName}** (${displayName})`)
        .join('\n');
    return message.reply(`**Party Roster**\n${roster}`);
}
```

- [ ] **Step 2: Add !start_campaign command**

Inside the `if (message.content.startsWith('!'))` block, add before the final `return;`:

```javascript
if (command === 'start_campaign') {
    const config = campaignConfig.get(channelId);
    if (!config || config.status !== 'ready') {
        return message.reply('No campaign configured. Run `!setup_campaign` first.');
    }
    const characters = readyCharacters.get(channelId);
    if (!characters || characters.size === 0) {
        return message.reply('No characters ready yet. Players should run `!create_character`.');
    }

    const titleMatch = config.brief.match(/\*\*Title:\*\*\s*(.+)/);
    const toneMatch  = config.brief.match(/\*\*Tone:\*\*\s*(.+)/);
    const settingMatch = config.brief.match(/\*\*Setting:\*\*\s*(.+)/);
    const title   = titleMatch   ? titleMatch[1].trim()   : 'Untitled Campaign';
    const tone    = toneMatch    ? toneMatch[1].trim()    : '';
    const setting = settingMatch ? settingMatch[1].trim() : '';

    const partyRoster = [...characters.values()].map(({ characterName, displayName, sheet }) => {
        const raceMatch  = sheet.match(/\*\*Race:\*\*\s*(.+)/);
        const classMatch = sheet.match(/\*\*Class:\*\*\s*(.+)/);
        const race  = raceMatch  ? raceMatch[1].trim()  : '';
        const cls   = classMatch ? classMatch[1].trim() : '';
        return `${characterName} (${displayName}) — ${race} ${cls}`.trim();
    }).join('\n');

    await message.channel.send(
        `📜 **CAMPAIGN: ${title}**\n` +
        `Tone: ${tone}\nSetting: ${setting}\n\n` +
        `**PARTY**\n──────────────────\n${partyRoster}\n\n` +
        `*The adventure begins...*`
    );

    channelThemes.set(channelId, 'fantasy');
    turnCounts.set(channelId, 0);

    const characterSheets = [...characters.values()].map(({ sheet }) => sheet).join('\n\n');
    const openingContext =
        `[CAMPAIGN CONFIGURATION]\n\n${config.brief}\n\n` +
        `[PARTY]\n\n${characterSheets}\n\n` +
        `Begin the session. Narrate the opening scene described in the campaign brief. ` +
        `Address each character by name as they arrive. Set the tone immediately.`;

    const history = [{ role: 'user', parts: [{ text: openingContext }] }];
    chatSessions.set(channelId, history);

    await message.channel.sendTyping();

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: history,
            config: {
                systemInstruction: buildSystemPrompt('fantasy'),
                temperature: 0.7, // Testing value — drop to 0.4 for production
                topP: 0.9,
                topK: 50,
            },
        });

        const narration = response.text;
        if (!narration) throw new Error('Empty response from Gemini');
        history.push({ role: 'model', parts: [{ text: narration }] });

        for (let i = 0; i < narration.length; i += 2000) {
            await message.channel.send(narration.slice(i, i + 2000));
        }
    } catch (error) {
        console.error(error);
        await message.channel.send(`**Error:** ${error.message}`);
    }
    return;
}
```

- [ ] **Step 3: Update !help**

Replace the existing `!help` handler:

```javascript
if (command === 'help') {
    return message.reply(
        '**DM Bot — Campaign Setup**\n' +
        '`!setup_campaign` — Design your campaign (any player, run first)\n' +
        '`!create_character` — Build your character in a private thread (after campaign setup)\n' +
        '`!party` — Show all ready characters\n' +
        '`!start_campaign` — Begin the session (campaign + ≥1 character required)\n\n' +
        '**During a session**\n' +
        '`!character <name>` — Set or change your character name\n' +
        '`!wipe_memory` — Clear all session data and start over\n' +
        '`!set_theme <fantasy|cyberpunk|western>` — Switch theme and reset session\n' +
        '`!help` — Show this message\n\n' +
        'Wrap a message in `(parentheses)` to speak OOC to the DM.\n' +
        'Say "Save campaign" to get a copy-pasteable save state.'
    );
}
```

- [ ] **Step 4: Test !party in Discord**

After at least one character is ready: run `!party`. Expected: roster listing character names and Discord display names.

- [ ] **Step 5: Test !start_campaign in Discord**

Run `!start_campaign` after campaign setup + at least one character ready. Expected:
1. Public briefing posted (📜 title, tone, setting, party roster)
2. DM narrates the opening scene addressing characters by name
3. Players can now type freely and the bot responds as the Game Master

- [ ] **Step 6: Test error states**

- Run `!create_character` before `!setup_campaign` → expect: "Set up the campaign first"
- Run `!start_campaign` before any characters → expect: "No characters ready yet"
- Run `!create_character` twice → expect: link to existing thread on second run

- [ ] **Step 7: Commit**

```bash
git add index.js
git commit -m "feat: add !party, !start_campaign commands and update !help"
```

---

## Task 6: End-to-end test and cleanup

**Files:**
- Modify: `index.js` (temperature comment update only)

- [ ] **Step 1: Full flow test with two players**

Run the complete flow with two Discord accounts:

1. Player 1: `!setup_campaign` → answer all questions → confirm `[CAMPAIGN READY]`
2. Player 1: `!create_character` → go through creation in thread
3. Player 2: `!create_character` → go through creation in thread (simultaneously or sequentially)
4. Main channel: `!party` → both characters listed
5. `!start_campaign` → briefing posted, opening narration begins
6. Both players type actions → DM addresses both characters by name
7. Say "Save campaign" → structured state block output
8. `!wipe_memory` → confirm fresh state, `!party` returns "No characters ready"

- [ ] **Step 2: Raise gameplay temperature to 0.4 for testing**

In the main gameplay Gemini call (inside the `client.on('messageCreate', ...)` handler, near the bottom of `index.js`), change:
```javascript
temperature: 0.2,
```
to:
```javascript
temperature: 0.4, // Testing value — drop to 0.2 for production
```

The `!start_campaign` opening narration already has `temperature: 0.7` with a matching comment — confirm it's there.

- [ ] **Step 3: Update CLAUDE.md with new commands**

Add to the Commands section in `CLAUDE.md`:

```markdown
## Commands

\`\`\`bash
npm install          # Install dependencies
npm run dev          # Run with --watch (auto-restart on file changes)
npm start            # Run in production
\`\`\`

## Bot Commands (in Discord)

**Campaign setup (run in order):**
- `!setup_campaign` — Guided campaign design Q&A
- `!create_character` — Opens a character creation thread per player
- `!party` — Lists ready characters
- `!start_campaign` — Compiles everything and starts the session

**During a session:**
- `!character <name>`, `!wipe_memory`, `!set_theme`, `!help`
```

- [ ] **Step 4: Final commit**

```bash
git add index.js CLAUDE.md
git commit -m "feat: complete campaign and character creation flow"
```

---

## Temperature Reference

| Call | Testing | Production |
|---|---|---|
| `!start_campaign` opening narration | `0.7` | `0.4` |
| Gameplay | `0.4` (currently `0.2` — raise for testing) | `0.2` |
| Campaign setup | `0.5` | `0.5` |
| Character creation | `0.5` | `0.5` |
| Auto-summarisation | `0.1` | `0.1` |
