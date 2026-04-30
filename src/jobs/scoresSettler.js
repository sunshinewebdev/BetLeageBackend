const cron = require('node-cron');
const { SPORTS, fetchScores, calculatePayout } = require('../services/oddsService');
const { fetchGameStats, getStatValue, findGameId } = require('../services/balldontlieService');
const supabase = require('../lib/supabase');

const INTERVAL = parseInt(process.env.SCORES_FETCH_INTERVAL || '4');

async function settlePropBet(bet, event) {
  try {
    const gameDate = new Date(event.commence_time);
    const gameId = await findGameId(event.sport, event.home_team, event.away_team, gameDate);
    if (!gameId) return null;

    const stats = await fetchGameStats(event.sport, gameId);
    if (!stats || stats.length === 0) return null;

    // Find player stats - match by last name
    const playerLast = bet.prop_player?.split(' ').pop()?.toLowerCase();
    if (!playerLast) return null;

    const playerStats = stats.find(s => {
      const name = s.player?.last_name || s.player?.name || '';
      return name.toLowerCase() === playerLast;
    });

    if (!playerStats) return 'void';

    const actual = getStatValue(playerStats, bet.prop_market, event.sport);
    if (actual === null) return null;

    const line = bet.prop_line;
    if (actual === line) return 'pushed';
    if (bet.selection === 'over') return actual > line ? 'won' : 'lost';
    if (bet.selection === 'under') return actual < line ? 'won' : 'lost';
    return null;
  } catch (err) {
    console.error(`[ScoresSettler] Prop bet error for bet ${bet.id}:`, err.message);
    return null;
  }
}

async function creditBankroll({ user_id, league_id, tournament_id }, amount) {
  if (tournament_id) {
    const { data: entry } = await supabase
      .from('tournament_entries')
      .select('id, balance')
      .eq('tournament_id', tournament_id)
      .eq('user_id', user_id)
      .single();
    if (entry) {
      await supabase
        .from('tournament_entries')
        .update({ balance: Number(entry.balance) + amount })
        .eq('id', entry.id);
    }
  } else if (league_id) {
    await supabase.rpc('adjust_league_balance', {
      p_league_id: league_id,
      p_user_id:   user_id,
      p_amount:    amount,
    });
  } else {
    await supabase.rpc('adjust_account_balance', {
      p_user_id: user_id,
      p_amount:  amount,
    });
  }
}

async function settleParlayLegsForEvent(event) {
  const { data: legs, error } = await supabase
    .from('parlay_legs')
    .select('*')
    .eq('event_id', event.id)
    .eq('status', 'pending');

  if (error || !legs?.length) return;

  const touchedParlayIds = new Set();

  for (const leg of legs) {
    const result = leg.bet_type === 'prop'
      ? await settlePropBet(leg, event)
      : resolveBet(leg, event);
    if (result === null) continue;

    await supabase.from('parlay_legs').update({
      status: result,
      settled_at: new Date().toISOString(),
    }).eq('id', leg.id);

    touchedParlayIds.add(leg.parlay_id);
  }

  for (const parlayId of touchedParlayIds) {
    await maybeSettleParlay(parlayId);
  }
}

async function maybeSettleParlay(parlayId) {
  const { data: parlay } = await supabase
    .from('parlays')
    .select('*')
    .eq('id', parlayId)
    .eq('status', 'pending')
    .single();

  if (!parlay) return;

  const { data: legs } = await supabase
    .from('parlay_legs')
    .select('status')
    .eq('parlay_id', parlayId);

  if (!legs?.length) return;

  const anyLost    = legs.some(l => l.status === 'lost');
  const anyVoid    = legs.some(l => l.status === 'void' || l.status === 'pushed');
  const allWon     = legs.every(l => l.status === 'won');

  let finalStatus = null;
  let creditAmount = 0;

  if (anyLost) {
    finalStatus = 'lost';
  } else if (anyVoid) {
    finalStatus = 'void';
    creditAmount = Number(parlay.wager);
  } else if (allWon) {
    finalStatus = 'won';
    creditAmount = Number(parlay.potential_payout);
  }

  if (!finalStatus) return; // some legs still pending

  await supabase.from('parlays').update({
    status:     finalStatus,
    settled_at: new Date().toISOString(),
  }).eq('id', parlay.id);

  if (creditAmount > 0) {
    await creditBankroll(parlay, creditAmount);
  }
}

async function settleBetsForEvent(event) {
  const { data: bets, error } = await supabase
    .from('bets')
    .select('*')
    .eq('event_id', event.id)
    .eq('status', 'pending');

  if (error || !bets?.length) return;

  for (const bet of bets) {
    const result = bet.bet_type === 'prop'
      ? await settlePropBet(bet, event)
      : resolveBet(bet, event);
    if (result === null) continue;

    await supabase.from('bets').update({
      status: result,
      settled_at: new Date().toISOString()
    }).eq('id', bet.id);

    const amount = result === 'won' ? bet.potential_payout
                 : result === 'pushed' ? bet.wager
                 : null;

    if (amount) {
      if (bet.tournament_id) {
        const { data: entry } = await supabase
          .from('tournament_entries')
          .select('id, balance')
          .eq('tournament_id', bet.tournament_id)
          .eq('user_id', bet.user_id)
          .single();

        if (entry) {
          await supabase
            .from('tournament_entries')
            .update({ balance: Number(entry.balance) + amount })
            .eq('id', entry.id);
        }
      } else if (bet.league_id) {
        await supabase.rpc('adjust_league_balance', {
          p_league_id: bet.league_id,
          p_user_id:   bet.user_id,
          p_amount:    amount,
        });
      } else {
        await supabase.rpc('adjust_account_balance', {
          p_user_id: bet.user_id,
          p_amount:  amount,
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
        await settleParlayLegsForEvent(event);
        console.log("bets settled");
      }
    } catch (err) {
      console.error(`[ScoresSettler] Failed for ${sport}:`, err.message);
    }
  }

    console.log('check scores done')

}

function startScoresSettler() {
  const schedule = `* ${INTERVAL} * * *`;
  cron.schedule(schedule, runScoresCheck);
  console.log(`[ScoresSettler] Scheduled every ${INTERVAL} minutes`);
}

module.exports = { startScoresSettler };
