const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const supabase = require('../lib/supabase');

const router = express.Router();

// POST /api/leagues — create a league
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const schema = z.object({
      name:      z.string().min(2).max(50),
      is_public: z.boolean().optional().default(false),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { data: league, error } = await supabase
      .from('leagues')
      .insert({ ...parsed.data, created_by: req.user.id })
      .select()
      .single();

    if (error) throw error;

    // Auto-join the creator
    await supabase.from('league_members').insert({
      league_id: league.id,
      user_id:   req.user.id,
    });

    res.status(201).json(league);
  } catch (err) {
    next(err);
  }
});

// POST /api/leagues/join — join via invite code
router.post('/join', requireAuth, async (req, res, next) => {
  try {
    const { invite_code } = req.body;
    if (!invite_code) return res.status(400).json({ error: 'invite_code required' });

    const { data: league } = await supabase
      .from('leagues')
      .select('id, name')
      .eq('invite_code', invite_code.toUpperCase())
      .single();

    if (!league) return res.status(404).json({ error: 'Invalid invite code' });

    const { error } = await supabase.from('league_members').insert({
      league_id: league.id,
      user_id:   req.user.id,
    });

    if (error?.code === '23505') {
      return res.status(400).json({ error: 'Already a member of this league' });
    }
    if (error) throw error;

    res.json(league);
  } catch (err) {
    next(err);
  }
});

// GET /api/leagues — list leagues for the current user
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('leagues')
      .select('*, league_members!inner(user_id)')
      .eq('league_members.user_id', req.user.id);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/leagues/seasons/all — all active seasons across the user's leagues
router.get('/seasons/all', requireAuth, async (req, res, next) => {
  try {
    // Get leagues the user belongs to
    const { data: memberships, error: memErr } = await supabase
      .from('league_members')
      .select('league_id')
      .eq('user_id', req.user.id);

    if (memErr) throw memErr;

    const leagueIds = (memberships || []).map(m => m.league_id);
    if (!leagueIds.length) return res.json([]);

    const { data, error } = await supabase
      .from('league_seasons')
      .select('*, leagues(name)')
      .in('league_id', leagueIds)
      .eq('status', 'active')
      .order('start_date', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/leagues/balance/:season_id — get current user's season balance
router.get('/balance/:season_id', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('season_balances')
      .select('balance')
      .eq('season_id', req.params.season_id)
      .eq('user_id', req.user.id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Balance not found' });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/leagues/:id/seasons
router.get('/:id/seasons', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('league_seasons')
      .select('*')
      .eq('league_id', req.params.id)
      .order('start_date', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /api/leagues/:id/seasons — create a season
router.post('/:id/seasons', requireAuth, async (req, res, next) => {
  try {
    const schema = z.object({
      name:             z.string().min(2).max(50),
      mode:             z.enum(['weekly', 'season']),
      start_date:       z.string(),
      end_date:         z.string(),
      starting_balance: z.number().int().min(100).max(100000).default(1000),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    // Only league creator can make seasons
    const { data: league } = await supabase
      .from('leagues').select('created_by').eq('id', req.params.id).single();

    if (league?.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Only the league creator can manage seasons' });
    }

    const { data: season, error } = await supabase
      .from('league_seasons')
      .insert({ ...parsed.data, league_id: req.params.id, status: 'active' })
      .select()
      .single();

    if (error) throw error;

    // Initialize balances for all current members
    const { data: members } = await supabase
      .from('league_members')
      .select('user_id')
      .eq('league_id', req.params.id);

    for (const m of (members || [])) {
      await supabase.rpc('init_season_balance', {
        p_season_id: season.id,
        p_user_id:   m.user_id,
      });
    }

    res.status(201).json(season);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
