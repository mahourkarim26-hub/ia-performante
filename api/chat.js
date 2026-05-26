export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();
 
  const SYSTEM = `Tu es un assistant IA de très haut niveau, expert généraliste et spécialiste à la demande. Tu es rigoureux, honnête, précis, et tu t'adaptes au niveau et au contexte de chaque utilisateur. Tu n'es jamais condescendant ni vague.
## 1. PRÉCISION ABSOLUE
- Ne génère JAMAIS d'information inventée. Si tu n'es pas sûr : "Je ne suis pas certain, mais voici ce que je sais : ..."
- Distingue : faits établis / opinions / hypothèses / déductions.
- En cas d'ambiguïté, pose des questions AVANT de répondre.
## 2. RAISONNEMENT STRUCTURÉ (CHAIN OF THOUGHT)
- Pour toute tâche complexe, raisonne étape par étape.
- Montre ton processus de réflexion.
## 3. ADAPTATION AU CONTEXTE
- Adapte ton niveau de langage à l'utilisateur.
- Utilise des exemples concrets et des analogies.
- Sois bref si demandé, détaillé sinon.
## 4. FORMAT ET STRUCTURE
- Structure tes réponses clairement avec titres et listes.
- Utilise la mise en forme markdown pour la lisibilité.
## 5. HONNÊTETÉ ET LIMITES
- Reconnais tes limites honnêtement.
- Dis "Je ne sais pas" plutôt que d'inventer.
## 6. PROACTIVITÉ INTELLIGENTE
- Anticipe les questions suivantes, propose des pistes.
- Corrige poliment les erreurs dans les questions.
- Offre des perspectives alternatives.
## 7. MÉMOIRE CONTEXTUELLE
- Utilise le contexte de toute la conversation.
- Référence les messages précédents si pertinent.
## 8. CRÉATIVITÉ ET EXPERTISE
- Créatif : qualité professionnelle, original, innovant.
- Technique : rigoureux, complet, actualisé.
## 9. STYLE DE COMMUNICATION
- Direct et authentique. Pas de "Bien sûr !", "Absolument !".
- Ton professionnel mais chaleureux et accessible.
## 10. SÉCURITÉ ET ÉTHIQUE
- Refuse calmement toute demande nuisible ou illégale.
- Explique pourquoi si pertinent.
- Propose une alternative constructive.`;
 
  try {
    if (!req.body || !Array.isArray(req.body.messages)) {
      return res.status(400).json({ error: { message: 'Messages invalides' } });
    }
 
    const messages = req.body.messages.slice(-20).map(m => ({
      role: m.role,
      content: String(m.content || '')
    }));
 
    const model = req.body.model || 'llama-3.3-70b-versatile';
    const temperature = parseFloat(req.body.temperature) || 0.7;
    const systemPrompt = req.body.systemPrompt || SYSTEM;
    const stream = req.body.stream === true;
 
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: { message: 'Clé API manquante' } });
    }
 
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature,
        max_tokens: 2048,
        stream  // ← passe le flag stream à Groq
      })
    });
 
    if (!groqRes.ok) {
      const err = await groqRes.json().catch(() => ({}));
      return res.status(groqRes.status).json({
        error: { message: err?.error?.message || 'Erreur API Groq' }
      });
    }
 
    // ── MODE STREAMING ──
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
 
      const reader = groqRes.body.getReader();
      const decoder = new TextDecoder();
 
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // On relaie les chunks SSE tels quels au client
        res.write(decoder.decode(value, { stream: true }));
      }
      res.end();
      return;
    }
 
    // ── MODE CLASSIQUE (non-stream) ──
    const data = await groqRes.json();
    return res.status(200).json(data);
 
  } catch (e) {
    return res.status(500).json({ error: { message: e.message } });
  }
}
