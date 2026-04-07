const cron = require('node-cron');
const { SPORTS, fetchScores, calculatePayout } = require('../services/oddsService');
const supabase = require('../lib/supabase');

const INTERVAL = parseInt(process.env.SCORES_FETCH_INTERVAL || '5');

async function settleBetsForEvent(event) {
  const { data: bets, error } = await supabase
    .from('bets')
    .select('*')
    .eq('event_id', event.id)
    .eq('status', 'pending');

  if (error || !bets?.length) return;

  for (const bet of bets) {
    const result = resolveBet(bet, event);
    if (result === null) continue;

    await supabase.from('bets').update({
      status: result,
      settled_at: new Date().toISOString()
    }).eq('id', bet.id);

    const isLeagueBet = !!bet.season_id;

    if (result === 'won') {
      if (isLeagueBet) {
        await supabase.rpc('adjust_balance', {
          p_season_id: bet.season_id,
          p_user_id:   bet.user_id,
          p_amount:    bet.potential_payout,
        });
      } else {
        await supabase.rpc('adjust_account_balance', {
          p_user_id: bet.user_id,
          p_amount:  bet.potential_payout,
        });
      }
    }

    if (result === 'pushed') {
      if (isLeagueBet) {
        await supabase.rpc('adjust_balance', {
          p_season_id: bet.season_id,
          p_user_id:   bet.user_id,
          p_amount:    bet.wager,
        });
      } else {
        await supabase.rpc('adjust_account_balance', {
          p_user_id: bet.user_id,
          p_amount:  bet.wager,
        });
      }
    }
  }
}

function resolveBet(bet, event) {
  const { home_score, away_score, odds } = event;

  if (home_score == null || away_score == null) return null;

  const homeWon = home_score > away_score;
  const awayWon = away_score > home_score;
  const homeDiff = home_score - away_score; // positive = home winning

  if (bet.bet_type === 'moneyline') {
    if (bet.selection === 'home') return homeWon ? 'won' : (home_score === away_score ? 'pushed' : 'lost');
    if (bet.selection === 'away') return awayWon ? 'won' : (home_score === away_score ? 'pushed' : 'lost');
  }

  if (bet.bet_type === 'spread') {
    const spreadPoint = odds?.spread?.[bet.selection]?.point;
    if (spreadPoint == null) return null;

    const adjustedDiff = bet.selection === 'home'
      ? homeDiff + spreadPoint
      : -homeDiff + spreadPoint;

    if (adjustedDiff > 0)  return 'won';
    if (adjustedDiff < 0)  return 'lost';
    return 'pushed';
  }

  if (bet.bet_type === 'totals') {
    const totalPoint = odds?.totals?.point;
    if (totalPoint == null) return null;

    const total = home_score + away_score;
    if (total === totalPoint) return 'pushed';
    if (bet.selection === 'over')  return total > totalPoint ? 'won' : 'lost';
    if (bet.selection === 'under') return total < totalPoint ? 'won' : 'lost';
  }

  return null;
}

async function runScoresCheck() {
  console.log(`[ScoresSettler] Checking scores at ${new Date().toISOString()}`);

  for (const sport of SPORTS) {
    try {
      const scores = await fetchScores(sport);

      for (const game of scores) {
        if (!game.completed) continue;

        const homeScore = game.scores?.find(s => s.name === game.home_team)?.score;
        const awayScore = game.scores?.find(s => s.name === game.away_team)?.score;

        // Update event to completed with final score
        const { data: event, error } = await supabase
          .from('events')
          .update({
            status:      'completed',
            home_score:  parseInt(homeScore),
            away_score:  parseInt(awayScore),
            winner:      parseInt(homeScore) > parseInt(awayScore) ? 'home' : 'away',
          })
          .eq('id', game.id)
          .select()
          .single();

        if (error || !event) continue;

        await settleBetsForEvent(event);
        console.log("bets settled");
      }
    } catch (err) {
      console.error(`[ScoresSettler] Failed for ${sport}:`, err.message);
    }
  }
}

function startScoresSettler() {
  const schedule = `*/${INTERVAL} * * * *`;
  cron.schedule(schedule, runScoresCheck);
  console.log(`[ScoresSettler] Scheduled every ${INTERVAL} minutes`);
}

module.exports = { startScoresSettler };
