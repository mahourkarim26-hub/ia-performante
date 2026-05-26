// server.js — npm install express node-fetch dotenv
require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());
app.use(express.static('public'));
 
const SYSTEM = `Tu es un assistant IA de très haut niveau...`;
 
app.post('/api/chat', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { messages, model, temperature, systemPrompt, stream } = req.body;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'GROQ_API_KEY manquante' } });
 
  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: systemPrompt || SYSTEM }, ...messages.slice(-20)],
      temperature: temperature || 0.7,
      max_tokens: 2048,
      stream: !!stream
    })
  });
 
  if (!groqRes.ok) {
    const err = await groqRes.json().catch(() => ({}));
    return res.status(groqRes.status).json({ error: err?.error || { message: 'Erreur Groq' } });
  }
 
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    groqRes.body.pipeTo(new WritableStream({
      write(chunk) { res.write(chunk); },
      close() { res.end(); }
    }));
  } else {
    const data = await groqRes.json();
    res.json(data);
  }
});
 
app.listen(3000, () => console.log('✓ http://localhost:3000'));
