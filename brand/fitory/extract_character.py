"""Deterministic source-pixel extraction; no drawing or generated artwork."""
from collections import deque
from PIL import Image, ImageDraw, ImageFilter


def extract_character(original, recipe):
    original = original.convert('RGB')
    width, height = original.size
    region = Image.new('L', original.size)
    ImageDraw.Draw(region).polygon(recipe['selectionPolygon'], fill=255)
    boundary = Image.new('L', original.size)
    rgb, selected, pixels = original.load(), region.load(), boundary.load()
    x0, y0, x1, y1 = region.getbbox()
    for y in range(y0, y1):
        for x in range(x0, x1):
            color = rgb[x, y]
            if selected[x, y] and (max(color) < recipe['darkThreshold'] or
                                   max(color) - min(color) > recipe['colorThreshold']):
                pixels[x, y] = 255
    # This closes only the extraction mask across the existing lower torso.
    # It does not paint a new outline or alter the source RGB pixels.
    ImageDraw.Draw(boundary).line(recipe['alphaClosure'], fill=255, width=1)
    mask = boundary.copy()
    ImageDraw.floodfill(mask, (0, 0), 128, thresh=0)
    pixels = mask.load()
    for y in range(height):
        for x in range(width):
            pixels[x, y] = 0 if pixels[x, y] == 128 or not selected[x, y] else 255
    visited = set()
    for y in range(y0, y1):
        for x in range(x0, x1):
            if not pixels[x, y] or (x, y) in visited:
                continue
            queue = deque([(x, y)])
            visited.add((x, y))
            component = []
            while queue:
                a, b = queue.pop()
                component.append((a, b))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    point = (a + dx, b + dy)
                    if (0 <= point[0] < width and 0 <= point[1] < height and
                            point not in visited and pixels[point[0], point[1]]):
                        visited.add(point)
                        queue.append(point)
            if len(component) < recipe['minimumComponentPixels']:
                for a, b in component:
                    pixels[a, b] = 0
    mask = mask.filter(ImageFilter.MaxFilter(recipe['edgeExpansionKernel']))
    bbox = mask.getbbox()
    if list(bbox) != recipe['sourceBounds']:
        raise ValueError('Character extraction bounds changed.')
    mask = mask.crop(bbox)
    # Export on white, matching the source matte. No transparent mascot is claimed.
    character = Image.new('RGB', mask.size, recipe['background'])
    character.paste(original.crop(bbox), (0, 0), mask)
    size = recipe['canvasSize']
    icon = Image.new('RGB', (size, size), recipe['background'])
    character_width = recipe['characterWidth']
    scaled = character.resize((character_width, round(character.height * character_width / character.width)),
                              Image.Resampling.LANCZOS)
    icon.paste(scaled, ((size - scaled.width) // 2, (size - scaled.height) // 2))
    return mask, character, icon
