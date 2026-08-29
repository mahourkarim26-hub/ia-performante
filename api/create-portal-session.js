// Crée une session du "Customer Portal" Stripe : permet à l'utilisateur de
// résilier, changer sa carte, voir ses factures — tout est géré par Stripe,
// aucune logique d'annulation à coder nous-mêmes.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: 'Paiement non configuré (clé Stripe manquante)' });
  }

  const { customerId } = req.body || {};
  if (!customerId) {
    return res.status(400).json({ error: 'Abonnement introuvable' });
  }

  const origin = req.headers.origin || 'https://ia-performante.vercel.app';

  const params = new URLSearchParams({
    'customer': customerId,
    'return_url': origin + '/'
  });

  try {
    const stripeRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
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
