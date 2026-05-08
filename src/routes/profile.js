const express = require('express');
const { requireAuth } = require('../middleware/auth');
const supabase = require('../lib/supabase');

const router = express.Router();

// GET /api/profile/:username — public profile by username
router.get('/:username', requireAuth, async (req, res, next) => {
  try {
    const { username } = req.params;

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, username, avatar_url')
      .ilike('username', username)
      .maybeSingle();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = profile.id;
    const today = new Date().toISOString().split('T')[0];

    const [accountResp, betsResp, parlaysResp, tournamentsResp, leaguesResp] = await Promise.all([
      supabase
        .from('account_balances')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle(),
      supabase
        .from('bets')
        .select('status, wager, potential_payout')
        .eq('user_id', userId),
      supabase
        .from('parlays')
        .select('status, wager, potential_payout')
        .eq('user_id', userId),
      supabase
        .from('tournament_entries')
        .select(`
          balance, final_rank, payout, joined_at,
          tournaments (
            id, type, buy_in, start_date, end_date,
            prize_pool, player_count, status
          )
        `)
        .eq('user_id', userId)
        .not('final_rank', 'is', null)
        .order('joined_at', { ascending: false })
        .limit(20),
      supabase
        .from('league_members')
        .select(`
          balance, joined_at,
          leagues (
            id, name, start_date, end_date,
            starting_chips, is_public
          )
        `)
        .eq('user_id', userId)
        .lt('leagues.end_date', today)
        .order('joined_at', { ascending: false })
        .limit(20),
    ]);

    const account     = accountResp.data;
    const bets        = betsResp.data       || [];
    const parlays     = parlaysResp.data    || [];
    const tournaments = tournamentsResp.data || [];
    const leagues     = leaguesResp.data    || [];

    // ── Combined bet + parlay stats (settled only) ─────────────
    const allWagers  = [...bets, ...parlays];
    const settled    = allWagers.filter(w => ['won','lost','pushed'].includes(w.status));
    const wonAll     = settled.filter(w => w.status === 'won');
    const lostAll    = settled.filter(w => w.status === 'lost');
    const totalBets  = settled.length;
    const winRate    = (wonAll.length + lostAll.length) > 0
      ? Math.round((wonAll.length / (wonAll.length + lostAll.length)) * 100)
      : 0;
    const biggestWin = wonAll.reduce(
      (max, w) => Math.max(max, Number(w.potential_payout) - Number(w.wager)),
      0
    );

    // ── Parlay stats (kept separate for the Parlays-won card) ──
    const totalParlays = parlays.filter(p => ['won','lost','pushed'].includes(p.status)).length;
    const parlaysWon   = parlays.filter(p => p.status === 'won').length;

    // ── Tournament stats ───────────────────────────────────────
    const tournamentsWon     = tournaments.filter(t => t.final_rank === 1).length;
    const tournamentEarnings = tournaments.reduce(
      (sum, t) => sum + (Number(t.payout) || 0),
      0
    );

    // ── League history with ranks ──────────────────────────────
    const leagueHistory = await Promise.all(
      leagues.map(async (lm) => {
        if (!lm.leagues) return null;
        const { data: lb } = await supabase
          .from('leaderboard')
          .select('rank, profit_loss, win_rate, total_bets')
          .eq('league_id', lm.leagues.id)
          .eq('user_id', userId)
          .maybeSingle();
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
      user_id:             profile.id,
      username:            profile.username,
      avatar_url:          profile.avatar_url,
      is_premium:          account?.is_premium ?? false,
      login_streak:        account?.login_streak ?? 0,
      total_bets:          totalBets,
      win_rate:            winRate,
      biggest_win:         biggestWin,
      total_parlays:       totalParlays,
      parlays_won:         parlaysWon,
      tournaments_won:     tournamentsWon,
      tournament_earnings: tournamentEarnings,
      tournament_history:  tournaments.map(te => ({
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
          .maybeSingle();

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
