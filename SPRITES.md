# Sprite library: a guide for AI agents

All raw sheets in this folder were cut into separate sprites by `tools/slice_sprites.py`.
**Source of truth:** `assets/sprites.json` (141 entries). The same data, without frame lists, is in
`assets/sprites.js` (`window.SPRITES = {id: entry}`), which a browser game can load synchronously
with a `<script>` tag.

To see what exists, open the labelled contact sheets in `assets/preview/<category>.png`.

## Regenerating

```bash
python tools/slice_sprites.py
```

Needs Pillow, numpy and scipy. Deterministic; it rewrites `assets/`. `tools/detect.py <image>` prints
the bounding boxes it finds, which helps when you add a new sheet.

## Folder layout

| Path | Contents | For |
|---|---|---|
| `assets/atlas/<id>.png` | uniform-grid animation atlases (characters, monsters) and single monsters (max 220 px) | the game |
| `assets/world/<id>.png` | props and buildings, longest side max 512 px | the game |
| `assets/textures/<name>.png` | seamless 256 px ground textures (grass, dirt, cobble, water, plus a grey `detail_grass`) | the game |
| `assets/icons/icon_<weapon>.png` | 128 px UI weapon icons | the game UI |
| `assets/weapons/weapon_<type>.png` | held weapons, 256 px | the game |
| `assets/sprites/<category>/...` | every frame and object at **full source resolution** | editing, re-packing |
| `assets/preview/*.png` | contact sheets | looking things up |

## Conventions (also in `sprites.json > conventions`)

- **World (three.js):** Y is up and the ground is the XZ plane. 1 unit is about 1 m, and a player is about 2.3 units tall.
- **Anchor:** every sprite is `bottom-center`. In three.js set `sprite.center.set(0.5, 0)` and put `position` at the feet.
- **Size:** `world_height` is the suggested height. Width = height × (`cell[0]/cell[1]` or `size[0]/size[1]`).
- **Alpha:** hard 0/255 with no glow. Use `alphaTest: 0.5`; `NearestFilter` keeps the pixel art crisp.
- **Atlas UV:** `tex.repeat = (1/cols, 1/rows)`, `tex.offset = (col/cols, 1 - (row+1)/rows)`. To mirror:
  `repeat.x = -1/cols`, `offset.x = (col+1)/cols`.

## Animated sheets

| id | grid | rows | notes |
|---|---|---|---|
| `hero_male`, `hero_female` | 4×4 | 0 front, 1 left, 2 right, 3 back | walk = cols 0-3, idle = col 0. Female side rows were 3 frames, padded 0-1-2-1. No attack frames. |
| `slime`, `wolf`, `dragon` | 4×3 | 0 front, 1 side, 2 back | side art faces **left**, so mirror it for right |
| `goblin` | 4×3 | 0 front, 1 side, 2 back | side art faces **right** |

"front" means facing the camera. To pick a row, project the movement vector onto the camera's
forward and right axes (see `rowFor()` in `game/index.html`).

## Single-pose sprites (animate them in the engine: bob, squash, flip)

- **Monsters** (`monster_single`): `slime_single`, `wolf_single`, `dragon_young`, `ghost`, `goblin_single`,
  `skeleton`, `orc`, `bat`, `mushroom`, `dragon_elder`
- **Buildings:** `cottage`, `tavern`, `blacksmith`, `magic_shop`, `warehouse`, `castle_gate`, `house_large`, `shop_general`
- **Village props:** `market_stall`, `well`, `street_lamp`, `banner_blue`, `stone_pillar`, `crates_barrels`, `flower_arch`,
  `picket_fence`, `fence_wood_rail`, `flower_planter`, `signpost_lantern`, `bridge_wood`, plus isometric ground patches `tile_*_iso`
- **Nature:** trees (`tree_oak_big`, `tree_pine`, `tree_round`, `tree_pine_small`, `tree_oak_small`, `tree_stump`), bushes, rocks,
  flowers, grass, ferns, mushrooms, logs, cliffs, waterfall, bridges
- **Tileset ground squares** (`tileset_ground`): opaque top-down tiles. For a repeating ground, use `assets/textures/` instead.
- **Weapons:** `weapon_sword1|sword2|mace|bow|staff` (held; the `orientation` field says which way the art points),
  `icon_*` for the UI. `weapon_type` matches the game's weapon types.

## Recipes

**Animated character (THREE.Sprite):**
```js
const s = SPRITES.hero_male, tex = new THREE.TextureLoader().load(s.atlas);
tex.magFilter = THREE.NearestFilter; tex.repeat.set(1 / s.grid[0], 1 / s.grid[1]);
const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, alphaTest: 0.5 }));
sp.center.set(0.5, 0); sp.scale.set(s.world_height * s.cell[0] / s.cell[1], s.world_height, 1);
// each frame: tex.offset.set(col / 4, 1 - (row + 1) / 4)
```

**Thousands of props:** use one `InstancedMesh` per sprite id with a billboard vertex shader (`bbMaterial()`
in `game/index.html`). That costs one draw call per sprite type.

## Not used

`Gemini_Generated_Image_*.jfif` is a JPEG draft with a fake checkerboard. It duplicates the weapon sheets, so it was skipped.
