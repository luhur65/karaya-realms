import os
import json

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
json_path = os.path.join(ROOT, 'assets/sprites.json')
js_path = os.path.join(ROOT, 'assets/sprites.js')

with open('tools/built_meta.json', 'r') as fh:
    meta = json.load(fh)

with open(json_path, 'r', encoding='utf-8') as fh:
    data = json.load(fh)

sprites_map = {s['id']: s for s in data['sprites']}

# 1. Update hero_male & hero_female
sprites_map['hero_male']['cell'] = meta['hero_male']['cell']
sprites_map['hero_male']['grid'] = [4, 8]
sprites_map['hero_male']['source'] = 'male_object'

sprites_map['hero_female']['cell'] = meta['hero_female']['cell']
sprites_map['hero_female']['grid'] = [4, 8]
sprites_map['hero_female']['source'] = 'female_object'

# 2. Update monsters (all 7 now have atlas)
for mid, mdata in meta['monsters'].items():
    if mid in sprites_map:
        sprites_map[mid].update({
            'atlas': mdata['atlas'],
            'cell': mdata['cell'],
            'grid': mdata['grid'],
            'rows': mdata['rows'],
            'side_faces': mdata['side_faces'],
            'anims': mdata['anims'],
            'world_height': mdata['world_height'],
        })
    else:
        sprites_map[mid] = mdata

# 3. Add NPCs
for nid, ndata in meta['npcs'].items():
    sprites_map[nid] = ndata

# 4. Update Weapons with 4 directions
for wid, wdata in meta['weapons'].items():
    if wid in sprites_map:
        sprites_map[wid].update({
            'image': wdata['image'],
            'cell': wdata['cell'],
            'grid': wdata['grid'],
            'directions': ['front', 'left', 'right', 'back'],
        })

# Reassemble list
data['sprites'] = list(sprites_map.values())

with open(json_path, 'w', encoding='utf-8') as fh:
    json.dump(data, fh, indent=1, ensure_ascii=False)
print("Updated assets/sprites.json")

# Generate assets/sprites.js
slim = {
    s['id']: {k: v for k, v in s.items() if k not in ('frames', 'source', 'image_full', 'description', 'notes')}
    for s in data['sprites']
}
with open(js_path, 'w', encoding='utf-8') as fh:
    fh.write('window.SPRITES = ' + json.dumps(slim, ensure_ascii=False) + ';\n')
print("Generated assets/sprites.js")
