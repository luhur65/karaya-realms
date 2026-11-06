import os
from PIL import Image
import numpy as np

os.makedirs('tools/preview_temp', exist_ok=True)

def sample_sheet(path, name):
    im = Image.open(path)
    # Save a 400px wide preview
    small = im.copy()
    small.thumbnail((512, 512))
    small.save(f'tools/preview_temp/{name}.png')
    print(f"Saved preview for {name}: {small.size}")

sample_sheet('female_object/Chibi Adventurer Walking Sprite Sheet.png', 'female_walk')
sample_sheet('female_object/Isometric Anime Warrior Slash Sprite Sheet.png', 'female_slash')
sample_sheet('female_object/Anime Archer Sprite Sheet Animation.png', 'female_archer')
sample_sheet('female_object/Chibi Mage Casting Sprite Sheet.png', 'female_mage')

sample_sheet('male_object/Fantasy Adventurer Walking Sprite Sheet.png', 'male_walk')
sample_sheet('male_object/Chibi Adventurer Attack Sprite Sheet.png', 'male_attack')
sample_sheet('male_object/Anime Chibi Archer Sprite Sheet.png', 'male_archer')
sample_sheet('male_object/Anime RPG Hero Spellcasting Sprite Sheet.png', 'male_mage')

sample_sheet('all monster/ghost/Ghostly Phantom Sprite Sheet.png', 'ghost_sheet')
sample_sheet('all monster/orc/Orc Warrior Animation Sprite Sheet.png', 'orc_sheet')
sample_sheet('all monster/skeleton/Undead Warrior Sprite Sheet.png', 'skeleton_sheet')

sample_sheet('weapons/archer/Fantasy Bow Sprite Sheet.png', 'wp_bow')
sample_sheet('weapons/gada/Pixel-Art Spiked Mace Sprite Sheet.png', 'wp_mace')
sample_sheet('weapons/sword-one-hand/Isometric Pixel Sword Sprite Sheet.png', 'wp_sword1')
sample_sheet('weapons/sword-two-hand/Dark Fantasy Greatsword Sprite Sheet.png', 'wp_sword2')
