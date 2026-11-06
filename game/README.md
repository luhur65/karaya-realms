# Karaya Realm: sprite edition

This is a copy of the client (`https://games.karaya.site/realm/`) and the server (`karaya-realm-server/server.mjs`).
The procedural graphics are replaced with the sprites from `../assets` (see `../SPRITES.md`).
The originals are kept in `../_reference/`.

## Changes from the original

| Part | Before | Now |
|---|---|---|
| Players | 32 px pixels drawn on a canvas | `hero_male` / `hero_female` atlas (even hair index = male, odd = female), 4-frame walk in 4 directions, attack lunge |
| Weapons | drawn into the character | separate sprite in the hand (`weapon_*`), with a swing animation; the attack is a swing for melee and a pulse for bow/staff |
| Monsters | 2 canvas frames | `slime`, `wolf`, `goblin`, `dragon`: 4 frames × front/side/back. `orc` (formerly Golem Batu) and `ghost` (Arwah): single pose plus bob/hover |
| Trees and rocks | 3D cylinder/icosahedron | ~33k instanced billboards (one draw call per sprite type), tinted per biome |
| Town | box houses and cones | sprite buildings, cobblestone plaza, market, lamps, banners, picket fence, 4 castle gates, dirt roads |
| Ground | flat vertex colour | vertex colour × grass detail texture |
| UI | weapon emoji | weapon icons from the icon sheet |
| Server | - | `name: 'Orc Batu'` for type 3, and serves `/realm/assets/*` in dev mode |

Game rules, the network protocol and the save format are **unchanged**, so it is compatible with the existing server and save data.

## Running locally

```bash
node game/dev.mjs
```

Then open http://127.0.0.1:3078/realm/. Saves go to `game/data-dev/`.

## Deploying to the VPS

1. Copy `game/index.html` to `/var/www/games/realm/index.html`.
2. Copy the folders `assets/atlas`, `assets/world`, `assets/textures`, `assets/icons`, `assets/weapons` and the file
   `assets/sprites.js` to `/var/www/games/realm/assets/`. That is about 10 MB; the `assets/sprites` and `preview` folders are not needed.
3. Update `server.mjs` (only the monster name changed) and run `pm2 restart realm-server`.
4. nginx must serve `/realm/assets/` as static files (it probably already serves `/var/www/games/realm/`).
