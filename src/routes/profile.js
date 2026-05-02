const express = require('express');
const { requireAuth } = require('../middleware/auth');
const supabase = require('../lib/supabase');

const router = express.Router();

// GET /api/profile/:username — public profile by username
router.get('/:username', requireAuth, async (req, res, next) => {
  try {
    const { username } = req.params;

    // Get career stats
    const { data: stats, error: statsError } = await supabase
      .from('user_stats')
      .select('*')
      .eq('username', username.toLowerCase())
      .single();

    if (statsError || !stats) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get tournament history (completed, user entered)
    const { data: tournaments } = await supabase
      .from('tournament_entries')
      .select(`
        balance,
        final_rank,
        payout,
        joined_at,
        tournaments (
          id, type, buy_in, start_date, end_date,
          prize_pool, player_count, status
        )
      `)
      .eq('user_id', stats.user_id)
      .not('final_rank', 'is', null)
      .order('joined_at', { ascending: false })
      .limit(20);

    // Get league history (ended leagues user was in)
    const { data: leagues } = await supabase
      .from('league_members')
      .select(`
        balance,
        joined_at,
        leagues (
          id, name, start_date, end_date,
          starting_chips, is_public
        )
      `)
      .eq('user_id', stats.user_id)
      .lt('leagues.end_date', new Date().toISOString().split('T')[0])
      .order('joined_at', { ascending: false })
      .limit(20);

    // For each past league, get user's final rank
    const leagueHistory = await Promise.all(
      (leagues || []).map(async (lm) => {
        if (!lm.leagues) return null;

        const { data: lb } = await supabase
          .from('leaderboard')
          .select('rank, balance, profit_loss, win_rate, total_bets')
          .eq('league_id', lm.leagues.id)
          .eq('user_id', stats.user_id)
          .single();

        return {
          ...lm.leagues,
          final_balance: lm.balance,
          rank:          lb?.rank ?? null,
          profit_loss:   lb?.profit_loss ?? 0,
          win_rate:      lb?.win_rate ?? 0,
          total_bets:    lb?.total_bets ?? 0,
        };
      })
    );

    res.json({
      ...stats,
      tournament_history: (tournaments || []).map(te => ({
        ...te.tournaments,
        final_rank:    te.final_rank,
        payout:        te.payout,
        final_balance: te.balance,
      })),
      league_history: leagueHistory.filter(Boolean),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/profile/me/leagues/past — past leagues for current user
router.get('/me/leagues/past', requireAuth, async (req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('league_members')
      .select(`
        balance,
        joined_at,
        leagues!inner (
          id, name, start_date, end_date,
          starting_chips, invite_code, is_public, created_by
        )
      `)
      .eq('user_id', req.user.id)
      .lt('leagues.end_date', today)
      .order('joined_at', { ascending: false });

    if (error) throw error;

    // Enrich with final rank from leaderboard view
    const enriched = await Promise.all(
      (data || []).map(async (lm) => {
        const { data: lb } = await supabase
          .from('leaderboard')
          .select('rank, profit_loss, win_rate, total_bets')
          .eq('league_id', lm.leagues.id)
          .eq('user_id', req.user.id)
          .single();

        return {
          ...lm.leagues,
          final_balance: lm.balance,
          rank:          lb?.rank ?? null,
          profit_loss:   lb?.profit_loss ?? 0,
          win_rate:      lb?.win_rate ?? 0,
          total_bets:    lb?.total_bets ?? 0,
        };
      })
    );

    res.json(enriched);
  } catch (err) {
    next(err);
  }
});

module.exports = router;