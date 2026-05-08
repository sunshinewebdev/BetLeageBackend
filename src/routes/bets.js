const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { calculatePayout } = require('../services/oddsService');
const supabase = require('../lib/supabase');

const router = express.Router();

const PlaceBetSchema = z.object({
  event_id:        z.string(),
  league_id:       z.string().uuid().optional().nullable(),
  tournament_id:   z.string().uuid().optional().nullable(),
  bet_type:        z.enum(['moneyline', 'spread', 'totals', 'prop']),
  selection:       z.enum(['home', 'away', 'over', 'under']),
  selection_label: z.string(),
  american_odds:   z.number().int(),
  wager:           z.number().positive().max(10000),
  prop_player:     z.string().optional().nullable(),
  prop_market:     z.string().optional().nullable(),
  prop_line:       z.number().optional().nullable(),
});

// POST /api/bets
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const parsed = PlaceBetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const {
      event_id, league_id, tournament_id, bet_type, selection,
      selection_label, american_odds, wager, prop_player, prop_market, prop_line
    } = parsed.data;
    const userId = req.user.id;

    // 1. Verify event is still upcoming
    const { data: event } = await supabase
      .from('events').select('status').eq('id', event_id).single();

    if (!event || event.status !== 'upcoming') {
      return res.status(400).json({ error: 'Event is no longer open for betting' });
    }

    const potential_payout = calculatePayout(wager, american_odds);
    if (tournament_id) {
      // ── Tournament bet: deduct from tournament_entries.balance ──
      const { data: entry } = await supabase
        .from('tournament_entries')
        .select('id, balance')
        .eq('tournament_id', tournament_id)
        .eq('user_id', userId)
        .single();

      if (!entry) {
        return res.status(400).json({ error: 'You have not entered this tournament' });
      }

      if (entry.balance < wager) {
        return res.status(400).json({ error: 'Insufficient tournament balance' });
      }

      const { error: balanceError } = await supabase
        .from('tournament_entries')
        .update({ balance: entry.balance - wager })
        .eq('id', entry.id);

      if (balanceError) throw balanceError;

    } else if (league_id) {
      // ── League bet: deduct from league_members.balance ──
      const { data: member } = await supabase
        .from('league_members')
        .select('id, balance')
        .eq('league_id', league_id)
        .eq('user_id', userId)
        .single();

      if (!member) {
        return res.status(403).json({ error: 'You are not a member of this league' });
      }

      if (member.balance < wager) {
        return res.status(400).json({ error: 'Insufficient league balance' });
      }

      const { error: balanceError } = await supabase
        .from('league_members')
        .update({ balance: member.balance - wager, updated_at: new Date() })
        .eq('league_id', league_id)
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
        league_id: league_id || null,
        tournament_id: tournament_id || null,
        bet_type,
        selection,
        selection_label,
        american_odds,
        wager,
        potential_payout,
        prop_player: prop_player || null,
        prop_market: prop_market || null,
        prop_line: prop_line ?? null,
      })
      .select()
      .single();

    if (betError) {
      // Rollback balance
      if (tournament_id) {
        const { data: entry } = await supabase
          .from('tournament_entries')
          .select('id, balance')
          .eq('tournament_id', tournament_id)
          .eq('user_id', userId)
          .single();

        await supabase
          .from('tournament_entries')
          .update({ balance: entry.balance + wager })
          .eq('id', entry.id);
      } else if (league_id) {
        const { data: member } = await supabase
          .from('league_members').select('balance')
          .eq('league_id', league_id).eq('user_id', userId).single();
        await supabase.from('league_members')
          .update({ balance: member.balance + wager })
          .eq('league_id', league_id).eq('user_id', userId);
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
    const { league_id, tournament_id, source, status } = req.query;

    let query = supabase
      .from('bets')
      .select('*, event:events(home_team, away_team, commence_time, sport)')
      .eq('user_id', req.user.id)
      .order('placed_at', { ascending: false });

    if (source === 'account') {
      query = query.is('league_id', null).is('tournament_id', null);
    } else if (league_id === 'global') {
      query = query.is('league_id', null);
    } else if (league_id) {
      query = query.eq('league_id', league_id);
    }

    if (tournament_id) {
      query = query.eq('tournament_id', tournament_id);
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