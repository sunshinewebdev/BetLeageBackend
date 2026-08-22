const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { calculatePayout } = require('../services/oddsService');
const { getServerOdds, eventIsBettable } = require('../lib/betValidation');
const supabase = require('../lib/supabase');

const router = express.Router();

const PlaceBetSchema = z.object({
  event_id:        z.string().min(1).max(100),
  league_id:       z.string().uuid().optional().nullable(),
  tournament_id:   z.string().uuid().optional().nullable(),
  bet_type:        z.enum(['moneyline', 'spread', 'totals', 'prop']),
  selection:       z.enum(['home', 'away', 'over', 'under']),
  selection_label: z.string().min(1).max(200),
  american_odds:   z.number().int(),
  wager:           z.number().positive().max(10000),
  prop_player:     z.string().max(100).optional().nullable(),
  prop_market:     z.string().max(100).optional().nullable(),
  prop_line:       z.number().optional().nullable(),
}).refine(
  b => !(b.league_id && b.tournament_id),
  { message: 'A bet cannot belong to both a league and a tournament' },
).refine(
  b => b.bet_type !== 'prop' || (b.prop_player && b.prop_market && b.prop_line != null),
  { message: 'Prop bets require prop_player, prop_market, and prop_line' },
);

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

    // 1. Verify event exists, is upcoming, and has not started
    const { data: event } = await supabase
      .from('events')
      .select('id, status, commence_time, odds, props')
      .eq('id', event_id)
      .single();

    if (!eventIsBettable(event)) {
      return res.status(400).json({ error: 'Event is no longer open for betting' });
    }

    // 2. Never trust client odds — price the bet from the stored event odds
    const { price: serverOdds, point: serverPoint, error: oddsError } = getServerOdds(event, parsed.data);
    if (oddsError) {
      return res.status(400).json({ error: oddsError });
    }
    if (serverOdds !== american_odds) {
      return res.status(409).json({ error: 'Odds have changed — refresh and try again' });
    }

    const potential_payout = calculatePayout(wager, serverOdds);

    // 3. Deduct the wager atomically (deduct_* RPCs only succeed when the
    //    balance covers the wager, so concurrent bets can't double-spend)
    if (tournament_id) {
      const { data: tournament } = await supabase
        .from('tournaments')
        .select('id, status, end_date')
        .eq('id', tournament_id)
        .single();

      if (!tournament || tournament.status !== 'active') {
        return res.status(400).json({ error: 'Tournament is not open for betting' });
      }
      // Chips locked in games beyond the window can't count in the final
      // ranking — the event must start before the tournament ends.
      if (new Date(event.commence_time) >= new Date(tournament.end_date)) {
        return res.status(400).json({ error: 'Event starts after this tournament ends' });
      }

      const { data: entry } = await supabase
        .from('tournament_entries')
        .select('id')
        .eq('tournament_id', tournament_id)
        .eq('user_id', userId)
        .single();

      if (!entry) {
        return res.status(400).json({ error: 'You have not entered this tournament' });
      }

      const { data: deducted, error: balanceError } = await supabase.rpc('deduct_tournament_balance', {
        p_tournament_id: tournament_id,
        p_user_id:       userId,
        p_amount:        wager,
      });

      if (balanceError) throw balanceError;
      if (!deducted) {
        return res.status(400).json({ error: 'Insufficient tournament balance' });
      }

    } else if (league_id) {
      const { data: member } = await supabase
        .from('league_members')
        .select('id, leagues!inner(end_date)')
        .eq('league_id', league_id)
        .eq('user_id', userId)
        .single();

      if (!member) {
        return res.status(403).json({ error: 'You are not a member of this league' });
      }

      const today = new Date().toISOString().split('T')[0];
      if (member.leagues?.end_date && member.leagues.end_date < today) {
        return res.status(400).json({ error: 'This league has ended' });
      }

      const { data: deducted, error: balanceError } = await supabase.rpc('deduct_league_balance', {
        p_league_id: league_id,
        p_user_id:   userId,
        p_amount:    wager,
      });

      if (balanceError) throw balanceError;
      if (!deducted) {
        return res.status(400).json({ error: 'Insufficient league balance' });
      }

    } else {
      const { data: deducted, error: balanceError } = await supabase.rpc('deduct_account_balance', {
        p_user_id: userId,
        p_amount:  wager,
      });

      if (balanceError) throw balanceError;
      if (!deducted) {
        return res.status(400).json({ error: 'Insufficient account balance' });
      }
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
        american_odds: serverOdds,
        line: serverPoint,
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
        await supabase.rpc('adjust_tournament_balance', {
          p_tournament_id: tournament_id, p_user_id: userId, p_amount: wager,
        });
      } else if (league_id) {
        await supabase.rpc('adjust_league_balance', {
          p_league_id: league_id, p_user_id: userId, p_amount: wager,
        });
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

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (league_id && league_id !== 'global' && !UUID_RE.test(league_id)) {
      return res.status(400).json({ error: 'Invalid league_id' });
    }
    if (tournament_id && !UUID_RE.test(tournament_id)) {
      return res.status(400).json({ error: 'Invalid tournament_id' });
    }
    if (status && !['pending', 'won', 'lost', 'void', 'pushed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

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