// Webhook Stripe : reçoit les événements de paiement/abonnement et met à jour
// le statut premium de l'utilisateur dans Supabase. Vérifie la signature
// Stripe manuellement (HMAC-SHA256) pour ne pas dépendre du SDK npm officiel.

import crypto from 'crypto';

export const config = { api: { bodyParser: false } };

const SUPABASE_URL = 'https://sfbjyduzziwhnsvcwesp.supabase.co';

function readRawBody(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', c => chunks.push(c));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  if (!parts.t || !parts.v1) return false;
  const signedPayload = `${parts.t}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
  } catch (e) {
    return false;
  }
}

async function upsertPremium(serviceKey, userId, active, customerId, subscriptionId) {
  if (!userId) return;
  await fetch(`${SUPABASE_URL}/rest/v1/premium_status`, {
    method: 'POST',
    headers: {
      'apikey': serviceKey,
      'Authorization': 'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify({
      user_id: userId,
      active,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      updated_at: new Date().toISOString()
    })
  });
}

async function findUserIdByCustomer(serviceKey, customerId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/premium_status?stripe_customer_id=eq.${customerId}&select=user_id`,
    { headers: { 'apikey': serviceKey, 'Authorization': 'Bearer ' + serviceKey } }
  );
  const rows = await r.json().catch(() => []);
  return rows?.[0]?.user_id || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!webhookSecret || !serviceKey) {
    return res.status(500).send('Webhook non configuré');
  }

  const rawBody = await readRawBody(req);
  const sig = req.headers['stripe-signature'];
  if (!verifyStripeSignature(rawBody, sig, webhookSecret)) {
    return res.status(400).send('Signature invalide');
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    return res.status(400).send('JSON invalide');
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      await upsertPremium(serviceKey, session.client_reference_id, true, session.customer, session.subscription);
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const active = sub.status === 'active' || sub.status === 'trialing';
      const userId = await findUserIdByCustomer(serviceKey, sub.customer);
      if (userId) await upsertPremium(serviceKey, userId, active, sub.customer, sub.id);
    }
  } catch (e) {
    console.error('Erreur traitement webhook Stripe', e);
  }

  res.status(200).json({ received: true });
}
