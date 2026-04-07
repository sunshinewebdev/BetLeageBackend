const cron = require('node-cron');
const { SPORTS, fetchEventsWithOdds, normalizeEvent } = require('../services/oddsService');
const supabase = require('../lib/supabase');

const INTERVAL = parseInt(process.env.ODDS_FETCH_INTERVAL || '15');

async function runOddsFetch() {
  console.log(`[OddsFetcher] Starting fetch at ${new Date().toISOString()}`);

  for (const sport of SPORTS) {
    try {
      const raw = await fetchEventsWithOdds(sport);
      const events = raw.map(e => normalizeEvent(e, sport));

      if (events.length === 0) continue;

      const { error } = await supabase
        .from('events')
        .upsert(events, { onConflict: 'id' });

      if (error) {
        console.error(`[OddsFetcher] Upsert error for ${sport}:`, error.message);
      } else {
        console.log(`[OddsFetcher] ${sport}: upserted ${events.length} events`);
      }
    } catch (err) {
      // Don't let one sport crash the whole job
      console.error(`[OddsFetcher] Failed for ${sport}:`, err.message);
    }
  }
}

function startOddsFetcher() {
  // Run immediately on startup
  runOddsFetch();

  // Then on schedule
  const schedule = `*/${INTERVAL} * * * *`;
  cron.schedule(schedule, runOddsFetch);
  console.log(`[OddsFetcher] Scheduled every ${INTERVAL} minutes`);
}

module.exports = { startOddsFetcher };
