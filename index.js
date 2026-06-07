import { Client, GatewayIntentBits } from 'discord.js';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!GEMINI_API_KEY || !DISCORD_TOKEN) {
    console.error('Missing GEMINI_API_KEY or DISCORD_TOKEN environment variables');
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// Per-channel state
const chatSessions = new Map();    // channelId -> history[]
const channelThemes = new Map();   // channelId -> themeKey
const characterNames = new Map();  // channelId -> Map(userId -> characterName)
const turnCounts = new Map();      // channelId -> number
const campaignConfig = new Map();  // channelId -> { status: 'configuring'|'ready', brief: string, history: [] }
const creationSessions = new Map();// threadId  -> { userId, channelId, history: [] }
const readyCharacters = new Map(); // channelId -> Map(userId -> { displayName, characterName, sheet })

const MAX_HISTORY = 50;
const SUMMARY_INTERVAL = 10; // Summarise and compress history every N player turns

const THEME_FILES = {
    fantasy: '5esrd.md',
    cyberpunk: 'cyberpunk.md',
    western: 'space_western.md',
};

function buildSystemPrompt(themeKey) {
    const file = THEME_FILES[themeKey] ?? '5esrd.md';
    let rules = '';
    try {
        rules = fs.readFileSync(file, 'utf-8');
    } catch {
        rules = 'Rules file not found. Use baseline RPG logic.';
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

UNIVERSE RULES:
${rules}`;
}

async function summariseSession(channelId, history) {
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: history,
            config: {
                systemInstruction: `You are a precise campaign recorder. Summarise the current state of this D&D session into a structured block. Include:
- Every player character: name, class, current HP / max HP, inventory, active status effects
- Current location and approximate time of day
- The last 5 significant events or outcomes
- Any active quests, threats, or objectives
- Key NPCs encountered and their relationship to the party

Be strictly factual — only record what is explicitly established in the conversation. Do not invent or embellish anything.`,
                temperature: 0.1,
                topP: 0.8,
                topK: 40,
            },
        });

        const summary = response.text;
        if (!summary) return;

        // Keep the last 6 history entries (3 full exchanges) and prepend the summary
        const recentTurns = history.splice(-6);
        history.length = 0;
        history.push(
            { role: 'user', parts: [{ text: `[AUTO CAMPAIGN STATE — Ground Truth — treat this as authoritative]\n\n${summary}` }] },
            { role: 'model', parts: [{ text: 'Campaign state acknowledged. Continuing the session with this as ground truth.' }] },
            ...recentTurns
        );
    } catch (error) {
        console.error('Summarisation failed:', error.message);
        // Non-fatal — session continues with untrimmed history
    }
}

client.once('ready', () => {
    console.log(`Dungeon Master online as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const channelId = message.channel.isThread() ? message.channel.parentId : message.channel.id;

    if (message.content.startsWith('!')) {
        const [command, ...args] = message.content.slice(1).trim().split(/\s+/);

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
            for (const [threadId, s] of creationSessions) {
                if (s.channelId === channelId) creationSessions.delete(threadId);
            }
            return message.channel.send(`**Theme set: ${theme.toUpperCase()}**\n*The universe shifts. Set your character name with \`!character <name>\`, then just type to play.*`);
        }

        if (command === 'character') {
            const name = args.join(' ').trim();
            if (!name) return message.reply('Usage: `!character <name>` — e.g. `!character Thorin Oakenshield`');
            if (!characterNames.has(channelId)) characterNames.set(channelId, new Map());
            characterNames.get(channelId).set(message.author.id, name);
            return message.reply(`Character set to **${name}**. The DM will address you by this name.`);
        }

        if (command === 'wipe_memory') {
            chatSessions.set(channelId, []);
            characterNames.set(channelId, new Map());
            turnCounts.set(channelId, 0);
            campaignConfig.delete(channelId);
            readyCharacters.delete(channelId);
            for (const [threadId, s] of creationSessions) {
                if (s.channelId === channelId) creationSessions.delete(threadId);
            }
            return message.reply('Session memory, character names, and campaign data cleared.');
        }

        if (command === 'help') {
            return message.reply(
                '**DM Bot Commands**\n' +
                '`!set_theme <fantasy|cyberpunk|western>` — Start or restart a campaign\n' +
                '`!character <name>` — Set your character name (e.g. `!character Aria Swiftblade`)\n' +
                '`!wipe_memory` — Clear session history and character names\n' +
                '`!help` — Show this message\n\n' +
                'Wrap a message in `(parentheses)` to speak OOC directly to the DM.\n' +
                'Say "Save campaign" to get a copy-pasteable save state.'
            );
        }

        return;
    }

    if (!channelThemes.has(channelId)) {
        return message.reply('Set a theme first with `!set_theme fantasy`, `cyberpunk`, or `western`.');
    }

    const history = chatSessions.get(channelId) ?? [];
    chatSessions.set(channelId, history);

    const discordName = message.member?.displayName ?? message.author.username;
    const characterName = characterNames.get(channelId)?.get(message.author.id);
    const label = characterName ? `${characterName} (${discordName})` : discordName;
    history.push({ role: 'user', parts: [{ text: `[${label}]: ${message.content}` }] });

    // Increment turn counter and auto-summarise every SUMMARY_INTERVAL turns
    const turns = (turnCounts.get(channelId) ?? 0) + 1;
    turnCounts.set(channelId, turns);
    if (turns % SUMMARY_INTERVAL === 0) {
        await summariseSession(channelId, history);
    }

    // Fallback trim if summarisation didn't run or history grew unexpectedly
    if (history.length > MAX_HISTORY) {
        history.splice(0, history.length - MAX_HISTORY);
    }

    await message.channel.sendTyping();

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: history,
            config: {
                systemInstruction: buildSystemPrompt(channelThemes.get(channelId)),
                temperature: 0.2,
                topP: 0.8,
                topK: 40,
            },
        });

        const narration = response.text;
        if (!narration) throw new Error('Empty response from Gemini');

        history.push({ role: 'model', parts: [{ text: narration }] });

        // Discord message limit is 2000 chars
        for (let i = 0; i < narration.length; i += 2000) {
            await message.channel.send(narration.slice(i, i + 2000));
        }
    } catch (error) {
        console.error(error);
        await message.channel.send(`**Error:** ${error.message}`);
    }
});

client.login(DISCORD_TOKEN);
