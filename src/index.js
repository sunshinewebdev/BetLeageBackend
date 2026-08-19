require('dotenv').config();

// Tournament windows and cron schedules are computed in local time — pin the
// timezone (US sports schedules are Eastern) so period boundaries don't shift
// between hosts. Override with TZ in the environment if needed.
process.env.TZ = process.env.TZ || 'America/New_York';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { startOddsFetcher } = require('./jobs/oddsFetcher');
const { startScoresSettler } = require('./jobs/scoresSettler');
const { startTournamentManager } = require('./jobs/tournamentManager');

const eventsRouter = require('./routes/events');
const betsRouter = require('./routes/bets');
const parlaysRouter = require('./routes/parlays');
const leaguesRouter = require('./routes/leagues');
const leaderboardRouter = require('./routes/leaderboard');
const stripeRouter  = require('./routes/stripe');
const accountRouter = require('./routes/account');
const tournamentsRouter = require('./routes/tournaments');
const profileRouter = require('./routes/profile');
const app = express();
const PORT = process.env.PORT || 3001;

if (!process.env.CLIENT_URL) {
  // Fail closed: with origin undefined, cors() would reflect any origin.
  throw new Error('CLIENT_URL must be set');
}

// Behind a reverse proxy (Render/Railway/etc.) so req.ip and the rate
// limiter see the real client IP instead of the proxy's.
app.set('trust proxy', 1);

// ── Middleware ──────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  // Stripe's webhook deliveries/retries must not be throttled — the
  // endpoint authenticates via signature verification instead.
  skip: (req) => req.originalUrl === '/api/stripe/webhook',
}));

// ── Routes ──────────────────────────────────────────────────
app.use('/api/events',      eventsRouter);
app.use('/api/bets',        betsRouter);
app.use('/api/parlays',     parlaysRouter);
app.use('/api/leagues',     leaguesRouter);
app.use('/api/leaderboard', leaderboardRouter);
app.use('/api/stripe',      stripeRouter);
app.use('/api/account',     accountRouter);
app.use('/api/tournaments', tournamentsRouter);
app.use('/api/profile', profileRouter);

app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

// ── Error handler ───────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack || err);
  const status = err.status || 500;
  // Don't leak internal error details (Supabase/Stripe messages, stack
  // info) to clients on unexpected errors.
  res.status(status).json({
    error: status < 500 ? (err.message || 'Request failed') : 'Internal server error'
  });
});

// ── Start ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`BetLeague API running on :${PORT}`);
  startOddsFetcher();
  startScoresSettler();
  startTournamentManager();
});
