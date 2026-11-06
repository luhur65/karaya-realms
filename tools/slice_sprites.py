"""Slice the raw AI-generated sprite sheets in this folder into clean, game-ready sprites.

Run from the project root:   python tools/slice_sprites.py

Output (everything under assets/):
  assets/sprites/<category>/<id>/<frame>.png   one trimmed PNG per frame / object (full source resolution)
  assets/atlas/<id>.png                        uniform-grid atlas for animated sheets (characters, monsters)
  assets/textures/<name>.png                   seamless ground textures (grass, dirt, cobble, water...)
  assets/preview/<category>.png                labelled contact sheets so a human or AI can see what exists
  assets/sprites.json                          the machine-readable manifest (the single source of truth)

Cleaning rules: the sheets are RGBA but carry a soft coloured "glow" in low alpha; alpha < 128 is
dropped and the rest made fully opaque (crisp pixel-art edges). The Tileset sheet is opaque with a fake
grey/white checkerboard, which is keyed out (low saturation + bright). Each object is cut with its own
connected-component mask, so neighbours that overlap a bounding box do not leak in.
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

sys.path.insert(0, os.path.dirname(__file__))
from detect import components, rows_of  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'assets')
MANIFEST = {'version': 1, 'generated_by': 'tools/slice_sprites.py', 'conventions': {}, 'sprites': []}


# ----------------------------------------------------------------------------- helpers
def load(rel):
    return np.array(Image.open(os.path.join(ROOT, rel)).convert('RGBA'))


def checker_bg(rgba):
    rgb = rgba[..., :3].astype(int)
    mx, mn = rgb.max(-1), rgb.min(-1)
    return ((mx - mn) < 20) & (mx > 200)


def clean(rgba, keep):
    """Hard alpha (0/255) and zero RGB under transparent pixels (no dark fringes when filtered)."""
    out = rgba.copy()
    a = (out[..., 3] >= 128) & keep
    out[..., 3] = np.where(a, 255, 0)
    out[~a, :3] = 0
    return out


def trim(rgba):
    ys, xs = np.nonzero(rgba[..., 3])
    if len(xs) == 0:
        return rgba[:1, :1]
    return rgba[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def save(img, rel):
    p = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    (img if isinstance(img, Image.Image) else Image.fromarray(img)).save(p, optimize=True)
    return 'assets/' + rel.replace('\\', '/')


def cut_components(rgba, alpha_seg=160, dilate=6, min_area=800, grow=4, bg=None):
    """Return [(box, cleaned_trimmed_rgba)] grouped in rows (top->bottom, left->right)."""
    solid = rgba[..., 3] >= alpha_seg
    if bg is not None:
        solid &= ~bg
    boxes = components(solid, dilate, min_area)
    grown = ndi.binary_dilation(solid, iterations=dilate) if dilate else solid
    lab, _ = ndi.label(grown)
    rows = []
    for row in rows_of(boxes):
        r = []
        for (x0, y0, x1, y1, _) in row:
            sub = lab[y0:y1, x0:x1]
            ids, counts = np.unique(sub[sub > 0], return_counts=True)
            region = lab == ids[counts.argmax()]
            region = ndi.binary_dilation(region, iterations=grow)
            keep = region if bg is None else (region & ~bg)
            pad = grow + 2
            X0, Y0 = max(0, x0 - pad), max(0, y0 - pad)
            X1, Y1 = min(rgba.shape[1], x1 + pad), min(rgba.shape[0], y1 + pad)
            img = trim(clean(rgba[Y0:Y1, X0:X1], keep[Y0:Y1, X0:X1]))
            r.append(((x0, y0, x1 - x0, y1 - y0), img))
        rows.append(r)
    return rows


def cut_box(rgba, box, bg=None, raw=False):
    x, y, w, h = box
    sub = rgba[y:y + h, x:x + w]
    if raw:
        return sub.copy()
    keep = np.ones(sub.shape[:2], bool)
    if bg is not None:
        # key out the checkerboard AND its anti-aliased fringe: any light, grey-ish pixel that is
        # connected to the box border (interior greys are fenced off by the dark pixel-art outline)
        rgb = sub[..., :3].astype(int)
        light = ((rgb.max(-1) - rgb.min(-1)) < 28) & (rgb.max(-1) > 150)
        lab, _ = ndi.label(light | bg[y:y + h, x:x + w])
        border = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
        keep &= ~np.isin(lab, border[border > 0])
        # enclosed checkerboard holes (between fence rails / branches): big near-white blobs.
        # White flower petals are much smaller than one checker square, so they survive.
        # A checker hole holds both checker tones (~216 and ~248 grey); a petal is one shaded white.
        hole, n = ndi.label(light & (rgb.max(-1) > 195))
        mx = rgb.max(-1)
        for i in range(1, n + 1):
            m = hole == i
            k = int(m.sum())
            if k < 40:
                continue
            dark = ((mx[m] >= 205) & (mx[m] <= 226)).mean()
            bright = (mx[m] >= 240).mean()
            if dark > 0.15 and bright > 0.15:
                keep &= ~m
    # keep only the biggest blob (+ anything touching it) so neighbours' edges do not sneak in
    solid = (sub[..., 3] >= 128) & keep
    lab, n = ndi.label(ndi.binary_dilation(solid, iterations=3))
    if n > 1:
        sizes = ndi.sum(solid, lab, range(1, n + 1))
        keep &= lab == (1 + int(np.argmax(sizes)))
    return trim(clean(sub, keep))


def resize(img, f):
    im = Image.fromarray(img)
    if f == 1:
        return im
    return im.resize((max(1, round(im.width * f)), max(1, round(im.height * f))), Image.LANCZOS)


def build_atlas(frames, cols, rows, scale, size_rows=None):
    """frames: {(row, col): rgba}. Uniform cells, every frame bottom-centre anchored.
    size_rows: only these rows decide the cell size (bigger frames in other rows are cropped to fit)."""
    ims = {k: resize(v, scale) for k, v in frames.items()}
    ref = [i for (r, _), i in ims.items() if size_rows is None or r in size_rows]
    cw = max(i.width for i in ref) + 2
    ch = max(i.height for i in ref) + 2
    cw += cw % 2
    atlas = Image.new('RGBA', (cw * cols, ch * rows), (0, 0, 0, 0))
    for (r, c), im in ims.items():
        if im.width > cw or im.height > ch - 1:
            x0 = max(0, (im.width - cw) // 2)
            im = im.crop((x0, max(0, im.height - (ch - 1)), x0 + min(im.width, cw), im.height))
        atlas.alpha_composite(im, (c * cw + (cw - im.width) // 2, r * ch + ch - 1 - im.height))
    # resampling creates soft alpha again: re-harden for crisp sprites with alphaTest
    a = np.array(atlas)
    hard = a[..., 3] >= 110
    a[..., 3] = np.where(hard, 255, 0)
    a[~hard, :3] = 0
    return Image.fromarray(a), cw, ch


def add(entry):
    MANIFEST['sprites'].append(entry)
    return entry


# ----------------------------------------------------------------------------- characters
def characters():
    sheets = [
        ('hero_male', 'Lembar Sprite Petualang Pria RPG Pixel Art.png', 'Petualang pria rambut coklat, rompi kulit (pemain).'),
        ('hero_female', 'Lembar Sprite Petualang Berambut Kuncir.png', 'Petualang wanita rambut kuncir kuda, syal merah (pemain).'),
    ]
    for cid, src, desc in sheets:
        rows = cut_components(load(src), 160, 6, 800)
        assert len(rows) == 3, (cid, [len(r) for r in rows])
        front, side, back = rows
        half = len(side) // 2
        left, right = side[:half], side[half:]
        named = {'front': front, 'left': left, 'right': right, 'back': back}
        frames, files = {}, {}
        for ri, d in enumerate(['front', 'left', 'right', 'back']):
            seq = [img for _, img in named[d]]
            for i, img in enumerate(seq):
                files[f'{d}_{i}'] = save(img, f'sprites/characters/{cid}/{d}_{i}.png')
            if len(seq) == 3:          # 3-frame walk -> ping-pong to 4 so all rows share one layout
                seq = [seq[0], seq[1], seq[2], seq[1]]
            for c, img in enumerate(seq[:4]):
                frames[(ri, c)] = img
        scale = 150 / max(i.shape[0] for i in frames.values())
        # attack rows 4-7 (front/left/right/back): wind-up, strike, follow-through, recover
        for ri, d in enumerate(['front', 'left', 'right', 'back']):
            base = named[d][1 if d in ('left', 'right') else 0][1]
            for c, img in enumerate(attack_frames(base, d)):
                frames[(4 + ri, c)] = img
                files[f'attack_{d}_{c}'] = save(img, f'sprites/characters/{cid}/attack_{d}_{c}.png')
        atlas, cw, ch = build_atlas(frames, 4, 8, scale, size_rows={0, 1, 2, 3})
        add({
            'id': cid, 'category': 'character', 'description': desc, 'source': src,
            'atlas': save(atlas, f'atlas/{cid}.png'), 'cell': [cw, ch], 'grid': [4, 8],
            'anchor': 'bottom-center', 'world_height': 2.3,
            'rows': {'front': 0, 'left': 1, 'right': 2, 'back': 3,
                     'attack_front': 4, 'attack_left': 5, 'attack_right': 6, 'attack_back': 7},
            'anims': {'idle': {'cols': [0], 'fps': 1}, 'walk': {'cols': [0, 1, 2, 3], 'fps': 8},
                      'attack': {'cols': [0, 1, 2, 3], 'fps': 16, 'row_offset': 4}},
            'notes': 'Rows 0-3 walk (front=towards camera), rows 4-7 attack in the same direction order. '
                     'Attack frames are derived from the walk art (lean back -> lunge -> follow-through -> recover); '
                     'pair them with the held weapon sprite and fx_slash.',
            'frames': files,
        })


def attack_frames(img, d):
    """Wind-up, strike, follow-through, recover poses made from one walk frame (pivot = feet)."""
    im = Image.fromarray(img)
    if d in ('left', 'right'):
        fwd = -1 if d == 'left' else 1                 # screen direction the character faces
        poses = [(-7, -0.03, 1.0), (14, 0.07, 1.0), (9, 0.05, 1.0), (3, 0.015, 1.0)]   # (lean deg, shift, sy)
    else:
        poses = [(0, 0, 0.93), (0, 0, 1.05), (0, 0, 1.03), (0, 0, 1.0)]                 # crouch -> stretch
        fwd = 1
    out = []
    for lean, shift, sy in poses:
        f = im
        if sy != 1.0:
            f = f.resize((round(f.width * (2 - sy)), round(f.height * sy)), Image.NEAREST)
        if lean:
            # PIL rotates counter-clockwise; leaning forward to the right is clockwise
            pad = Image.new('RGBA', (f.width * 2, f.height * 2), (0, 0, 0, 0))
            pad.alpha_composite(f, (f.width // 2, f.height - f.height))   # feet at the pad centre row
            f = pad.rotate(-lean * fwd, resample=Image.NEAREST, center=(pad.width / 2, f.height))
            f = Image.fromarray(trim(np.array(f)))
        s = round(abs(shift) * im.height * 2)
        if s:   # move the body forward: pad the opposite side (frames are placed centred)
            g = Image.new('RGBA', (f.width + s, f.height), (0, 0, 0, 0))
            g.alpha_composite(f, (s if shift * fwd > 0 else 0, 0))
            f = g
        out.append(np.array(f))
    return out


# ----------------------------------------------------------------------------- monsters
def monsters():
    sheets = [
        # id, src, side faces, world height, description
        ('slime', 'all monster/slimes/Lembar Sprite Animasi Slime Hijau.png', 'left', 1.3, 'Slime hijau (lendir).'),
        ('wolf', 'all monster/wolf/Sprite Serigala Pixel 3x4 Animasi.png', 'left', 2.0, 'Serigala abu-abu.'),
        ('goblin', 'all monster/goblin/Lembar Sprite Goblin Pixel Art Isometrik.png', 'right', 2.0, 'Goblin hijau dengan gada kayu.'),
        ('dragon', 'all monster/dragon_bing/Lembar Sprite Naga Merah Pixel-Art.png', 'left', 4.2, 'Naga merah bersayap.'),
    ]
    for mid, src, faces, wh, desc in sheets:
        rows = cut_components(load(src), 160, 6, 800)
        assert len(rows) == 3 and all(len(r) == 4 for r in rows), (mid, [len(r) for r in rows])
        frames, files = {}, {}
        for ri, d in enumerate(['front', 'side', 'back']):
            for c, (_, img) in enumerate(rows[ri]):
                frames[(ri, c)] = img
                files[f'{d}_{c}'] = save(img, f'sprites/monsters/{mid}/{d}_{c}.png')
        scale = 200 / max(i.shape[0] for i in frames.values())
        atlas, cw, ch = build_atlas(frames, 4, 3, scale)
        add({
            'id': mid, 'category': 'monster', 'description': desc, 'source': src,
            'atlas': save(atlas, f'atlas/{mid}.png'), 'cell': [cw, ch], 'grid': [4, 3],
            'anchor': 'bottom-center', 'world_height': wh,
            'rows': {'front': 0, 'side': 1, 'back': 2}, 'side_faces': faces,
            'anims': {'idle': {'cols': [0], 'fps': 1}, 'walk': {'cols': [0, 1, 2, 3], 'fps': 7}},
            'notes': f'Side row is drawn facing {faces}; mirror it (repeat.x = -1/cols) for the other side.',
            'frames': files,
        })

    # single-pose bestiary sheet
    src = 'all monster/Koleksi Sprite Monster RPG Fantasi.png'
    names = [['slime_single', 'wolf_single', 'dragon_young', 'ghost', 'goblin_single'],
             ['skeleton', 'orc', 'bat', 'mushroom', 'dragon_elder']]
    heights = {'slime_single': 1.3, 'wolf_single': 2.0, 'dragon_young': 3.2, 'ghost': 2.4, 'goblin_single': 2.0,
               'skeleton': 2.4, 'orc': 3.0, 'bat': 1.6, 'mushroom': 1.5, 'dragon_elder': 5.0}
    faces = {'slime_single': 'front', 'wolf_single': 'left', 'dragon_young': 'left', 'ghost': 'front',
             'goblin_single': 'front', 'skeleton': 'front', 'orc': 'front', 'bat': 'front', 'mushroom': 'front',
             'dragon_elder': 'left'}
    rows = cut_components(load(src), 160, 6, 800)
    assert [len(r) for r in rows] == [5, 5], [len(r) for r in rows]
    for ri, row in enumerate(rows):
        for ci, (_, img) in enumerate(row):
            n = names[ri][ci]
            full = save(img, f'sprites/monsters/single/{n}.png')
            small = resize(img, min(1, 220 / max(img.shape[:2])))
            add({'id': n, 'category': 'monster_single', 'description': f'Monster 1 pose: {n}.', 'source': src,
                 'image': save(small, f'atlas/{n}.png'), 'image_full': full, 'size': list(small.size),
                 'anchor': 'bottom-center', 'world_height': heights[n], 'faces': faces[n],
                 'notes': 'Single pose: animate in-engine (bob / squash / flip).'})


# ----------------------------------------------------------------------------- world props
def props(src, cat, names, alpha_seg=240, dilate=1, min_area=3000, heights=None, skip_small=0):
    rows = cut_components(load(src), alpha_seg, dilate, min_area, grow=6)
    flat = [img for r in rows for _, img in r if img.shape[0] > skip_small]
    assert len(flat) == len(names), (src, len(flat), len(names))
    for n, img in zip(names, flat):
        if n is None:
            continue
        full = save(img, f'sprites/{cat}/{n}.png')
        small = resize(img, min(1, 512 / max(img.shape[:2])))
        add({'id': n, 'category': cat, 'source': src, 'image': save(small, f'world/{n}.png'), 'image_full': full,
             'size': list(small.size), 'anchor': 'bottom-center', 'world_height': (heights or {}).get(n, 2.0),
             'billboard': 'cylindrical'})


def world():
    H = {'house_large': 9, 'shop_general': 8, 'bridge_wood': 5, 'tree_oak_small': 7, 'tile_cobblestone_iso': 2.5,
         'tile_grass_iso': 2.5, 'tile_dirt_iso': 2.5, 'fence_wood_rail': 1.6, 'signpost_lantern': 3.2,
         'market_stall': 3.4, 'well': 3.4, 'street_lamp': 4.2, 'banner_blue': 3.6, 'stone_pillar': 2.6,
         'crates_barrels': 2.2, 'flower_arch': 4.0, 'picket_fence': 1.8, 'flower_planter': 1.3,
         'cottage': 8, 'tavern': 11, 'blacksmith': 9.5, 'magic_shop': 9.5, 'warehouse': 8.5, 'castle_gate': 12}
    props('tiles/Lembar Aset Desa Fantasi Isometrik.png', 'village',
          ['house_large', 'shop_general', 'bridge_wood', 'tree_oak_small',
           'tile_cobblestone_iso', 'tile_grass_iso', 'tile_dirt_iso', 'fence_wood_rail', 'signpost_lantern',
           'market_stall', 'well', 'street_lamp', 'banner_blue', 'stone_pillar', 'crates_barrels', 'flower_arch',
           'picket_fence', 'flower_planter'], heights=H)
    props('tiles/Koleksi Bangunan Fantasi Isometrik.png', 'buildings',
          ['cottage', 'tavern', 'blacksmith', 'magic_shop', 'warehouse', 'castle_gate'], heights=H)
    N = {'tree_oak_big': 8, 'tree_pine': 8.5, 'bush_round': 2.4, 'rock_cluster': 2.6, 'rock_medium': 1.3,
         'fence_wood_long': 1.8, 'flower_bush': 1.6, 'log_hollow': 1.4, 'rock_mossy': 1.4}
    props('tiles/Lembar Sprite Alam RPG Isometrik.png', 'nature',
          ['tree_oak_big', 'tree_pine', 'bush_round', 'rock_medium', 'rock_cluster', 'pebble_a', 'pebble_b', 'pebble_c',
           'fence_wood_long', 'flower_bush', 'log_hollow', 'rock_mossy', 'grass_tuft_a', 'grass_tuft_b',
           'flowers_pink', 'flowers_white', 'flowers_purple', 'flowers_orange', 'grass_a', 'grass_b', 'clover',
           'grass_c', 'pebbles', 'leafy_plant'],
          alpha_seg=160, dilate=4, min_area=1500,
          heights={**N, **{k: 0.8 for k in ['pebble_a', 'pebble_b', 'pebble_c', 'grass_tuft_a', 'grass_tuft_b', 'grass_a',
                                            'grass_b', 'clover', 'grass_c', 'pebbles', 'leafy_plant']},
                   **{k: 0.9 for k in ['flowers_pink', 'flowers_white', 'flowers_purple', 'flowers_orange']}})


def tileset():
    src = 'Tileset RPG Fantasi Pixel Art.png'
    rgba = load(src)
    bg = checker_bg(rgba)
    ground = {  # name: (box, inset) -> seamless texture made from the tile interior
        'grass': ((13, 15, 187, 186), 34), 'grass_flowers': ((211, 15, 177, 184), 12),
        'dirt': ((398, 15, 178, 185), 40), 'cobble': ((774, 17, 175, 185), 10),
        'cobble_mossy': ((959, 14, 180, 185), 10), 'water': ((1151, 17, 180, 182), 8),
    }
    for n, (box, inset) in ground.items():
        x, y, w, h = box
        tile = rgba[y + inset:y + h - inset, x + inset:x + w - inset].copy()
        tile[..., 3] = 255
        t = Image.fromarray(tile)
        # mirror-tile: 2x2 of (t, flipX, flipY, flipXY) is always seamless
        tw, th = t.size
        s = Image.new('RGBA', (tw * 2, th * 2))
        s.paste(t, (0, 0)); s.paste(t.transpose(Image.FLIP_LEFT_RIGHT), (tw, 0))
        s.paste(t.transpose(Image.FLIP_TOP_BOTTOM), (0, th)); s.paste(t.transpose(Image.ROTATE_180), (tw, th))
        s = s.resize((256, 256), Image.LANCZOS)
        add({'id': 'tex_' + n, 'category': 'texture', 'source': src, 'image': save(s, f'textures/{n}.png'),
             'size': [256, 256], 'wrap': 'repeat', 'notes': 'Seamless (mirror-tiled). Use as RepeatWrapping ground texture.'})
        if n == 'grass':
            # neutral grey "detail" version: multiply it with any biome vertex colour (mean 0.8)
            g = np.array(s.convert('L')).astype(float)
            g = 0.8 + (g - g.mean()) / (g.std() + 1e-6) * 0.055
            d = Image.fromarray((np.clip(g, 0, 1) * 255).astype(np.uint8)).convert('RGBA')
            add({'id': 'tex_detail_grass', 'category': 'texture', 'source': src,
                 'image': save(d, 'textures/detail_grass.png'), 'size': [256, 256], 'wrap': 'repeat',
                 'notes': 'Grey detail map (mean 0.8). Multiply with vertex colours; scale colours by 1/0.8.'})
    T = [  # name, box, world height, raw (no keying)
        ('ground_grass', (13, 15, 187, 186), 0, True), ('ground_grass_flowers', (211, 15, 177, 184), 0, True),
        ('ground_dirt_a', (398, 15, 178, 185), 0, True), ('ground_dirt_b', (584, 16, 178, 185), 0, True),
        ('ground_cobble_a', (774, 17, 175, 185), 0, True), ('ground_cobble_b', (959, 14, 180, 185), 0, True),
        ('ground_water_a', (1151, 17, 180, 182), 0, True), ('ground_water_b', (1342, 16, 180, 183), 0, True),
        ('ground_grass_bushes', (13, 209, 186, 183), 0, True), ('ground_grass_rock', (211, 209, 177, 183), 0, True),
        ('ground_dirt_c', (398, 209, 177, 183), 0, True), ('ground_dirt_d', (585, 210, 177, 183), 0, True),
        ('ground_cobble_c', (774, 209, 175, 183), 0, True), ('ground_cobble_d', (960, 210, 179, 182), 0, True),
        ('ground_water_shore_a', (1151, 210, 180, 182), 0, True), ('ground_water_shore_b', (1342, 210, 181, 183), 0, True),
        ('ground_water_deep', (1161, 403, 169, 262), 0, True), ('waterfall', (1340, 403, 182, 262), 3.5, True),
        ('bridge_plank_long', (13, 405, 291, 193), 1.2, False), ('bridge_plank_mid', (326, 408, 213, 190), 1.2, False),
        ('bridge_plank_short', (554, 407, 185, 193), 1.2, False), ('cliff_grass', (761, 404, 186, 188), 2.0, False),
        ('cliff_dirt', (959, 404, 188, 187), 2.0, False), ('cliff_small', (1050, 602, 98, 127), 1.6, False),
        ('rock_big', (22, 639, 115, 85), 1.1, False), ('rock_mossy_a', (161, 652, 81, 65), 0.8, False),
        ('rock_mossy_b', (305, 639, 83, 70), 0.8, False), ('bush_a', (417, 635, 104, 94), 1.1, False),
        ('bush_b', (539, 636, 83, 96), 1.1, False), ('flowers_orange_small', (644, 651, 85, 81), 0.8, False),
        ('tree_round', (748, 614, 162, 246), 5.5, False), ('tree_pine_small', (895, 614, 153, 247), 6.0, False),
        ('rock_stack', (16, 757, 138, 102), 1.2, False), ('flowers_white_small', (186, 759, 90, 98), 0.8, False),
        ('flowers_yellow_a', (304, 763, 84, 92), 0.8, False), ('flowers_yellow_b', (416, 770, 86, 88), 0.8, False),
        ('flowers_purple_small', (531, 758, 98, 104), 0.8, False), ('flowers_yellow_c', (650, 763, 85, 95), 0.8, False),
        ('tree_stump', (1053, 763, 98, 95), 1.0, False), ('fence_short', (1177, 763, 153, 89), 1.2, False),
        ('lamp_post', (1351, 715, 64, 182), 3.2, False), ('banner_red', (1436, 709, 85, 188), 3.2, False),
        ('boulder', (25, 894, 85, 79), 0.9, False), ('stones_small', (137, 907, 52, 67), 0.6, False),
        ('stone_c', (215, 906, 53, 50), 0.5, False), ('stone_d', (291, 916, 41, 35), 0.4, False),
        ('mushroom_red', (363, 905, 47, 57), 0.6, False), ('mushroom_brown', (431, 899, 59, 74), 0.7, False),
        ('flower_tiny_a', (540, 909, 51, 51), 0.5, False), ('flower_tiny_b', (603, 909, 41, 51), 0.5, False),
        ('flower_tiny_c', (658, 908, 44, 53), 0.5, False), ('fern_a', (715, 887, 82, 82), 0.8, False),
        ('fern_b', (812, 892, 73, 77), 0.8, False), ('fern_c', (903, 890, 70, 82), 0.8, False),
        ('fern_d', (991, 891, 69, 79), 0.8, False), ('signpost', (1110, 876, 79, 91), 1.4, False),
        ('reeds', (1213, 904, 92, 70), 0.8, False), ('grass_small', (1316, 924, 104, 49), 0.5, False),
        ('shrub_small', (1428, 909, 69, 65), 0.7, False),
    ]
    for n, box, wh, raw in T:
        x, y, w, h = box
        pad = 0 if raw else 4
        b2 = (max(0, x - pad), max(0, y - pad), w + 2 * pad, h + 2 * pad)
        img = cut_box(rgba, b2, None if raw else bg, raw)
        full = save(img, f'sprites/tileset/{n}.png')
        e = {'id': n, 'category': 'tileset_ground' if n.startswith('ground_') else 'tileset_prop', 'source': src,
             'image': full, 'size': [img.shape[1], img.shape[0]], 'anchor': 'bottom-center'}
        if wh:
            e['world_height'] = wh
            e['billboard'] = 'cylindrical'
        else:
            e['notes'] = 'Top-down square ground tile (opaque). For a repeating ground use assets/textures/*.'
        add(e)


# ----------------------------------------------------------------------------- weapons
def weapons():
    icon_src = 'Lembar Ikon Senjata RPG Fantasi.png'
    rgba = load(icon_src)
    for x0, y0, x1, y1 in [(50, 450, 400, 515), (515, 450, 925, 515), (1085, 450, 1465, 515),
                           (170, 905, 530, 975), (920, 905, 1245, 975)]:
        rgba[y0:y1, x0:x1, 3] = 0          # erase the text-label banners under each icon
    rows = cut_components(rgba, 240, 1, 3000, grow=6)
    items = [img for r in rows for _, img in r if img.shape[0] > 90]   # drop the text labels
    names = ['icon_sword1', 'icon_sword2', 'icon_mace', 'icon_shield', 'icon_bow', 'icon_staff']
    assert len(items) == len(names), len(items)
    wt = {'icon_sword1': 'sword1', 'icon_sword2': 'sword2', 'icon_mace': 'mace', 'icon_shield': 'mace',
          'icon_bow': 'bow', 'icon_staff': 'staff'}
    for n, img in zip(names, items):
        small = resize(img, min(1, 128 / max(img.shape[:2])))
        add({'id': n, 'category': 'weapon_icon', 'source': icon_src, 'weapon_type': wt[n],
             'image': save(small, f'icons/{n}.png'), 'image_full': save(img, f'sprites/weapons/{n}.png'),
             'size': list(small.size), 'notes': 'UI icon (inventory / shop / job picker).'})
    singles = [  # id, file, weapon type, how the art is oriented
        ('weapon_sword1', 'weapons/Pedang Pixel Perak dengan Permata Emas.png', 'sword1', 'diagonal, tip up-right'),
        ('weapon_sword2', 'weapons/Pedang Besar Gotik Berpermata Rubi.png', 'sword2', 'diagonal, tip up-right'),
        ('weapon_mace', 'weapons/Gada Berduri Baja Fantasi.png', 'mace', 'diagonal, head up-right'),
        ('weapon_bow', 'weapons/Busur Fantasi dengan Anak Panah Nocked.png', 'bow', 'vertical bow, arrow points left'),
        ('weapon_staff', 'weapons/Tongkat Kristal Biru Ajaib.png', 'staff', 'vertical, crystal on top'),
    ]
    for n, f, w, orient in singles:
        rgba = load(f)
        img = trim(clean(rgba, np.ones(rgba.shape[:2], bool)))
        small = resize(img, min(1, 256 / max(img.shape[:2])))
        add({'id': n, 'category': 'weapon', 'source': f, 'weapon_type': w, 'orientation': orient,
             'image': save(small, f'weapons/{n}.png'), 'image_full': save(img, f'sprites/weapons/{n}.png'),
             'size': list(small.size), 'notes': 'Held-weapon / swing-effect sprite (rotate in-engine).'})


def gate_towers():
    """Split castle_gate into its two towers, so east/west road gates can stand on both sides of a road
    that runs across the screen (a single billboard would point the wrong way there)."""
    g = np.array(Image.open(os.path.join(OUT, 'sprites/buildings/castle_gate.png')).convert('RGBA'))
    w = g.shape[1]
    for n, (a, b) in {'gate_tower_l': (0, int(w * 0.37)), 'gate_tower_r': (int(w * 0.63), w)}.items():
        img = trim(g[:, a:b].copy())
        small = resize(img, min(1, 512 / max(img.shape[:2])))
        add({'id': n, 'category': 'buildings', 'source': 'tiles/Koleksi Bangunan Fantasi Isometrik.png',
             'image': save(small, f'world/{n}.png'), 'image_full': save(img, f'sprites/buildings/{n}.png'),
             'size': list(small.size), 'anchor': 'bottom-center', 'world_height': 9.5, 'billboard': 'cylindrical',
             'notes': 'One tower of castle_gate; place one on each side of a road.'})


def effects():
    """Procedural pixel-art combat effects in the same palette: slash arc, hit spark, arrow."""
    S = 48   # drawn at 48 px, scaled x2 with nearest -> chunky pixels like the sprites
    yy, xx = np.mgrid[0:S, 0:S] + 0.5
    cx, cy = S / 2, S / 2
    r = np.hypot(xx - cx, yy - cy)
    ang = np.degrees(np.arctan2(-(yy - cy), xx - cx))          # 0 = right, 90 = up
    frames = []
    for i, (a_end, width, alpha) in enumerate([(30, 4, 1), (-30, 6, 1), (-80, 6, 1), (-110, 3, 0.7)]):
        a_start = 120
        im = np.zeros((S, S, 4), np.uint8)
        sweep = (ang <= a_start) & (ang >= a_end)
        t = np.clip((ang - a_end) / max(1, a_start - a_end), 0, 1)            # 0 at the leading edge
        w = width * (1 - t) + 1
        band = sweep & (np.abs(r - 18) < w)
        core = sweep & (np.abs(r - 18) < w * 0.45)
        im[band] = (120, 220, 255, 255)
        im[core] = (255, 255, 255, 255)
        edge = sweep & (np.abs(r - 18) >= w) & (np.abs(r - 18) < w + 1.2)
        im[edge] = (40, 90, 200, 255)
        if alpha < 1:
            im[(xx.astype(int) + yy.astype(int)) % 2 == 0] = 0                 # dither-out fade
        frames.append(im)
    strip = Image.new('RGBA', (S * 2 * 4, S * 2), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        strip.alpha_composite(Image.fromarray(f).resize((S * 2, S * 2), Image.NEAREST), (i * S * 2, 0))
    add({'id': 'fx_slash', 'category': 'effect', 'atlas': save(strip, 'atlas/fx_slash.png'), 'cell': [S * 2, S * 2],
         'grid': [4, 1], 'anchor': 'center', 'world_height': 2.4,
         'notes': 'Slash arc sweeping clockwise from upper-left to lower-right (a right-facing swing). Mirror for left.'})
    S2 = 32
    yy, xx = np.mgrid[0:S2, 0:S2] + 0.5
    r = np.hypot(xx - S2 / 2, yy - S2 / 2)
    ang = np.arctan2(yy - S2 / 2, xx - S2 / 2)
    ray = np.abs(np.cos(ang * 4)) ** 6                                           # 8 spikes
    hit = Image.new('RGBA', (S2 * 2 * 4, S2 * 2), (0, 0, 0, 0))
    for i, rad in enumerate([5, 9, 12, 14]):
        f = np.zeros((S2, S2, 4), np.uint8)
        reach = rad * (0.45 + 0.55 * ray)
        f[r < reach] = (255, 170, 60, 255)
        f[r < reach * 0.65] = (255, 230, 120, 255)
        f[r < reach * 0.35] = (255, 255, 255, 255)
        if i >= 2:
            f[r < rad * (0.5 if i == 2 else 0.8)] = 0                            # hollow out as it fades
        hit.alpha_composite(Image.fromarray(f).resize((S2 * 2, S2 * 2), Image.NEAREST), (i * S2 * 2, 0))
    add({'id': 'fx_hit', 'category': 'effect', 'atlas': save(hit, 'atlas/fx_hit.png'), 'cell': [S2 * 2, S2 * 2],
         'grid': [4, 1], 'anchor': 'center', 'world_height': 1.4, 'notes': 'Impact spark, 4 frames (play at ~20 fps).'})
    # arrow drawn in the palette of weapon_bow: wooden shaft, steel head, white fletching, dark outline
    arr = np.zeros((9, 40, 4), np.uint8)
    put = lambda x0, x1, y0, y1, c: arr.__setitem__((slice(y0, y1), slice(x0, x1)), c)
    put(6, 31, 4, 5, (176, 104, 48, 255))                          # shaft
    for i in range(5):                                              # head (tip points right)
        put(31 + i, 32 + i, 4 - (4 - i) // 2, 5 + (4 - i) // 2, (210, 214, 224, 255))
    put(36, 38, 4, 5, (240, 244, 250, 255))
    for i in range(6):                                              # fletching
        put(i, i + 1, 1 + i // 3, 4, (240, 236, 228, 255)); put(i, i + 1, 5, 8 - i // 3, (240, 236, 228, 255))
    outline = ndi.binary_dilation(arr[..., 3] > 0) & (arr[..., 3] == 0)
    arr[outline] = (34, 24, 40, 255)
    arr = np.array(Image.fromarray(arr).resize((arr.shape[1] * 3, arr.shape[0] * 3), Image.NEAREST))
    small = Image.fromarray(trim(arr))
    add({'id': 'fx_arrow', 'category': 'effect', 'image': save(small, 'atlas/fx_arrow.png'), 'size': list(small.size),
         'anchor': 'center', 'world_height': 0.35, 'notes': 'Flying arrow, tip points right (rotate in-engine).'})


# ----------------------------------------------------------------------------- previews
def previews():
    by = {}
    for s in MANIFEST['sprites']:
        by.setdefault(s['category'], []).append(s)
    for cat, items in by.items():
        thumbs = []
        for s in items:
            p = os.path.join(ROOT, (s.get('atlas') or s['image']))
            im = Image.open(p).convert('RGBA')
            im.thumbnail((360 if 'atlas' in s else 160, 260 if 'atlas' in s else 160))
            thumbs.append((s['id'], im))
        cw = max(t.width for _, t in thumbs) + 16
        chh = max(t.height for _, t in thumbs) + 30
        cols = max(1, min(len(thumbs), 1400 // cw))
        rows = (len(thumbs) + cols - 1) // cols
        sheet = Image.new('RGBA', (cols * cw, rows * chh), (58, 74, 64, 255))
        d = ImageDraw.Draw(sheet)
        for i, (n, t) in enumerate(thumbs):
            x, y = (i % cols) * cw, (i // cols) * chh
            sheet.alpha_composite(t, (x + (cw - t.width) // 2, y + 4))
            d.text((x + 6, y + chh - 22), n, fill=(255, 255, 255, 255))
        save(sheet, f'preview/{cat}.png')


if __name__ == '__main__':
    MANIFEST['conventions'] = {
        'coordinates': 'three.js: Y up, ground is the XZ plane. 1 world unit ~ 1 metre; a player is ~2.3 units tall.',
        'anchor': 'bottom-center: put the sprite position at the feet / base; in three.js Sprite.center = (0.5, 0).',
        'atlas_uv': 'For atlas sheets: texture.repeat = (1/cols, 1/rows); offset = (col/cols, 1 - (row+1)/rows).',
        'world_height': 'Suggested on-screen height in world units; width = height * (cell_w / cell_h).',
        'billboard': 'cylindrical = always faces the camera around the Y axis (THREE.Sprite is fine).',
        'filtering': 'Pixel art: NearestFilter for magFilter keeps crisp pixels; alphaTest 0.5 (alpha is hard 0/255).',
        'facing_rows_character': 'front=towards camera, back=away, left/right=screen-left/right.',
        'facing_rows_monster': 'front, side, back; side is drawn facing `side_faces`, mirror for the other side.',
    }
    characters(); monsters(); world(); gate_towers(); tileset(); weapons(); effects(); previews()
    with open(os.path.join(OUT, 'sprites.json'), 'w', encoding='utf-8') as fh:
        json.dump(MANIFEST, fh, indent=1, ensure_ascii=False)
    # same data as a classic <script> (window.SPRITES = {id: entry}) so a game can read it synchronously
    slim = {s['id']: {k: v for k, v in s.items() if k not in ('frames', 'source', 'image_full', 'description', 'notes')}
            for s in MANIFEST['sprites']}
    with open(os.path.join(OUT, 'sprites.js'), 'w', encoding='utf-8') as fh:
        fh.write('// generated by tools/slice_sprites.py - do not edit\nwindow.SPRITES = ')
        json.dump(slim, fh, separators=(',', ':'), ensure_ascii=False)
        fh.write(';\n')
    cats = {}
    for s in MANIFEST['sprites']:
        cats[s['category']] = cats.get(s['category'], 0) + 1
    print('sprites:', len(MANIFEST['sprites']), cats)
