require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { startOddsFetcher } = require('./jobs/oddsFetcher');
const { startScoresSettler } = require('./jobs/scoresSettler');

const eventsRouter = require('./routes/events');
const betsRouter = require('./routes/bets');
const leaguesRouter = require('./routes/leagues');
const leaderboardRouter = require('./routes/leaderboard');

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ──────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
app.use(express.json());

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ── Routes ──────────────────────────────────────────────────
app.use('/api/events',      eventsRouter);
app.use('/api/bets',        betsRouter);
app.use('/api/leagues',     leaguesRouter);
app.use('/api/leaderboard', leaderboardRouter);

app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

// ── Error handler ───────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

// ── Start ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`BetLeague API running on :${PORT}`);
  // startOddsFetcher();
  // startScoresSettler();
});
