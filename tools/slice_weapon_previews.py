import os
import sys
import numpy as np
from PIL import Image

sys.path.insert(0, 'tools')
from detect import components, rows_of
from slice_sprites import clean, trim

os.makedirs('tools/preview_weapons', exist_ok=True)

def slice_weapon_sheet(path, name):
    im = Image.open(path).convert('RGBA')
    rgba = np.array(im)
    # alpha check
    solid = rgba[..., 3] >= 140
    boxes = components(solid, dilate=6, min_area=500)
    rows = rows_of(boxes)
    print(f"Weapon {name}: {len(rows)} rows: {[len(r) for r in rows]}")
    for ri, r in enumerate(rows):
        r_sorted = sorted(r, key=lambda b: b[0])
        for ci, (x0, y0, x1, y1, _) in enumerate(r_sorted):
            sub = rgba[y0:y1, x0:x1]
            t = trim(clean(sub, sub[..., 3] >= 120))
            out_im = Image.fromarray(t)
            out_im.save(f'tools/preview_weapons/{name}_r{ri}_c{ci}.png')

slice_weapon_sheet('weapons/archer/Fantasy Bow Sprite Sheet.png', 'bow')
slice_weapon_sheet('weapons/sword-one-hand/Isometric Pixel Sword Sprite Sheet.png', 'sword1')
slice_weapon_sheet('weapons/sword-two-hand/Dark Fantasy Greatsword Sprite Sheet.png', 'sword2')
slice_weapon_sheet('weapons/gada/Pixel-Art Spiked Mace Sprite Sheet.png', 'mace')
print("Sliced all weapon preview frames!")
