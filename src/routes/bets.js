const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { calculatePayout } = require('../services/oddsService');
const supabase = require('../lib/supabase');

const router = express.Router();

const PlaceBetSchema = z.object({
  event_id:        z.string(),
  season_id:       z.string().uuid().optional().nullable(),
  bet_type:        z.enum(['moneyline', 'spread', 'totals']),
  selection:       z.enum(['home', 'away', 'over', 'under']),
  selection_label: z.string(),
  american_odds:   z.number().int(),
  wager:           z.number().positive().max(10000),
});

// POST /api/bets
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const parsed = PlaceBetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const {
      event_id, season_id, bet_type, selection,
      selection_label, american_odds, wager
    } = parsed.data;
    const userId = req.user.id;

    // 1. Verify event is still upcoming
    const { data: event } = await supabase
      .from('events').select('status').eq('id', event_id).single();

    if (!event || event.status !== 'upcoming') {
      return res.status(400).json({ error: 'Event is no longer open for betting' });
    }

    const potential_payout = calculatePayout(wager, american_odds);
    const isLeagueBet = !!season_id;

    if (isLeagueBet) {
      // ── League bet: deduct from season_balances ──────────
      const { data: season } = await supabase
        .from('league_seasons')
        .select('id, league_id, status')
        .eq('id', season_id)
        .single();

      if (!season || season.status !== 'active') {
        return res.status(400).json({ error: 'Season is not active' });
      }

      const { data: member } = await supabase
        .from('league_members')
        .select('id')
        .eq('league_id', season.league_id)
        .eq('user_id', userId)
        .single();

      if (!member) {
        return res.status(403).json({ error: 'You are not a member of this league' });
      }

      const { data: balanceRow } = await supabase
        .from('season_balances')
        .select('balance')
        .eq('season_id', season_id)
        .eq('user_id', userId)
        .single();

      if (!balanceRow || balanceRow.balance < wager) {
        return res.status(400).json({ error: 'Insufficient league balance' });
      }

      const { error: balanceError } = await supabase
        .from('season_balances')
        .update({ balance: balanceRow.balance - wager, updated_at: new Date() })
        .eq('season_id', season_id)
        .eq('user_id', userId);

      if (balanceError) throw balanceError;

    } else {
      // ── Global bet: deduct from account_balances ─────────
      const { data: balanceRow } = await supabase
        .from('account_balances')
        .select('balance')
        .eq('user_id', userId)
        .single();

      if (!balanceRow || balanceRow.balance < wager) {
        return res.status(400).json({ error: 'Insufficient account balance' });
      }

      const { error: balanceError } = await supabase
        .from('account_balances')
        .update({ balance: balanceRow.balance - wager, updated_at: new Date() })
        .eq('user_id', userId);

      if (balanceError) throw balanceError;
    }

    // Insert the bet
    const { data: bet, error: betError } = await supabase
      .from('bets')
      .insert({
        user_id: userId,
        event_id,
        season_id: season_id || null,
        bet_type,
        selection,
        selection_label,
        american_odds,
        wager,
        potential_payout,
      })
      .select()
      .single();

    if (betError) {
      // Rollback balance
      if (season_id) {
        const { data: balanceRow } = await supabase
          .from('season_balances').select('balance')
          .eq('season_id', season_id).eq('user_id', userId).single();
        await supabase.from('season_balances')
          .update({ balance: balanceRow.balance + wager })
          .eq('season_id', season_id).eq('user_id', userId);
      } else {
        await supabase.rpc('adjust_account_balance', {
          p_user_id: userId, p_amount: wager
        });
      }
      throw betError;
    }

    res.status(201).json(bet);
  } catch (err) {
    next(err);
  }
});

// GET /api/bets
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { season_id, status } = req.query;

    let query = supabase
      .from('bets')
      .select('*, events(home_team, away_team, commence_time, sport)')
      .eq('user_id', req.user.id)
      .order('placed_at', { ascending: false });

    if (season_id === 'global') {
      query = query.is('season_id', null);
    } else if (season_id) {
      query = query.eq('season_id', season_id);
    }

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/bets/balance — get the calling user's global balance
router.get('/balance', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('account_balances')
      .select('balance')
      .eq('user_id', req.user.id)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;