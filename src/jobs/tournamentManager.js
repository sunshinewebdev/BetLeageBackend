const cron = require('node-cron');
const supabase = require('../lib/supabase');
const { createTournament, settleTournament, BUY_INS } = require('../services/tournamentService');

// ── Settle ended tournaments ────────────────────────────────
async function settleEndedTournaments() {
  // 'settling' marks a settlement that crashed mid-way — retry it
  const { data: ended, error } = await supabase
    .from('tournaments')
    .select('id')
    .in('status', ['upcoming', 'active', 'settling'])
    .lte('end_date', new Date().toISOString());

  if (error) {
    console.error('[TournamentManager] Failed to list ended tournaments:', error.message);
    return;
  }
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

// ── Ensure a tournament exists for the current period ───────
async function ensureCurrentTournaments() {
  const now = new Date();

  for (const type of ['weekly', 'monthly', 'yearly']) {
    const { start_date, end_date } = getCurrentTournamentWindow(type, now);

    for (const buy_in of BUY_INS) {
      // Check if a tournament of this type + buy-in already covers the current
      // period. Ended-but-unsettled tournaments (deferred on pending wagers)
      // have end_date in the past, so they don't block the next period.
      const { data: existing, error: existingError } = await supabase
        .from('tournaments')
        .select('id')
        .eq('type', type)
        .eq('buy_in', buy_in)
        .in('status', ['upcoming', 'active', 'settling'])
        .gt('end_date', now.toISOString())
        .limit(1);

      if (existingError) {
        console.error(`[TournamentManager] Failed to check for existing ${type} ${buy_in}-credit tournament:`, existingError.message);
        continue; // don't risk creating a duplicate
      }
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

function getCurrentTournamentWindow(type, now) {
  const year = now.getFullYear();
  const month = now.getMonth();

  if (type === 'weekly') {
    // Current week: Tuesday 00:00 → Monday 23:59, so a full NFL week
    // (Thu/Sun/Mon games) falls inside one tournament.
    const day = now.getDay(); // 0 = Sun … 6 = Sat
    const daysSinceTuesday = (day - 2 + 7) % 7;
    const start = new Date(now);
    start.setDate(now.getDate() - daysSinceTuesday);
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
    // Current month: 1st to last day
    const start = new Date(year, month, 1);
    const end = new Date(year, month + 1, 0, 23, 59, 59, 999);
    return {
      start_date: start.toISOString(),
      end_date: end.toISOString(),
    };
  }

  // yearly — current year Jan 1 to Dec 31
  return {
    start_date: new Date(year, 0, 1).toISOString(),
    end_date: new Date(year, 11, 31, 23, 59, 59, 999).toISOString(),
  };
}

// ── Main run ────────────────────────────────────────────────
async function runTournamentManager() {
  console.log(`[TournamentManager] Running at ${new Date().toISOString()}`);
  await settleEndedTournaments();
  await activateStartedTournaments();
  await ensureCurrentTournaments();
}

function startTournamentManager() {
  // Hourly: period transitions still happen at the midnight boundary, but
  // settlements deferred on pending wagers retry within the hour instead of
  // waiting a full day.
  cron.schedule('0 * * * *', runTournamentManager);
  // Also run once on startup — seeds current-period tournaments on a fresh
  // deploy (createTournament activates them immediately when the window has
  // already started, even mid-week/month/year).
  runTournamentManager();
  console.log('[TournamentManager] Scheduled hourly');
}

module.exports = { startTournamentManager };
