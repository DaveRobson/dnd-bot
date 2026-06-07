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
             character_name = COALESCE($3, characters.character_name),
             display_name   = COALESCE($4, characters.display_name),
             sheet          = COALESCE($5, characters.sheet)`,
        [channelId, userId, characterName ?? null, displayName ?? null, sheet ?? null]
    );
}

export async function deleteCampaignAndChars(channelId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM campaign   WHERE channel_id = $1', [channelId]);
        await client.query('DELETE FROM characters WHERE channel_id = $1', [channelId]);
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

export async function saveChatSession(channelId, history) {
    await pool.query(
        `INSERT INTO chat_sessions (channel_id, history)
         VALUES ($1, $2)
         ON CONFLICT (channel_id) DO UPDATE SET history = $2`,
        [channelId, JSON.stringify(history)]
    );
}

export async function loadAll(chatSessions, channelThemes, characterNames, turnCounts, campaignConfig, readyCharacters) {
    const [channelStateRes, campaignRes, charactersRes, chatSessionsRes] = await Promise.all([
        pool.query('SELECT * FROM channel_state'),
        pool.query('SELECT * FROM campaign'),
        pool.query('SELECT * FROM characters'),
        pool.query('SELECT * FROM chat_sessions'),
    ]);

    for (const row of channelStateRes.rows) {
        channelThemes.set(row.channel_id, row.theme);
        turnCounts.set(row.channel_id, row.turn_count);
    }

    for (const row of campaignRes.rows) {
        campaignConfig.set(row.channel_id, {
            status: row.status,
            brief: row.brief,
            lore: row.lore,
            storyArcs: row.story_arcs,
            relationships: row.relationships,
            history: [],
        });
    }

    for (const row of charactersRes.rows) {
        const { channel_id, user_id, character_name, display_name, sheet } = row;

        if (!characterNames.has(channel_id)) characterNames.set(channel_id, new Map());
        characterNames.get(channel_id).set(user_id, character_name);

        if (sheet != null) {
            if (!readyCharacters.has(channel_id)) readyCharacters.set(channel_id, new Map());
            readyCharacters.get(channel_id).set(user_id, {
                displayName: display_name,
                characterName: character_name,
                sheet,
            });
        }
    }

    for (const row of chatSessionsRes.rows) {
        chatSessions.set(row.channel_id, row.history);
    }
}

export async function clearChannel(channelId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM channel_state  WHERE channel_id = $1', [channelId]);
        await client.query('DELETE FROM campaign        WHERE channel_id = $1', [channelId]);
        await client.query('DELETE FROM characters      WHERE channel_id = $1', [channelId]);
        await client.query('DELETE FROM chat_sessions   WHERE channel_id = $1', [channelId]);
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}
