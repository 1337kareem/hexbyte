// Where duels are saved. With DATABASE_URL set to a Tiger Data service, spells and
// body tracking go into hypertables, stats come from a continuous aggregate, and
// old body-tracking data is compressed. Without it, everything saves to server/data/.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const POINTS_PER_FRAME = 66; // 33 body points, x and y each
const MAX_FRAMES_PER_POST = 400;

function cleanFrames(frames) {
  if (!Array.isArray(frames)) return [];
  return frames
    .slice(0, MAX_FRAMES_PER_POST)
    .filter(
      (f) =>
        Number.isFinite(f?.t) &&
        (f.side === 0 || f.side === 1) &&
        Array.isArray(f.points) &&
        f.points.length === POINTS_PER_FRAME &&
        f.points.every(Number.isFinite),
    )
    .map((f) => ({ t: f.t, side: f.side, points: f.points.map((v) => Math.round(v * 1000) / 1000) }));
}

function summarize(spells, matchCount) {
  const cast = spells.filter((s) => s.outcome === 'cast');
  const byElement = ['fire', 'shield', 'lightning'].map((element) => {
    const mine = cast.filter((s) => s.element === element);
    return {
      element,
      spells: mine.length,
      avgPower: mine.length ? mine.reduce((sum, s) => sum + (s.power ?? 0), 0) / mine.length : null,
      damage: mine.reduce((sum, s) => sum + (s.damage ?? 0), 0),
    };
  });
  const timed = spells.filter((s) => Number.isFinite(s.latencyMs));
  const top = [...cast].sort((a, b) => (b.power ?? 0) - (a.power ?? 0) || (b.damage ?? 0) - (a.damage ?? 0))[0];
  return {
    matches: matchCount,
    spells: cast.length,
    cheatsBlocked: spells.filter((s) => s.outcome === 'cheat').length,
    byElement,
    avgLatencyMs: timed.length ? Math.round(timed.reduce((sum, s) => sum + s.latencyMs, 0) / timed.length) : null,
    topSpell: top ? { name: top.name, power: top.power, player: top.player, element: top.element } : null,
  };
}

export async function createFileStore(dir = join(import.meta.dirname, 'data'), kind = 'local file') {
  await mkdir(join(dir, 'frames'), { recursive: true });
  const spellsFile = join(dir, 'spells.jsonl');
  const matchesFile = join(dir, 'matches.jsonl');
  const runesFile = join(dir, 'runes.json');
  const readLines = async (file) => {
    try {
      return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  const spells = await readLines(spellsFile);
  const matchIds = new Set((await readLines(matchesFile)).map((m) => m.id));
  let runes = {};
  try {
    runes = JSON.parse(await readFile(runesFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const framesFile = (matchId) => join(dir, 'frames', `${matchId.replace(/[^\w-]/g, '')}.jsonl`);

  return {
    kind,
    async addMatch(match) {
      matchIds.add(match.id);
      await appendFile(matchesFile, `${JSON.stringify({ event: 'start', ...match })}\n`);
    },
    async endMatch(id, result) {
      await appendFile(matchesFile, `${JSON.stringify({ event: 'end', id, ...result, time: new Date().toISOString() })}\n`);
    },
    async addSpell(spell) {
      spells.push(spell);
      await appendFile(spellsFile, `${JSON.stringify(spell)}\n`);
    },
    async addFrames(matchId, frames) {
      const clean = cleanFrames(frames);
      if (clean.length) await appendFile(framesFile(matchId), clean.map((f) => `${JSON.stringify(f)}\n`).join(''));
      return clean.length;
    },
    async replay(matchId) {
      return {
        frames: (await readLines(framesFile(matchId))).sort((a, b) => a.t - b.t),
        spells: spells.filter((s) => s.matchId === matchId).map((s) => ({ ...s, t: Date.parse(s.time) })),
      };
    },
    async stats() {
      return { source: kind, ...summarize(spells, matchIds.size) };
    },
    async getRune(sub) {
      return runes[sub] ?? [];
    },
    async saveRune(sub, samples) {
      runes[sub] = samples;
      await writeFile(runesFile, JSON.stringify(runes));
    },
  };
}

// Runs one setup statement, and keeps going if this database doesn't support it.
async function tryQuery(pool, sql, note) {
  try {
    await pool.query(sql);
    return true;
  } catch (error) {
    console.warn(`Tiger Data setup skipped (${note}): ${error.message}`);
    return false;
  }
}

async function createTigerStore(connectionString) {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 8000, max: 5 });
  // Without this, a dropped idle connection would crash the server during a demo.
  pool.on('error', (error) => console.warn(`Database connection lost: ${error.message}`));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ,
      players JSONB NOT NULL,
      winner SMALLINT,
      final_hp JSONB
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS spells (
      time TIMESTAMPTZ NOT NULL,
      match_id TEXT NOT NULL,
      side SMALLINT NOT NULL,
      player TEXT NOT NULL,
      element TEXT NOT NULL,
      outcome TEXT NOT NULL,
      power SMALLINT,
      damage SMALLINT,
      name TEXT,
      words TEXT,
      cost_usd DOUBLE PRECISION,
      latency_ms INTEGER
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pose_frames (
      time TIMESTAMPTZ NOT NULL,
      match_id TEXT NOT NULL,
      side SMALLINT NOT NULL,
      points REAL[] NOT NULL
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS runes (
      sub TEXT PRIMARY KEY,
      samples JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  // Hypertables split rows into time chunks, so time-range queries stay fast.
  const hypertables =
    (await tryQuery(pool, `SELECT create_hypertable('spells', 'time', if_not_exists => TRUE)`, 'spells hypertable')) &&
    (await tryQuery(pool, `SELECT create_hypertable('pose_frames', 'time', if_not_exists => TRUE)`, 'pose hypertable'));

  if (hypertables) {
    await pool.query(`CREATE INDEX IF NOT EXISTS pose_frames_match ON pose_frames (match_id, time)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS spells_match ON spells (match_id, time)`);
    // Body tracking is about 1,300 numbers a second per duel. Compress chunks
    // older than a day, grouped by match and side so replays stay cheap.
    const compressed =
      (await tryQuery(
        pool,
        `ALTER TABLE pose_frames SET (timescaledb.compress, timescaledb.compress_segmentby = 'match_id, side')`,
        'compression settings',
      )) &&
      (await tryQuery(
        pool,
        `SELECT add_compression_policy('pose_frames', INTERVAL '1 day', if_not_exists => TRUE)`,
        'compression policy',
      ));
    if (!compressed) console.warn('Body-tracking data will not be compressed.');

    // A continuous aggregate keeps per-hour spell stats up to date in the background.
    // materialized_only = false also counts spells cast since the last refresh.
    await tryQuery(
      pool,
      `CREATE MATERIALIZED VIEW IF NOT EXISTS spell_stats_hourly
       WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
       SELECT time_bucket('1 hour', time) AS bucket, element, outcome,
              count(*) AS spells, avg(power) AS avg_power, sum(damage) AS damage,
              avg(latency_ms) AS avg_latency_ms
       FROM spells
       GROUP BY bucket, element, outcome
       WITH NO DATA`,
      'continuous aggregate',
    );
    await tryQuery(
      pool,
      `SELECT add_continuous_aggregate_policy('spell_stats_hourly',
         start_offset => INTERVAL '30 days', end_offset => INTERVAL '1 minute',
         schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE)`,
      'aggregate refresh policy',
    );
  } else {
    console.warn('This database has no hypertables, so it is not a Tiger Data service.');
  }

  const hasAggregate = async () => {
    const { rows } = await pool.query(`SELECT to_regclass('spell_stats_hourly') IS NOT NULL AS ok`);
    return rows[0].ok;
  };

  return {
    kind: hypertables ? 'Tiger Data' : 'PostgreSQL',
    async addMatch(match) {
      await pool.query(`INSERT INTO matches (id, started_at, players) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [
        match.id,
        match.startedAt,
        JSON.stringify(match.players.map(({ sub, ...p }) => p)),
      ]);
    },
    async endMatch(id, { winner, finalHp }) {
      await pool.query(`UPDATE matches SET ended_at = now(), winner = $2, final_hp = $3 WHERE id = $1`, [
        id,
        winner,
        JSON.stringify(finalHp),
      ]);
    },
    async addSpell(s) {
      await pool.query(
        `INSERT INTO spells (time, match_id, side, player, element, outcome, power, damage, name, words, cost_usd, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [s.time, s.matchId, s.side, s.player, s.element, s.outcome, s.power, s.damage, s.name, s.words, s.costUsd, s.latencyMs],
      );
    },
    async addFrames(matchId, frames) {
      const clean = cleanFrames(frames);
      if (!clean.length) return 0;
      const values = [];
      const params = [];
      clean.forEach((f, i) => {
        values.push(`($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`);
        params.push(new Date(f.t).toISOString(), matchId, f.side, f.points);
      });
      await pool.query(`INSERT INTO pose_frames (time, match_id, side, points) VALUES ${values.join(', ')}`, params);
      return clean.length;
    },
    async replay(matchId) {
      const frames = await pool.query(
        `SELECT (extract(epoch FROM time) * 1000)::float8 AS t, side, points
         FROM pose_frames WHERE match_id = $1 ORDER BY time LIMIT 6000`,
        [matchId],
      );
      const spells = await pool.query(
        `SELECT (extract(epoch FROM time) * 1000)::float8 AS t, side, player, element, outcome, power, damage, name
         FROM spells WHERE match_id = $1 ORDER BY time`,
        [matchId],
      );
      return { frames: frames.rows, spells: spells.rows };
    },
    async stats() {
      const matches = await pool.query(`SELECT count(*)::int AS n FROM matches`);
      const recent = await pool.query(
        `SELECT element, outcome, power, damage, name, player, latency_ms AS "latencyMs"
         FROM spells WHERE time > now() - INTERVAL '30 days'`,
      );
      const rows = recent.rows.map((r) => ({ ...r, latencyMs: r.latencyMs ?? undefined }));
      const summary = summarize(rows, matches.rows[0].n);

      // Per-element totals come from the continuous aggregate when it exists.
      if (hypertables && (await hasAggregate())) {
        const agg = await pool.query(
          `SELECT element, sum(spells)::int AS spells,
                  (sum(avg_power * spells) / NULLIF(sum(spells), 0))::float8 AS "avgPower",
                  coalesce(sum(damage), 0)::int AS damage
           FROM spell_stats_hourly
           WHERE outcome = 'cast' AND bucket > now() - INTERVAL '30 days'
           GROUP BY element`,
        );
        summary.byElement = summary.byElement.map(
          (e) => agg.rows.find((row) => row.element === e.element) ?? { ...e, spells: 0, avgPower: null, damage: 0 },
        );
        summary.fromAggregate = true;
      }

      let compression = null;
      try {
        const { rows: c } = await pool.query(
          `SELECT before_compression_total_bytes::float8 AS before, after_compression_total_bytes::float8 AS after
           FROM hypertable_compression_stats('pose_frames')`,
        );
        if (c[0]?.before && c[0]?.after) compression = { before: c[0].before, after: c[0].after };
      } catch {
        // Older or newer Tiger versions name this differently. Stats still work without it.
      }
      return { source: 'Tiger Data', ...summary, compression };
    },
    async getRune(sub) {
      const { rows } = await pool.query(`SELECT samples FROM runes WHERE sub = $1`, [sub]);
      return rows[0]?.samples ?? [];
    },
    async saveRune(sub, samples) {
      await pool.query(
        `INSERT INTO runes (sub, samples, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (sub) DO UPDATE SET samples = EXCLUDED.samples, updated_at = now()`,
        [sub, JSON.stringify(samples)],
      );
    },
  };
}

// A bad database connection should never stop the demo from starting.
export async function createStore(connectionString) {
  if (connectionString) {
    try {
      return await createTigerStore(connectionString);
    } catch (error) {
      console.warn(`Tiger Data is unavailable, so duels will save locally: ${error.message}`);
    }
  }
  if (process.env.HEXBYTE_DATA_DIR) return createFileStore(process.env.HEXBYTE_DATA_DIR);
  // On Vercel only /tmp is writable, and it is wiped whenever a server copy shuts down.
  // Add DATABASE_URL (Tiger Data) to keep stats and replays there.
  if (process.env.VERCEL) return createFileStore('/tmp/hexbyte', 'temporary storage');
  return createFileStore();
}
