export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const SYSTEM = `
Tu es un assistant IA très intelligent, précis et utile.
Réponds clairement et naturellement.
`;

  try {

    if (
      !req.body ||
      !Array.isArray(req.body.messages)
    ) {
      return res.status(400).json({
        error: {
          message: 'Messages invalides'
        }
      });
    }

    // ===== ENLEVE ts =====

    const messages = req.body.messages
      .slice(-20)
      .map(m => ({
        role: m.role,
        content: m.content
      }));

    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: {
          message: 'Clé API manquante'
        }
      });
    }

    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },

        body: JSON.stringify({

          model: 'llama-3.3-70b-versatile',

          messages: [
            {
              role: 'system',
              content: SYSTEM
            },

            ...messages
          ],

          temperature: 0.7,
          max_tokens: 2048

        })

      }
    );

    const data = await response.json();

    if (!response.ok) {

      return res.status(response.status).json({
        error: {
          message:
            data?.error?.message ||
            'Erreur API Groq'
        }
      });

    }

    return res.status(200).json(data);

  } catch (e) {

    return res.status(500).json({
      error: {
        message: e.message
      }
    });

  }

}
