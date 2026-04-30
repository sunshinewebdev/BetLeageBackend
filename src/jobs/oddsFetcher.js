const cron = require('node-cron');
const { SPORTS, fetchEventsWithOdds, fetchEventProps, normalizeEvent } = require('../services/oddsService');
const supabase = require('../lib/supabase');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const INTERVAL = parseInt(process.env.ODDS_FETCH_INTERVAL || '4');

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

      // Fetch props for each upcoming event within 7 days
      for (const event of events) {
        if (event.status !== 'upcoming') continue;

        const commenceTime = new Date(event.commence_time);
        const now = new Date();
        const daysUntilGame = (commenceTime - now) / (1000 * 60 * 60 * 24);

        // Only fetch props for games within the next 7 days
        if (daysUntilGame > 7 || daysUntilGame < 0) continue;

        const props = await fetchEventProps(event.id, sport);
        if (props && Object.keys(props).length > 0) {
          await supabase
            .from('events')
            .update({ props })
            .eq('id', event.id);
        }

        await new Promise(r => setTimeout(r, 300));
      }
    } catch (err) {
      // Don't let one sport crash the whole job
      console.error(`[OddsFetcher] Failed for ${sport}:`, err.message);
    }
  }
  console.log('odds fetch done')
}

function startOddsFetcher() {
  // Run immediately on startup
  runOddsFetch();

  // Then on schedule
  const schedule = `* ${INTERVAL} * * *`;
  cron.schedule(schedule, runOddsFetch);
  console.log(`[OddsFetcher] Scheduled every ${INTERVAL} minutes`);
}

module.exports = { startOddsFetcher };
