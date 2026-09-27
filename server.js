require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const { createBot }               = require('./bot');
const { autoCloseExpiredMatches } = require('./db');

// ── Express app ──────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── API routes ───────────────────────────────────────────────────────
app.use('/api/matches',     require('./routes/matches'));
app.use('/api/predictions', require('./routes/predictions'));
app.use('/api/leaderboard', require('./routes/leaderboard'));

// ── 404 catch-all ────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Start Express ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
});

// ── Telegraf bot ──────────────────────────────────────────────────────
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('[Server] Missing BOT_TOKEN in .env');
  process.exit(1);
}

const bot = createBot(token);

bot.launch().then(() => {
  console.log('[Bot] Running');
});

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ── Cron: auto-close matches whose deadline has passed ────────────────
cron.schedule('*/5 * * * *', () => {
  const closed = autoCloseExpiredMatches();
  if (closed > 0) console.log(`[Cron] Auto-closed ${closed} expired match(es)`);
});
