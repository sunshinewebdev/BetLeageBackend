const cron = require('node-cron');
const supabase = require('../lib/supabase');
const { createTournament, settleTournament, BUY_INS } = require('../services/tournamentService');

// ── Settle ended tournaments ────────────────────────────────
async function settleEndedTournaments() {
  const { data: ended } = await supabase
    .from('tournaments')
    .select('id')
    .in('status', ['upcoming', 'active'])
    .lte('end_date', new Date().toISOString());

  if (!ended?.length) return;

  for (const t of ended) {
    try {
      await settleTournament(t.id);
    } catch (err) {
      console.error(`[TournamentManager] Failed to settle ${t.id}:`, err.message);
    }
  }
}

// ── Activate tournaments that have started ──────────────────
async function activateStartedTournaments() {
  const now = new Date().toISOString();
  await supabase
    .from('tournaments')
    .update({ status: 'active' })
    .eq('status', 'upcoming')
    .lte('start_date', now)
    .gt('end_date', now);
}

// ── Ensure upcoming tournaments exist ───────────────────────
async function ensureUpcomingTournaments() {
  const now = new Date();

  for (const type of ['weekly', 'monthly', 'yearly']) {
    const { start_date, end_date } = getNextTournamentWindow(type, now);

    for (const buy_in of BUY_INS) {
      // Check if an active or upcoming tournament of this type + buy-in already exists
      const { data: existing } = await supabase
        .from('tournaments')
        .select('id')
        .eq('type', type)
        .eq('buy_in', buy_in)
        .in('status', ['upcoming', 'active'])
        .limit(1);

      if (existing?.length) continue;

      try {
        const created = await createTournament({ type, buy_in, start_date, end_date });
        console.log(`[TournamentManager] Created ${type} ${buy_in}-credit tournament ${created.id}`);
      } catch (err) {
        console.error(`[TournamentManager] Failed to create ${type} ${buy_in}-credit tournament:`, err.message);
      }
    }
  }
}

function getNextTournamentWindow(type, now) {
  const year = now.getFullYear();
  const month = now.getMonth();

  if (type === 'weekly') {
    // Start next Monday, end following Sunday
    const day = now.getDay();
    const daysUntilMonday = day === 0 ? 1 : 8 - day;
    const start = new Date(now);
    start.setDate(now.getDate() + daysUntilMonday);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);

    return {
      start_date: start.toISOString(),
      end_date: end.toISOString(),
    };
  }

  if (type === 'monthly') {
    // Next month, 1st to last day
    const startMonth = month + 1 > 11 ? 0 : month + 1;
    const startYear = month + 1 > 11 ? year + 1 : year;
    const start = new Date(startYear, startMonth, 1);
    const end = new Date(startYear, startMonth + 1, 0, 23, 59, 59, 999);
    return {
      start_date: start.toISOString(),
      end_date: end.toISOString(),
    };
  }

  // yearly — next year Jan 1 to Dec 31
  const startYear = year + 1;
  return {
    start_date: new Date(startYear, 0, 1).toISOString(),
    end_date: new Date(startYear, 11, 31, 23, 59, 59, 999).toISOString(),
  };
}

// ── Main run ────────────────────────────────────────────────
async function runTournamentManager() {
  console.log(`[TournamentManager] Running at ${new Date().toISOString()}`);
  await settleEndedTournaments();
  await activateStartedTournaments();
  await ensureUpcomingTournaments();
}

function startTournamentManager() {
  // Run daily at midnight
  cron.schedule('0 0 * * *', runTournamentManager);
  // Also run once on startup
  runTournamentManager();
  console.log('[TournamentManager] Scheduled daily at midnight');
}

module.exports = { startTournamentManager };
