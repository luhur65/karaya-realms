import os
import sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

sys.path.insert(0, 'tools')
from detect import components, rows_of

def check_sheet(path, alpha_seg=160, dilate=6, min_area=800):
    im = Image.open(path)
    rgba = np.array(im.convert('RGBA'))
    print(f"\n--- {path} ({im.size}, mode={im.mode}) ---")
    
    # Check if RGB had fake background (white or checker or solid)
    # Let's check border pixels
    borders = np.concatenate([rgba[0], rgba[-1], rgba[:, 0], rgba[:, -1]])
    unique_border = np.unique(borders[..., :3], axis=0)
    print(f"Border colors: {len(unique_border)} unique colors, first few: {unique_border[:3].tolist()}")
    
    solid = rgba[..., 3] >= alpha_seg
    # If RGB, alpha is all 255, so we need color keying or background detection
    if im.mode == 'RGB':
        # Check background color, usually near white or light grey
        bg_col = borders[..., :3].mean(axis=0)
        print(f"Mean border RGB: {bg_col}")
        # check distance from border color
        dist = np.linalg.norm(rgba[..., :3] - bg_col, axis=-1)
        solid = dist > 30
        print(f"Solid pixels after bg removal: {solid.sum()} / {solid.size}")

    boxes = components(solid, dilate, min_area)
    rows = rows_of(boxes)
    print(f"Detected {len(rows)} rows: {[len(r) for r in rows]} items per row")
    for ri, r in enumerate(rows):
        h_avg = np.mean([b[3] for b in r]) if r else 0
        w_avg = np.mean([b[2] for b in r]) if r else 0
        print(f"  Row {ri}: {len(r)} boxes, avg size {w_avg:.0f}x{h_avg:.0f}")

sheets = [
    'female_object/Chibi Adventurer Walking Sprite Sheet.png',
    'female_object/Isometric Anime Warrior Slash Sprite Sheet.png',
    'female_object/Anime Archer Sprite Sheet Animation.png',
    'female_object/Chibi Mage Casting Sprite Sheet.png',
    'male_object/Fantasy Adventurer Walking Sprite Sheet.png',
    'male_object/Chibi Adventurer Attack Sprite Sheet.png',
    'male_object/Anime Chibi Archer Sprite Sheet.png',
    'male_object/Anime RPG Hero Spellcasting Sprite Sheet.png',
    'another_object/Lembar Sprite Petualang Wanita Isometrik.png',
    'another_object/Lembar Sprite Serangan Petarung Cokelat.png',
    'another_object/Lembar Sprite Petualang Berambut Kuncir.png',
    'another_object/Lembar Sprite Petualang Pria RPG Pixel Art.png',
    'all monster/ghost/Ghostly Phantom Sprite Sheet.png',
    'all monster/orc/Orc Warrior Animation Sprite Sheet.png',
    'all monster/skeleton/Undead Warrior Sprite Sheet.png',
    'weapons/archer/Fantasy Bow Sprite Sheet.png',
    'weapons/gada/Pixel-Art Spiked Mace Sprite Sheet.png',
    'weapons/sword-one-hand/Isometric Pixel Sword Sprite Sheet.png',
    'weapons/sword-two-hand/Dark Fantasy Greatsword Sprite Sheet.png',
]

for s in sheets:
    if os.path.exists(s):
        try:
            check_sheet(s)
        except Exception as e:
            print(f"Error {s}: {e}")
