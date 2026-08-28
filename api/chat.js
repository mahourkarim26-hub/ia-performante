// ── Anti-abus gratuit (rien à payer) ──────────────────────────────────────
// 1) CORS restreint à ton propre domaine (empêche d'autres sites d'utiliser ta clé).
// 2) Rate limiting en mémoire par IP (best-effort : ça vit tant que l'instance
//    serverless reste "chaude" ; ce n'est pas parfait mais ça coûte 0€ et ça
//    bloque déjà l'essentiel des abus/scripts).
// 3) Validation basique de la taille de la requête pour éviter les factures Groq surprises.

const ALLOWED_ORIGINS = [
  'https://ia-performante.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  ...(process.env.ALLOWED_ORIGIN ? [process.env.ALLOWED_ORIGIN] : [])
];

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MAX = 30; // 30 requêtes / 5 min / IP
const MAX_MESSAGES = 30;
const MAX_TOTAL_CHARS = 60000; // ~15k tokens de contexte max envoyés à Groq

// Persiste tant que l'instance serverless reste chaude (gratuit, pas de DB).
const rateBuckets = globalThis.__iaRateBuckets || (globalThis.__iaRateBuckets = new Map());

// ── Recherche web (Tavily) : quota séparé + cache ──────────────────────────
// Tavily offre 1000 recherches/mois gratuites. On protège ce quota avec :
// 1) une limite dédiée par IP (plus stricte que le chat normal, car chaque
//    recherche web coûte un appel Tavily en plus de l'appel Groq)
// 2) un cache en mémoire (5 min) : deux personnes qui posent la même question
//    avec 🌐 activé ne déclenchent qu'une seule recherche Tavily
const WEB_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 heure
const WEB_RATE_LIMIT_MAX = 15; // 15 recherches web / heure / IP
const WEB_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const webRateBuckets = globalThis.__iaWebRateBuckets || (globalThis.__iaWebRateBuckets = new Map());
const webCache = globalThis.__iaWebCache || (globalThis.__iaWebCache = new Map());

function isWebRateLimited(ip) {
  const now = Date.now();
  const bucket = webRateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > WEB_RATE_LIMIT_WINDOW_MS) {
    webRateBuckets.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > WEB_RATE_LIMIT_MAX;
}

function getWebCache(query) {
  const key = query.trim().toLowerCase();
  const entry = webCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > WEB_CACHE_TTL_MS) { webCache.delete(key); return null; }
  return entry.results;
}

function setWebCache(query, results) {
  const key = query.trim().toLowerCase();
  webCache.set(key, { results, ts: Date.now() });
  // Purge basique pour éviter une fuite mémoire si le cache grossit trop
  if (webCache.size > 200) {
    const oldestKey = webCache.keys().next().value;
    webCache.delete(oldestKey);
  }
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
}

function estimateContentLength(content) {
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      if (part.type === 'text') return sum + (part.text?.length || 0);
      if (part.type === 'image_url') return sum + 200; // les images ne comptent pas pour le quota texte
      return sum;
    }, 0);
  }
  return String(content || '').length;
}

// ── Vérification du statut premium (via Authorization: Bearer <token utilisateur>) ──
// Interroge Supabase avec le JWT de l'utilisateur (pas une clé serveur) : les
// règles RLS garantissent qu'il ne peut lire que SON PROPRE statut, donc cette
// vérification est fiable même si elle est faite depuis un simple fetch.
const SUPABASE_URL_CHAT = 'https://sfbjyduzziwhnsvcwesp.supabase.co';
const SUPABASE_ANON_KEY_CHAT = 'sb_publishable_dJ0J0aaN8igcqGg6OyxuMw_dMjK81KH';
async function isPremiumUser(authHeader) {
  if (!authHeader) return false;
  try {
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const r = await fetch(`${SUPABASE_URL_CHAT}/rest/v1/premium_status?select=active`, {
      headers: { 'apikey': SUPABASE_ANON_KEY_CHAT, 'Authorization': 'Bearer ' + token }
    });
    if (!r.ok) return false;
    const rows = await r.json();
    return !!rows?.[0]?.active;
  } catch (e) {
    return false;
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: { message: 'Trop de requêtes — réessaie dans quelques minutes.' } });
  }
  const isPremium = await isPremiumUser(req.headers['authorization']);

  const SYSTEM = req.body?.systemPrompt || `Tu es un assistant IA de très haut niveau, expert généraliste et spécialiste à la demande. Tu es rigoureux, honnête, précis, et tu t'adaptes au niveau et au contexte de chaque utilisateur.

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
- N'utilise JAMAIS de balises HTML (comme <br>, <b>, <div>) dans tes réponses, même dans un tableau. Pour un saut de ligne dans une cellule de tableau, utilise une virgule ou un point-virgule à la place.
- N'utilise JAMAIS de marqueurs de citation type 【1†source】 ou [1] : quand tu cites une source web, écris-la simplement en texte normal, par exemple "(source : nom du site)".
- Quand on te demande de créer un document (CV, lettre de motivation, présentation/PowerPoint, post, rapport, etc.) : génère-le DIRECTEMENT et en entier, avec des hypothèses raisonnables pour les détails manquants (des exemples plausibles entre crochets si besoin, ex: [Votre Nom]). Ne renvoie JAMAIS un tableau de questions de clarification avant de produire le contenu — l'utilisateur préfère un premier jet complet qu'il pourra ensuite ajuster. Pose une question seulement si une information est absolument bloquante et ne peut raisonnablement pas être devinée.
- Pour une présentation/PowerPoint : structure toujours ta réponse avec des titres markdown clairs (## Titre de la diapo) suivis de listes à puces courtes (une idée par ligne, pas de phrases longues) — ce format est ensuite converti automatiquement en vraies diapositives.

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
- Refuse calmement toute demande nuisible ou illégale.

## 11. IDENTITÉ
- Si on te demande qui t'a créé, qui est ton développeur/créateur, d'où tu viens, sur quelle technologie ou quel modèle tu es basé : réponds uniquement que tu as été créé par un jeune étudiant passionné d'intelligence artificielle, en solo.
- Ne mentionne jamais les noms Groq, Meta, Llama, OpenAI, GPT, Qwen, Mixtral, Gemma ni aucune autre entreprise ou modèle sous-jacent, même si on insiste ou reformule la question.`;

  try {
    if (!req.body || !Array.isArray(req.body.messages)) {
      return res.status(400).json({ error: { message: 'Messages invalides' } });
    }

    if (req.body.messages.length > MAX_MESSAGES) {
      return res.status(400).json({ error: { message: `Trop de messages (max ${MAX_MESSAGES})` } });
    }

    const messages = req.body.messages.slice(-MAX_MESSAGES).map(m => ({
      role: m.role,
      content: Array.isArray(m.content) ? m.content : String(m.content || '')
    }));

    const totalChars = messages.reduce((sum, m) => sum + estimateContentLength(m.content), 0);
    if (totalChars > MAX_TOTAL_CHARS) {
      return res.status(400).json({ error: { message: 'Message trop long, raccourcis ta demande.' } });
    }

    const hasImages = messages.some(m =>
      Array.isArray(m.content) && m.content.some(c => c.type === 'image_url')
    );

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: { message: 'Clé API manquante' } });
    }

    // Modèles Groq à jour (les anciens llama-3.3-70b-versatile / llama-3.1-8b-instant /
    // llama-4-scout / llama-4-maverick / mixtral-8x7b ont été mis hors service par Groq).
    const VALID_MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.6-27b', 'gemma2-9b-it'];
    const VISION_MODEL = 'qwen/qwen3.6-27b';
    let requestedModel = req.body.model || 'openai/gpt-oss-120b';
    if (!VALID_MODELS.includes(requestedModel)) requestedModel = 'openai/gpt-oss-120b';
    const model = hasImages ? VISION_MODEL : requestedModel;
    const temperature = req.body.temperature ?? 0.7;
    const stream = req.body.stream === true;
    const webSearchRequested = req.body.webSearch === true;

    // Recherche web (Tavily, gratuit jusqu'à 1000 recherches/mois) : si activée,
    // on cherche sur le web à partir du dernier message utilisateur et on injecte
    // les résultats dans le prompt système avant d'appeler Groq.
    let webSearchResults = '';
    if (webSearchRequested && process.env.TAVILY_API_KEY) {
      try {
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
        const query = lastUserMsg
          ? (Array.isArray(lastUserMsg.content)
              ? (lastUserMsg.content.find(p => p.type === 'text')?.text || '')
              : String(lastUserMsg.content || ''))
          : '';
        if (query.trim()) {
          const cached = getWebCache(query);
          if (cached) {
            webSearchResults = cached;
          } else if (!isPremium && isWebRateLimited(ip)) {
            webSearchResults = '\n\n[Recherche web indisponible : limite horaire atteinte. Réponds du mieux que tu peux sans elle, et précise que la recherche web est temporairement limitée.]';
          } else {
            const tavilyRes = await fetch('https://api.tavily.com/search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                api_key: process.env.TAVILY_API_KEY,
                query: query.slice(0, 400),
                max_results: 5,
                search_depth: 'basic'
              })
            });
            if (tavilyRes.ok) {
              const tavilyData = await tavilyRes.json();
              const results = (tavilyData.results || []).slice(0, 5);
              if (results.length) {
                webSearchResults = '\n\n## RÉSULTATS DE RECHERCHE WEB (utilise-les pour répondre, cite tes sources) :\n' +
                  results.map((r, i) => `${i + 1}. ${r.title}\n${r.content?.slice(0, 500) || ''}\nSource: ${r.url}`).join('\n\n');
                setWebCache(query, webSearchResults);
              }
            }
          }
        }
      } catch (e) {
        // La recherche web échoue silencieusement : la conversation continue sans elle
      }
    }

    // Un vrai rôle "system" fonctionne aussi bien pour les modèles vision
    // sur l'API Groq (compatible OpenAI) — plus besoin du bricolage précédent.
    const finalMessages = [{ role: 'system', content: SYSTEM + webSearchResults }, ...messages];

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
