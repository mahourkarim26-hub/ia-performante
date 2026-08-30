// Crée une session Stripe Checkout pour l'abonnement Premium (5€/mois).
// Appelle directement l'API REST Stripe (pas besoin du SDK npm) avec la clé
// secrète, qui ne quitte jamais le serveur.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: 'Paiement non configuré (clé Stripe manquante)' });
  }

  const { userId, email } = req.body || {};
  if (!userId) {
    return res.status(400).json({ error: 'Utilisateur non identifié' });
  }

  const origin = req.headers.origin || 'https://ia-performante.vercel.app';
  const PRICE_ID = 'price_1U9LDgGXHqHhitBzyBKPaP1V';

  const params = new URLSearchParams({
    'mode': 'subscription',
    'line_items[0][price]': PRICE_ID,
    'line_items[0][quantity]': '1',
    'subscription_data[trial_period_days]': '3',
    'success_url': origin + '/?premium=success',
    'cancel_url': origin + '/?premium=cancel',
    'client_reference_id': userId,
  });
  if (email) params.set('customer_email', email);

  try {
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });
    const data = await stripeRes.json();
    if (!stripeRes.ok) {
      return res.status(400).json({ error: data?.error?.message || 'Erreur Stripe' });
    }
    return res.status(200).json({ url: data.url });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
