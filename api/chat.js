// ── Anti-abus gratuit (rien à payer) ──────────────────────────────────────
// 1) CORS restreint à ton propre domaine (empêche d'autres sites d'utiliser ta clé).
// 2) Rate limiting en mémoire par IP (best-effort : ça vit tant que l'instance
//    serverless reste "chaude" ; ce n'est pas parfait mais ça coûte 0€ et ça
//    bloque déjà l'essentiel des abus/scripts).
// 3) Validation basique de la taille de la requête pour éviter les factures Groq surprises.
// 4) Cache + budget quotidien + rate limit dédié pour la recherche web Tavily
//    (protège le quota gratuit de 1000 recherches/mois).

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

// ── WEB SEARCH : cache + budget quotidien + rate limit dédié ──────────────
// Objectif : le quota gratuit Tavily est de 1000 recherches/mois. Sans
// protection, quelques utilisateurs actifs avec 🌐 activé peuvent le cramer
// en quelques jours. Trois garde-fous, du moins au plus agressif :
//
//   1. Cache (1h) : deux personnes qui posent une question proche dans
//      l'heure ne déclenchent qu'UN seul appel Tavily.
//   2. Rate limit par IP (8 recherches web / 10 min) : empêche un seul
//      utilisateur (ou script) de consommer le quota à lui seul.
//   3. Budget quotidien global (30/jour ≈ 1000/mois avec marge) : filet de
//      sécurité final si le cache et le rate limit par IP ne suffisent pas
//      (beaucoup d'utilisateurs différents, requêtes toutes uniques).
//
// Tout est en mémoire (best-effort, reset à chaque cold start), donc gratuit
// et sans dépendance — cohérent avec le reste du fichier.

const WEB_SEARCH_CACHE_TTL_MS = 60 * 60 * 1000; // 1h : les résultats web ne périment pas plus vite que ça pour la plupart des requêtes
const WEB_SEARCH_CACHE_MAX_ENTRIES = 500; // borne la mémoire utilisée par le cache
const webSearchCache = globalThis.__iaWebSearchCache || (globalThis.__iaWebSearchCache = new Map());

const WEB_SEARCH_IP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const WEB_SEARCH_IP_MAX = 8; // 8 recherches web / 10 min / IP
const webSearchIpBuckets = globalThis.__iaWebSearchIpBuckets || (globalThis.__iaWebSearchIpBuckets = new Map());

const TAVILY_DAILY_BUDGET = 30; // ~1000/mois réparti sur 30 jours, avec marge de sécurité
const tavilyBudget = globalThis.__iaTavilyBudget || (globalThis.__iaTavilyBudget = { date: null, count: 0 });

function normalizeSearchQuery(q) {
  return q.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 400);
}

function getCachedSearch(query) {
  const entry = webSearchCache.get(query);
  if (!entry) return null;
  if (Date.now() - entry.ts > WEB_SEARCH_CACHE_TTL_MS) {
    webSearchCache.delete(query);
    return null;
  }
  return entry.value;
}

function setCachedSearch(query, value) {
  if (webSearchCache.size >= WEB_SEARCH_CACHE_MAX_ENTRIES) {
    // Map conserve l'ordre d'insertion : on évince l'entrée la plus ancienne (FIFO simple).
    const oldestKey = webSearchCache.keys().next().value;
    webSearchCache.delete(oldestKey);
  }
  webSearchCache.set(query, { value, ts: Date.now() });
}

function isWebSearchIpLimited(ip) {
  const now = Date.now();
  const bucket = webSearchIpBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > WEB_SEARCH_IP_WINDOW_MS) {
    webSearchIpBuckets.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > WEB_SEARCH_IP_MAX;
}

function isTavilyBudgetExceeded() {
  const today = new Date().toDateString();
  if (tavilyBudget.date !== today) {
    tavilyBudget.date = today;
    tavilyBudget.count = 0;
  }
  return tavilyBudget.count >= TAVILY_DAILY_BUDGET;
}

function consumeTavilyBudget() {
  const today = new Date().toDateString();
  if (tavilyBudget.date !== today) {
    tavilyBudget.date = today;
    tavilyBudget.count = 0;
  }
  tavilyBudget.count += 1;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: { message: 'Trop de requêtes — réessaie dans quelques minutes.' } });
  }

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
    // Protégée par : cache (évite les doublons), rate limit par IP (évite qu'un
    // seul utilisateur consomme tout le quota), budget quotidien global (filet
    // de sécurité final).
    let webSearchResults = '';
    if (webSearchRequested && process.env.TAVILY_API_KEY) {
      try {
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
        const rawQuery = lastUserMsg
          ? (Array.isArray(lastUserMsg.content)
              ? (lastUserMsg.content.find(p => p.type === 'text')?.text || '')
              : String(lastUserMsg.content || ''))
          : '';
        if (rawQuery.trim()) {
          const normQuery = normalizeSearchQuery(rawQuery);
          const cached = getCachedSearch(normQuery);

          if (cached) {
            webSearchResults = cached;
          } else if (isWebSearchIpLimited(ip)) {
            webSearchResults = '\n\n[Recherche web indisponible : trop de recherches en peu de temps depuis cette connexion. Réponds du mieux que tu peux sans web et signale-le brièvement à l\'utilisateur.]';
          } else if (isTavilyBudgetExceeded()) {
            webSearchResults = '\n\n[Recherche web temporairement indisponible : quota journalier atteint. Réponds du mieux que tu peux sans web et signale-le brièvement à l\'utilisateur.]';
          } else {
            consumeTavilyBudget();
            const tavilyRes = await fetch('https://api.tavily.com/search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                api_key: process.env.TAVILY_API_KEY,
                query: normQuery,
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
                setCachedSearch(normQuery, webSearchResults);
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
