// Karaya Realm shared world layout + collision. Loaded by the client (<script src="world.js">) and by
// the server (import './world.js'), so trees, rocks, buildings and their blockers are identical on both.
// Exposes globalThis.RealmWorld.
(function (root) {
  'use strict';
  const WORLD = 600, TOWN_R = 28, MAX_LEVEL = 9999, TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  function zoneLevel(x, z) {
    const d = Math.hypot(x, z);
    if (d < TOWN_R) return 1;
    const t = Math.min(1, (d - TOWN_R) / (WORLD - TOWN_R));
    return clamp(Math.round(1 + (MAX_LEVEL - 1) * t ** 3), 1, MAX_LEVEL);
  }
  const BIOME_UPTO = [25, 220, 1100, 3600, 7200, 1e9], BIOME_KEEP = [0.3, 1, 0.12, 0.45, 0.25, 0.35];
  const biomeIndex = (lvl) => BIOME_UPTO.findIndex((u) => lvl <= u);
  function hash(x, z) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  function vnoise(x, z) {
    const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
    return lerp(lerp(hash(xi, zi), hash(xi + 1, zi), u), lerp(hash(xi, zi + 1), hash(xi + 1, zi + 1), u), v);
  }

  // ---- towns definition ----
  const TOWNS = [
    { id: 'karaya', name: 'Kota Karaya', subtitle: 'Ibukota Kerajaan', x: 0, z: 0, r: 28, lvl: 1, groundCol: 0xb3a48a, icon: '🏰' },
    { id: 'eldoria', name: 'Desa Eldoria', subtitle: 'Desa Hutan Rimba', x: -160, z: 110, r: 22, lvl: 100, groundCol: 0x8fa878, icon: '🌲' },
    { id: 'alzahra', name: 'Oase Al-Zahra', subtitle: 'Kota Gurun Senja', x: 180, z: -150, r: 24, lvl: 500, groundCol: 0xd4b87c, icon: '🌴' },
    { id: 'frostfall', name: 'Benteng Frostfall', subtitle: 'Benteng Tundra Beku', x: -260, z: -240, r: 24, lvl: 2500, groundCol: 0x98b6cc, icon: '❄️' },
    { id: 'ignis', name: 'Benteng Ignis', subtitle: 'Kastil Tanah Bara', x: 300, z: 280, r: 26, lvl: 5000, groundCol: 0x7c463a, icon: '🔥' },
  ];

  function townAt(x, z) {
    for (const tw of TOWNS) if (Math.hypot(x - tw.x, z - tw.z) < tw.r) return tw;
    return null;
  }
  function townNear(x, z, margin = 0) {
    for (const tw of TOWNS) if (Math.hypot(x - tw.x, z - tw.z) < tw.r + margin) return tw;
    return null;
  }
  function inTownGate(tw, x, z) {
    const dx = Math.abs(x - tw.x), dz = Math.abs(z - tw.z);
    return Math.hypot(dx, dz) < tw.r + 3.5 && Math.min(dx, dz) < 3.4;
  }

  function heightAt(x, z) {
    let minD = Math.hypot(x, z) - TOWN_R;
    for (const tw of TOWNS) {
      const d = Math.hypot(x - tw.x, z - tw.z) - tw.r;
      if (d < minD) minD = d;
    }
    const t = clamp(minD / 14, 0, 1), k = t * t * (3 - 2 * t);
    return ((vnoise(x * 0.025, z * 0.025) - 0.5) * 6 + (vnoise(x * 0.09 + 50, z * 0.09) - 0.5) * 1.2) * k;
  }
  function seeded(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

  // [sprite id, weight, tint] per biome: big = trees, rock = blockers on the ground, small = walk-through ground cover
  const BIODECOR = [
    { big: [['tree_oak_big', 3], ['tree_round', 2], ['tree_pine', 1]], rock: [['rock_medium', 2], ['rock_mossy', 2], ['pebbles', 2], ['log_hollow', 1]],
      small: [['flowers_pink', 2], ['flowers_white', 2], ['flowers_purple', 2], ['flowers_orange', 2], ['grass_a', 4], ['grass_b', 4], ['grass_c', 3], ['clover', 3], ['bush_round', 1], ['flower_bush', 1]] },
    { big: [['tree_pine', 4], ['tree_oak_big', 2], ['tree_pine_small', 2], ['tree_oak_small', 1]], rock: [['rock_mossy', 2], ['rock_cluster', 1], ['log_hollow', 1], ['tree_stump', 2]],
      small: [['fern_a', 3], ['fern_b', 3], ['fern_c', 2], ['fern_d', 2], ['mushroom_red', 2], ['mushroom_brown', 2], ['bush_a', 2], ['bush_b', 2], ['leafy_plant', 2], ['grass_a', 2]] },
    { big: [['tree_stump', 2, 0xd8b890], ['tree_round', 1, 0xc8b070]], rock: [['rock_cluster', 3, 0xf0d0a0], ['rock_big', 2, 0xf0d0a0], ['boulder', 2, 0xf0d0a0], ['rock_stack', 1, 0xf0d0a0]],
      small: [['reeds', 3, 0xe8d090], ['grass_small', 3, 0xe0c080], ['shrub_small', 2, 0xd0b070], ['stones_small', 2, 0xf0d0a0]] },
    { big: [['tree_pine', 4, 0xcfe2ee], ['tree_pine_small', 3, 0xd8eaf4]], rock: [['rock_big', 2, 0xe4eef8], ['boulder', 2, 0xe4eef8], ['rock_cluster', 1, 0xe4eef8]],
      small: [['grass_small', 2, 0xc8d8e0], ['stones_small', 2, 0xe4eef8], ['shrub_small', 1, 0xb8d0d8]] },
    { big: [['tree_pine', 2, 0x4a2a24], ['tree_stump', 2, 0x6a3a30]], rock: [['rock_big', 2, 0x7a4a44], ['rock_cluster', 2, 0x7a4a44], ['rock_stack', 1, 0x7a4a44]],
      small: [['grass_small', 2, 0xff8a50], ['stones_small', 2, 0x7a4a44], ['reeds', 1, 0xc05030]] },
    { big: [['tree_round', 2, 0xb98cff], ['tree_pine', 2, 0x9a7aff]], rock: [['rock_stack', 2, 0x9a80e0], ['boulder', 2, 0x9a80e0]],
      small: [['mushroom_red', 2, 0xc8a8ff], ['mushroom_brown', 1, 0xb090ff], ['flower_tiny_a', 2, 0xd0b0ff], ['fern_a', 1, 0xa080ff]] },
  ];
  // [default height (world units), blocker radius at that height (0 = walk through)]
  const PROP = {
    tree_oak_big: [8, 0.8], tree_round: [5.5, 0.6], tree_pine: [8.5, 0.65], tree_pine_small: [6, 0.5], tree_oak_small: [7, 0.65],
    tree_stump: [1.0, 0.55], rock_medium: [1.3, 0.9], rock_mossy: [1.4, 0.85], pebbles: [0.8, 0], log_hollow: [1.4, 1.0],
    rock_cluster: [2.6, 1.4], rock_big: [1.1, 1.0], boulder: [0.9, 0.75], rock_stack: [1.2, 1.1],
    tavern: [10.5, 4.0], blacksmith: [9.0, 3.4], magic_shop: [9.0, 3.3], shop_general: [7.6, 3.0], house_large: [8.6, 3.5],
    cottage: [7.6, 3.0], warehouse: [8.1, 3.4], market_stall: [3.4, 1.5], well: [3.4, 1.25], crates_barrels: [2.2, 1.0],
    flower_planter: [1.3, 0.8], street_lamp: [4.2, 0.3], banner_blue: [3.6, 0.3], banner_red: [3.4, 0.3],
    castle_gate: [9.5, 3.6], gate_tower_l: [9.5, 1.6], gate_tower_r: [9.5, 1.6], picket_fence: [1.8, 0],
  };
  function pick(list, r) {
    let tot = 0; for (const e of list) tot += e[1];
    let v = r * tot; for (const e of list) { v -= e[1]; if (v <= 0) return e; }
    return list[list.length - 1];
  }

  // ---- collision: static circles in a uniform grid ----
  const CELL = 8, GN = Math.ceil((WORLD * 2) / CELL), cells = new Map();
  const ckey = (x, z) => clamp(Math.floor((x + WORLD) / CELL), 0, GN - 1) + clamp(Math.floor((z + WORLD) / CELL), 0, GN - 1) * GN;
  function block(x, z, r) {
    if (r <= 0) return;
    const c = [x, z, r];
    for (let gx = Math.floor((x - r + WORLD) / CELL); gx <= Math.floor((x + r + WORLD) / CELL); gx++)
      for (let gz = Math.floor((z - r + WORLD) / CELL); gz <= Math.floor((z + r + WORLD) / CELL); gz++) {
        if (gx < 0 || gz < 0 || gx >= GN || gz >= GN) continue;
        const k = gx + gz * GN; if (!cells.has(k)) cells.set(k, []); cells.get(k).push(c);
      }
  }
  // gates in the fence: the four roads (|x| or |z| small)
  const GATE_HALF = 2.6, FENCE_PAD = 0.35;
  const inGate = (x, z) => inTownGate(TOWNS[0], x, z);
  // Move a body of radius r from (ox, oz) to (nx, nz); returns the corrected [x, z] (slides along blockers).
  function resolve(ox, oz, nx, nz, r) {
    let x = nx, z = nz;
    for (let it = 0; it < 3; it++) {
      const list = cells.get(ckey(x, z));
      let moved = false;
      if (list) for (const [cx, cz, cr] of list) {
        const dx = x - cx, dz = z - cz, d = Math.hypot(dx, dz), min = cr + r;
        if (d < min) {
          if (d < 1e-4) { x = cx + min; moved = true; continue; }
          x = cx + (dx / d) * min; z = cz + (dz / d) * min; moved = true;
        }
      }
      if (!moved) break;
    }
    // town fences: stay on the side you came from unless walking through a gate
    for (const tw of TOWNS) {
      const od = Math.hypot(ox - tw.x, oz - tw.z), d = Math.hypot(x - tw.x, z - tw.z), band = r + FENCE_PAD;
      if (!inTownGate(tw, x, z) && d > 1e-3 && (Math.abs(d - tw.r) < band || (od - tw.r) * (d - tw.r) < 0)) {
        const want = od < tw.r ? tw.r - band : tw.r + band;
        const dx = (x - tw.x) * (want / d), dz = (z - tw.z) * (want / d);
        x = tw.x + dx; z = tw.z + dz;
      }
    }
    return [clamp(x, -WORLD, WORLD), clamp(z, -WORLD, WORLD)];
  }
  const free = (x, z, r) => resolve(x, z, x, z, r);

  // ---- wilderness trees & rocks (deterministic) ----
  const wild = [];   // [id, x, z, height, tint]
  {
    const rnd = seeded(77), N = 7000;
    for (let i = 0; i < N; i++) {
      const x = (rnd() * 2 - 1) * (WORLD - 2), z = (rnd() * 2 - 1) * (WORLD - 2);
      if (townNear(x, z, 5)) continue;   // keep all town grounds completely clear of wild trees/rocks
      const bi = biomeIndex(zoneLevel(x, z)), D = BIODECOR[bi];
      let e, s;
      if (rnd() < 0.18) { e = pick(D.rock, rnd()); s = 0.7 + rnd() * 0.7; }
      else { if (rnd() > BIOME_KEEP[bi]) continue; e = pick(D.big, rnd()); s = 0.75 + rnd() * 0.5; }
      if (Math.min(Math.abs(x), Math.abs(z)) < 3.5 && Math.hypot(x, z) < TOWN_R + 40) continue;   // keep roads clear
      const P = PROP[e[0]];
      wild.push([e[0], x, z, P[0] * s, e[2] == null ? 0xffffff : e[2]]);
      block(x, z, P[1] * s);
    }
  }

  // ---- town layouts ----
  const town = [];   // [id, x, z, height, tint, faceAngle?]
  function put(id, x, z, h) { const P = PROP[id] || [2, 0]; h = h || P[0]; town.push([id, x, z, h, 0xffffff]); block(x, z, P[1] * h / P[0]); }

  // 1. Kota Karaya (Ibukota)
  block(0, 0, 3.6);   // fountain
  ['tavern', 'blacksmith', 'magic_shop', 'shop_general', 'house_large', 'cottage', 'warehouse', 'cottage'].forEach((id, i) => {
    const a = (i / 8) * TAU + TAU / 16, r = 19.5; put(id, Math.cos(a) * r, Math.sin(a) * r);
  });
  for (const [id, r, a] of [['market_stall', 11.5, 0.42], ['well', 11.5, 1.98], ['market_stall', 11.5, 3.55], ['crates_barrels', 11.5, 5.1],
    ['flower_planter', 8.5, 0.8], ['flower_planter', 8.5, 2.35], ['flower_planter', 8.5, 3.9], ['flower_planter', 8.5, 5.5]]) put(id, Math.cos(a) * r, Math.sin(a) * r);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU, ux = Math.round(Math.cos(a)), uz = Math.round(Math.sin(a)), nx = -uz, nz = ux;
    for (const s of [-1, 1]) {
      put('street_lamp', ux * 15 + nx * 3.2 * s, uz * 15 + nz * 3.2 * s);
      put(s > 0 ? 'banner_blue' : 'banner_red', ux * 7 + nx * 3.2 * s, uz * 7 + nz * 3.2 * s);
    }
    const gx = ux * (TOWN_R + 0.5), gz = uz * (TOWN_R + 0.5);
    if (uz !== 0) { put('gate_tower_l', gx - 3.6, gz); put('gate_tower_r', gx + 3.6, gz); }
    else { put('gate_tower_l', gx, gz - 3.6); put('gate_tower_r', gx, gz + 3.6); }
  }
  {
    const n = 110;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU, x = Math.cos(a) * TOWN_R, z = Math.sin(a) * TOWN_R;
      if (inTownGate(TOWNS[0], x, z) || Math.min(Math.abs(x), Math.abs(z)) < 4.4) continue;
      town.push(['picket_fence', x, z, PROP.picket_fence[0], 0xffffff]);
    }
  }

  // 2-5. Other towns layout
  TOWNS.slice(1).forEach((tw) => {
    const tx = tw.x, tz = tw.z, tr = tw.r;
    // Central feature
    if (tw.id === 'eldoria') { put('well', tx, tz); }
    else if (tw.id === 'alzahra') { block(tx, tz, 2.8); put('flower_planter', tx - 3, tz); put('flower_planter', tx + 3, tz); }
    else if (tw.id === 'frostfall') { block(tx, tz, 2.5); put('crates_barrels', tx - 2.5, tz); }
    else if (tw.id === 'ignis') { put('blacksmith', tx, tz); }

    // Ring of buildings
    const btypes = tw.id === 'eldoria'
      ? ['cottage', 'tavern', 'warehouse', 'house_large', 'cottage', 'shop_general']
      : ['house_large', 'blacksmith', 'tavern', 'magic_shop', 'warehouse', 'cottage', 'shop_general', 'cottage'];
    const nb = btypes.length, br = tr * 0.72;
    btypes.forEach((id, i) => {
      const a = (i / nb) * TAU + TAU / (nb * 2);
      put(id, tx + Math.cos(a) * br, tz + Math.sin(a) * br);
    });

    // Market stalls & lamps
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.4, mr = tr * 0.45;
      put('market_stall', tx + Math.cos(a) * mr, tz + Math.sin(a) * mr);
      put('crates_barrels', tx + Math.cos(a + 0.3) * mr, tz + Math.sin(a + 0.3) * mr);
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU, ux = Math.round(Math.cos(a)), uz = Math.round(Math.sin(a));
      put('street_lamp', tx + ux * (tr * 0.6), tz + uz * (tr * 0.6));
      put(tw.id === 'frostfall' ? 'banner_blue' : 'banner_red', tx + ux * (tr * 0.35), tz + uz * (tr * 0.35));
    }

    // Fence perimeter with 4 gates
    const fn = Math.round(tr * 3.8);
    for (let i = 0; i < fn; i++) {
      const a = (i / fn) * TAU, fx = tx + Math.cos(a) * tr, fz = tz + Math.sin(a) * tr;
      if (inTownGate(tw, fx, fz)) continue;
      town.push(['picket_fence', fx, fz, PROP.picket_fence[0], 0xffffff]);
    }
  });

  // Human NPCs in all towns
  const npcs = [
    // Kota Karaya (Ibukota Lembah Hijau)
    { id: 'npc_guide', name: 'Luna', title: 'Pemandu Karaya', townId: 'karaya', x: 2.8, z: -1.2, dir: 0, text: 'Selamat datang di Karaya Realm! Kalahkan monster di luar kota untuk naik level.' },
    { id: 'npc_guard', name: 'Kapten Sean', title: 'Penjaga Kota', townId: 'karaya', x: -2.2, z: -25.5, dir: 0, text: 'Waspadalah! Semakin jauh ke luar kota, monster akan semakin buas!' },
    { id: 'npc_guard', name: 'Ksatria Roland', title: 'Penjaga Gerbang', townId: 'karaya', x: 2.2, z: 25.5, dir: 3, text: 'Kota Karaya aman di bawah perlindungan kami.' },
    { id: 'npc_fighter', name: 'Bima', title: 'Instruktur Tempur', townId: 'karaya', x: -14.0, z: 8.5, dir: 2, text: 'Gunakan senjata dan skill Job-mu dengan tepat dalam pertarungan!' },

    // Desa Eldoria (Hutan Rimba)
    { id: 'npc_guide', name: 'Elena', title: 'Kepala Desa Eldoria', townId: 'eldoria', x: -157.5, z: 108.5, dir: 0, text: 'Selamat datang di Desa Eldoria. Hutan di sekitar sini dipenuhi Goblin dan Serigala buas!' },
    { id: 'npc_guard', name: 'Penjaga Robin', title: 'Pemburu Rimba', townId: 'eldoria', x: -162.2, z: 92.5, dir: 0, text: 'Pemanah sangat lincah dan mematikan di medan rimba ini.' },
    { id: 'npc_fighter', name: 'Bram', title: 'Pelatih Rimba', townId: 'eldoria', x: -172.0, z: 116.5, dir: 2, text: 'Kalahkan monster hutan untuk mengumpulkan bahan perlengkapan langka!' },

    // Oase Al-Zahra (Gurun Senja)
    { id: 'npc_guide', name: 'Putri Zahra', title: 'Penguasa Oase', townId: 'alzahra', x: 182.8, z: -151.2, dir: 0, text: 'Selamat datang di Oase Al-Zahra! Istirahatlah sejenak di dekat mata air oase yang sejuk.' },
    { id: 'npc_guard', name: 'Pengawal Malik', title: 'Penjaga Karavan', townId: 'alzahra', x: 177.8, z: -171.5, dir: 0, text: 'Badai pasir gurun menyembunyikan Arwah dan Orc Batu yang sangat berbahaya!' },
    { id: 'npc_fighter', name: 'Tariq', title: 'Ahli Pedang Gurun', townId: 'alzahra', x: 168.0, z: -143.5, dir: 2, text: 'Pertahanan yang kokoh dan perisai baja adalah kunci menaklukkan gurun.' },

    // Benteng Frostfall (Tundra Beku)
    { id: 'npc_guide', name: 'Jenderal Vane', title: 'Komandan Frostfall', townId: 'frostfall', x: -257.2, z: -241.5, dir: 0, text: 'Dinginnya salju Frostfall takkan memadamkan semangat petualang sejati!' },
    { id: 'npc_guard', name: 'Ksatria Kael', title: 'Pengawal Es', townId: 'frostfall', x: -262.2, z: -261.5, dir: 0, text: 'Tengkorak dan monster es berkeliaran di puncak gunung es utara!' },
    { id: 'npc_fighter', name: 'Ymir', title: 'Pandai Besi Salju', townId: 'frostfall', x: -272.0, z: -233.5, dir: 2, text: 'Pedang besar dan gada sangat ampuh menembus zirah monster beku!' },

    // Benteng Ignis (Tanah Bara)
    { id: 'npc_guide', name: 'Panglima Ignis', title: 'Penakluk Lahar', townId: 'ignis', x: 302.8, z: 278.5, dir: 0, text: 'Kau telah tiba di perbatasan Tanah Bara! Di depan sana terbentang Ujung Dunia!' },
    { id: 'npc_guard', name: 'Kapten Vulcan', title: 'Penjaga Gerbang Bara', townId: 'ignis', x: 297.8, z: 257.5, dir: 0, text: 'Waspadalah! Naga merah purba bersemayam di kawah lahar paling ujung!' },
    { id: 'npc_fighter', name: 'Master Ryu', title: 'Pendekar Api', townId: 'ignis', x: 288.0, z: 287.5, dir: 2, text: 'Keluarkan seluruh jurus pamungkasmu dan buktikan kehebatanmu!' },
  ];
  for (const n of npcs) block(n.x, n.z, 0.6);

  root.RealmWorld = { WORLD, TOWN_R, TOWNS, townAt, townNear, inTownGate, MAX_LEVEL, BIODECOR, PROP, zoneLevel, biomeIndex, hash, vnoise, heightAt, seeded, pick,
    wild, town, npcs, resolve, free, inGate };
})(typeof window !== 'undefined' ? window : globalThis);
