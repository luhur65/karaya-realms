import os
import sys
import numpy as np
from PIL import Image

sys.path.insert(0, 'tools')
from detect import components, rows_of
from slice_sprites import clean, trim

os.makedirs('tools/preview_npc', exist_ok=True)

for name, path in [
    ('npc_male_guard', 'another_object/Lembar Sprite Petualang Pria RPG Pixel Art.png'),
    ('npc_female_guide', 'another_object/Lembar Sprite Petualang Berambut Kuncir.png'),
    ('npc_fighter', 'another_object/Lembar Sprite Serangan Petarung Cokelat.png'),
    ('npc_female_iso', 'another_object/Lembar Sprite Petualang Wanita Isometrik.png')
]:
    im = Image.open(path).convert('RGBA')
    rgba = np.array(im)
    solid = rgba[..., 3] >= 140
    boxes = components(solid, dilate=6, min_area=500)
    rows = rows_of(boxes)
    print(f"{name}: {len(rows)} rows: {[len(r) for r in rows]}")
    # Save first frame of row 0
    if rows and rows[0]:
        x0, y0, x1, y1, _ = sorted(rows[0], key=lambda b: b[0])[0]
        sub = trim(clean(rgba[y0:y1, x0:x1], rgba[y0:y1, x0:x1, 3] >= 120))
        Image.fromarray(sub).save(f'tools/preview_npc/{name}_sample.png')

print("NPC check complete!")
