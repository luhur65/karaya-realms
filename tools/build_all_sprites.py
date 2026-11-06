import os
import sys
import json
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'assets')
os.makedirs(os.path.join(OUT, 'atlas'), exist_ok=True)
os.makedirs(os.path.join(OUT, 'weapons'), exist_ok=True)

sys.path.insert(0, os.path.join(ROOT, 'tools'))
from detect import components, rows_of
from slice_sprites import clean, trim, resize, build_atlas, save, checker_bg

# 1. Keyout checkerboard for female walk sheet
def keyout_checkerboard(rgba):
    rgb = rgba[..., :3].astype(int)
    diff = rgb.max(-1) - rgb.min(-1)
    bright = rgb.max(-1)
    is_checker = (diff < 22) & (bright > 185)
    lab, _ = ndi.label(is_checker)
    border = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    mask = ~np.isin(lab, border[border > 0])
    out = rgba.copy()
    out[~mask, 3] = 0
    return out

def get_row_boxes(rgba, alpha_seg=140, dilate=6, min_area=600):
    solid = rgba[..., 3] >= alpha_seg
    boxes = components(solid, dilate, min_area)
    rows = rows_of(boxes)
    return [[b for b in sorted(r, key=lambda x: x[0])] for r in rows]

def extract_row_frames(rgba, rows_boxes):
    out = []
    for r in rows_boxes:
        row_imgs = []
        for (x0, y0, x1, y1, _) in r:
            sub = rgba[y0:y1, x0:x1]
            t = trim(clean(sub, sub[..., 3] >= 110))
            row_imgs.append(t)
        out.append(row_imgs)
    return out

# -------------------------------------------------------------
# BUILD HEROES (4 cols x 8 rows atlas: walk 0-3, attack 4-7)
# -------------------------------------------------------------
def build_hero_atlas(walk_path, atk_path, out_id, is_female=False):
    print(f"Building hero: {out_id}...")
    w_raw = np.array(Image.open(os.path.join(ROOT, walk_path)).convert('RGBA'))
    if is_female:
        w_raw = keyout_checkerboard(w_raw)
    a_raw = np.array(Image.open(os.path.join(ROOT, atk_path)).convert('RGBA'))
    
    w_boxes = get_row_boxes(w_raw)
    a_boxes = get_row_boxes(a_raw)
    w_frames = extract_row_frames(w_raw, w_boxes)
    a_frames = extract_row_frames(a_raw, a_boxes)
    
    # Walk: row 0 = front, row 1 = right, row 2 = back
    w_front = w_frames[0]
    if len(w_front) == 3:
        w_front = [w_front[0], w_front[1], w_front[2], w_front[1]]
    w_right = w_frames[1][:4]
    w_left = [f[:, ::-1].copy() for f in w_right]
    w_back = w_frames[2][:4]
    
    # Attack: row 0 = front, row 1 = right, row 2 = back
    a_front = a_frames[0][:4]
    a_right = a_frames[1][:4]
    a_left = [f[:, ::-1].copy() for f in a_right]
    a_back = a_frames[2][:4]
    
    # Put into 8 rows:
    # 0: front, 1: left, 2: right, 3: back, 4: atk_front, 5: atk_left, 6: atk_right, 7: atk_back
    all_rows = [w_front, w_left, w_right, w_back, a_front, a_left, a_right, a_back]
    frames = {}
    for ri, r in enumerate(all_rows):
        for ci, img in enumerate(r):
            frames[(ri, ci)] = img
            
    scale = 150 / max(i.shape[0] for i in frames.values())
    atlas, cw, ch = build_atlas(frames, 4, 8, scale, size_rows={0, 1, 2, 3})
    atlas_path = os.path.join(OUT, f'atlas/{out_id}.png')
    atlas.save(atlas_path)
    print(f"  Saved {atlas_path}: size={atlas.size}, cell=[{cw}, {ch}]")
    return {'cell': [cw, ch], 'grid': [4, 8], 'atlas': f'assets/atlas/{out_id}.png'}

# -------------------------------------------------------------
# BUILD MONSTERS (3 rows x 4 cols atlas)
# -------------------------------------------------------------
def build_monster_atlas(src_path, mid, faces='left', wh=2.0):
    print(f"Building monster: {mid} from {src_path}...")
    raw = np.array(Image.open(os.path.join(ROOT, src_path)).convert('RGBA'))
    boxes = get_row_boxes(raw)
    assert len(boxes) == 3, f"Expected 3 rows for {mid}, got {len(boxes)}"
    frames_raw = extract_row_frames(raw, boxes)
    frames = {}
    for ri in range(3):
        seq = frames_raw[ri]
        if len(seq) == 3:
            seq = [seq[0], seq[1], seq[2], seq[1]]
        for ci, img in enumerate(seq[:4]):
            frames[(ri, ci)] = img
    scale = 200 / max(i.shape[0] for i in frames.values())
    atlas, cw, ch = build_atlas(frames, 4, 3, scale)
    atlas_path = os.path.join(OUT, f'atlas/{mid}.png')
    atlas.save(atlas_path)
    print(f"  Saved {atlas_path}: size={atlas.size}, cell=[{cw}, {ch}]")
    return {
        'id': mid, 'category': 'monster',
        'atlas': f'assets/atlas/{mid}.png', 'cell': [cw, ch], 'grid': [4, 3],
        'anchor': 'bottom-center', 'world_height': wh,
        'rows': {'front': 0, 'side': 1, 'back': 2}, 'side_faces': faces,
        'anims': {'idle': {'cols': [0], 'fps': 1}, 'walk': {'cols': [0, 1, 2, 3], 'fps': 7}}
    }

# -------------------------------------------------------------
# BUILD NPCS (3 rows x 4 cols atlas)
# -------------------------------------------------------------
def build_npc_atlas(src_path, nid, wh=2.3):
    print(f"Building NPC: {nid} from {src_path}...")
    raw = np.array(Image.open(os.path.join(ROOT, src_path)).convert('RGBA'))
    boxes = get_row_boxes(raw)
    frames_raw = extract_row_frames(raw, boxes)
    # Row 0: front, Row 1: side, Row 2: back
    front = frames_raw[0]
    if len(front) == 3:
        front = [front[0], front[1], front[2], front[1]]
    side = frames_raw[1]
    if len(side) >= 4:
        side = side[:4]
    else:
        side = [side[0], side[1 % len(side)], side[2 % len(side)], side[1 % len(side)]]
    back = frames_raw[2]
    if len(back) == 3:
        back = [back[0], back[1], back[2], back[1]]
    
    # 4 rows: front=0, left=1 (mirror side), right=2 (side), back=3
    left = [f[:, ::-1].copy() for f in side]
    frames = {}
    for ri, r in enumerate([front[:4], left[:4], side[:4], back[:4]]):
        for ci, img in enumerate(r):
            frames[(ri, ci)] = img
    scale = 150 / max(i.shape[0] for i in frames.values())
    atlas, cw, ch = build_atlas(frames, 4, 4, scale)
    atlas_path = os.path.join(OUT, f'atlas/{nid}.png')
    atlas.save(atlas_path)
    print(f"  Saved NPC atlas: {atlas_path}: size={atlas.size}, cell=[{cw}, {ch}]")
    return {
        'id': nid, 'category': 'npc',
        'atlas': f'assets/atlas/{nid}.png', 'cell': [cw, ch], 'grid': [4, 4],
        'anchor': 'bottom-center', 'world_height': wh,
        'rows': {'front': 0, 'left': 1, 'right': 2, 'back': 3},
        'anims': {'idle': {'cols': [0], 'fps': 1}, 'walk': {'cols': [0, 1, 2, 3], 'fps': 8}}
    }

# -------------------------------------------------------------
# BUILD DIRECTIONAL WEAPONS (4 cols: [front, left, right, back])
# -------------------------------------------------------------
def build_directional_weapon(name, front_img, left_img, right_img, back_img, max_dim=256):
    print(f"Building directional weapon: {name}...")
    dirs = [front_img, left_img, right_img, back_img]
    # Resize so max dimension is max_dim
    s = min(max_dim / max(im.width, im.height) for im in dirs)
    resized = [im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS) for im in dirs]
    cw = max(im.width for im in resized) + 4
    ch = max(im.height for im in resized) + 4
    atlas = Image.new('RGBA', (cw * 4, ch), (0, 0, 0, 0))
    for i, im in enumerate(resized):
        ox = i * cw + (cw - im.width) // 2
        oy = (ch - im.height) // 2
        atlas.alpha_composite(im, (ox, oy))
    # Re-harden alpha
    a = np.array(atlas)
    hard = a[..., 3] >= 110
    a[..., 3] = np.where(hard, 255, 0)
    a[~hard, :3] = 0
    final_im = Image.fromarray(a)
    p = os.path.join(OUT, f'weapons/{name}.png')
    final_im.save(p)
    print(f"  Saved directional weapon {p}: size={final_im.size}, cell=[{cw}, {ch}]")
    return {'cell': [cw, ch], 'grid': [4, 1], 'image': f'assets/weapons/{name}.png'}

if __name__ == '__main__':
    # 1. Build heroes
    hero_m = build_hero_atlas(
        'male_object/Fantasy Adventurer Walking Sprite Sheet.png',
        'male_object/Chibi Adventurer Attack Sprite Sheet.png',
        'hero_male', is_female=False
    )
    hero_f = build_hero_atlas(
        'female_object/Chibi Adventurer Walking Sprite Sheet.png',
        'female_object/Isometric Anime Warrior Slash Sprite Sheet.png',
        'hero_female', is_female=True
    )
    
    # 2. Build all 7 monsters
    monsters_data = [
        ('slime', 'all monster/slimes/Lembar Sprite Animasi Slime Hijau.png', 'left', 1.3),
        ('wolf', 'all monster/wolf/Sprite Serigala Pixel 3x4 Animasi.png', 'left', 2.0),
        ('goblin', 'all monster/goblin/Lembar Sprite Goblin Pixel Art Isometrik.png', 'right', 2.0),
        ('dragon', 'all monster/dragon_bing/Lembar Sprite Naga Merah Pixel-Art.png', 'left', 4.2),
        ('ghost', 'all monster/ghost/Ghostly Phantom Sprite Sheet.png', 'left', 2.5),
        ('orc', 'all monster/orc/Orc Warrior Animation Sprite Sheet.png', 'left', 2.9),
        ('skeleton', 'all monster/skeleton/Undead Warrior Sprite Sheet.png', 'right', 2.4),
    ]
    monsters_entries = {}
    for mid, path, faces, wh in monsters_data:
        monsters_entries[mid] = build_monster_atlas(path, mid, faces, wh)
        
    # 3. Build human NPCs from another_object
    npcs_data = [
        ('npc_guard', 'another_object/Lembar Sprite Petualang Pria RPG Pixel Art.png', 2.3),
        ('npc_guide', 'another_object/Lembar Sprite Petualang Berambut Kuncir.png', 2.3),
        ('npc_fighter', 'another_object/Lembar Sprite Serangan Petarung Cokelat.png', 2.4),
    ]
    npc_entries = {}
    for nid, path, wh in npcs_data:
        npc_entries[nid] = build_npc_atlas(path, nid, wh)
        
    # 4. Build directional weapons
    # Load previews
    def load_prev(name):
        return Image.open(f'tools/preview_weapons/{name}.png')
    
    # Bow: front (r0_c2), left (r1_c2), right (r0_c2), back (r1_c1)
    b_front = load_prev('bow_r0_c2')
    b_right = load_prev('bow_r0_c3')
    b_left = Image.fromarray(np.array(b_right)[:, ::-1])
    b_back = load_prev('bow_r1_c1')
    wp_bow = build_directional_weapon('weapon_bow', b_front, b_left, b_right, b_back)
    
    # Sword1: front (r0_c1), left (r0_c2 mirrored), right (r0_c2), back (r0_c0)
    s1_front = load_prev('sword1_r0_c1')
    s1_right = load_prev('sword1_r0_c2')
    s1_left = Image.fromarray(np.array(s1_right)[:, ::-1])
    s1_back = load_prev('sword1_r0_c0')
    wp_sword1 = build_directional_weapon('weapon_sword1', s1_front, s1_left, s1_right, s1_back)
    
    # Sword2: front (r0_c1), left (r0_c2 mirrored), right (r0_c2), back (r0_c0)
    s2_front = load_prev('sword2_r0_c1')
    s2_right = load_prev('sword2_r0_c2')
    s2_left = Image.fromarray(np.array(s2_right)[:, ::-1])
    s2_back = load_prev('sword2_r0_c0')
    wp_sword2 = build_directional_weapon('weapon_sword2', s2_front, s2_left, s2_right, s2_back)
    
    # Mace: front (r0_c2), left (r0_c3 mirrored), right (r0_c3), back (r0_c0)
    m_front = load_prev('mace_r0_c2')
    m_right = load_prev('mace_r0_c3')
    m_left = Image.fromarray(np.array(m_right)[:, ::-1])
    m_back = load_prev('mace_r0_c0')
    wp_mace = build_directional_weapon('weapon_mace', m_front, m_left, m_right, m_back)
    
    # Staff: 4 identical views (staff looks same from all sides)
    st = Image.open('weapons/magic/Tongkat Kristal Biru Ajaib.png').convert('RGBA')
    st_clean = trim(clean(np.array(st), np.array(st)[..., 3] >= 120))
    st_im = Image.fromarray(st_clean)
    wp_staff = build_directional_weapon('weapon_staff', st_im, st_im, st_im, st_im)
    
    print("\nAll assets built successfully!")
    
    # Save meta for updating sprites.json
    meta = {
        'hero_male': hero_m,
        'hero_female': hero_f,
        'monsters': monsters_entries,
        'npcs': npc_entries,
        'weapons': {
            'weapon_bow': wp_bow,
            'weapon_sword1': wp_sword1,
            'weapon_sword2': wp_sword2,
            'weapon_mace': wp_mace,
            'weapon_staff': wp_staff,
        }
    }
    with open('tools/built_meta.json', 'w') as fh:
        json.dump(meta, fh, indent=2)
    print("Saved tools/built_meta.json")
