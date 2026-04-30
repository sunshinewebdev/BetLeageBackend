const supabase = require('../lib/supabase');

const BUY_INS = [1, 10, 50, 200, 750, 2000, 10000];

const STARTING_CHIPS = 10000;
const RAKE_PERCENT = 25;

const PAYOUT_TIERS = [
  { min: 3,  max: 4,   splits: [1.0] },
  { min: 5,  max: 9,   splits: [0.65, 0.35] },
  { min: 10, max: 19,  splits: [0.50, 0.30, 0.20] },
  { min: 20, max: 49,  splits: [0.40, 0.25, 0.18, 0.12, 0.05] },
  { min: 50, max: 99,  splits: [0.35, 0.20, 0.14, 0.10, 0.08, 0.0433, 0.0433, 0.0434] },
  { min: 100, max: Infinity, splits: null }, // calculated dynamically for large fields
];

function getPayoutSplits(playerCount) {
  const tier = PAYOUT_TIERS.find(t => playerCount >= t.min && playerCount <= t.max);
  if (!tier) return [1.0];

  // For 100+ players, calculate dynamically: top 10% paid
  if (tier.splits === null) {
    const paidSpots = Math.max(3, Math.floor(playerCount * 0.1));
    const splits = [];
    let remaining = 1.0;
    for (let i = 0; i < paidSpots; i++) {
      // Exponential decay: each spot gets ~70% of the previous
      const share = i === paidSpots - 1
        ? remaining
        : remaining * 0.3;
      splits.push(share);
      remaining -= share;
    }
    return splits;
  }

  return tier.splits;
}

function calculatePayouts(prizePool, playerCount) {
  const splits = getPayoutSplits(playerCount);
  return splits.map((pct, i) => ({
    place: i + 1,
    amount: Math.floor(prizePool * pct),
    percentage: Math.round(pct * 100),
  }));
}

function getPayoutStructure(playerCount) {
  const splits = getPayoutSplits(playerCount);
  return splits.map((pct, i) => ({
    place: i + 1,
    percentage: Math.round(pct * 100),
  }));
}

function getPayoutSpots(playerCount) {
  if (playerCount < 3) return 0;
  return getPayoutSplits(playerCount).length;
}

function getPayoutPercentages(spots) {
  // Find the tier whose splits length matches this spot count
  for (const tier of PAYOUT_TIERS) {
    if (tier.splits && tier.splits.length === spots) {
      return tier.splits.map(s => +(s * 100).toFixed(2));
    }
  }
  // Dynamic tier (100+): reconstruct from a player count that yields this many spots
  if (spots > 0) {
    const playerCount = spots * 10;
    return getPayoutSplits(playerCount).map(s => +(s * 100).toFixed(2));
  }
  return [];
}

async function createTournament({ type, buy_in, start_date, end_date }) {
  if (!BUY_INS.includes(buy_in)) throw new Error(`Invalid buy-in: ${buy_in}`);

  const { data, error } = await supabase
    .from('tournaments')
    .insert({
      type,
      buy_in,
      starting_chips: STARTING_CHIPS,
      min_players: 3,
      rake_percent: RAKE_PERCENT,
      prize_pool: 0,
      player_count: 0,
      status: 'upcoming',
      start_date,
      end_date,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function enterTournament(tournamentId, userId) {
  const { data: tournament } = await supabase
    .from('tournaments')
    .select('*')
    .eq('id', tournamentId)
    .single();

  if (!tournament) throw Object.assign(new Error('Tournament not found'), { status: 404 });
  if (tournament.status === 'settled' || tournament.status === 'cancelled') {
    throw Object.assign(new Error('Tournament is no longer accepting entries'), { status: 400 });
  }

  // Check if already entered
  const { data: existing } = await supabase
    .from('tournament_entries')
    .select('id')
    .eq('tournament_id', tournamentId)
    .eq('user_id', userId)
    .single();

  if (existing) throw Object.assign(new Error('Already entered this tournament'), { status: 400 });

  // Deduct buy-in from account balance
  const { data: balanceRow } = await supabase
    .from('account_balances')
    .select('balance')
    .eq('user_id', userId)
    .single();

  if (!balanceRow || balanceRow.balance < tournament.buy_in) {
    throw Object.assign(new Error('Insufficient account balance for buy-in'), { status: 400 });
  }

  const { error: deductError } = await supabase
    .from('account_balances')
    .update({ balance: balanceRow.balance - tournament.buy_in, updated_at: new Date() })
    .eq('user_id', userId);

  if (deductError) throw deductError;

  // Create entry with starting balance
  const { data: entry, error: entryError } = await supabase
    .from('tournament_entries')
    .insert({
      tournament_id: tournamentId,
      user_id: userId,
      balance: tournament.starting_chips,
    })
    .select()
    .single();

  if (entryError) {
    // Rollback balance deduction
    await supabase.rpc('adjust_account_balance', {
      p_user_id: userId, p_amount: tournament.buy_in,
    });
    throw entryError;
  }

  // Increase prize pool (after rake) and player_count
  const rake = Math.floor(tournament.buy_in * tournament.rake_percent / 100);
  const poolContribution = tournament.buy_in - rake;
  const { error: poolError } = await supabase
    .from('tournaments')
    .update({
      prize_pool: tournament.prize_pool + poolContribution,
      player_count: tournament.player_count + 1,
    })
    .eq('id', tournamentId);

  if (poolError) console.error('[TournamentService] Failed to update tournament:', poolError.message);

  return entry;
}

async function settleTournament(tournamentId) {
  const { data: tournament } = await supabase
    .from('tournaments')
    .select('*')
    .eq('id', tournamentId)
    .single();

  if (!tournament || tournament.status === 'settled' || tournament.status === 'cancelled') return;

  const { data: entries } = await supabase
    .from('tournament_entries')
    .select('*, profiles(username)')
    .eq('tournament_id', tournamentId)
    .order('balance', { ascending: false });

  if (!entries || entries.length === 0) {
    // No entries — just cancel
    await supabase.from('tournaments').update({ status: 'cancelled' }).eq('id', tournamentId);
    return;
  }

  // Refund if fewer than min_players
  if (entries.length < tournament.min_players) {
    for (const entry of entries) {
      await supabase.rpc('adjust_account_balance', {
        p_user_id: entry.user_id,
        p_amount: tournament.buy_in,
      });
    }
    await supabase.from('tournaments').update({ status: 'cancelled' }).eq('id', tournamentId);
    console.log(`[TournamentService] Refunded ${entries.length} players for tournament ${tournamentId} (< ${tournament.min_players} players)`);
    return;
  }

  // Calculate and distribute payouts
  const payouts = calculatePayouts(tournament.prize_pool, entries.length);

  // Set final_rank on all entries and payout on winners
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const payoutInfo = payouts.find(p => p.place === i + 1);
    const updateData = { final_rank: i + 1 };

    if (payoutInfo) {
      updateData.payout = payoutInfo.amount;
      await supabase.rpc('adjust_account_balance', {
        p_user_id: entry.user_id,
        p_amount: payoutInfo.amount,
      });
    }

    await supabase
      .from('tournament_entries')
      .update(updateData)
      .eq('tournament_id', tournamentId)
      .eq('user_id', entry.user_id);
  }

  await supabase.from('tournaments')
    .update({ status: 'settled', paid_out: true })
    .eq('id', tournamentId);

  console.log(`[TournamentService] Settled tournament ${tournamentId} — ${payouts.length} places paid`);
}

module.exports = {
  BUY_INS,
  STARTING_CHIPS,
  RAKE_PERCENT,
  getPayoutStructure,
  getPayoutSpots,
  getPayoutPercentages,
  calculatePayouts,
  createTournament,
  enterTournament,
  settleTournament,
};
