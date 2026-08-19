const cron = require('node-cron');
const { SPORTS, fetchScores } = require('../services/oddsService');
const { fetchGameStats, getStatValue, findGameId } = require('../services/balldontlieService');
const supabase = require('../lib/supabase');

const INTERVAL = parseInt(process.env.SCORES_FETCH_INTERVAL || '4');

const AMBIGUOUS = Symbol('ambiguous-player');

function normalizeName(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z\s]/g, '')        // strip punctuation (D'Angelo, Jr.)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ (jr|sr|ii|iii|iv|v)$/, ''); // strip generational suffixes
}

// Match the bet's player against the stats feed. Prefer an exact full-name
// match; fall back to last name only when exactly one player carries it
// (two Joneses in one game must not grade each other's bets). Returns the
// stats row, null when the player is absent, or AMBIGUOUS.
function findPlayerStats(stats, propPlayer) {
  const target = normalizeName(propPlayer || '');
  if (!target) return null;

  const fullMatches = stats.filter(s => {
    const p = s.player || {};
    const full = p.first_name && p.last_name
      ? `${p.first_name} ${p.last_name}`
      : (p.name || '');
    return normalizeName(full) === target;
  });
  if (fullMatches.length === 1) return fullMatches[0];
  if (fullMatches.length > 1) return AMBIGUOUS;

  const targetLast = target.split(' ').pop();
  const lastMatches = stats.filter(s => {
    const last = s.player?.last_name || String(s.player?.name || '').split(' ').pop();
    return normalizeName(last) === targetLast;
  });
  if (lastMatches.length === 1) return lastMatches[0];
  if (lastMatches.length > 1) return AMBIGUOUS;
  return null;
}

async function settlePropBet(bet, event) {
  try {
    const gameDate = new Date(event.commence_time);
    const gameId = await findGameId(event.sport, event.home_team, event.away_team, gameDate);
    if (!gameId) return null;

    const stats = await fetchGameStats(event.sport, gameId);

    if (!stats || stats.length === 0) return null;
    
    const playerStats = findPlayerStats(stats, bet.prop_player);
    if (playerStats === AMBIGUOUS) {
      // Two players share the name we'd match on — never grade a guess.
      console.warn(`[ScoresSettler] Ambiguous player match for "${bet.prop_player}" — leaving bet ${bet.id} pending`);
      return null;
    }
    if (!playerStats) return 'void';

    const actual = getStatValue(playerStats, bet.prop_market, event.sport);
    if (actual === null) return null;

    // numeric columns come back from Postgres as strings — coerce before
    // comparing, or the push check can never match
    const line = Number(bet.prop_line);
    if (Number.isNaN(line)) return null;
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
    await supabase.rpc('adjust_tournament_balance', {
      p_tournament_id: tournament_id,
      p_user_id:       user_id,
      p_amount:        amount,
    });
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
      await creditBankroll(bet, Number(amount));
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

  // Grade against the line frozen on the wager at placement. Fall back to
  // the event's odds snapshot only for wagers placed before `line` existed.
  if (bet.bet_type === 'spread') {
    const rawPoint = bet.line ?? odds?.spread?.[bet.selection]?.point;
    if (rawPoint == null) return null;
    const spreadPoint = Number(rawPoint);
    if (Number.isNaN(spreadPoint)) return null;

    const adjustedDiff = bet.selection === 'home'
      ? homeDiff + spreadPoint
      : -homeDiff + spreadPoint;

    if (adjustedDiff > 0)  return 'won';
    if (adjustedDiff < 0)  return 'lost';
    return 'pushed';
  }

  if (bet.bet_type === 'totals') {
    const rawPoint = bet.line ?? odds?.totals?.point;
    if (rawPoint == null) return null;
    const totalPoint = Number(rawPoint);
    if (Number.isNaN(totalPoint)) return null;

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

        const homeScore = parseInt(game.scores?.find(s => s.name === game.home_team)?.score, 10);
        const awayScore = parseInt(game.scores?.find(s => s.name === game.away_team)?.score, 10);

        // Never settle from a malformed/missing score payload
        if (Number.isNaN(homeScore) || Number.isNaN(awayScore)) continue;

        // Update event to completed with final score
        const { data: event, error } = await supabase
          .from('events')
          .update({
            status:      'completed',
            home_score:  homeScore,
            away_score:  awayScore,
            winner:      homeScore > awayScore ? 'home' : 'away',
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
  runScoresCheck();
  // every INTERVAL minutes (the previous `0 N * * *` ran once daily at N:00)
  const schedule = `* ${INTERVAL} * * * *`;
  cron.schedule(schedule, runScoresCheck);
  console.log(`[ScoresSettler] Scheduled every ${INTERVAL} minutes`);
}

module.exports = { startScoresSettler };
