const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { enterTournament, getPayoutSpots, getPayoutPercentages } = require('../services/tournamentService');
const supabase = require('../lib/supabase');

const router = express.Router();

// GET /api/tournaments — list active tournaments with caller's entered status
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { type } = req.query;
    const today = new Date().toISOString().split('T')[0];

    let query = supabase
      .from('tournaments')
      .select('*')
      .eq('status', 'active')
      .gte('end_date', today)
      .order('buy_in', { ascending: true });

    if (type) query = query.eq('type', type);

    const { data, error } = await query;
    if (error) throw error;

    const { data: entries } = await supabase
      .from('tournament_entries')
      .select('tournament_id')
      .eq('user_id', req.user.id);

    const enteredIds = new Set((entries || []).map(e => e.tournament_id));

    const enriched = (data || []).map(t => ({
      ...t,
      entered: enteredIds.has(t.id),
      payout_spots: getPayoutSpots(t.player_count),
      payout_percentages: getPayoutPercentages(getPayoutSpots(t.player_count)),
    }));

    res.json(enriched);
  } catch (err) {
    next(err);
  }
});

// GET /api/tournaments/my-entries — tournaments the user has entered
router.get('/my-entries', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('tournament_entries')
      .select('*, tournaments(*)')
      .eq('user_id', req.user.id)
      .order('joined_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/tournaments/:id/leaderboard — tournament leaderboard
router.get('/:id/leaderboard', requireAuth, async (req, res, next) => {
  try {
    const tournamentId = req.params.id;

    const { data: entries, error } = await supabase
      .from('tournament_entries')
      .select('user_id, balance, final_rank, payout, joined_at, profiles(username, avatar_url)')
      .eq('tournament_id', tournamentId)
      .order('balance', { ascending: false });

    if (error) throw error;

    // Get bet stats per user for this tournament
    const { data: bets } = await supabase
      .from('bets')
      .select('user_id, status')
      .eq('tournament_id', tournamentId);

    const betStats = {};
    for (const b of (bets || [])) {
      if (!betStats[b.user_id]) betStats[b.user_id] = { total: 0, won: 0, lost: 0 };
      if (b.status !== 'void') betStats[b.user_id].total++;
      if (b.status === 'won') betStats[b.user_id].won++;
      if (b.status === 'lost') betStats[b.user_id].lost++;
    }

    const leaderboard = entries.map((entry, i) => {
      const stats = betStats[entry.user_id] || { total: 0, won: 0, lost: 0 };
      const winRate = stats.won + stats.lost > 0
        ? Math.round((stats.won / (stats.won + stats.lost)) * 100)
        : 0;

      return {
        rank: entry.final_rank || i + 1,
        user_id: entry.user_id,
        username: entry.profiles?.username,
        avatar_url: entry.profiles?.avatar_url,
        balance: entry.balance,
        total_bets: stats.total,
        won_bets: stats.won,
        win_rate: winRate,
        payout: entry.payout,
      };
    });

    res.json(leaderboard);
  } catch (err) {
    next(err);
  }
});

// POST /api/tournaments/:id/enter — enter a tournament
router.post('/:id/enter', requireAuth, async (req, res, next) => {
  try {
    const entry = await enterTournament(req.params.id, req.user.id);
    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
