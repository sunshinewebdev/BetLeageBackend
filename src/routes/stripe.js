const express = require('express');
const { requireAuth } = require('../middleware/auth');
const supabase = require('../lib/supabase');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const {
  CREDIT_PACKS,
  SUBSCRIPTION_PLANS,
  createCreditCheckout,
  createSubscriptionCheckout,
  constructWebhookEvent,
} = require('../services/stripeService');

const router = express.Router();

const CLIENT_URL = process.env.CLIENT_URL;

// GET /api/stripe/packs — return available credit packs
router.get('/packs', (req, res) => {
  res.json(Object.entries(CREDIT_PACKS).map(([id, pack]) => ({ id, ...pack })));
});

// GET /api/stripe/plans — return subscription plans
router.get('/plans', (req, res) => {
  res.json(Object.entries(SUBSCRIPTION_PLANS).map(([id, plan]) => ({ id, ...plan })));
});

// POST /api/stripe/checkout/credits
router.post('/checkout/credits', requireAuth, async (req, res, next) => {
  try {
    const { packId } = req.body;
    if (!packId) return res.status(400).json({ error: 'packId required' });

    const session = await createCreditCheckout({
      packId,
      userId:     req.user.id,
      userEmail:  req.user.email,
      successUrl: `${CLIENT_URL}/shop?success=true`,
      cancelUrl:  `${CLIENT_URL}/shop`,
    });

    // Log pending purchase
    await supabase.from('credit_purchases').insert({
      user_id:           req.user.id,
      stripe_session_id: session.id,
      pack_id:           packId,
      credits:           CREDIT_PACKS[packId].credits,
      amount_cents:      CREDIT_PACKS[packId].amount_cents,
      status:            'pending',
    });

    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

// POST /api/stripe/checkout/subscribe
router.post('/checkout/subscribe', requireAuth, async (req, res, next) => {
  try {
    const { plan } = req.body;
    if (!plan) return res.status(400).json({ error: 'plan required' });

    const session = await createSubscriptionCheckout({
      plan,
      userId:     req.user.id,
      userEmail:  req.user.email,
      successUrl: `${CLIENT_URL}/shop?subscribed=true`,
      cancelUrl:  `${CLIENT_URL}/shop`,
    });

    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

// POST /api/stripe/webhook — Stripe calls this after payment
// Must use raw body — registered before express.json() in index.js
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = await constructWebhookEvent(req.body, sig);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { type, userId, packId, credits, plan } = session.metadata;

      if (type === 'credits') {
        // Credit the user's account balance
        await supabase.rpc('adjust_account_balance', {
          p_user_id: userId,
          p_amount:  parseInt(credits),
        });

        // Mark purchase complete
        await supabase.from('credit_purchases')
          .update({ status: 'completed' })
          .eq('stripe_session_id', session.id);

        console.log(`[Stripe] Credited ${credits} to user ${userId}`);
      }

      if (type === 'subscription') {
        const subscriptionId = session.subscription;
        const customerId     = session.customer;
        const stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId);
        const periodEnd      = new Date(stripeSubscription.current_period_end * 1000);

        // Upsert subscription record
        await supabase.from('subscriptions').upsert({
          user_id:                userId,
          stripe_subscription_id: subscriptionId,
          stripe_customer_id:     customerId,
          plan,
          status:                 'active',
          current_period_end:     periodEnd.toISOString(),
          updated_at:             new Date().toISOString(),
        }, { onConflict: 'stripe_subscription_id' });

        // Mark account as premium
        await supabase.from('account_balances').update({
          is_premium:          true,
          premium_expires_at:  periodEnd.toISOString(),
        }).eq('user_id', userId);

        console.log(`[Stripe] Premium activated for user ${userId}`);
      }
    }

    if (event.type === 'customer.subscription.deleted' ||
        event.type === 'customer.subscription.updated') {
      const sub    = event.data.object;
      const status = sub.status; // 'active' | 'canceled' | 'past_due'

      const { data: record } = await supabase
        .from('subscriptions')
        .select('user_id')
        .eq('stripe_subscription_id', sub.id)
        .single();

      if (record) {
        await supabase.from('subscriptions').update({
          status,
          current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('stripe_subscription_id', sub.id);

        // Revoke premium if canceled or past due
        if (status !== 'active') {
          await supabase.from('account_balances').update({
            is_premium:         false,
            premium_expires_at: null,
          }).eq('user_id', record.user_id);
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Stripe webhook error]', err.message);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

module.exports = router;