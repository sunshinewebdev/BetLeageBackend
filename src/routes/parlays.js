const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { calculateParlayOdds, calculateParlayPayout } = require('../lib/parlayOdds');
const supabase = require('../lib/supabase');

const router = express.Router();

const LegSchema = z.object({
  event_id:        z.string(),
  bet_type:        z.enum(['moneyline', 'spread', 'totals', 'prop']),
  selection:       z.enum(['home', 'away', 'over', 'under']),
  selection_label: z.string(),
  american_odds:   z.number().int(),
});

const PlaceParlaySchema = z.object({
  league_id:     z.string().uuid().optional().nullable(),
  tournament_id: z.string().uuid().optional().nullable(),
  wager:         z.number().positive().max(10000),
  legs:          z.array(LegSchema).min(2),
});

// POST /api/parlays
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const parsed = PlaceParlaySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { league_id, tournament_id, wager, legs } = parsed.data;
    const userId = req.user.id;

    // Reject duplicate events in the same parlay
    const eventIds = legs.map(l => l.event_id);
    if (new Set(eventIds).size !== eventIds.length) {
      return res.status(400).json({ error: 'Each leg must be for a different event' });
    }

    // Verify all events are still upcoming
    const { data: events, error: eventsError } = await supabase
      .from('events')
      .select('id, status')
      .in('id', eventIds);

    if (eventsError) throw eventsError;
    if (!events || events.length !== eventIds.length) {
      return res.status(400).json({ error: 'One or more events could not be found' });
    }
    if (events.some(e => e.status !== 'upcoming')) {
      return res.status(400).json({ error: 'One or more events are no longer open for betting' });
    }

    const oddsArray       = legs.map(l => l.american_odds);
    const combinedOdds    = calculateParlayOdds(oddsArray);
    const potentialPayout = calculateParlayPayout(wager, oddsArray);

    // Deduct from the correct bankroll
    if (tournament_id) {
      const { data: entry } = await supabase
        .from('tournament_entries')
        .select('id, balance')
        .eq('tournament_id', tournament_id)
        .eq('user_id', userId)
        .single();

      if (!entry)             return res.status(400).json({ error: 'You have not entered this tournament' });
      if (entry.balance < wager) return res.status(400).json({ error: 'Insufficient tournament balance' });

      const { error } = await supabase
        .from('tournament_entries')
        .update({ balance: Number(entry.balance) - wager })
        .eq('id', entry.id);
      if (error) throw error;

    } else if (league_id) {
      const { data: member } = await supabase
        .from('league_members')
        .select('id, balance')
        .eq('league_id', league_id)
        .eq('user_id', userId)
        .single();

      if (!member)              return res.status(403).json({ error: 'You are not a member of this league' });
      if (member.balance < wager) return res.status(400).json({ error: 'Insufficient league balance' });

      const { error } = await supabase
        .from('league_members')
        .update({ balance: Number(member.balance) - wager, updated_at: new Date() })
        .eq('league_id', league_id)
        .eq('user_id', userId);
      if (error) throw error;

    } else {
      const { data: balanceRow } = await supabase
        .from('account_balances')
        .select('balance')
        .eq('user_id', userId)
        .single();

      if (!balanceRow || balanceRow.balance < wager) {
        return res.status(400).json({ error: 'Insufficient account balance' });
      }

      const { error } = await supabase
        .from('account_balances')
        .update({ balance: Number(balanceRow.balance) - wager, updated_at: new Date() })
        .eq('user_id', userId);
      if (error) throw error;
    }

    // Insert parlay
    const { data: parlay, error: parlayError } = await supabase
      .from('parlays')
      .insert({
        user_id:          userId,
        league_id:        league_id     || null,
        tournament_id:    tournament_id || null,
        combined_odds:    combinedOdds,
        wager,
        potential_payout: potentialPayout,
      })
      .select()
      .single();

    if (parlayError) {
      // Refund and bail
      await refundWager({ userId, league_id, tournament_id, wager });
      throw parlayError;
    }

    // Insert legs
    const legRows = legs.map(l => ({
      parlay_id:       parlay.id,
      event_id:        l.event_id,
      bet_type:        l.bet_type,
      selection:       l.selection,
      selection_label: l.selection_label,
      american_odds:   l.american_odds,
    }));

    const { error: legsError } = await supabase.from('parlay_legs').insert(legRows);

    if (legsError) {
      await supabase.from('parlays').delete().eq('id', parlay.id);
      await refundWager({ userId, league_id, tournament_id, wager });
      throw legsError;
    }

    res.status(201).json({ ...parlay, legs: legRows });
  } catch (err) {
    next(err);
  }
});

// GET /api/parlays
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { league_id, tournament_id, source, status } = req.query;

    let query = supabase
      .from('parlays')
      .select('*, legs:parlay_legs(*, event:events(home_team, away_team, commence_time, sport))')
      .eq('user_id', req.user.id)
      .order('placed_at', { ascending: false });

    if (source === 'account') {
      query = query.is('league_id', null).is('tournament_id', null);
    } else if (league_id) {
      query = query.eq('league_id', league_id);
    }

    if (tournament_id) query = query.eq('tournament_id', tournament_id);
    if (status)        query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    next(err);
  }
});

async function refundWager({ userId, league_id, tournament_id, wager }) {
  if (tournament_id) {
    const { data: entry } = await supabase
      .from('tournament_entries')
      .select('id, balance')
      .eq('tournament_id', tournament_id)
      .eq('user_id', userId)
      .single();
    if (entry) {
      await supabase
        .from('tournament_entries')
        .update({ balance: Number(entry.balance) + wager })
        .eq('id', entry.id);
    }
  } else if (league_id) {
    await supabase.rpc('adjust_league_balance', {
      p_league_id: league_id,
      p_user_id:   userId,
      p_amount:    wager,
    });
  } else {
    await supabase.rpc('adjust_account_balance', {
      p_user_id: userId,
      p_amount:  wager,
    });
  }
}

module.exports = router;
