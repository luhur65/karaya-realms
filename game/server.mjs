// Karaya Realm game server.
// One shared open world: the server owns monsters, combat, XP, loot and saves, clients only
// send where they walk and what they attack. WebSocket is implemented here (RFC 6455, text
// frames only) so the server has no npm dependencies.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import './world.js';   // shared layout + collision (same file the client loads)

try {
  process.loadEnvFile();
} catch {}

const RW = globalThis.RealmWorld;

const PORT = +process.env.PORT || 3077;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, 'data');
const STATIC_DIR = process.env.STATIC_DIR || '';          // dev only: serve the client at /realm/
// dev only: sprite assets served at /realm/assets/* (in production nginx serves them as static files)
const ASSETS_DIR = process.env.ASSETS_DIR || (STATIC_DIR ? path.resolve(STATIC_DIR, '..', 'assets') : '');
const MIME = { '.png': 'image/png', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg' };
const ORIGINS = (process.env.ORIGINS || 'https://games.karaya.site').split(',');

// ---------- world rules (the client has a copy of the ones it draws) ----------
const WORLD = 600;          // world spans -WORLD..WORLD on x and z
const TOWN_R = 28;          // safe town in the middle
const MAX_LEVEL = 9999;
const TICK_MS = 100;
const VIEW = 50;            // entities within this distance are sent to a player
const ACTIVE = 64;          // monsters within this distance of a player think
const SPAWNS = 3200;
const INV_MAX = 40;
const CELL = 16;
const GRID = Math.ceil((WORLD * 2) / CELL);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);
const now = () => Date.now();

function zoneLevel(x, z) {
  const d = Math.hypot(x, z);
  if (d < TOWN_R) return 1;
  const t = Math.min(1, (d - TOWN_R) / (WORLD - TOWN_R));
  return clamp(Math.round(1 + (MAX_LEVEL - 1) * t ** 3), 1, MAX_LEVEL);
}
const xpNeed = (l) => Math.floor(40 * l ** 1.75 + 60);
function xpReward(m, l, elite) {
  const d = m - l;
  const f = d >= 0 ? 1 + Math.min(1, d / (5 + l * 0.05)) : Math.max(0.1, 1 + d / (5 + l * 0.1));
  return Math.max(1, Math.floor((6 * m ** 1.65 + 10) * f * (elite ? 4 : 1)));
}
function damage(atk, def, lvl) {
  const k = 20 + 4 * lvl;
  return Math.max(1, Math.round(atk * (k / (k + def)) * rand(0.9, 1.1)));
}

const MTYPES = [
  { key: 'slime', name: 'Lendir', from: 1, aggro: false, speed: 2.2, range: 1.5, cd: 1.6, r: 0.6, hp: 1, atk: 1 },
  { key: 'wolf', name: 'Serigala', from: 12, aggro: true, speed: 4.4, range: 1.7, cd: 1.3, r: 0.7, hp: 0.9, atk: 1.1 },
  { key: 'goblin', name: 'Goblin', from: 50, aggro: true, speed: 3.6, range: 1.7, cd: 1.2, r: 0.6, hp: 1, atk: 1.15 },
  { key: 'orc', name: 'Orc Batu', from: 250, aggro: false, speed: 2.0, range: 2.0, cd: 2.0, r: 1.0, hp: 1.8, atk: 1.4 },
  { key: 'skeleton', name: 'Tengkorak', from: 500, aggro: true, speed: 3.2, range: 1.8, cd: 1.4, r: 0.7, hp: 1.2, atk: 1.2 },
  { key: 'ghost', name: 'Arwah', from: 1000, aggro: true, speed: 4.0, range: 1.8, cd: 1.3, r: 0.7, hp: 0.9, atk: 1.25 },
  { key: 'dragon', name: 'Naga Muda', from: 3500, aggro: true, speed: 3.8, range: 2.2, cd: 1.6, r: 1.1, hp: 1.5, atk: 1.35 },
];

// ---------- jobs & weapons ----------
// Melee jobs (swordsman, berserker, tanker) fight up close; ranged jobs (archer, mage) hit from afar
// but have less HP and defense. Each job can only use its own weapon type.
const WTYPES = {
  sword1: { names: ['Pedang', 'Rapier', 'Katana'], atk: 1, delay: 700, range: 2.2 },
  sword2: { names: ['Pedang Besar', 'Claymore', 'Pedang Raksasa'], atk: 1.4, delay: 1000, range: 2.5 },
  mace: { names: ['Gada & Perisai', 'Palu & Perisai', 'Morgenstern & Perisai'], atk: 0.8, delay: 800, range: 2.2 },
  bow: { names: ['Busur', 'Busur Panjang', 'Busur Silang'], atk: 0.95, delay: 800, range: 11 },
  staff: { names: ['Tongkat', 'Tongkat Rune', 'Tongkat Kristal'], atk: 1.1, delay: 900, range: 10 },
};
const JOBS = {
  swordsman: { name: 'Swordsman', w: 'sword1', hp: 1.1, def: 1.1, atk: 1, mp: 1, crit: 0, speed: 0 },
  berserker: { name: 'Berserker', w: 'sword2', hp: 1, def: 0.9, atk: 1.15, mp: 0.8, crit: 5, speed: 0 },
  tanker: { name: 'Tanker', w: 'mace', hp: 1.45, def: 1.5, atk: 0.8, mp: 0.9, crit: 0, speed: -0.2 },
  archer: { name: 'Archer', w: 'bow', hp: 0.9, def: 0.85, atk: 1.05, mp: 1, crit: 8, speed: 0.4 },
  mage: { name: 'Magician', w: 'staff', hp: 0.8, def: 0.8, atk: 1.1, mp: 1.7, crit: 0, speed: 0 },
};
// two skills per job: [mana cost in % of max mana, cooldown ms]; the effects are in castSkill()
const SKILLS = {
  swordsman: [[18, 6000], [12, 4000]],
  berserker: [[25, 8000], [20, 20000]],
  tanker: [[18, 8000], [20, 18000]],
  archer: [[22, 7000], [12, 4000]],
  mage: [[25, 8000], [25, 12000]],
};
const jobOf = (p) => (JOBS[p.job] ? p.job : 'swordsman');
const wtOf = (it) => it.wt || 'sword1';

// ---------- items ----------
const RARITY = [
  { key: 'biasa', w: 600, mult: 1 },
  { key: 'bagus', w: 250, mult: 1.35 },
  { key: 'langka', w: 100, mult: 1.8 },
  { key: 'epik', w: 40, mult: 2.5 },
  { key: 'legenda', w: 10, mult: 3.5 },
];
const SLOTS = {
  weapon: ['Pedang', 'Kapak', 'Tombak', 'Belati', 'Gada'],
  armor: ['Zirah', 'Jubah', 'Rompi'],
  helm: ['Helm', 'Topi', 'Mahkota'],
  boots: ['Sepatu', 'Sandal', 'Pelindung Kaki'],
  ring: ['Cincin', 'Kalung', 'Jimat'],
};
const PREFIX = {
  biasa: ['Usang', 'Kayu', 'Kasar'], bagus: ['Tajam', 'Kokoh', 'Baja'], langka: ['Rune', 'Perak', 'Badai'],
  epik: ['Naga', 'Bayangan', 'Petir'], legenda: ['Karaya', 'Abadi', 'Sang Surya'],
};
const pick = (a) => a[(Math.random() * a.length) | 0];
function rollRarity(luck) {
  const ws = RARITY.map((r, i) => r.w * (i >= 2 ? luck : 1));
  let x = Math.random() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < ws.length; i++) if ((x -= ws[i]) < 0) return i;
  return 0;
}
// prefer: the killer's weapon type, so half of the weapons that drop fit their job
function makeItem(lvl, luck, prefer) {
  const slot = pick(Object.keys(SLOTS)), ri = rollRarity(luck), r = RARITY[ri], m = r.mult, L = lvl;
  const st = {};
  if (slot === 'weapon') {
    const wt = prefer && Math.random() < 0.5 ? prefer : pick(Object.keys(WTYPES)), W = WTYPES[wt];
    st.atk = Math.round((5 + L * 1.4) * m * W.atk);
    if (wt === 'mace') st.def = Math.round((1 + L * 0.5) * m);
    return { id: crypto.randomBytes(6).toString('hex'), slot, wt, rar: ri, lvl: L, req: Math.max(1, L - 3), name: `${pick(W.names)} ${pick(PREFIX[r.key])}`, st };
  }
  if (slot === 'armor') { st.def = Math.round((2 + L * 0.9) * m); st.maxHp = Math.round((15 + L * 7) * m); }
  if (slot === 'helm') { st.def = Math.round((1 + L * 0.5) * m); st.maxHp = Math.round((5 + L * 3) * m); }
  if (slot === 'boots') { st.def = Math.round((1 + L * 0.4) * m); st.speed = Math.round(m * 2.5) / 10; }
  if (slot === 'ring') { st.atk = Math.round((2 + L * 0.6) * m); st.crit = Math.round(2 * m); }
  return { id: crypto.randomBytes(6).toString('hex'), slot, rar: ri, lvl: L, req: Math.max(1, L - 3), name: `${pick(SLOTS[slot])} ${pick(PREFIX[r.key])}`, st };
}
// Market: the system buys items at a fixed price that grows steeply with rarity
const PRICE_MULT = [1, 3, 8, 25, 80];
const sellPrice = (it) => Math.floor((8 + it.lvl * 3) * PRICE_MULT[it.rar]);
// Diamonds: the rare currency. 1 diamond = 1000 gold, exchangeable both ways at the market.
const DIA_GOLD = 1000, DIA_CHANCE = 0.004, DIA_CHANCE_ELITE = 0.04;
// Admins have unlimited diamonds (shown as ∞): spending never runs out or lowers their count
function spendDia(p, n) {
  if (p.admin) return true;
  if (p.dia < n) return false;
  p.dia -= n;
  return true;
}

// ---------- save data ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const SAVE = path.join(DATA_DIR, 'players.json');
let db = {};
try { db = JSON.parse(fs.readFileSync(SAVE, 'utf8')); } catch { db = {}; }
let dirty = false;
const names = new Map(Object.entries(db).map(([tok, d]) => [d.name.toLowerCase(), tok]));
// guilds: { id: { name, tag, leader: token, members: [token] } }
const GSAVE = path.join(DATA_DIR, 'guilds.json');
let guilds = {};
try { guilds = JSON.parse(fs.readFileSync(GSAVE, 'utf8')); } catch { guilds = {}; }
function save() {
  if (!dirty) return;
  for (const p of players.values()) persist(p);
  fs.writeFileSync(SAVE + '.tmp', JSON.stringify(db));
  fs.renameSync(SAVE + '.tmp', SAVE);
  fs.writeFileSync(GSAVE + '.tmp', JSON.stringify(guilds));
  fs.renameSync(GSAVE + '.tmp', GSAVE);
  dirty = false;
}
function persist(p) {
  db[p.token] = { name: p.name, lvl: p.lvl, xp: p.xp, inv: p.inv, eq: p.eq, x: +p.x.toFixed(1), z: +p.z.toFixed(1), hair: p.hair, gold: p.gold, dia: p.dia, job: p.job, guild: p.guild, at: now() };
  if (p.admin) db[p.token].admin = true;
  if (p.title) db[p.token].title = p.title;
  dirty = true;
}
setInterval(save, 30000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { dirty = true; save(); process.exit(0); });

// ---------- monsters ----------
const grid = Array.from({ length: GRID * GRID }, () => new Set());
const cellOf = (x, z) => clamp(((x + WORLD) / CELL) | 0, 0, GRID - 1) + clamp(((z + WORLD) / CELL) | 0, 0, GRID - 1) * GRID;
function place(e) { const c = cellOf(e.x, e.z); if (c !== e.cell) { if (e.cell !== undefined) grid[e.cell].delete(e); grid[c].add(e); e.cell = c; } }
function near(x, z, r, fn) {
  const c0 = clamp(((x - r + WORLD) / CELL) | 0, 0, GRID - 1), c1 = clamp(((x + r + WORLD) / CELL) | 0, 0, GRID - 1);
  const r0 = clamp(((z - r + WORLD) / CELL) | 0, 0, GRID - 1), r1 = clamp(((z + r + WORLD) / CELL) | 0, 0, GRID - 1);
  for (let gz = r0; gz <= r1; gz++) for (let gx = c0; gx <= c1; gx++) for (const e of grid[gx + gz * GRID]) {
    if (Math.abs(e.x - x) <= r && Math.abs(e.z - z) <= r) fn(e);
  }
}
const monsters = new Map();
const deadMonsters = new Set();
let nextMid = 1;
function seeded(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function rollMonster(m) {
  const lvl = clamp(Math.round(zoneLevel(m.sx, m.sz) * rand(0.95, 1.05)), 1, MAX_LEVEL);
  const options = MTYPES.map((t, i) => i).filter((i) => MTYPES[i].from <= lvl);
  const ti = options.length > 1 && Math.random() < 0.35 ? options[options.length - 2] : options[options.length - 1];
  const T = MTYPES[ti], elite = Math.random() < 0.03;
  Object.assign(m, {
    type: ti, T, lvl, elite,
    maxHp: Math.round((40 + lvl * 12) * T.hp * (elite ? 3 : 1)),
    atk: (6 + lvl * 2.6) * T.atk * (elite ? 1.5 : 1),
    def: 1 + lvl * 1.2,
    x: m.sx, z: m.sz, state: 'idle', target: 0, cdT: 0, wanderT: rand(0, 4), tx: m.sx, tz: m.sz, face: 1, hits: new Map(), atkT: 0,
  });
  m.hp = m.maxHp;
  place(m);
}
{
  const r = seeded(20261105);
  while (monsters.size < SPAWNS) {
    // 40% of the monsters live in the first ring around town, so new players find them quickly
    let x, z;
    if (r() < 0.4) { const a = r() * Math.PI * 2, d = TOWN_R + 8 + 190 * Math.sqrt(r()); x = Math.cos(a) * d; z = Math.sin(a) * d; }
    else { x = (r() * 2 - 1) * (WORLD - 4); z = (r() * 2 - 1) * (WORLD - 4); }
    if (RW.townNear(x, z, 8)) continue;
    [x, z] = RW.free(x, z, 1.2);   // never spawn inside a tree or rock
    const m = { id: nextMid++, sx: x, sz: z };
    rollMonster(m);
    monsters.set(m.id, m);
  }
}
const inTown = (x, z) => !!RW.townAt(x, z);

// ---------- players ----------
const players = new Map();
let nextPid = 1;
function stats(p) {
  const J = JOBS[jobOf(p)];
  const s = { atk: 10 + p.lvl * 3, def: 2 + p.lvl * 1.5, maxHp: 100 + p.lvl * 20, maxMp: Math.round((50 + p.lvl * 2) * J.mp), crit: 5 + J.crit, speed: 6 + J.speed };
  for (const it of Object.values(p.eq)) if (it) for (const k in it.st) s[k] += it.st[k];
  s.atk = Math.round(s.atk * J.atk); s.def = Math.round(s.def * J.def); s.maxHp = Math.round(s.maxHp * J.hp);
  s.crit = Math.min(60, s.crit); s.speed = Math.min(9, s.speed);
  return s;
}
function look(p) { return [p.hair, p.eq.armor ? p.eq.armor.rar : -1, p.eq.weapon ? p.eq.weapon.rar : -1, p.eq.helm ? p.eq.helm.rar : -1, p.eq.wings ? p.eq.wings.style || 'villain' : '', p.eq.weapon ? wtOf(p.eq.weapon) : '', p.job].join(','); }
function sendMe(p) {
  const s = (p.st = stats(p));
  p.hp = Math.min(p.hp, s.maxHp); p.mp = Math.min(p.mp, s.maxMp);
  send(p, { t: 'me', admin: p.admin, lvl: p.lvl, xp: p.xp, need: p.lvl >= MAX_LEVEL ? 0 : xpNeed(p.lvl), hp: Math.ceil(p.hp), mp: Math.floor(p.mp), st: s, inv: p.inv, eq: p.eq, gold: p.gold, dia: p.admin ? -1 : p.dia, job: p.job });
}
function sys(p, text, kind = 'sys') { p.ev.push(['msg', kind, text]); }
function giveXp(p, amount) {
  if (p.lvl >= MAX_LEVEL) return;
  p.xp += amount;
  let up = 0;
  while (p.lvl < MAX_LEVEL && p.xp >= xpNeed(p.lvl)) { p.xp -= xpNeed(p.lvl); p.lvl++; up++; }
  if (p.lvl >= MAX_LEVEL) p.xp = 0;
  if (up) {
    p.st = stats(p); p.hp = p.st.maxHp;
    broadcastNear(p.x, p.z, ['lvl', p.id, p.lvl]);
    sys(p, `Naik ke level ${p.lvl}!`, 'up');
  }
}
function killMonster(m, killer) {
  m.state = 'dead'; m.hp = 0; m.respawnAt = now() + (m.elite ? 45000 : 12000);
  grid[m.cell].delete(m); m.cell = undefined;
  deadMonsters.add(m);
  broadcastNear(m.x, m.z, ['die', m.id]);
  let total = 0; for (const v of m.hits.values()) total += v;
  for (const [pid, dmg] of m.hits) {
    const p = players.get(pid);
    if (!p || Math.hypot(p.x - m.x, p.z - m.z) > 40) continue;
    const xp = Math.max(1, Math.floor(xpReward(m.lvl, p.lvl, m.elite) * (dmg / total)));
    const gold = Math.max(1, Math.floor((3 + m.lvl * 1.2) * (m.elite ? 5 : 1) * rand(0.8, 1.2) * (dmg / total)));
    giveXp(p, xp);
    p.gold += gold;
    p.ev.push(['xp', xp], ['gold', gold]);
    p.meDirty = true;
  }
  if (killer && Math.random() < (m.elite ? DIA_CHANCE_ELITE : DIA_CHANCE)) {
    killer.dia++; killer.ev.push(['dia', 1]); killer.meDirty = true;
    sys(killer, `💎 Beruntung! Kamu menemukan 1 Berlian (setara ${DIA_GOLD.toLocaleString('id-ID')} gold).`, 'up');
  }
  if (killer && (m.elite || Math.random() < 0.3)) {
    const item = makeItem(m.lvl, m.elite ? 4 : 1, JOBS[jobOf(killer)].w);
    if (killer.inv.length >= INV_MAX) sys(killer, 'Tas penuh, barang tidak bisa diambil. Jual barang yang tidak dipakai.', 'warn');
    else { killer.inv.push(item); killer.ev.push(['loot', item]); killer.meDirty = true; }
  }
  m.hits = new Map();
}
function hitMonster(p, m, mult) {
  const crit = Math.random() * 100 < p.st.crit;
  if (p.buffAtk > now()) mult *= 1.5;
  const amt = Math.round(damage(p.st.atk * mult, m.def, p.lvl) * (crit ? 1.8 : 1));
  m.hp -= amt;
  m.hits.set(p.id, (m.hits.get(p.id) || 0) + amt);
  if (m.state !== 'chase' || !players.has(m.target)) { m.state = 'chase'; m.target = p.id; }
  p.lastCombat = now();
  broadcastNear(m.x, m.z, ['dm', m.id, amt, crit ? 1 : 0]);
  if (m.hp <= 0) killMonster(m, p);
}
function hurtPlayer(p, m) {
  if (p.dead) return;
  const amt = Math.max(1, Math.round(damage(m.atk, p.st.def, m.lvl) * (p.buffGuard > now() ? 0.4 : 1)));
  p.hp -= amt; p.lastCombat = now();
  broadcastNear(p.x, p.z, ['dp', p.id, amt]);
  if (p.hp <= 0) {
    p.hp = 0; p.dead = true;
    sys(p, `Kamu dikalahkan oleh ${m.elite ? 'Raja ' : ''}${m.T.name} Lv ${m.lvl}.`, 'warn');
  }
  p.meDirty = true;
}
function aoe(p, x, z, r, mult, max = 12) {
  let n = 0;
  near(x, z, r + 1.5, (m) => { if (m.state !== 'dead' && Math.hypot(m.x - x, m.z - z) <= r + m.T.r && n++ < max) hitMonster(p, m, mult); });
}
function nearestMonster(p, r) {
  let best = null, bd = r;
  near(p.x, p.z, r + 1.5, (m) => { const d = Math.hypot(m.x - p.x, m.z - p.z) - m.T.r; if (m.state !== 'dead' && d < bd) { bd = d; best = m; } });
  return best;
}
// Returns false when the skill could not be used (then no mana or cooldown is spent)
function castSkill(p, job, n, tg) {
  const T = now();
  const need = (range) => {
    if (!tg) tg = nearestMonster(p, range);
    if (tg && Math.hypot(tg.x - p.x, tg.z - p.z) <= range + tg.T.r + 0.6) return true;
    sys(p, 'Tidak ada monster dalam jangkauan skill.', 'warn');
    return false;
  };
  let fx = p.x, fz = p.z;
  switch (job + n) {
    case 'swordsman0': aoe(p, p.x, p.z, 4, 1.8); break;
    case 'swordsman1': if (!need(3)) return false; fx = tg.x; fz = tg.z; hitMonster(p, tg, 3.5); break;
    case 'berserker0': aoe(p, p.x, p.z, 5, 2.4); break;
    case 'berserker1': p.buffAtk = T + 8000; sys(p, 'Amarah! Serangan +50% selama 8 detik.', 'up'); break;
    case 'tanker0':
      near(p.x, p.z, 8, (m) => { if (m.state !== 'dead' && Math.hypot(m.x - p.x, m.z - p.z) <= 7) { m.state = 'chase'; m.target = p.id; } });
      aoe(p, p.x, p.z, 6, 1.2, 16); break;
    case 'tanker1': p.buffGuard = T + 6000; sys(p, 'Benteng Baja! Kerusakan yang diterima -60% selama 6 detik.', 'up'); break;
    case 'archer0': if (!need(12)) return false; fx = tg.x; fz = tg.z; aoe(p, fx, fz, 3.5, 1.6, 10); break;
    case 'archer1': if (!need(12)) return false; fx = tg.x; fz = tg.z; hitMonster(p, tg, 3.2); break;
    case 'mage0': if (!need(11)) return false; fx = tg.x; fz = tg.z; aoe(p, fx, fz, 4, 2.4); break;
    case 'mage1':
      for (const q of players.values()) {
        if (q.dead || Math.hypot(q.x - p.x, q.z - p.z) > 6) continue;
        const h = Math.round(q.st.maxHp * 0.35);
        q.hp = Math.min(q.st.maxHp, q.hp + h); q.meDirty = true;
        broadcastNear(q.x, q.z, ['hl', q.id, h]);
      }
      break;
    default: return false;
  }
  broadcastNear(p.x, p.z, ['sk', p.id, job, n, +fx.toFixed(1), +fz.toFixed(1)]);
  return true;
}

// ---------- guilds ----------
const GUILD_COST = 1000, GUILD_MAX = 30;
const GNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_ ]{1,18}[A-Za-z0-9_]$/, TAG_RE = /^[A-Za-z0-9]{2,4}$/;
const guildOf = (p) => (p.guild && guilds[p.guild] ? guilds[p.guild] : null);
function onlineByToken(tok) { for (const q of players.values()) if (q.token === tok) return q; return null; }
function sendGuild(p) {
  const g = guildOf(p);
  send(p, {
    t: 'guild',
    g: g && { name: g.name, tag: g.tag, lead: g.leader === p.token, max: GUILD_MAX, members: g.members.map((tok) => { const q = onlineByToken(tok), d = q || db[tok] || {}; return [d.name || '?', d.lvl || 1, q ? 1 : 0, tok === g.leader ? 1 : 0, d.job || '']; }) },
    inv: [...p.ginv].filter(([gid]) => guilds[gid]).map(([gid, from]) => [gid, guilds[gid].name, guilds[gid].tag, from]),
  });
}
function guildChanged(g) { for (const tok of g.members) { const q = onlineByToken(tok); if (q) sendGuild(q); } }
function leaveGuild(tok, g, gid) {
  g.members = g.members.filter((x) => x !== tok);
  const q = onlineByToken(tok);
  if (q) { q.guild = ''; sendGuild(q); } else if (db[tok]) db[tok].guild = '';
  if (!g.members.length) delete guilds[gid];
  else { if (g.leader === tok) g.leader = g.members[0]; guildChanged(g); }
  dirty = true;
}
function guildAction(p, msg) {
  const g = guildOf(p), op = String(msg.op || '');
  const tell = (q, text) => q.ev.push(['msg', 'gd', text]);
  if (op === 'info') return sendGuild(p);
  if (op === 'create') {
    const name = String(msg.name || '').trim().replace(/\s+/g, ' '), tag = String(msg.tag || '').trim().toUpperCase();
    if (g) return sys(p, 'Kamu sudah punya guild.', 'warn');
    if (!GNAME_RE.test(name)) return sys(p, 'Nama guild 3–20 karakter: huruf, angka, spasi atau _.', 'warn');
    if (!TAG_RE.test(tag)) return sys(p, 'Tag guild 2–4 huruf/angka.', 'warn');
    if (Object.values(guilds).some((x) => x.name.toLowerCase() === name.toLowerCase() || x.tag === tag)) return sys(p, 'Nama atau tag guild itu sudah dipakai.', 'warn');
    if (p.gold < GUILD_COST) return sys(p, `Butuh ${GUILD_COST.toLocaleString('id-ID')} gold untuk membuat guild.`, 'warn');
    const gid = crypto.randomBytes(4).toString('hex');
    guilds[gid] = { name, tag, leader: p.token, members: [p.token] };
    p.gold -= GUILD_COST; p.guild = gid; p.ginv.clear(); p.meDirty = true; dirty = true;
    sys(p, `Guild [${tag}] ${name} berdiri! Undang temanmu dari menu Guild.`, 'up');
    return sendGuild(p);
  }
  if (op === 'invite') {
    if (!g) return;
    if (g.leader !== p.token) return sys(p, 'Hanya ketua guild yang bisa mengundang.', 'warn');
    const q = [...players.values()].find((x) => x.name.toLowerCase() === String(msg.to || '').trim().toLowerCase());
    if (!q) return sys(p, 'Pemain itu tidak sedang online.', 'warn');
    if (q.guild) return sys(p, `${q.name} sudah punya guild.`, 'warn');
    if (g.members.length >= GUILD_MAX) return sys(p, 'Guild sudah penuh.', 'warn');
    q.ginv.set(p.guild, p.name);
    tell(q, `${p.name} mengundangmu ke guild [${g.tag}] ${g.name}. Buka menu Guild untuk menerima.`);
    sendGuild(q);
    return sys(p, `Undangan terkirim ke ${q.name}.`);
  }
  if (op === 'accept' || op === 'decline') {
    const gid = String(msg.gid || ''), ng = guilds[gid];
    if (!p.ginv.has(gid)) return;
    p.ginv.delete(gid);
    if (op === 'decline' || !ng) return sendGuild(p);
    if (g) return sys(p, 'Keluar dulu dari guild lamamu.', 'warn');
    if (ng.members.length >= GUILD_MAX) { sendGuild(p); return sys(p, 'Guild itu sudah penuh.', 'warn'); }
    ng.members.push(p.token); p.guild = gid; p.ginv.clear(); dirty = true;
    for (const tok of ng.members) { const q = onlineByToken(tok); if (q) tell(q, `${p.name} bergabung dengan guild.`); }
    return guildChanged(ng);
  }
  if (op === 'leave') {
    if (!g) return;
    const gid = p.guild;
    leaveGuild(p.token, g, gid);
    for (const tok of g.members) { const q = onlineByToken(tok); if (q) tell(q, `${p.name} keluar dari guild.`); }
    return sys(p, 'Kamu keluar dari guild.');
  }
  if (op === 'kick') {
    if (!g || g.leader !== p.token) return;
    const tok = names.get(String(msg.name || '').trim().toLowerCase());
    if (!tok || tok === p.token || !g.members.includes(tok)) return;
    const q = onlineByToken(tok);
    if (q) tell(q, `Kamu dikeluarkan dari guild [${g.tag}] ${g.name}.`);
    leaveGuild(tok, g, p.guild);
    return sys(p, `${(db[tok] || q || {}).name} dikeluarkan dari guild.`);
  }
}

// ---------- simulation ----------
let lastTick = now();
function step(e, tx, tz, speed, dt) {
  const dx = tx - e.x, dz = tz - e.z, d = Math.hypot(dx, dz);
  if (d < 0.05) return 0;
  const s = Math.min(d, speed * dt);
  let nx = e.x + (dx / d) * s, nz = e.z + (dz / d) * s;
  [nx, nz] = RW.resolve(e.x, e.z, nx, nz, e.T.r * 0.8);   // walk around trees and rocks
  if (inTown(nx, nz)) return 0;
  e.x = nx; e.z = nz; if (Math.abs(dx) > 0.01) e.face = dx > 0 ? 1 : -1;
  place(e);
  return d - s;
}
function tick() {
  const t = now(), dt = Math.min(0.25, (t - lastTick) / 1000);
  lastTick = t;
  for (const m of deadMonsters) if (t >= m.respawnAt) { deadMonsters.delete(m); rollMonster(m); }

  const active = new Set();
  for (const p of players.values()) near(p.x, p.z, ACTIVE, (m) => active.add(m));
  for (const m of active) {
    if (m.state === 'dead') continue;
    m.cdT -= dt;
    let p = m.target ? players.get(m.target) : null;
    if (m.state === 'chase') {
      const leash = Math.hypot(m.x - m.sx, m.z - m.sz) > 32;
      if (!p || p.dead || inTown(p.x, p.z) || leash) { m.state = 'return'; m.target = 0; p = null; }
    }
    if (m.state === 'idle' && m.T.aggro) {
      let best = null, bd = 7;
      for (const q of players.values()) {
        if (q.dead || inTown(q.x, q.z)) continue;
        const d = Math.hypot(q.x - m.x, q.z - m.z);
        if (d < bd) { bd = d; best = q; }
      }
      if (best) { m.state = 'chase'; m.target = best.id; p = best; }
    }
    if (m.state === 'chase' && p) {
      const d = Math.hypot(p.x - m.x, p.z - m.z);
      if (d > m.T.range) step(m, p.x, p.z, m.T.speed, dt);
      else {
        if (Math.abs(p.x - m.x) > 0.01) m.face = p.x > m.x ? 1 : -1;
        if (m.cdT <= 0) { m.cdT = m.T.cd; m.atkT = t; hurtPlayer(p, m); }
      }
    } else if (m.state === 'return') {
      if (step(m, m.sx, m.sz, m.T.speed * 1.5, dt) <= 0.1) { m.state = 'idle'; m.hp = m.maxHp; m.hits = new Map(); }
    } else if (m.state === 'idle') {
      m.wanderT -= dt;
      if (m.wanderT <= 0) { m.wanderT = rand(3, 8); m.tx = m.sx + rand(-5, 5); m.tz = m.sz + rand(-5, 5); }
      step(m, m.tx, m.tz, m.T.speed * 0.4, dt);
    }
  }

  // bodies do not overlap: push monsters apart from each other and out of players
  for (const m of active) {
    if (m.state === 'dead') continue;
    let px = 0, pz = 0;
    near(m.x, m.z, 4, (o) => {
      if (o === m || o.state === 'dead') return;
      const dx = m.x - o.x, dz = m.z - o.z, d = Math.hypot(dx, dz), min = (m.T.r + o.T.r) * 0.9;
      if (d < min) { const k = (min - Math.max(d, 1e-3)) * 0.5, l = d || 1; px += (d ? dx / l : Math.random() - 0.5) * k; pz += (d ? dz / l : Math.random() - 0.5) * k; }
    });
    for (const q of players.values()) {
      if (q.dead) continue;
      const dx = m.x - q.x, dz = m.z - q.z, d = Math.hypot(dx, dz), min = m.T.r + 0.45;
      if (d < min && d > 1e-3) { px += dx / d * (min - d); pz += dz / d * (min - d); }
    }
    if (px || pz) {
      const [nx, nz] = RW.resolve(m.x, m.z, m.x + px, m.z + pz, m.T.r * 0.8);
      if (!inTown(nx, nz)) { m.x = nx; m.z = nz; place(m); }
    }
  }

  for (const p of players.values()) {
    if (!p.dead && p.hp < p.st.maxHp) {
      const town = inTown(p.x, p.z), calm = t - p.lastCombat > 6000;
      if (town || calm) { p.hp = Math.min(p.st.maxHp, p.hp + p.st.maxHp * (town ? 0.15 : 0.03) * dt); p.hpSend = true; }
    }
    if (!p.dead && p.mp < p.st.maxMp) p.mp = Math.min(p.st.maxMp, p.mp + p.st.maxMp * (inTown(p.x, p.z) ? 0.1 : 0.025) * dt);
  }

  for (const p of players.values()) {
    const ps = [], ms = [];
    for (const q of players.values()) {
      if (Math.abs(q.x - p.x) > VIEW || Math.abs(q.z - p.z) > VIEW) continue;
      ps.push([q.id, q.name, +q.x.toFixed(2), +q.z.toFixed(2), +q.dir.toFixed(2), Math.ceil(q.hp), q.st.maxHp, q.lvl, q.look, q.dead ? 1 : 0, t - q.atkT < 300 ? 1 : 0, q.title || '', q.admin ? 1 : 0, guildOf(q)?.tag || '']);
    }
    near(p.x, p.z, VIEW, (m) => {
      ms.push([m.id, m.type, +m.x.toFixed(2), +m.z.toFixed(2), Math.ceil(m.hp), m.maxHp, m.lvl, m.elite ? 1 : 0, m.face, t - m.atkT < 300 ? 1 : 0]);
    });
    const msg = { t: 's', p: ps, m: ms, hp: Math.ceil(p.hp), mp: Math.floor(p.mp) };
    if (p.ev.length) { msg.ev = p.ev; p.ev = []; }
    send(p, msg);
    if (p.meDirty) { p.meDirty = false; sendMe(p); }
  }
}
setInterval(tick, TICK_MS);

function broadcastNear(x, z, ev) {
  for (const p of players.values()) if (Math.abs(p.x - x) <= VIEW && Math.abs(p.z - z) <= VIEW) p.ev.push(ev);
}
let topCache = [];
function leaderboard() {
  for (const p of players.values()) persist(p);
  topCache = Object.values(db).sort((a, b) => b.lvl - a.lvl || b.xp - a.xp).slice(0, 10).map((d) => [d.name, d.lvl]);
  const msg = { t: 'top', top: topCache, online: players.size };
  for (const p of players.values()) send(p, msg);
}
setInterval(leaderboard, 10000);

// ---------- client messages ----------
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_ ]{1,14}[A-Za-z0-9_]$/;
const TOKEN_RE = /^[a-f0-9]{32}$/;
function onMessage(c, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg.t !== 'string') return;
  const p = c.player;
  if (!p) {
    if (msg.t === 'hello') return hello(c, msg);
    return;
  }
  const t = now();
  switch (msg.t) {
    case 'mv': {
      if (p.dead) return;
      const x = +msg.x, z = +msg.z;
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      // Movement budget: refills with walking speed and absorbs network jitter (bunched or late
      // packets), so honest players are never snapped back; only real speed hacks are refused.
      const cap = p.st.speed * 2 + 2;
      p.moveB = Math.min(cap, p.moveB + p.st.speed * 1.3 * ((t - p.moveT) / 1000));
      p.moveT = t;
      const nx = clamp(x, -WORLD, WORLD), nz = clamp(z, -WORLD, WORLD), d = Math.hypot(nx - p.x, nz - p.z);
      if (d > p.moveB + 0.6) send(p, { t: 'pos', x: p.x, z: p.z });
      else { p.x = nx; p.z = nz; p.moveB = Math.max(0, p.moveB - d); }
      if (Number.isFinite(+msg.d)) p.dir = +msg.d;
      return;
    }
    case 'atk': {
      const m = monsters.get(msg.id | 0), wt = JOBS[jobOf(p)].w, W = WTYPES[wt];
      if (p.dead || !m || m.state === 'dead' || t - p.atkT < W.delay - 80) return;
      if (Math.hypot(m.x - p.x, m.z - p.z) > W.range + m.T.r + 0.6) return;
      p.atkT = t;
      if (W.range > 4) broadcastNear(p.x, p.z, ['at', p.id, m.id, wt]);
      hitMonster(p, m, 1);
      return;
    }
    case 'skill': {
      const n = msg.n === 2 ? 1 : 0, job = jobOf(p), [cost, cd] = SKILLS[job][n];
      if (p.dead || t - p.skT[n] < cd - 150) return;
      const mp = (p.st.maxMp * cost) / 100;
      if (p.mp < mp) return sys(p, 'Mana tidak cukup.', 'warn');
      const m = monsters.get(msg.id | 0);
      if (!castSkill(p, job, n, m && m.state !== 'dead' ? m : null)) return;
      p.skT[n] = t; p.atkT = t; p.mp -= mp; p.lastCombat = t; p.meDirty = true;
      return;
    }
    case 'job': {
      const job = String(msg.job || '');
      if (!JOBS[job] || job === p.job) return;
      if (p.job && !inTown(p.x, p.z) && !p.admin) return sys(p, 'Ganti job hanya bisa di dalam kota.', 'warn');
      p.job = job;
      const want = JOBS[job].w, cur = p.eq.weapon;
      if (cur && wtOf(cur) !== want) { p.inv.push(cur); p.eq.weapon = null; }
      if (!p.eq.weapon) {
        // put on the best weapon from the bag that fits the new job
        let best = -1;
        p.inv.forEach((it, i) => { if (it.slot === 'weapon' && wtOf(it) === want && it.req <= p.lvl && (best < 0 || it.st.atk > p.inv[best].st.atk)) best = i; });
        if (best >= 0) p.eq.weapon = p.inv.splice(best, 1)[0];
      }
      p.st = stats(p); p.hp = Math.min(p.hp, p.st.maxHp); p.mp = Math.min(p.mp, p.st.maxMp);
      p.look = look(p); p.meDirty = true; dirty = true;
      return sys(p, `Job sekarang: ${JOBS[job].name}.`, 'up');
    }
    case 'travel': {
      const tw = RW.TOWNS.find((t) => t.id === msg.townId);
      if (tw) {
        p.x = tw.x; p.z = tw.z + 4; p.moveT = now(); p.moveB = 10;
        send(p, { t: 'pos', x: p.x, z: p.z });
        sys(p, `Tiba di ${tw.name} (${tw.subtitle}).`);
      }
      return;
    }
    case 'sell': {
      const ids = (Array.isArray(msg.ids) ? msg.ids : [msg.id]).slice(0, INV_MAX + 5);
      let sum = 0, n = 0;
      for (const id of ids) {
        const i = p.inv.findIndex((it) => it.id === id);
        if (i < 0) continue;
        sum += sellPrice(p.inv[i]); p.inv.splice(i, 1); n++;
      }
      if (!n) return;
      p.gold += sum; p.meDirty = true; dirty = true;
      return sys(p, `Terjual ${n} barang: +${sum.toLocaleString('id-ID')} gold.`, 'up');
    }
    case 'gift': {
      if (t - p.giftT < 1500) return sys(p, 'Tunggu sebentar sebelum mengirim hadiah lagi.', 'warn');
      const tok = names.get(String(msg.to || '').trim().toLowerCase());
      if (!tok || tok === p.token || !db[tok]) return sys(p, 'Pemain dengan nama itu tidak ditemukan.', 'warn');
      const q = onlineByToken(tok), d = q || db[tok];
      if (!d.inv) d.inv = [];
      let what;
      if (msg.dia != null) {
        const n = Math.floor(+msg.dia);
        if (!(n > 0) || n > 1e6 || !spendDia(p, n)) return sys(p, 'Berlian tidak cukup.', 'warn');
        d.dia = (d.dia || 0) + n;
        what = `${n.toLocaleString('id-ID')} berlian`;
      } else if (msg.gold != null) {
        const g = Math.floor(+msg.gold);
        if (!(g > 0) || g > p.gold) return sys(p, 'Gold tidak cukup.', 'warn');
        p.gold -= g; d.gold = (d.gold || 0) + g;
        what = `${g.toLocaleString('id-ID')} gold`;
      } else {
        const i = p.inv.findIndex((it) => it.id === msg.id);
        if (i < 0) return;
        if (d.inv.length >= INV_MAX) return sys(p, `Tas ${d.name} penuh.`, 'warn');
        const it = p.inv.splice(i, 1)[0];
        d.inv.push(it);
        what = it.name;
      }
      p.giftT = t; p.meDirty = true; dirty = true;
      sys(p, `🎁 Hadiah terkirim ke ${d.name}: ${what}.`, 'up');
      if (q) { q.meDirty = true; q.ev.push(['gift', p.name, what]); }
      else d.mail = [...(d.mail || []), `🎁 ${p.name} mengirim hadiah: ${what}`].slice(-20);
      return;
    }
    case 'ex': {
      // exchange at the market: buy = gold -> diamonds, sell = diamonds -> gold
      const n = Math.floor(+msg.n);
      if (!(n > 0) || n > 1e6) return;
      if (msg.dir === 'buy') {
        if (p.admin) return sys(p, 'Berlian admin sudah tak terbatas (∞).');
        if (p.gold < n * DIA_GOLD) return sys(p, 'Gold tidak cukup untuk membeli berlian.', 'warn');
        p.gold -= n * DIA_GOLD; p.dia += n;
        sys(p, `🏪 Membeli ${n.toLocaleString('id-ID')} berlian seharga ${(n * DIA_GOLD).toLocaleString('id-ID')} gold.`, 'up');
      } else {
        if (!spendDia(p, n)) return sys(p, 'Berlian tidak cukup.', 'warn');
        p.gold += n * DIA_GOLD;
        sys(p, `🏪 Menjual ${n.toLocaleString('id-ID')} berlian: +${(n * DIA_GOLD).toLocaleString('id-ID')} gold.`, 'up');
      }
      p.meDirty = true; dirty = true;
      return;
    }
    case 'g': return guildAction(p, msg);
    case 'respawn': {
      if (!p.dead) return;
      p.dead = false; p.hp = p.st.maxHp; p.mp = p.st.maxMp; p.moveB = 99;
      const a = Math.random() * Math.PI * 2;
      p.x = Math.cos(a) * 6; p.z = Math.sin(a) * 6; p.moveT = t;
      send(p, { t: 'pos', x: p.x, z: p.z });
      p.meDirty = true;
      return;
    }
    case 'equip': {
      const i = p.inv.findIndex((it) => it.id === msg.id);
      if (i < 0) return;
      const it = p.inv[i];
      if (p.lvl < it.req) return sys(p, `Butuh level ${it.req} untuk memakai ${it.name}.`, 'warn');
      if (it.slot === 'weapon' && wtOf(it) !== JOBS[jobOf(p)].w) {
        const fit = Object.values(JOBS).find((j) => j.w === wtOf(it));
        return sys(p, `${it.name} hanya bisa dipakai job ${fit ? fit.name : '-'}.`, 'warn');
      }
      p.inv.splice(i, 1);
      if (p.eq[it.slot]) p.inv.push(p.eq[it.slot]);
      p.eq[it.slot] = it;
      p.look = look(p); p.meDirty = true; dirty = true;
      return;
    }
    case 'unequip': {
      if (!['weapon', 'armor', 'helm', 'boots', 'ring', 'wings'].includes(msg.slot)) return;
      if (!p.eq[msg.slot]) return;
      const it = p.eq[msg.slot];
      if (!it) return;
      if (p.inv.length >= INV_MAX) return sys(p, 'Tas penuh.', 'warn');
      p.eq[msg.slot] = null; p.inv.push(it);
      p.look = look(p); p.meDirty = true; dirty = true;
      return;
    }
    case 'drop': {
      const i = p.inv.findIndex((it) => it.id === msg.id);
      if (i >= 0) { p.inv.splice(i, 1); p.meDirty = true; dirty = true; }
      return;
    }
    case 'chat': {
      const text = String(msg.text || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 140);
      if (!text || (!p.admin && t - p.chatT < 1000)) return;
      p.chatT = t;
      if (msg.ch === 'g' || text.startsWith('/g ')) {
        const g = guildOf(p), body = msg.ch === 'g' ? text : text.slice(3).trim();
        if (!g) return sys(p, 'Kamu belum punya guild.', 'warn');
        if (!body) return;
        for (const tok of g.members) { const q = onlineByToken(tok); if (q) q.ev.push(['chat', p.name, body, p.admin ? 1 : 0, 'g']); }
        return;
      }
      if (p.admin && text.startsWith('/')) return adminCommand(p, text);
      for (const q of players.values()) q.ev.push(['chat', p.name, text, p.admin ? 1 : 0]);
      return;
    }
  }
}
// Chat commands for admins (players with admin: true in the save file)
function adminCommand(p, text) {
  const [cmd, ...args] = text.slice(1).split(' ');
  const rest = args.join(' ').trim();
  const find = (n) => [...players.values()].find((q) => q.name.toLowerCase() === n.toLowerCase());
  switch (cmd.toLowerCase()) {
    case 'umum':
      if (!rest) return sys(p, 'Pakai: /umum <pesan>', 'warn');
      for (const q of players.values()) q.ev.push(['msg', 'up', `📢 ${p.name}: ${rest}`]);
      return;
    case 'tp': {
      const x = clamp(+args[0], -WORLD, WORLD), z = clamp(+args[1], -WORLD, WORLD);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return sys(p, 'Pakai: /tp <x> <z>, mis. /tp 0 -300', 'warn');
      p.x = x; p.z = z; p.moveT = now(); send(p, { t: 'pos', x, z });
      return sys(p, `Teleport ke ${Math.round(x)}, ${Math.round(z)} (monster Lv ${zoneLevel(x, z)}).`);
    }
    case 'kota': {
      const q = (rest || '').toLowerCase().trim();
      const target = q ? RW.TOWNS.find((t) => t.id === q || t.name.toLowerCase().includes(q)) : RW.TOWNS[0];
      if (!target) return sys(p, 'Kota tidak ditemukan. Pilih: ' + RW.TOWNS.map((t) => t.name).join(', '), 'warn');
      p.x = target.x; p.z = target.z + 4; p.moveT = now(); p.moveB = 10;
      send(p, { t: 'pos', x: p.x, z: p.z });
      return sys(p, `Tiba di ${target.name} (${target.subtitle}).`);
    }
    case 'ke': {
      const q = find(rest);
      if (!q) return sys(p, `Pemain "${rest}" tidak online.`, 'warn');
      p.x = q.x + 1.5; p.z = q.z; p.moveT = now(); send(p, { t: 'pos', x: p.x, z: p.z });
      return;
    }
    case 'pulih': p.dead = false; p.hp = p.st.maxHp; p.meDirty = true; return sys(p, 'HP penuh.');
    case 'kick': {
      const q = find(rest);
      if (!q || q === p) return sys(p, `Pemain "${rest}" tidak online.`, 'warn');
      q.conn.close(4002, 'Dikeluarkan oleh admin'); dropPlayer(q);
      return sys(p, `${q.name} dikeluarkan.`);
    }
    case 'online': return sys(p, 'Online: ' + [...players.values()].map((q) => `${q.name} (Lv ${q.lvl})`).join(', '));
    case 'berlian': {
      const n = Math.floor(+args[0]);
      if (!(n > 0) || n > 1e6) return sys(p, 'Pakai: /berlian <jumlah>, mis. /berlian 10', 'warn');
      p.dia += n; p.meDirty = true; dirty = true;
      return sys(p, `+${n.toLocaleString('id-ID')} berlian.`, 'up');
    }
    case 'gold': {
      const g = Math.floor(+args[0]);
      if (!(g > 0) || g > 1e9) return sys(p, 'Pakai: /gold <jumlah>, mis. /gold 10000', 'warn');
      p.gold += g; p.meDirty = true; dirty = true;
      return sys(p, `+${g.toLocaleString('id-ID')} gold.`, 'up');
    }
    default:
      return sys(p, 'Perintah admin: /umum <pesan>, /tp <x> <z>, /kota, /ke <nama>, /pulih, /kick <nama>, /online, /gold <jumlah>, /berlian <jumlah>. Semua pemain: /g <pesan> untuk chat guild.', 'up');
  }
}
function hello(c, msg) {
  const token = String(msg.token || '');
  if (!TOKEN_RE.test(token)) return c.send({ t: 'err', msg: 'Kode akun tidak valid.' });
  let d = db[token];
  if (!d) {
    const name = String(msg.name || '').trim().replace(/\s+/g, ' ');
    if (!name) return c.send({ t: 'err', code: 'nocode', msg: 'Kode akun tidak ditemukan. Ketik nama karaktermu lalu tekan "Masuk ke Dunia".' });
    if (!NAME_RE.test(name)) return c.send({ t: 'err', msg: 'Nama 3–16 karakter: huruf, angka, spasi atau _.' });
    const owner = names.get(name.toLowerCase());
    if (owner && db[owner] && db[owner].claim) {
      // One-time move of an account whose device lost its code (bug in the first client), to this device's code
      d = db[token] = db[owner]; delete db[owner]; delete d.claim;
      names.set(name.toLowerCase(), token); dirty = true;
    } else if (owner) return c.send({ t: 'err', msg: 'Nama itu sudah dipakai pemain lain.' });
  }
  if (!d) {
    const name = String(msg.name || '').trim().replace(/\s+/g, ' ');
    d = db[token] = { name, lvl: 1, xp: 0, inv: [], eq: { weapon: null, armor: null, helm: null, boots: null, ring: null, wings: null }, x: 0, z: 9, hair: (Math.random() * 8) | 0, gold: 0, job: '' };
    names.set(name.toLowerCase(), token);
    dirty = true;
  }
  for (const q of players.values()) if (q.token === token) { q.conn.close(4001, 'Masuk dari tempat lain'); dropPlayer(q); }
  // weapons from before jobs existed are one-handed swords
  for (const it of [...d.inv, d.eq.weapon]) if (it && it.slot === 'weapon' && !it.wt) it.wt = 'sword1';
  const g = d.guild && guilds[d.guild];
  const p = {
    id: nextPid++, conn: c, token, name: d.name, lvl: d.lvl, xp: d.xp, inv: d.inv, eq: d.eq, hair: d.hair ?? 0, admin: !!d.admin, title: typeof d.title === 'string' ? d.title.slice(0, 40) : '',
    gold: d.gold || 0, dia: d.dia || 0, job: JOBS[d.job] ? d.job : '', guild: g && g.members.includes(token) ? d.guild : '', ginv: new Map(),
    x: d.x, z: d.z, dir: 0, dead: false, atkT: 0, skT: [0, 0], buffAtk: 0, buffGuard: 0, chatT: 0, giftT: 0, moveT: now(), moveB: 99, lastCombat: 0, ev: [], meDirty: false,
  };
  if (!('wings' in p.eq)) p.eq.wings = null;
  p.st = stats(p); p.hp = p.st.maxHp; p.mp = p.st.maxMp; p.look = look(p);
  c.player = p;
  players.set(p.id, p);
  c.send({ t: 'welcome', id: p.id, name: p.name, x: p.x, z: p.z, top: topCache, online: players.size });
  sendMe(p);
  sendGuild(p);
  if (d.mail) { for (const text of d.mail) sys(p, text, 'up'); delete d.mail; dirty = true; }
  for (const q of players.values()) if (q !== p) sys(q, `${p.name} masuk ke dunia.`);
  if (p.guild) for (const tok of guilds[p.guild].members) { const q = onlineByToken(tok); if (q && q !== p) sendGuild(q); }
}
function dropPlayer(p) {
  if (!players.has(p.id)) return;
  persist(p);
  players.delete(p.id);
  for (const m of monsters.values()) if (m.target === p.id) { m.state = 'return'; m.target = 0; }
  const g = guildOf(p);
  if (g) guildChanged(g);
}

// ---------- minimal WebSocket server ----------
function send(p, obj) { p.conn.send(obj); }
const ipCount = new Map();
function wsAccept(req, socket) {
  const ip = String(req.headers['x-real-ip'] || socket.remoteAddress);
  const origin = req.headers.origin || '';
  const okOrigin = ORIGINS.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!okOrigin || (ipCount.get(ip) || 0) >= 6 || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  ipCount.set(ip, (ipCount.get(ip) || 0) + 1);
  let buf = Buffer.alloc(0), closed = false, budget = 60, budgetT = now();
  const c = {
    player: null,
    send(obj) {
      if (closed || socket.writableLength > 1 << 20) return;
      const data = Buffer.from(JSON.stringify(obj));
      const len = data.length;
      const head = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
      socket.write(Buffer.concat([head, data]));
    },
    close(code = 1000, reason = '') {
      if (closed) return;
      const r = Buffer.from(reason).subarray(0, 100);
      try { socket.end(Buffer.concat([Buffer.from([0x88, r.length + 2, code >> 8, code & 255]), r])); } catch {}
      finish();
    },
  };
  function finish() {
    if (closed) return;
    closed = true;
    ipCount.set(ip, Math.max(0, (ipCount.get(ip) || 1) - 1));
    if (c.player) dropPlayer(c.player);
  }
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 65536) return c.close(1009);
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) return c.close(1009);
      if (!masked || len > 4096) return c.close(1002);
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (!fin) return c.close(1003);
      if (op === 8) return c.close();
      if (op === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); continue; }
      if (op !== 1) continue;
      const t = now();
      budget = Math.min(60, budget + ((t - budgetT) / 1000) * 30); budgetT = t;
      if (--budget < -60) return c.close(1008, 'Terlalu banyak pesan');
      if (budget < 0) continue;
      try { onMessage(c, data.toString('utf8')); } catch (e) { console.error(e); }
    }
  });
  socket.on('close', finish);
  socket.on('error', finish);
}

const server = http.createServer((req, res) => {
  if (STATIC_DIR && req.url.split('?')[0] === '/realm/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(STATIC_DIR, 'index.html')).pipe(res);
  }
  const u = req.url.split('?')[0];
  if (ASSETS_DIR && u.startsWith('/realm/assets/')) {
    const f = path.resolve(ASSETS_DIR, decodeURIComponent(u.slice('/realm/assets/'.length)));
    if (!f.startsWith(path.resolve(ASSETS_DIR) + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': /\.(js|json)$/.test(f) ? 'no-cache' : 'max-age=3600' });
    return fs.createReadStream(f).pipe(res);
  }
  if (STATIC_DIR && u === '/realm/world.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    return fs.createReadStream(path.join(STATIC_DIR, 'world.js')).pipe(res);
  }
  if (req.url === '/realm/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, online: players.size })); }
  res.writeHead(404); res.end();
});
server.on('upgrade', (req, socket) => {
  if (req.url.split('?')[0] !== '/realm/ws') return socket.destroy();
  wsAccept(req, socket);
});
server.listen(PORT, HOST, () => { leaderboard(); console.log(`Karaya Realm server on ${HOST}:${PORT}, ${monsters.size} monsters`); });
