import os
import sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

sys.path.insert(0, 'tools')
from detect import components, rows_of
from slice_sprites import clean, trim, resize, build_atlas

def keyout_checkerboard(rgba):
    # Detect the light checkerboard pattern
    rgb = rgba[..., :3].astype(int)
    # Check max-min difference (saturation) and brightness
    diff = rgb.max(-1) - rgb.min(-1)
    bright = rgb.max(-1)
    # Checkerboard is low saturation and bright (> 200)
    is_checker = (diff < 20) & (bright > 190)
    # Remove border connected checkerboard
    lab, _ = ndi.label(is_checker)
    border = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    mask = ~np.isin(lab, border[border > 0])
    
    out = rgba.copy()
    out[~mask, 3] = 0
    return out

def get_row_boxes(rgba, alpha_seg=160, dilate=6, min_area=800):
    solid = rgba[..., 3] >= alpha_seg
    boxes = components(solid, dilate, min_area)
    rows = rows_of(boxes)
    # Sort boxes in each row left-to-right
    return [[b for b in sorted(r, key=lambda x: x[0])] for r in rows]

def extract_frames(rgba, rows_boxes):
    out = []
    for r in rows_boxes:
        row_imgs = []
        for (x0, y0, x1, y1, _) in r:
            sub = rgba[y0:y1, x0:x1]
            # clean alpha
            t = trim(clean(sub, sub[..., 3] >= 128))
            row_imgs.append(t)
        out.append(row_imgs)
    return out

print("Processing male hero...")
male_walk_raw = np.array(Image.open('male_object/Fantasy Adventurer Walking Sprite Sheet.png').convert('RGBA'))
male_atk_raw = np.array(Image.open('male_object/Chibi Adventurer Attack Sprite Sheet.png').convert('RGBA'))

mw_boxes = get_row_boxes(male_walk_raw)
ma_boxes = get_row_boxes(male_atk_raw)
print("Male walk boxes:", [len(r) for r in mw_boxes])
print("Male attack boxes:", [len(r) for r in ma_boxes])

mw_frames = extract_frames(male_walk_raw, mw_boxes)
ma_frames = extract_frames(male_atk_raw, ma_boxes)

# Now female hero:
print("Processing female hero...")
female_walk_im = Image.open('female_object/Chibi Adventurer Walking Sprite Sheet.png').convert('RGBA')
female_walk_raw = keyout_checkerboard(np.array(female_walk_im))
female_atk_raw = np.array(Image.open('female_object/Isometric Anime Warrior Slash Sprite Sheet.png').convert('RGBA'))

fw_boxes = get_row_boxes(female_walk_raw)
fa_boxes = get_row_boxes(female_atk_raw)
print("Female walk boxes:", [len(r) for r in fw_boxes])
print("Female attack boxes:", [len(r) for r in fa_boxes])

fw_frames = extract_frames(female_walk_raw, fw_boxes)
fa_frames = extract_frames(female_atk_raw, fa_boxes)

print("Extraction test complete!")
