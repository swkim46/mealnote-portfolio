#!/usr/bin/env python3
"""Export the frozen FITORY bitmap without drawing or regenerating it."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import shutil
import sys

VERSION = 'v4'
SOURCE_SHA256S = {
    'v1': '32168348504b5e522ca2e77494731aa84755b49c57858d39af29017b1ceda638',
    'v2': '32168348504b5e522ca2e77494731aa84755b49c57858d39af29017b1ceda638',
    'v3': 'ba8c8a977f31ea284b170357fdd7e4990134a2e1ebbd78755f2b3b09f18582b6',
    'v4': 'ba8c8a977f31ea284b170357fdd7e4990134a2e1ebbd78755f2b3b09f18582b6',
}
LOCK_SHA256S = {
    'v1': 'cac627b73a1e61057c66b3772d28fb89d1811a4c88645e8015664aab302a29a8',
    'v2': '4869e8fb43337dfcddf8759e9e394d51256ae3c115e4b64b16194ec08727c0ae',
    'v3': '701f92a3248b16c19839e0ce3c99177eacab35a63b2f76fd86a4497809a5821b',
    'v4': '5c03a483aa52f83558a94c12c2eda5e0dea694a1b1b2bce75685a5665394fedb',
}
PILLOW_VERSION = '11.3.0'
PNG_SIZES = {
    'favicon-16x16.png': 16, 'favicon-32x32.png': 32,
    'favicon-48x48.png': 48, 'pwa-64x64.png': 64,
    'fitory-icon-128.png': 128, 'apple-touch-icon-180x180.png': 180,
    'pwa-192x192.png': 192, 'fitory-icon-256.png': 256,
    'fitory-icon-384.png': 384, 'pwa-512x512.png': 512,
    'fitory-icon-1024.png': 1024,
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode_png(image):
    output = io.BytesIO()
    image.save(output, format='PNG', optimize=False, compress_level=9)
    return output.getvalue()


def render_exports(version_root):
    import PIL
    from PIL import Image
    if PIL.__version__ != PILLOW_VERSION:
        raise ValueError('Export requires Pillow ' + PILLOW_VERSION +
                         '; use the checked-in exports or the pinned requirements.')
    with Image.open(version_root / 'master/icon.png') as original:
        master = original.convert('RGB')
    out = {name: encode_png(master.resize((size, size), Image.Resampling.LANCZOS))
           for name, size in PNG_SIZES.items()}
    for size in (192, 512):
        if version_root.name in ('v3', 'v4'):
            # The selected artwork deliberately bleeds to the tile edges.
            # Preserve its exact layout; only the face/arrow recognition areas
            # must fit the launcher safe circle, not every decorative contour.
            out['maskable-icon-' + str(size) + 'x' + str(size) + '.png'] = out['pwa-' + str(size) + 'x' + str(size) + '.png']
            continue
        # v2 needs slightly more padding to keep the wider character inside masks.
        side = round(size * (.84 if version_root.name == 'v2' else .86))
        canvas = Image.new('RGB', (size, size), '#FFFFFF')
        canvas.paste(master.resize((side, side), Image.Resampling.LANCZOS),
                     ((size - side) // 2, (size - side) // 2))
        out['maskable-icon-' + str(size) + 'x' + str(size) + '.png'] = encode_png(canvas)
    output = io.BytesIO()
    with Image.open(io.BytesIO(out['favicon-48x48.png'])) as icon:
        icon.save(output, format='ICO', sizes=[(16, 16), (32, 32), (48, 48)])
    out['favicon.ico'] = output.getvalue()
    out['logo.svg'] = (version_root / 'master/icon.svg').read_bytes()
    out['fitory-icon-original.png'] = (version_root / 'master/icon.png').read_bytes()
    if version_root.name in ('v2', 'v3', 'v4'):
        out['app-icon.svg'] = out.pop('logo.svg')
        out['fitory-brand-logo.png'] = (version_root.parent / 'v1/master/icon.png').read_bytes()
        out['fitory-brand-logo.svg'] = (version_root.parent / 'v1/master/icon.svg').read_bytes()
    if version_root.name == 'v4':
        out['fitory-app-icon-fullbleed-1024.png'] = out['fitory-icon-1024.png']
    return out


def read_lock(root, version=VERSION):
    raw = (root / version / 'asset-lock.json').read_bytes()
    if digest(raw) != LOCK_SHA256S[version]:
        raise ValueError('The ' + version + ' lock file changed. Do not refresh hashes to accept a new image.')
    lock = json.loads(raw)
    if lock['version'] != version or lock['sourceSha256'] != SOURCE_SHA256S[version]:
        raise ValueError('The source anchor does not match frozen ' + version + '.')
    return lock


def check_files(root, lock, include_exports=True):
    for name, expected in lock['files'].items():
        if not include_exports and name.startswith('exports/'):
            continue
        path = root / lock['version'] / name
        if not path.is_file() or digest(path.read_bytes()) != expected['sha256']:
            raise ValueError('Missing or changed frozen asset: ' + name)


def check_v2_extraction(root, lock):
    from PIL import Image
    from extract_character import extract_character
    recipe = json.loads((root / 'v2/source/extraction-recipe.json').read_text())
    with Image.open(root / 'v1/source/trainer-original.jpg') as original:
        mask, character, icon = extract_character(original, recipe)
    png = encode_png(icon)
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
           '<image width="1024" height="1024" href="data:image/png;base64,' +
           base64.b64encode(png).decode() + '"/></svg>\n').encode()
    rendered = {'source/character-alpha.png': encode_png(mask),
                'master/character-on-white.png': encode_png(character),
                'master/icon.png': png, 'master/icon.svg': svg}
    for name, data in rendered.items():
        if digest(data) != lock['files'][name]['sha256']:
            raise ValueError('Non-identical extraction: ' + name + '; existing assets were preserved.')


def check_v4_preparation(root, lock):
    from PIL import Image
    from prepare_fullbleed import prepare_icon
    recipe = json.loads((root / 'v4/source/preparation-recipe.json').read_text())
    with Image.open(root / 'v3/source/fitory-icon-primary-lime-dumbbell.png') as original:
        mask, icon = prepare_icon(original, recipe)
    png = encode_png(icon)
    size = icon.width
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="' + str(size) +
           '" height="' + str(size) + '" viewBox="0 0 ' + str(size) + ' ' + str(size) +
           '"><image width="' + str(size) + '" height="' + str(size) +
           '" href="data:image/png;base64,' + base64.b64encode(png).decode() + '"/></svg>\n').encode()
    for name, data in {'source/retained-pixels-mask.png': encode_png(mask),
                       'master/icon.png': png, 'master/icon.svg': svg}.items():
        if digest(data) != lock['files'][name]['sha256']:
            raise ValueError('Non-identical preparation: ' + name + '; existing assets were preserved.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('command', choices=['verify', 'export', 'install'])
    args = parser.parse_args()
    root = args.root.resolve()
    try:
        lock = read_lock(root)
        for version in LOCK_SHA256S:
            check_files(root, read_lock(root, version),
                        include_exports=args.command != 'export' or version != VERSION)
        if args.command == 'export':
            # Validate the whole render in memory before overwriting any output.
            rendered = render_exports(root / VERSION)
            if VERSION == 'v2':
                check_v2_extraction(root, lock)
            if VERSION == 'v4':
                check_v4_preparation(root, lock)
            expected = {k.removeprefix('exports/'): v for k, v in lock['files'].items()
                        if k.startswith('exports/')}
            if set(rendered) != set(expected):
                raise ValueError('The export recipe or output list changed.')
            for name, data in rendered.items():
                if digest(data) != expected[name]['sha256']:
                    raise ValueError('Non-identical render: ' + name + '; existing assets were preserved.')
            for name, data in rendered.items():
                (root / VERSION / 'exports' / name).write_bytes(data)
        elif args.command == 'install':
            public = root.parents[1] / 'public'
            public.mkdir(exist_ok=True)
            for name, asset in lock['public'].items():
                shutil.copyfile(root / VERSION / asset, public / name)
        print('FITORY ' + VERSION + ': ' + args.command + ' OK; primary icon, alternatives and original brand logo preserved.')
        return 0
    except (OSError, ValueError, KeyError) as error:
        print('FITORY asset check failed: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
