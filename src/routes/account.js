const express = require('express');
const { requireAuth } = require('../middleware/auth');
const supabase = require('../lib/supabase');

const router = express.Router();

const STREAK_REWARDS = [0, 1, 2, 5, 10, 15, 20, 25];

function getReward(streak) {
  // streak is 1-indexed: day 1 = index 1
  const idx = Math.min(streak, STREAK_REWARDS.length - 1);
  return STREAK_REWARDS[idx];
}

// POST /api/account/claim-daily
router.post('/claim-daily', requireAuth, async (req, res, next) => {
  try {
    const userId  = req.user.id;
    const today   = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    const { data: account, error } = await supabase
      .from('account_balances')
      .select('balance, login_streak, last_claim_date')
      .eq('user_id', userId)
      .single();

    if (error) throw error;

    // Already claimed today
    if (account.last_claim_date === today) {
      return res.status(400).json({
        error: 'Already claimed today',
        next_claim: 'tomorrow',
      });
    }

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    // If last claim was yesterday, continue streak. Otherwise reset.
    const newStreak = account.last_claim_date === yesterdayStr
      ? account.login_streak + 1
      : 1;

    const reward = getReward(newStreak);

    // Atomically claim the day: the update is gated on last_claim_date still
    // holding the value we read, so concurrent requests can't claim twice.
    let claim = supabase.from('account_balances').update({
      login_streak:     newStreak,
      last_claim_date:  today,
      updated_at:       new Date().toISOString(),
    }).eq('user_id', userId);

    claim = account.last_claim_date === null
      ? claim.is('last_claim_date', null)
      : claim.eq('last_claim_date', account.last_claim_date);

    const { data: claimed, error: claimError } = await claim.select('user_id');
    if (claimError) throw claimError;

    if (!claimed?.length) {
      return res.status(400).json({
        error: 'Already claimed today',
        next_claim: 'tomorrow',
      });
    }

    // Credit relative to the current balance (not the value read above) so a
    // concurrently placed bet isn't clobbered.
    if (reward > 0) {
      const { error: creditError } = await supabase.rpc('adjust_account_balance', {
        p_user_id: userId,
        p_amount:  reward,
      });
      if (creditError) throw creditError;
    }

    res.json({
      credits_awarded: reward,
      new_streak:      newStreak,
      new_balance:     account.balance + reward,
      next_reward:     getReward(newStreak + 1),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/account/me
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const [accountRes, profileRes, subRes] = await Promise.all([
      supabase
        .from('account_balances')
        .select('balance, login_streak, last_claim_date, is_premium, premium_expires_at')
        .eq('user_id', req.user.id)
        .single(),
      supabase
        .from('profiles')
        .select('username, avatar_url')
        .eq('id', req.user.id)
        .maybeSingle(),
      supabase
        .from('subscriptions')
        .select('plan, status, current_period_end')
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (accountRes.error) throw accountRes.error;

    const data         = accountRes.data;
    const profile      = profileRes.data;
    const subscription = subRes.data;
    const today      = new Date().toISOString().split('T')[0];
    const canClaim   = data.last_claim_date !== today;
    const nextReward = getReward((data.login_streak || 0) + 1);

    res.json({
      ...data,
      username:             profile?.username ?? null,
      avatar_url:           profile?.avatar_url ?? null,
      can_claim:            canClaim,
      next_reward:          nextReward,
      subscription_plan:    subscription?.plan ?? null,
      subscription_status:  subscription?.status ?? null,
      subscription_expires: subscription?.current_period_end ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/account/me
router.delete('/me', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Check for active Stripe subscription and cancel if found
    const { data: subscription, error: subError } = await supabase
      .from('subscriptions')
      .select('stripe_subscription_id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle();

    if (subError) throw subError;

    if (subscription?.stripe_subscription_id) {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      await stripe.subscriptions.cancel(subscription.stripe_subscription_id);
    }

    // Delete all user data via RPC
    const { error: deleteError } = await supabase.rpc('delete_user_account', {
      p_user_id: userId,
    });

    if (deleteError) throw deleteError;

    res.json({ message: 'Account deleted successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;