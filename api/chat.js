export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const SYSTEM = req.body.systemPrompt || `Tu es un assistant IA de très haut niveau, expert généraliste et spécialiste à la demande. Tu es rigoureux, honnête, précis, et tu t'adaptes au niveau et au contexte de chaque utilisateur.

## 1. PRÉCISION ABSOLUE
- Ne génère JAMAIS d'information inventée. Si tu n'es pas sûr : "Je ne suis pas certain, mais voici ce que je sais : ..."
- Distingue : faits établis / opinions / hypothèses / déductions.
- En cas d'ambiguïté, pose des questions AVANT de répondre.

## 2. RAISONNEMENT STRUCTURÉ
- Pour toute tâche complexe, raisonne étape par étape.

## 3. ADAPTATION AU CONTEXTE
- Adapte ton niveau de langage à l'utilisateur.
- Utilise des exemples concrets et des analogies.

## 4. FORMAT ET STRUCTURE
- Structure tes réponses clairement avec titres et listes.
- Utilise la mise en forme markdown pour la lisibilité.

## 5. HONNÊTETÉ ET LIMITES
- Reconnais tes limites honnêtement.
- Dis "Je ne sais pas" plutôt que d'inventer.

## 6. PROACTIVITÉ INTELLIGENTE
- Anticipe les questions suivantes, propose des pistes.
- Corrige poliment les erreurs dans les questions.

## 7. MÉMOIRE CONTEXTUELLE
- Utilise le contexte de toute la conversation.

## 8. CRÉATIVITÉ ET EXPERTISE
- Créatif : qualité professionnelle. Technique : rigoureux et complet.

## 9. STYLE DE COMMUNICATION
- Direct et authentique. Pas de "Bien sûr !", "Absolument !".
- Ton professionnel mais chaleureux.

## 10. SÉCURITÉ ET ÉTHIQUE
- Refuse calmement toute demande nuisible ou illégale.`;

  try {
    if (!req.body || !Array.isArray(req.body.messages)) {
      return res.status(400).json({ error: { message: 'Messages invalides' } });
    }

    const messages = req.body.messages.slice(-20).map(m => ({
      role: m.role,
      content: Array.isArray(m.content) ? m.content : String(m.content || '')
    }));

    const hasImages = messages.some(m =>
      Array.isArray(m.content) && m.content.some(c => c.type === 'image_url')
    );

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: { message: 'Clé API manquante' } });
    }

    const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
    const requestedModel = req.body.model || 'llama-3.3-70b-versatile';
    const model = hasImages ? VISION_MODEL : requestedModel;
    const temperature = req.body.temperature ?? 0.7;
    const stream = req.body.stream === true;

    const finalMessages = hasImages
      ? [{ role: 'user', content: `[Système: ${SYSTEM}]\n\n[Message:]` }, ...messages]
      : [{ role: 'system', content: SYSTEM }, ...messages];

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: finalMessages,
        temperature,
        max_tokens: 2048,
        stream
      })
    });

    if (!stream) {
      const data = await groqRes.json();
      if (!groqRes.ok) {
        return res.status(groqRes.status).json({
          error: { message: data?.error?.message || 'Erreur API Groq' }
        });
      }
      return res.status(200).json(data);
    }

    if (!groqRes.ok) {
      const err = await groqRes.json().catch(() => ({}));
      return res.status(groqRes.status).json({
        error: { message: err?.error?.message || 'Erreur Groq ' + groqRes.status }
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const reader = groqRes.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
    } catch (e) {
      // client déconnecté
    } finally {
      res.end();
    }

  } catch (e) {
    if (!res.headersSent) {
      return res.status(500).json({ error: { message: e.message } });
    }
    res.end();
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: '20mb' },
    responseLimit: false,
  },
};
