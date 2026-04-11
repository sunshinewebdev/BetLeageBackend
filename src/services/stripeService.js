const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const CREDIT_PACKS = {
  pack_5:   { credits: 50,    amount_cents: 500,   label: '50 credits'     },
  pack_10:  { credits: 200,   amount_cents: 1000,  label: '200 credits'    },
  pack_25:  { credits: 750,   amount_cents: 2500,  label: '750 credits'    },
  pack_50:  { credits: 2000,  amount_cents: 5000,  label: '2,000 credits'  },
  pack_100: { credits: 10000, amount_cents: 10000, label: '10,000 credits' },
};

const SUBSCRIPTION_PLANS = {
  monthly: { amount_cents: 500,  interval: 'month', label: 'Premium Monthly' },
  yearly:  { amount_cents: 5000, interval: 'year',  label: 'Premium Yearly'  },
};

async function createCreditCheckout({ packId, userId, userEmail, successUrl, cancelUrl }) {
  const pack = CREDIT_PACKS[packId];
  if (!pack) throw new Error('Invalid pack');

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'payment',
    customer_email: userEmail,
    line_items: [{
      price_data: {
        currency: 'usd',
        unit_amount: pack.amount_cents,
        product_data: { name: `BetLeague — ${pack.label}` },
      },
      quantity: 1,
    }],
    metadata: { userId, packId, credits: pack.credits, type: 'credits' },
    success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  cancelUrl,
  });

  return session;
}

async function createSubscriptionCheckout({ plan, userId, userEmail, successUrl, cancelUrl }) {
  const planMeta = SUBSCRIPTION_PLANS[plan];
  if (!planMeta) throw new Error('Invalid plan');

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'subscription',
    customer_email: userEmail,
    line_items: [{
      price_data: {
        currency: 'usd',
        unit_amount: planMeta.amount_cents,
        recurring: { interval: planMeta.interval },
        product_data: { name: `BetLeague Premium — ${planMeta.label}` },
      },
      quantity: 1,
    }],
    metadata: { userId, plan, type: 'subscription' },
    success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  cancelUrl,
  });

  return session;
}

async function constructWebhookEvent(rawBody, signature) {
  return stripe.webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );
}

module.exports = {
  CREDIT_PACKS,
  SUBSCRIPTION_PLANS,
  createCreditCheckout,
  createSubscriptionCheckout,
  constructWebhookEvent,
};