import os
from PIL import Image
import numpy as np

def scan(folder):
    print(f"=== {folder} ===")
    if not os.path.exists(folder):
        print("Not found")
        return
    for root, dirs, files in os.walk(folder):
        for f in files:
            if f.endswith('.png'):
                p = os.path.join(root, f)
                im = Image.open(p)
                print(f"{os.path.relpath(p, '.')}: {im.size}, mode={im.mode}")

for folder in ['female_object', 'male_object', 'another_object', 'all monster', 'weapons']:
    scan(folder)
