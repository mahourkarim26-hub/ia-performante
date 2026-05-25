app.post('/api/chat', async (req, res) => {

  try {

    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer TA_CLE_GROQ'
        },

        body: JSON.stringify({

          model: 'llama-3.3-70b-versatile',

          messages: req.body.messages.map(m => ({
            role: m.role,
            content: m.content
          }))

        })
      }
    );

    const data = await response.json();

    res.json(data);

  } catch (err) {

    res.status(500).json({
      error: err.message
    });

  }

});
