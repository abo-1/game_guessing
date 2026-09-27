const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { calculatePoints } = require('./scoring');

// ── Ensure data directory exists ────────────────────────────────────
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'bot.sqlite');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ───────────────────────────────────────────────────────────
function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id   INTEGER UNIQUE NOT NULL,
      username      TEXT,
      first_name    TEXT,
      joined_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS matches (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      team_a          TEXT NOT NULL,
      team_b          TEXT NOT NULL,
      kickoff_time    DATETIME NOT NULL,
      guess_deadline  DATETIME NOT NULL,
      status          TEXT DEFAULT 'open',
      actual_score_a  INTEGER,
      actual_score_b  INTEGER,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS predictions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             INTEGER NOT NULL REFERENCES users(id),
      match_id            INTEGER NOT NULL REFERENCES matches(id),
      predicted_score_a   INTEGER NOT NULL,
      predicted_score_b   INTEGER NOT NULL,
      points_earned       INTEGER,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, match_id)
    );

    CREATE TABLE IF NOT EXISTS admins (
      telegram_id INTEGER PRIMARY KEY
    );
  `);

  syncAdminsFromEnv();
}

// ── Sync admin IDs from .env into the admins table ──────────────────
function syncAdminsFromEnv() {
  const raw = process.env.ADMIN_IDS || '';
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const insert = db.prepare('INSERT OR IGNORE INTO admins (telegram_id) VALUES (?)');
  for (const id of ids) {
    const n = Number(id);
    if (Number.isInteger(n) && n > 0) insert.run(n);
  }
}

// ── Users ────────────────────────────────────────────────────────────
function registerUser(telegramId, username, firstName) {
  const existing = db
    .prepare('SELECT id FROM users WHERE telegram_id = ?')
    .get(telegramId);

  if (existing) {
    db.prepare(`
      UPDATE users SET username = ?, first_name = ? WHERE telegram_id = ?
    `).run(username || null, firstName || null, telegramId);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO users (telegram_id, username, first_name) VALUES (?, ?, ?)
  `).run(telegramId, username || null, firstName || null);

  return result.lastInsertRowid;
}

function getUserByTelegramId(telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
}

function getAllUsers() {
  return db.prepare('SELECT * FROM users ORDER BY joined_at ASC').all();
}

// ── Admins ───────────────────────────────────────────────────────────
function isAdminTelegramId(telegramId) {
  return Boolean(
    db.prepare('SELECT telegram_id FROM admins WHERE telegram_id = ?').get(telegramId)
  );
}

// ── Matches ──────────────────────────────────────────────────────────
function addMatch(teamA, teamB, kickoffTime, guessDeadline) {
  const result = db.prepare(`
    INSERT INTO matches (team_a, team_b, kickoff_time, guess_deadline)
    VALUES (?, ?, ?, ?)
  `).run(teamA, teamB, kickoffTime, guessDeadline);
  return result.lastInsertRowid;
}

function getMatchById(matchId) {
  return db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
}

function getOpenMatches() {
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT * FROM matches
    WHERE status = 'open' AND guess_deadline > ?
    ORDER BY kickoff_time ASC
  `).all(now);
}

function getAllMatches() {
  return db.prepare('SELECT * FROM matches ORDER BY kickoff_time DESC').all();
}

function updateMatch(matchId, fields) {
  const allowed = ['team_a', 'team_b', 'kickoff_time', 'guess_deadline', 'status'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return;
  values.push(matchId);
  db.prepare(`UPDATE matches SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

function closeMatch(matchId) {
  const match = getMatchById(matchId);
  if (!match) return { success: false, message: 'Match not found.' };
  if (match.status === 'finished') return { success: false, message: 'Match already finished.' };
  db.prepare("UPDATE matches SET status = 'closed' WHERE id = ?").run(matchId);
  return { success: true };
}

function removeMatch(matchId) {
  const match = getMatchById(matchId);
  if (!match) return { success: false, message: 'Match not found.' };
  if (match.status === 'finished') return { success: false, message: 'Cannot remove a finished match.' };
  db.transaction(() => {
    db.prepare('DELETE FROM predictions WHERE match_id = ?').run(matchId);
    db.prepare('DELETE FROM matches WHERE id = ?').run(matchId);
  })();
  return { success: true };
}

// ── Predictions ──────────────────────────────────────────────────────
function savePrediction(userId, matchId, scoreA, scoreB) {
  const match = getMatchById(matchId);
  if (!match) return { success: false, message: 'Match not found.' };
  if (match.status !== 'open') return { success: false, message: 'Guessing is closed for this match.' };

  const now = new Date();
  if (now >= new Date(match.guess_deadline)) {
    return { success: false, message: 'The guess deadline has passed.' };
  }

  db.prepare(`
    INSERT INTO predictions (user_id, match_id, predicted_score_a, predicted_score_b)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, match_id) DO UPDATE SET
      predicted_score_a = excluded.predicted_score_a,
      predicted_score_b = excluded.predicted_score_b,
      points_earned = NULL,
      created_at = CURRENT_TIMESTAMP
  `).run(userId, matchId, scoreA, scoreB);

  return { success: true };
}

function getPredictionByUserAndMatch(userId, matchId) {
  return db.prepare(`
    SELECT * FROM predictions WHERE user_id = ? AND match_id = ?
  `).get(userId, matchId);
}

function getUserHistory(userId) {
  return db.prepare(`
    SELECT
      p.*,
      m.team_a, m.team_b, m.kickoff_time, m.status AS match_status,
      m.actual_score_a, m.actual_score_b
    FROM predictions p
    JOIN matches m ON m.id = p.match_id
    WHERE p.user_id = ?
    ORDER BY m.kickoff_time DESC
  `).all(userId);
}

function getUsersWithPredictionForMatch(matchId) {
  return db.prepare(`
    SELECT users.telegram_id
    FROM predictions
    JOIN users ON users.id = predictions.user_id
    WHERE predictions.match_id = ?
  `).all(matchId);
}

// ── Scoring ──────────────────────────────────────────────────────────
function setMatchResult(matchId, actualA, actualB) {
  const match = getMatchById(matchId);
  if (!match) return { success: false, message: 'Match not found.' };
  if (match.status === 'finished') return { success: false, message: 'Result already set.' };

  const predictions = db
    .prepare('SELECT * FROM predictions WHERE match_id = ?')
    .all(matchId);

  const updatePrediction = db.prepare(
    'UPDATE predictions SET points_earned = ? WHERE id = ?'
  );
  const updateMatch = db.prepare(`
    UPDATE matches
    SET status = 'finished', actual_score_a = ?, actual_score_b = ?
    WHERE id = ?
  `);

  let scoredCount = 0;

  db.transaction(() => {
    for (const p of predictions) {
      const pts = calculatePoints(
        p.predicted_score_a, p.predicted_score_b, actualA, actualB
      );
      updatePrediction.run(pts, p.id);
      if (pts > 0) scoredCount++;
    }
    updateMatch.run(actualA, actualB, matchId);
  })();

  return {
    success: true,
    predictionsCount: predictions.length,
    scoredCount,
  };
}

// ── Leaderboard / Stats ──────────────────────────────────────────────
function getLeaderboard(limit = 10) {
  return db.prepare(`
    SELECT
      u.id, u.telegram_id, u.username, u.first_name,
      COALESCE(SUM(p.points_earned), 0) AS total_points
    FROM users u
    LEFT JOIN predictions p ON u.id = p.user_id
    GROUP BY u.id
    ORDER BY total_points DESC, u.joined_at ASC
    LIMIT ?
  `).all(limit);
}

function getUserStats(userId) {
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(points_earned), 0)                                    AS total_points,
      COUNT(*)                                                            AS total_predictions,
      SUM(CASE WHEN points_earned IS NOT NULL THEN 1 ELSE 0 END)         AS scored_predictions,
      SUM(CASE WHEN points_earned > 0 THEN 1 ELSE 0 END)                 AS correct_predictions
    FROM predictions WHERE user_id = ?
  `).get(userId);

  const rankRow = db.prepare(`
    WITH ranked AS (
      SELECT u.id,
        RANK() OVER (
          ORDER BY COALESCE(SUM(p.points_earned), 0) DESC, u.joined_at ASC
        ) AS rank
      FROM users u
      LEFT JOIN predictions p ON u.id = p.user_id
      GROUP BY u.id
    )
    SELECT rank FROM ranked WHERE id = ?
  `).get(userId);

  const accuracy = totals.scored_predictions > 0
    ? Math.round((totals.correct_predictions / totals.scored_predictions) * 100)
    : 0;

  return {
    totalPoints: totals.total_points,
    totalPredictions: totals.total_predictions,
    scoredPredictions: totals.scored_predictions,
    correctPredictions: totals.correct_predictions,
    rank: rankRow?.rank ?? null,
    accuracy,
  };
}

// ── Cron helpers ─────────────────────────────────────────────────────
function autoCloseExpiredMatches() {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE matches SET status = 'closed'
    WHERE status = 'open' AND guess_deadline <= ?
  `).run(now);
  return result.changes;
}

function getMatchesClosingSoon(minutes = 60) {
  const now = new Date();
  const soon = new Date(now.getTime() + minutes * 60_000).toISOString();
  return db.prepare(`
    SELECT * FROM matches
    WHERE status = 'open' AND guess_deadline > ? AND guess_deadline <= ?
  `).all(now.toISOString(), soon);
}

// ── Init ─────────────────────────────────────────────────────────────
initDb();

module.exports = {
  db,
  registerUser,
  getUserByTelegramId,
  getAllUsers,
  isAdminTelegramId,
  addMatch,
  getMatchById,
  getOpenMatches,
  getAllMatches,
  updateMatch,
  closeMatch,
  removeMatch,
  savePrediction,
  getPredictionByUserAndMatch,
  getUserHistory,
  getUsersWithPredictionForMatch,
  setMatchResult,
  getLeaderboard,
  getUserStats,
  autoCloseExpiredMatches,
  getMatchesClosingSoon,
};
