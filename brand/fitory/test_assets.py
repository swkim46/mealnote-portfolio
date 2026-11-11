import base64
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

from PIL import Image, ImageChops

APP = Path(__file__).resolve().parents[2]
PACKAGE = APP / 'brand/fitory'


def hashes(folder):
    return {f.name: hashlib.sha256(f.read_bytes()).hexdigest()
            for f in folder.iterdir() if f.is_file()}


class FrozenAssetTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name) / 'app'
        shutil.copytree(PACKAGE, root / 'brand/fitory',
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        shutil.copytree(APP / 'public', root / 'public',
                        ignore=shutil.ignore_patterns('ocr', 'guides'))
        (root / 'brand/fitory/build_assets.py').write_bytes((PACKAGE / 'build_assets.py').read_bytes())
        return root

    def node_check(self, root):
        return subprocess.run(['node', str(APP / 'scripts/verify-brand-assets.mjs'),
                               '--root', str(root)], capture_output=True, text=True)

    def test_original_pixels_and_svg_are_preserved(self):
        root = PACKAGE / 'v1'
        with Image.open(root / 'source/trainer-original.jpg') as jpg:
            with Image.open(root / 'master/icon.png') as png:
                self.assertIsNone(ImageChops.difference(jpg.convert('RGB'), png.convert('RGB')).getbbox())
        svg = (root / 'master/icon.svg').read_text()
        encoded = re.search(r'data:image/jpeg;base64,([^\"]+)', svg).group(1)
        self.assertEqual(base64.b64decode(encoded), (root / 'source/trainer-original.jpg').read_bytes())

    def test_repeat_exports_are_byte_identical(self):
        root = self.fixture()
        exports = root / 'brand/fitory/v4/exports'
        expected = hashes(exports)
        for _ in range(2):
            result = subprocess.run(['python3', str(root / 'brand/fitory/build_assets.py'), 'export'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(hashes(exports), expected)

    def test_public_replacement_blocks_build_guard(self):
        root = self.fixture()
        self.assertEqual(self.node_check(root).returncode, 0)
        path = root / 'public/pwa-512x512.png'
        path.write_bytes(path.read_bytes() + b'changed')
        result = self.node_check(root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('diverged', result.stderr)

    def test_master_replacement_blocks_export(self):
        root = self.fixture()
        path = root / 'brand/fitory/v4/master/icon.png'; path.chmod(0o644)
        path.write_bytes(path.read_bytes() + b'changed')
        result = subprocess.run(['python3', str(root / 'brand/fitory/build_assets.py'), 'export'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('changed frozen asset', result.stderr)

    def test_lock_cannot_be_silently_refreshed(self):
        root = self.fixture()
        path = root / 'brand/fitory/v4/asset-lock.json'; path.chmod(0o644)
        data = json.loads(path.read_text()); data['frozenOn'] = 'changed'
        path.write_text(json.dumps(data))
        self.assertNotEqual(self.node_check(root).returncode, 0)

    def test_changed_export_recipe_preserves_existing_outputs(self):
        root = self.fixture()
        path = root / 'brand/fitory/build_assets.py'
        path.write_text(path.read_text().replace('Image.Resampling.LANCZOS', 'Image.Resampling.NEAREST'))
        exports = root / 'brand/fitory/v4/exports'; expected = hashes(exports)
        result = subprocess.run(['python3', str(path), 'export'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Non-identical render', result.stderr)
        self.assertEqual(hashes(exports), expected)

    def test_maskable_important_colors_fit_inside_safe_circle(self):
        for version, size in ((v, s) for v in ('v1', 'v2') for s in (192, 512)):
            with Image.open(PACKAGE / (version + '/exports/maskable-icon-' + str(size) + 'x' + str(size) + '.png')) as image:
                cx = cy = (size - 1) / 2
                maximum = 0
                for y in range(size):
                    for x in range(size):
                        r, g, b = image.getpixel((x, y))
                        if max(r, g, b) < 160 or (g-r > 12 and g-b > 30) or (r-g > 20 and r-b > 15):
                            maximum = max(maximum, math.hypot(x-cx, y-cy))
                self.assertLessEqual(maximum, size * .4)

    def test_character_pixels_come_from_original_and_exclude_wordmark(self):
        recipe = json.loads((PACKAGE / 'v2/source/extraction-recipe.json').read_text())
        with Image.open(PACKAGE / 'v1/source/trainer-original.jpg') as original:
            source = original.convert('RGB').crop(recipe['sourceBounds'])
        with Image.open(PACKAGE / 'v2/source/character-alpha.png') as mask:
            with Image.open(PACKAGE / 'v2/master/character-on-white.png') as character:
                # Every included native pixel is identical; every excluded one is white.
                expected = Image.new('RGB', mask.size, 'white')
                expected.paste(source, (0, 0), mask)
                self.assertIsNone(ImageChops.difference(expected, character).getbbox())
            x0, y0, _, _ = recipe['sourceBounds']
            self.assertIsNone(mask.crop((255-x0, 467-y0, 440-x0, mask.height)).getbbox())
        with Image.open(PACKAGE / 'v2/master/icon.png') as icon:
            bottom = icon.crop((0, 830, 1024, 1024))
            self.assertIsNone(ImageChops.difference(bottom, Image.new('RGB', bottom.size, 'white')).getbbox())

    def test_icon_and_brand_logo_have_distinct_roles(self):
        self.assertEqual((APP / 'public/logo.svg').read_bytes(),
                         (PACKAGE / 'v1/master/icon.svg').read_bytes())
        self.assertEqual((APP / 'public/app-icon.svg').read_bytes(),
                         (PACKAGE / 'v4/master/icon.svg').read_bytes())
        self.assertNotEqual((APP / 'public/logo.svg').read_bytes(),
                            (APP / 'public/app-icon.svg').read_bytes())
        svg = (PACKAGE / 'v4/master/icon.svg').read_text()
        encoded = re.search(r'data:image/png;base64,([^\"]+)', svg).group(1)
        self.assertEqual(base64.b64decode(encoded), (PACKAGE / 'v4/master/icon.png').read_bytes())
        self.assertIn('href="/app-icon.svg"', (APP / 'index.html').read_text())

    def test_historical_original_is_still_protected(self):
        root = self.fixture()
        path = root / 'brand/fitory/v1/source/trainer-original.jpg'; path.chmod(0o644)
        path.write_bytes(path.read_bytes() + b'changed')
        self.assertNotEqual(self.node_check(root).returncode, 0)

    def test_user_supplied_originals_are_unchanged_and_primary_is_first(self):
        version = PACKAGE / 'v3'
        catalog = json.loads((version / 'source/asset-catalog.json').read_text())
        self.assertEqual(len(catalog['files']), 3)
        self.assertEqual(catalog['files'][0]['attachmentOrder'], 1)
        self.assertEqual(catalog['files'][0]['role'], 'primary')
        self.assertEqual(catalog['files'][0]['originalFilename'], 'TalkMedia_i_6b4a52ad747b.png.png')
        for item in catalog['files']:
            self.assertEqual(hashlib.sha256((version / item['path']).read_bytes()).hexdigest(), item['sha256'])
        primary = (version / catalog['primary']).read_bytes()
        self.assertEqual(hashlib.sha256(primary).hexdigest(),
                         'ba8c8a977f31ea284b170357fdd7e4990134a2e1ebbd78755f2b3b09f18582b6')
        self.assertEqual(primary, (version / 'master/icon.png').read_bytes())
        self.assertEqual(primary, (version / 'exports/fitory-icon-original.png').read_bytes())

    def test_alternative_replacement_is_also_blocked(self):
        root = self.fixture()
        path = root / 'brand/fitory/v3/alternates/fitory-icon-alt-running-cream.png'
        path.chmod(0o644)
        path.write_bytes(path.read_bytes() + b'changed')
        self.assertNotEqual(self.node_check(root).returncode, 0)

    def test_v3_maskable_preserves_layout_and_essential_regions(self):
        version = PACKAGE / 'v3'
        lock = json.loads((version / 'asset-lock.json').read_text())
        native = lock['nativeSize'][0]
        for size in (192, 512):
            self.assertEqual((version / ('exports/maskable-icon-' + str(size) + 'x' + str(size) + '.png')).read_bytes(),
                             (version / ('exports/pwa-' + str(size) + 'x' + str(size) + '.png')).read_bytes())
            center = (size - 1) / 2
            for region in lock['renderer']['essentialRegions'].values():
                x0, y0, x1, y1 = region
                for x, y in ((x0, y0), (x0, y1), (x1, y0), (x1, y1)):
                    self.assertLess(math.hypot(x * size/native-center, y * size/native-center), size * .4)

    def test_v4_preserves_original_character_core_pixels(self):
        recipe = json.loads((PACKAGE / 'v4/source/preparation-recipe.json').read_text())
        with Image.open(PACKAGE / 'v3/source/fitory-icon-primary-lime-dumbbell.png') as original:
            cropped = original.convert('RGB').crop(recipe['cropBox'])
        with Image.open(PACKAGE / 'v4/master/icon.png') as prepared:
            self.assertEqual(prepared.size, (1094, 1094))
            lock = json.loads((PACKAGE / 'v4/asset-lock.json').read_text())
            for region in lock['renderer']['essentialRegions'].values():
                self.assertIsNone(ImageChops.difference(cropped.crop(region), prepared.crop(region)).getbbox())

    def test_v4_has_no_white_presentation_margin(self):
        for relative in ('master/icon.png', 'exports/apple-touch-icon-180x180.png',
                         'exports/pwa-512x512.png', 'exports/fitory-icon-1024.png'):
            with Image.open(PACKAGE / 'v4' / relative) as icon:
                width, height = icon.size
                # The white character may touch lower edges; the top and corners
                # must be lime, not the old white presentation frame or shadow.
                points = [(x, 0) for x in range(width)]
                points += [(x, y) for x in (0, width-1) for y in (0, height-1)]
                for point in points:
                    r, g, b = icon.convert('RGB').getpixel(point)
                    self.assertGreater(g, 220)
                    self.assertLess(b, 120)

    def test_changed_preparation_preserves_existing_outputs(self):
        root = self.fixture()
        path = root / 'brand/fitory/prepare_fullbleed.py'
        path.write_text(path.read_text().replace("recipe['edgeFeatherPixels']", '5'))
        exports = root / 'brand/fitory/v4/exports'; expected = hashes(exports)
        result = subprocess.run(['python3', str(root / 'brand/fitory/build_assets.py'), 'export'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Non-identical preparation', result.stderr)
        self.assertEqual(hashes(exports), expected)


if __name__ == '__main__':
    unittest.main(verbosity=2)
