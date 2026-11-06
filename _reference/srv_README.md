# Karaya Realm server

Server multiplayer untuk https://games.karaya.site/realm (klien: /var/www/games/realm/index.html).

- Jalankan: `pm2 start server.mjs --name realm-server` (port 3077, hanya 127.0.0.1)
- nginx meneruskan `wss://games.karaya.site/realm/ws` ke `127.0.0.1:3077`
- Data pemain: `data/players.json` (disimpan tiap 30 detik dan saat pemain keluar)
- Cek: `curl http://127.0.0.1:3077/realm/health`
- Uji lokal: `PORT=3078 STATIC_DIR=/var/www/games/realm DATA_DIR=/tmp/realm node server.mjs`, lalu buka http://127.0.0.1:3078/realm/
