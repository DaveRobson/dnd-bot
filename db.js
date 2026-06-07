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
