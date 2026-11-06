"""Debug helper: print connected-component bounding boxes for a sprite sheet.
usage: python tools/detect.py <image> [dilate_px] [min_area]
"""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi


def solid_mask(rgba, alpha_min=160):
    return rgba[..., 3] >= alpha_min


def components(mask, dilate=6, min_area=400):
    grown = ndi.binary_dilation(mask, iterations=dilate) if dilate else mask
    lab, n = ndi.label(grown)
    out = []
    for i, sl in enumerate(ndi.find_objects(lab), 1):
        if sl is None:
            continue
        sub = (lab[sl] == i) & mask[sl]
        area = int(sub.sum())
        if area < min_area:
            continue
        ys, xs = np.nonzero(sub)
        y0, x0 = sl[0].start + ys.min(), sl[1].start + xs.min()
        y1, x1 = sl[0].start + ys.max() + 1, sl[1].start + xs.max() + 1
        out.append((int(x0), int(y0), int(x1), int(y1), area))
    return out


def rows_of(boxes, tol=0.5):
    """Group boxes into rows by vertical-center overlap, top to bottom, left to right."""
    boxes = sorted(boxes, key=lambda b: (b[1] + b[3]) / 2)
    rows = []
    for b in boxes:
        cy = (b[1] + b[3]) / 2
        for r in rows:
            ry0 = min(x[1] for x in r); ry1 = max(x[3] for x in r)
            if ry0 <= cy <= ry1:
                r.append(b); break
        else:
            rows.append([b])
    return [sorted(r, key=lambda b: b[0]) for r in rows]


if __name__ == '__main__':
    path = sys.argv[1]
    dil = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    mn = int(sys.argv[3]) if len(sys.argv) > 3 else 400
    rgba = np.array(Image.open(path).convert('RGBA'))
    for ri, r in enumerate(rows_of(components(solid_mask(rgba), dil, mn))):
        print('row', ri, [(b[0], b[1], b[2] - b[0], b[3] - b[1]) for b in r])
