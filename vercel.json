{
  "version": 2,
  "builds": [
    { "src": "api/chat.js", "use": "@vercel/node" },
    { "src": "public/**", "use": "@vercel/static" }
  ],
  "routes": [
    { "src": "/api/chat", "dest": "/api/chat.js" },
    { "src": "/(.*)", "dest": "/public/$1" }
  ]
}
