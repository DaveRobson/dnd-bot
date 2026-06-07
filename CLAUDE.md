# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A multiplayer D&D Game Master bot for Discord, powered by Gemini 2.5 Flash. Players interact in Discord channels; the bot maintains per-channel conversation history and uses a loaded rules file to drive consistent narration.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Run with --watch (auto-restart on file changes)
npm start            # Run in production
```

## Bot Commands (in Discord)

**Campaign setup (run in order):**
- `!setup_campaign` — Guided Gemini Q&A to design the campaign
- `!create_character` — Opens a character creation thread per player (after campaign setup)
- `!party` — Lists ready characters
- `!start_campaign` — Compiles everything and starts the session (campaign + ≥1 character required)

**During a session:**
- `!character <name>` — Set or change your character name
- `!wipe_memory` — Fully reset session, campaign, and character data
- `!set_theme <fantasy|cyberpunk|western>` — Switch theme and reset session
- `!help` — List all commands

## Environment Variables

Copy `.env.example` to `.env` and fill in both values:
- `DISCORD_TOKEN` — from the Discord Developer Portal (Bot section)
- `GEMINI_API_KEY` — from Google AI Studio

On Railway, set these via the Railway dashboard (Variables tab).

## Architecture

All logic lives in `index.js`. There are no modules or subdirectories.

**State** is held in seven in-memory Maps keyed by Discord `channelId` (or `threadId` for `creationSessions`):
- `chatSessions` — Gemini conversation history for active gameplay
- `channelThemes` — active theme/rulebook per channel
- `characterNames` — channelId → Map(userId → characterName); populated by `!character` and `!create_character`
- `turnCounts` — auto-summarisation counter per channel
- `campaignConfig` — campaign setup state: `'configuring'` | `'ready'`, brief, history
- `creationSessions` — per-thread character creation state (keyed by threadId)
- `readyCharacters` — completed character sheets per channel

State is lost on restart. Persisting to a database would be the main architectural change needed for production.

**Pre-session flow:**
1. `!setup_campaign` → Gemini Q&A in main channel → detects `[CAMPAIGN READY]` sentinel → stores campaign brief
2. `!create_character` → bot creates a public thread per player → Gemini guides creation → detects `[CHARACTER READY]` sentinel → stores character sheet, announces in main channel
3. `!start_campaign` → compiles brief + all sheets → sets theme to `'fantasy'` → fires opening narration

**Theme system** — each theme maps to a Markdown file (`5esrd.md`, `cyberpunk.md`, `space_western.md`) loaded at request time and injected into the Gemini system prompt. Populate `5esrd.md` with actual D&D 5e SRD content. Note: `!start_campaign` always hardcodes the `'fantasy'` theme regardless of any prior `!set_theme` call.

**Session history** is capped at `MAX_HISTORY = 50` turns. Every `SUMMARY_INTERVAL = 10` turns, a second Gemini call compresses old history into a structured campaign state summary injected as ground truth.

**Temperatures (current testing values — reduce for production):**
- Gameplay: `0.4` (production: `0.2`)
- `!start_campaign` opening narration: `0.7` (production: `0.4`)
- Campaign setup / character creation: `0.5`
- Auto-summarisation: `0.1`

## Deployment (Railway)

The `Procfile` declares `worker: node index.js`. Set `DISCORD_TOKEN` and `GEMINI_API_KEY` in the Railway dashboard.

The bot requires these Discord permissions: **View Channels**, **Send Messages**, **Read Message History**, **Create Public Threads**, **Send Messages in Threads**.

Enable **Message Content Intent** in Discord Developer Portal → Bot → Privileged Gateway Intents.
