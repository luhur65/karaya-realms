import os
from PIL import Image
import numpy as np

def inspect_img(path):
    im = Image.open(path)
    print(f"=== {path} ===")
    print(f"Size: {im.size}, Mode: {im.mode}")
    arr = np.array(im)
    if im.mode == 'RGBA':
        alpha = arr[..., 3]
        print(f"Alpha min: {alpha.min()}, max: {alpha.max()}, mean: {alpha.mean():.1f}")
    else:
        # RGB check background
        corners = [arr[0, 0], arr[0, -1], arr[-1, 0], arr[-1, -1]]
        print(f"Corners: {corners}")

inspect_img('female_object/Chibi Adventurer Walking Sprite Sheet.png')
inspect_img('female_object/Isometric Anime Warrior Slash Sprite Sheet.png')
inspect_img('female_object/Anime Archer Sprite Sheet Animation.png')
inspect_img('female_object/Chibi Mage Casting Sprite Sheet.png')
inspect_img('male_object/Fantasy Adventurer Walking Sprite Sheet.png')
inspect_img('male_object/Chibi Adventurer Attack Sprite Sheet.png')
