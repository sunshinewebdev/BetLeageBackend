const express = require('express');
const { requireAuth } = require('../middleware/auth');
const supabase = require('../lib/supabase');

const router = express.Router();

// GET /api/events — list upcoming events, optionally filtered by sport
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { sport, status = 'upcoming' } = req.query;

    let query = supabase
      .from('events')
      .select('*')
      .eq('status', status)
      .order('commence_time', { ascending: true });

    if (sport) query = query.eq('sport', sport);

    const { data, error } = await query;
    if (error) throw error;

    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/events/:id
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('events')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Event not found' });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
