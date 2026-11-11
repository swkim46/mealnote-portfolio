"""Remove the source presentation margin and extend only the lime background."""
from PIL import Image, ImageFilter


def prepare_icon(original, recipe):
    original = original.convert('RGB')
    box = recipe['cropBox']
    cropped = original.crop(box)
    mask = Image.new('L', cropped.size, 255)
    pixels = mask.load()
    for y in range(cropped.height):
        for x in range(cropped.width):
            ox, oy = x + box[0], y + box[1]
            for corner in recipe['cornerModels']:
                q, cx, cy, radius = corner
                quadrant = ((ox < cx if q[1] == 'l' else ox > cx) and
                            (oy < cy if q[0] == 't' else oy > cy))
                if quadrant and (ox-cx)**2 + (oy-cy)**2 > radius**2:
                    pixels[x, y] = 0
    mask = mask.filter(ImageFilter.GaussianBlur(recipe['edgeFeatherPixels']))
    # Match the existing lime near each outer edge. Never paint over the face,
    # hands, headband or dumbbell; the central image remains the source pixels.
    background = Image.new('RGB', cropped.size)
    output, source = background.load(), original.load()
    left = right = original.getpixel(tuple(recipe['fallbackColorSample']))
    for y in range(cropped.height):
        sy = y + box[1]
        qualified = []
        for sx in range(box[0], box[2]):
            r, g, b = source[sx, sy]
            if r > 130 and g > 230 and b < 85 and g-r > 25 and g-b > 130:
                qualified.append(sx)
        for side in ('left', 'right'):
            candidates = [x for x in qualified if
                          (x < recipe['leftSampleMaxX'] if side == 'left' else
                           x > recipe['rightSampleMinX'])]
            if candidates:
                count = recipe['colorSampleCount']
                chosen = candidates[:count] if side == 'left' else candidates[-count:]
                color = tuple(round(sum(source[x, sy][c] for x in chosen) / len(chosen))
                              for c in range(3))
                if side == 'left':
                    left = color
                else:
                    right = color
        for x in range(cropped.width):
            output[x, y] = left if x < cropped.width // 2 else right
    background.paste(cropped, (0, 0), mask)
    return mask, background
