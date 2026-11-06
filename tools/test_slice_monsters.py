import os
import sys
import numpy as np
from PIL import Image

sys.path.insert(0, 'tools')
from slice_sprites import load, cut_components, build_atlas, save

monster_sheets = [
    ('ghost', 'all monster/ghost/Ghostly Phantom Sprite Sheet.png', 'left', 2.4, 'Ghostly phantom.'),
    ('orc', 'all monster/orc/Orc Warrior Animation Sprite Sheet.png', 'left', 3.0, 'Orc warrior with axe.'),
    ('skeleton', 'all monster/skeleton/Undead Warrior Sprite Sheet.png', 'left', 2.4, 'Skeleton warrior with sword.'),
]

for mid, src, faces, wh, desc in monster_sheets:
    print(f"Testing {mid} from {src}...")
    rows = cut_components(load(src), 160, 6, 800)
    print(f"  Rows detected: {len(rows)}, cols per row: {[len(r) for r in rows]}")
    assert len(rows) == 3 and all(len(r) == 4 for r in rows), f"Failed for {mid}: {[len(r) for r in rows]}"
    frames = {}
    for ri, d in enumerate(['front', 'side', 'back']):
        for c, (_, img) in enumerate(rows[ri]):
            frames[(ri, c)] = img
    scale = 200 / max(i.shape[0] for i in frames.values())
    atlas, cw, ch = build_atlas(frames, 4, 3, scale)
    out_path = f'assets/atlas/{mid}.png'
    atlas.save(out_path)
    print(f"  Successfully built atlas: {out_path}, cell: [{cw}, {ch}]")
print("All 3 new monsters sliced perfectly!")
