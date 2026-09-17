// Petit serveur web 100% local, sans dépendance externe.
// Sert uniquement les fichiers de ce dossier. Aucune donnée n'est envoyée sur Internet :
// ce serveur n'effectue aucun appel sortant, il ne fait que répondre aux requêtes locales.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.gz': 'application/gzip',
  '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Serveur local demarre sur le port ${PORT}.`);
  console.log(`- Sur cet appareil : http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  Object.values(nets).flat().forEach((net) => {
    if (net && net.family === 'IPv4' && !net.internal) {
      console.log(`- Depuis le meme Wi-Fi : http://${net.address}:${PORT}`);
    }
  });
  console.log('Aucune donnee ne quitte ce serveur : tout reste en local (LAN uniquement).');
});
