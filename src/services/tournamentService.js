const supabase = require('../lib/supabase');

const BUY_INS = [1, 10, 50, 200, 750, 2000, 10000];

const STARTING_CHIPS = 10000;
const RAKE_PERCENT = 25;

// How long after end_date we wait for pending wagers to resolve before
// voiding them and settling anyway.
const PENDING_WAGER_GRACE_HOURS = 48;

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

  // For 100+ players, calculate dynamically: top 10% paid.
  // Geometric decay (each spot ~70% of the previous), normalized so the
  // splits sum to 1 and stay strictly decreasing — last place must never
  // out-earn the places above it.
  if (tier.splits === null) {
    const paidSpots = Math.max(3, Math.floor(playerCount * 0.1));
    const weights = Array.from({ length: paidSpots }, (_, i) => Math.pow(0.7, i));
    const total = weights.reduce((sum, w) => sum + w, 0);
    return weights.map(w => w / total);
  }

  return tier.splits;
}

function calculatePayouts(prizePool, playerCount) {
  const splits = getPayoutSplits(playerCount);
  const payouts = splits.map((pct, i) => ({
    place: i + 1,
    amount: Math.floor(prizePool * pct),
    percentage: Math.round(pct * 100),
  }));
  // Rounding dust from the floors goes to first place so the pool pays out in full
  const paid = payouts.reduce((sum, p) => sum + p.amount, 0);
  if (payouts.length > 0) payouts[0].amount += prizePool - paid;
  return payouts;
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

  // Activate immediately if the window has already started; otherwise it's upcoming.
  const status = new Date(start_date) <= new Date() ? 'active' : 'upcoming';

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
      status,
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
  const closed = ['settled', 'cancelled', 'settling'].includes(tournament.status)
    || new Date(tournament.end_date) <= new Date();
  if (closed) {
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

  // Deduct buy-in from account balance atomically (fails when insufficient)
  const { data: deducted, error: deductError } = await supabase.rpc('deduct_account_balance', {
    p_user_id: userId,
    p_amount:  tournament.buy_in,
  });

  if (deductError) throw deductError;
  if (!deducted) {
    throw Object.assign(new Error('Insufficient account balance for buy-in'), { status: 400 });
  }

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

  // Increase prize pool (after rake) and player_count atomically so
  // concurrent entries don't overwrite each other's contribution
  const rake = Math.floor(tournament.buy_in * tournament.rake_percent / 100);
  const poolContribution = tournament.buy_in - rake;
  const { error: poolError } = await supabase.rpc('increment_tournament_pool', {
    p_tournament_id: tournamentId,
    p_amount:        poolContribution,
  });

  if (poolError) console.error('[TournamentService] Failed to update tournament:', poolError.message);

  return entry;
}

// Returns true when no wagers remain pending for the tournament. Within the
// grace window we defer settlement so the scores settler can resolve them;
// after it, stragglers are voided and their wagers returned to the entry
// balance so they count as a push in the final ranking, not a loss.
async function settlePendingWagers(tournament) {
  const [betsResp, parlaysResp] = await Promise.all([
    supabase.from('bets').select('id, user_id, wager')
      .eq('tournament_id', tournament.id).eq('status', 'pending'),
    supabase.from('parlays').select('id, user_id, wager')
      .eq('tournament_id', tournament.id).eq('status', 'pending'),
  ]);
  if (betsResp.error) throw betsResp.error;
  if (parlaysResp.error) throw parlaysResp.error;

  const pendingBets = betsResp.data || [];
  const pendingParlays = parlaysResp.data || [];
  if (pendingBets.length === 0 && pendingParlays.length === 0) return true;

  const hoursSinceEnd = (Date.now() - new Date(tournament.end_date).getTime()) / 36e5;
  if (hoursSinceEnd < PENDING_WAGER_GRACE_HOURS) return false;

  for (const { table, wagers } of [
    { table: 'bets', wagers: pendingBets },
    { table: 'parlays', wagers: pendingParlays },
  ]) {
    for (const w of wagers) {
      // Conditional flip so a concurrent scores-settler result wins the race
      const { data: voided, error } = await supabase
        .from(table)
        .update({ status: 'void' })
        .eq('id', w.id)
        .eq('status', 'pending')
        .select('id');
      if (error) throw error;
      if (!voided?.length) continue; // resolved in the meantime

      const { error: refundError } = await supabase.rpc('adjust_tournament_balance', {
        p_tournament_id: tournament.id,
        p_user_id: w.user_id,
        p_amount: w.wager,
      });
      if (refundError) throw refundError;
    }
  }
  return true;
}

// Entries tied on balance share a rank and split the pooled payouts for the
// places they span (competition ranking: 1, 1, 3, ...).
function rankWithTies(entries, payouts) {
  const results = [];
  let i = 0;
  while (i < entries.length) {
    let j = i;
    while (j < entries.length && Number(entries[j].balance) === Number(entries[i].balance)) j++;
    const group = entries.slice(i, j);
    const pooled = payouts
      .filter(p => p.place > i && p.place <= j)
      .reduce((sum, p) => sum + p.amount, 0);
    const share = Math.floor(pooled / group.length);
    let dust = pooled - share * group.length;
    for (const entry of group) {
      results.push({
        user_id: entry.user_id,
        rank: i + 1,
        payout: share + (dust-- > 0 ? 1 : 0),
      });
    }
    i = j;
  }
  return results;
}

async function settleTournament(tournamentId) {
  const { data: tournament, error: tournamentError } = await supabase
    .from('tournaments')
    .select('*')
    .eq('id', tournamentId)
    .single();

  if (tournamentError) throw tournamentError;
  if (!tournament || tournament.status === 'settled' || tournament.status === 'cancelled') return;

  const wagersResolved = await settlePendingWagers(tournament);
  if (!wagersResolved) {
    console.log(`[TournamentService] Tournament ${tournamentId} has pending wagers — deferring settlement`);
    return;
  }

  // Claim the tournament before moving money so a concurrent run can't pay
  // twice; a run that crashes mid-settlement stays 'settling' and is retried.
  const { error: claimError } = await supabase
    .from('tournaments')
    .update({ status: 'settling' })
    .eq('id', tournamentId)
    .in('status', ['upcoming', 'active', 'settling']);
  if (claimError) throw claimError;

  const { data: entries, error: entriesError } = await supabase
    .from('tournament_entries')
    .select('*')
    .eq('tournament_id', tournamentId)
    .order('balance', { ascending: false })
    .order('joined_at', { ascending: true });

  // A failed read must never be mistaken for "no entries" — that would
  // cancel the tournament and swallow every buy-in.
  if (entriesError) throw entriesError;

  if (!entries || entries.length === 0) {
    const { error } = await supabase
      .from('tournaments').update({ status: 'cancelled' }).eq('id', tournamentId);
    if (error) throw error;
    return;
  }

  // Refund if fewer than min_players (idempotent — retries skip refunded entries)
  if (entries.length < tournament.min_players) {
    for (const entry of entries) {
      const { error } = await supabase.rpc('refund_tournament_entry', {
        p_tournament_id: tournamentId,
        p_user_id: entry.user_id,
        p_amount: tournament.buy_in,
      });
      if (error) throw error; // stays 'settling'; next run retries the rest
    }
    const { error } = await supabase
      .from('tournaments').update({ status: 'cancelled' }).eq('id', tournamentId);
    if (error) throw error;
    console.log(`[TournamentService] Refunded ${entries.length} players for tournament ${tournamentId} (< ${tournament.min_players} players)`);
    return;
  }

  // Rank (splitting ties) and pay — idempotent, retries skip recorded entries
  const payouts = calculatePayouts(tournament.prize_pool, entries.length);
  const results = rankWithTies(entries, payouts);

  for (const result of results) {
    const { error } = await supabase.rpc('record_tournament_result', {
      p_tournament_id: tournamentId,
      p_user_id: result.user_id,
      p_rank: result.rank,
      p_payout: result.payout,
    });
    if (error) throw error; // stays 'settling'; next run retries the rest
  }

  const { error: doneError } = await supabase.from('tournaments')
    .update({ status: 'settled', paid_out: true })
    .eq('id', tournamentId);
  if (doneError) throw doneError;

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
  rankWithTies,
  createTournament,
  enterTournament,
  settleTournament,
};
