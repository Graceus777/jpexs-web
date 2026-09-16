import ast
import contextlib
import hashlib
import importlib.util
import io
import json
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest import mock

from PIL import Image, ImageChops, ImageDraw, features


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("manual_clipper", ROOT / "clipper" / "prepare.py")
clipper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(clipper)


class ClipperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source.png"
        self.mask = self.root / "mask.png"
        self.output = self.root / "output"
        Image.new("RGBA", clipper.TEMPLATE_SIZE, (200, 100, 50, 255)).save(self.source)

    def color_mask(self, region, box=None):
        image = Image.new("RGB", clipper.TEMPLATE_SIZE)
        if box is None:
            box = clipper.CROPS[region]
        image.paste(clipper.SLOT_COLORS[region], box)
        image.save(self.mask)
        return image

    def run_prepare(self, modtype="TOP", overfit=0):
        return clipper.prepare(self.source, self.mask, modtype, overfit, self.output)

    def assert_image_equal(self, actual, expected):
        self.assertEqual(actual.mode, expected.mode)
        self.assertEqual(actual.size, expected.size)
        self.assertEqual(actual.tobytes(), expected.tobytes())

    def read_bitmap(self, bitmap_id):
        with Image.open(self.output / "images" / f"{bitmap_id}.png") as image:
            self.assertEqual(image.format, "PNG")
            return image.copy()

    def test_bundled_swf_bitmap_ids_and_sizes(self):
        for modtype, filename in clipper.TEMPLATES.items():
            with self.subTest(modtype=modtype):
                data = (clipper.TEMPLATE_DIR / filename).read_bytes()
                self.assertIn(data[:3], (b"FWS", b"CWS"))
                body = zlib.decompress(data[8:]) if data[:3] == b"CWS" else data[8:]
                self.assertEqual(len(body) + 8, struct.unpack_from("<I", data, 4)[0])
                rect_bits = body[0] >> 3
                offset = (5 + 4 * rect_bits + 7) // 8 + 4
                bitmaps = {}
                while offset < len(body):
                    header = struct.unpack_from("<H", body, offset)[0]
                    offset += 2
                    tag, length = header >> 6, header & 63
                    if length == 63:
                        length = struct.unpack_from("<I", body, offset)[0]
                        offset += 4
                    if tag in (20, 36):
                        bitmap_id, bitmap_format, width, height = struct.unpack_from("<HBHH", body, offset)
                        bitmaps[bitmap_id] = (width, height)
                    offset += length
                    if tag == 0:
                        break
                for bitmap_id, size in clipper.BITMAPS[modtype].values():
                    self.assertEqual(bitmaps[bitmap_id], size)

    def test_all_bundled_masks_and_partition(self):
        source = Image.new("RGBA", clipper.TEMPLATE_SIZE, (80, 120, 200, 97))
        for region in clipper.REGION_ORDER:
            with self.subTest(region=region):
                mask = clipper.anatomical_mask(region)
                self.assertEqual(mask.size, clipper.TEMPLATE_SIZE)
                self.assertIsNotNone(mask.getbbox())
                self.assertEqual(set(mask.tobytes()), {0, 255})
                with Image.open(clipper.TEMPLATE_DIR / f"{region}.png") as original:
                    if original.mode == "RGBA":
                        expected_bytes = bytes(255 if alpha > 127 else 0
                                               for alpha in original.getchannel("A").tobytes())
                    else:
                        rgb = original.convert("RGB").tobytes()
                        expected_bytes = bytes(255 if min(rgb[i:i + 3]) < 250 else 0
                                               for i in range(0, len(rgb), 3))
                    expected = Image.new("L", clipper.TEMPLATE_SIZE)
                    expected.paste(Image.frombytes("L", original.size, expected_bytes), (0, 0))
                self.assert_image_equal(mask, expected)
                modtype = "TOP" if region in clipper.REGIONS["TOP"] else "BOTTOMS"
                pieces = clipper.extract_pieces(source, mask.convert("RGBA"), modtype)
                self.assertIn(region, pieces)
                expected_alpha = mask.point([97 if value else 0 for value in range(256)])
                self.assert_image_equal(pieces[region].getchannel("A"), expected_alpha)

    def test_cross_dilation_not_square_or_wrapped(self):
        mask = Image.new("L", (5, 5))
        mask.putpixel((2, 2), 255)
        result = clipper.dilate_cross(mask)
        selected = {(x, y) for y in range(5) for x in range(5) if result.getpixel((x, y))}
        self.assertEqual(selected, {(2, 2), (1, 2), (3, 2), (2, 1), (2, 3)})
        mask = Image.new("L", (5, 5))
        mask.putpixel((0, 0), 255)
        result = clipper.dilate_cross(mask)
        self.assertEqual(result.histogram()[255], 3)
        self.assertEqual(result.getpixel((4, 0)), 0)

    def test_binary_preserves_alpha_holes_and_single_pixels(self):
        source = Image.new("RGBA", clipper.TEMPLATE_SIZE, (200, 100, 50, 73))
        mask = clipper.anatomical_mask("rightBreast")
        coordinates = [(x, y) for y in range(500, 600) for x in range(700, 800)
                       if mask.getpixel((x, y))]
        x, y = coordinates[len(coordinates) // 2]
        source.putpixel((x, y), (255, 0, 0, 0))
        mask.putpixel((x + 1, y), 0)
        pieces = clipper.extract_pieces(source, mask.convert("RGBA"), "TOP")
        alpha = pieces["rightBreast"].getchannel("A")
        self.assertEqual(alpha.getpixel((x, y)), 0)
        self.assertEqual(alpha.getpixel((x + 1, y)), 0)
        self.assertEqual(alpha.getextrema()[1], 73)
        selection = Image.new("L", clipper.TEMPLATE_SIZE)
        selection.putpixel((x, y), 255)
        source.putpixel((x, y), (200, 100, 50, 1))
        pieces = clipper.extract_pieces(source, selection.convert("RGBA"), "TOP")
        self.assertEqual(pieces["rightBreast"].getchannel("A").histogram()[1], 1)

    def test_mask_alpha_and_binary_threshold(self):
        mask = Image.new("RGBA", (4, 1))
        mask.putdata([(255, 255, 255, 0), (127, 127, 127, 255),
                      (128, 128, 128, 255), (255, 255, 255, 127)])
        kind, selected = clipper.decode_mask(mask)
        self.assertEqual(kind, "binary")
        self.assertEqual([selected.getpixel((x, 0)) for x in (0, 256, 512, 768)], [0, 0, 255, 0])

    def test_color_labels_exact_and_authoritative(self):
        source = Image.new("RGBA", clipper.TEMPLATE_SIZE, (120, 80, 40, 31))
        mask = Image.new("RGBA", clipper.TEMPLATE_SIZE)
        mask.putpixel((0, 0), (*clipper.SLOT_COLORS["under"], 255))
        pieces = clipper.extract_pieces(source, mask, "TOP")
        self.assertEqual(list(pieces), ["under"])
        self.assertEqual(pieces["under"].getpixel((0, 0)), (120, 80, 40, 31))
        self.assertEqual(pieces["under"].getchannel("A").histogram()[31], 1)
        mask.putpixel((1, 0), (254, 0, 255, 255))
        with self.assertRaisesRegex(ValueError, "exact"):
            clipper.extract_pieces(source, mask, "TOP")
        mask.putpixel((1, 0), (254, 0, 255, 0))
        self.assertIn("under", clipper.extract_pieces(source, mask, "TOP"))

    def test_palette_png_mask(self):
        rgb = self.color_mask("under")
        rgb.convert("P", palette=Image.Palette.ADAPTIVE, colors=2).save(self.mask)
        self.assertEqual(self.run_prepare()["regions"], ["under"])

    def test_color_mask_nearest_normalization(self):
        mask = Image.new("RGBA", (2, 2), (*clipper.SLOT_COLORS["rightArm"], 255))
        mask.putpixel((0, 0), (0, 0, 0, 255))
        kind, labels = clipper.decode_mask(mask)
        self.assertEqual(kind, "color")
        self.assertEqual(labels.size, clipper.TEMPLATE_SIZE)
        self.assertEqual(labels.getpixel((511, 639)), (0, 0, 0))
        self.assertEqual(labels.getpixel((512, 640)), clipper.SLOT_COLORS["rightArm"])

    def test_all_seven_dimensions_and_missing_blanks(self):
        for modtype, region, present in (("TOP", "under", {30}),
                                         ("BOTTOMS", "rightCalf", {8, 20})):
            with self.subTest(modtype=modtype):
                self.output = self.root / modtype
                self.color_mask(region)
                result = self.run_prepare(modtype)
                self.assertEqual(result["regions"], [region])
                self.assertTrue(Path(result["template"]).is_absolute())
                self.assertEqual(Path(result["template"]).name, clipper.TEMPLATES[modtype])
                files = {path.name for path in (self.output / "images").iterdir()}
                self.assertEqual(files, {f"{bitmap_id}.png" for bitmap_id, _ in clipper.BITMAPS[modtype].values()})
                for bitmap_id, size in clipper.BITMAPS[modtype].values():
                    image = self.read_bitmap(bitmap_id)
                    self.assertEqual(image.mode, "RGBA")
                    self.assertEqual(image.size, size)
                    self.assertEqual(image.getchannel("A").getbbox() is not None, bitmap_id in present)
                    if bitmap_id not in present:
                        self.assertEqual(set(image.tobytes()), {0})

    def test_binary_output_preserves_source_transparency(self):
        source = Image.new("RGBA", clipper.TEMPLATE_SIZE, (200, 100, 50, 73))
        source.paste((200, 100, 50, 0), (730, 550, 760, 580))
        source.save(self.source)
        mask = clipper.anatomical_mask("rightBreast")
        mask.save(self.mask)
        self.run_prepare()
        expected = source.crop((680, 469, 848, 713))
        expected.putalpha(ImageChops.darker(expected.getchannel("A"),
                                           mask.crop((680, 469, 848, 713))))
        actual = self.read_bitmap(39)
        self.assert_image_equal(actual, expected)
        self.assertEqual(actual.getpixel((60, 90))[3], 0)
        self.assertEqual(actual.getchannel("A").getextrema()[1], 73)
        self.assert_image_equal(self.read_bitmap(33), clipper.paired_piece(expected, True))

    def test_under_binary_included(self):
        clipper.anatomical_mask("under").save(self.mask)
        self.assertIn("under", self.run_prepare()["regions"])
        self.assertIsNotNone(self.read_bitmap(30).getchannel("A").getbbox())

    def test_pairing_mirror_darken_and_alpha(self):
        piece = Image.new("RGBA", (256, 1))
        piece.putdata([(value, 255 - value, value, value) for value in range(256)])
        for mirror in (False, True):
            actual = clipper.paired_piece(piece, mirror)
            for x in range(256):
                original = piece.getpixel((255 - x if mirror else x, 0))
                expected = tuple(value * 4 // 5 for value in original[:3]) + (original[3],)
                self.assertEqual(actual.getpixel((x, 0)), expected)

    def test_fixed_crop_overfit_rotation_geometry(self):
        source = Image.new("RGBA", clipper.TEMPLATE_SIZE)
        draw = ImageDraw.Draw(source)
        draw.polygon([(430, 670), (700, 690), (680, 860), (470, 790)], fill=(180, 100, 40, 210))
        draw.rectangle((500, 720, 550, 760), fill=(30, 70, 130, 80))
        for region, box in (("chestTop", (363, 475, 783, 934)),
                            ("chestBot", (405, 662, 722, 934)),
                            ("backTop", (358, 361, 797, 828))):
            for overfit in (0, 4, 12):
                with self.subTest(region=region, overfit=overfit):
                    expected = source.crop(box)
                    width, height = expected.size
                    if overfit:
                        expected = expected.resize((width + 2 * overfit, height + 2 * overfit), Image.Resampling.LANCZOS)
                        expected = expected.crop((overfit, overfit, overfit + width, overfit + height))
                    if region.startswith("chest"):
                        expected = expected.rotate(27.565029053490893, resample=Image.Resampling.BICUBIC, expand=True)
                        alpha = expected.getchannel("A").tobytes()
                        positions = [i for i, value in enumerate(alpha) if value > 10]
                        xs = [i % expected.width for i in positions]
                        ys = [i // expected.width for i in positions]
                        expected = expected.crop((min(xs), min(ys), max(xs) + 1, max(ys) + 1))
                    self.assert_image_equal(clipper.transform_piece(source, region, overfit), expected)

    def test_short_calf_keeps_fixed_canvas(self):
        self.color_mask("rightCalf", (100, 1150, 200, 1180))
        self.run_prepare("BOTTOMS")
        right = self.read_bitmap(20)
        self.assertEqual(right.size, (776, 147))
        bounds = right.getchannel("A").getbbox()
        self.assertGreater(bounds[0], 50)
        self.assertLess(bounds[2], 170)
        self.assertLess(bounds[3], 60)

    def test_empty_transparent_nonoverlap_and_mismatch_rejected(self):
        for name, mask, modtype in (
            ("empty", Image.new("L", clipper.TEMPLATE_SIZE), "TOP"),
            ("nonoverlap", Image.new("L", clipper.TEMPLATE_SIZE), "TOP"),
            ("mismatch", clipper.anatomical_mask("rightCalf"), "TOP"),
        ):
            with self.subTest(name=name):
                if name == "nonoverlap":
                    mask.paste(255, (0, 0, 50, 50))
                mask.save(self.mask)
                with self.assertRaises(ValueError):
                    self.run_prepare(modtype)
                self.assertFalse(self.output.exists())
        self.color_mask("rightArm")
        Image.new("RGBA", clipper.TEMPLATE_SIZE).save(self.source)
        with self.assertRaises(ValueError):
            self.run_prepare()
        Image.new("L", clipper.TEMPLATE_SIZE, 255).save(self.mask)
        with self.assertRaises(ValueError):
            self.run_prepare()
        self.assertFalse(self.output.exists())

    def test_color_modtype_mismatch_and_outside_crop_rejected(self):
        self.color_mask("rightCalf")
        with self.assertRaisesRegex(ValueError, "mismatch"):
            self.run_prepare()
        self.color_mask("under", (0, 0, 20, 20))
        with self.assertRaisesRegex(ValueError, "fixed template crops"):
            self.run_prepare()
        self.assertFalse(self.output.exists())

    def test_source_formats_and_normalization(self):
        self.color_mask("under")
        for image_format in ("PNG", "JPEG", "WEBP"):
            if image_format == "WEBP" and not features.check("webp"):
                continue
            with self.subTest(format=image_format):
                self.source = self.root / f"source.{image_format.lower()}"
                Image.new("RGB", (512, 640), (200, 100, 50)).save(self.source, image_format)
                self.assertEqual(self.run_prepare()["regions"], ["under"])
                self.assertEqual(self.read_bitmap(30).getchannel("A").getextrema(), (255, 255))

    def test_invalid_format_corrupt_truncated_and_animated(self):
        for image_format in ("GIF", "BMP", "TIFF"):
            path = self.root / "fake.png"
            Image.new("RGB", (10, 10)).save(path, image_format)
            with self.assertRaises(ValueError):
                clipper.load_image(path)
        Image.new("RGB", (10, 10)).save(self.mask, "JPEG")
        with self.assertRaisesRegex(ValueError, "Mask must be PNG"):
            clipper.load_image(self.mask, mask=True)
        self.mask.write_bytes(b"not an image")
        with self.assertRaises(ValueError):
            clipper.load_image(self.mask, mask=True)
        self.mask.write_bytes(self.source.read_bytes()[:-30])
        with self.assertRaises(ValueError):
            clipper.load_image(self.mask, mask=True)
        first = Image.new("RGBA", (10, 10), "red")
        first.save(self.mask, "PNG", save_all=True, append_images=[Image.new("RGBA", (10, 10), "blue")])
        with self.assertRaisesRegex(ValueError, "multi-frame"):
            clipper.load_image(self.mask, mask=True)

    def test_decoded_limits_before_loading(self):
        for size in ((4097, 1), (1, 4097), (4096, 4096), (0, 10)):
            with self.subTest(size=size):
                with self.assertRaises(ValueError):
                    clipper.validate_size(size)
        for size in ((4096, 1), (1, 4096), (4000, 4000)):
            clipper.validate_size(size)
        for is_mask in (False, True):
            with mock.patch.object(clipper.Image, "open") as opener:
                image = opener.return_value.__enter__.return_value
                image.size = (4096, 4096)
                with self.assertRaisesRegex(ValueError, "16,000,000"):
                    clipper.load_image(self.source, mask=is_mask)
                image.load.assert_not_called()
                image.verify.assert_not_called()
                image.convert.assert_not_called()
        Image.new("L", (4097, 1)).save(self.mask)
        with self.assertRaisesRegex(ValueError, "4096"):
            clipper.load_image(self.mask, mask=True)

    def test_invalid_options(self):
        self.color_mask("under")
        for overfit in (-1, 1.5, True, 100000):
            with self.subTest(overfit=overfit):
                with self.assertRaises(ValueError):
                    self.run_prepare(overfit=overfit)
        with self.assertRaisesRegex(ValueError, "modtype"):
            self.run_prepare("BODY")
        self.assertFalse(self.output.exists())

    def test_rerun_blanks_previous_slots_without_cleanup(self):
        self.color_mask("rightArm")
        self.run_prepare()
        marker = self.output / "keep.txt"
        marker.write_text("keep", encoding="utf-8")
        self.color_mask("under")
        self.run_prepare()
        self.assertIsNone(self.read_bitmap(45).getchannel("A").getbbox())
        self.assertIsNone(self.read_bitmap(27).getchannel("A").getbbox())
        self.assertEqual(marker.read_text(encoding="utf-8"), "keep")
        unrelated = self.output / "images" / "unrelated.png"
        unrelated.write_bytes(b"keep")
        with self.assertRaisesRegex(ValueError, "unrelated"):
            self.run_prepare()
        self.assertEqual(unrelated.read_bytes(), b"keep")

    def test_cli_json_from_other_working_directory(self):
        self.color_mask("under")
        result = subprocess.run([
            sys.executable, str(ROOT / "clipper" / "prepare.py"),
            "--image", str(self.source), "--mask", str(self.mask),
            "--modtype", "TOP", "--overfit-px", "4", "--output", str(self.output),
        ], cwd=self.root, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        payload = json.loads(result.stdout)
        self.assertEqual(set(payload), {"template", "regions"})
        self.assertEqual(payload["regions"], ["under"])
        self.assertTrue(Path(payload["template"]).is_file())
        self.assertEqual(len(list((self.output / "images").iterdir())), 7)

    def test_cli_validation_uses_stderr_only(self):
        Image.new("L", clipper.TEMPLATE_SIZE).save(self.mask)
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            status = clipper.main([
                "--image", str(self.source), "--mask", str(self.mask),
                "--modtype", "TOP", "--overfit-px", "0", "--output", str(self.output),
            ])
        self.assertEqual(status, 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("error:", stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())

    def test_upstream_constants_and_asset_bytes_when_available(self):
        upstream = ROOT.parent / "SDTSD6"
        converter = upstream / "utils" / "swf_converter.py"
        if not converter.is_file():
            self.skipTest("Optional upstream checkout not available")
        tree = ast.parse(converter.read_text(encoding="utf-8"))
        constants = {node.target.id: ast.literal_eval(node.value)
                     for node in tree.body if isinstance(node, ast.AnnAssign)
                     and isinstance(node.target, ast.Name)
                     and node.target.id in {"TOP_STATIC_BITMAPS", "BOT_STATIC_BITMAPS", "TEMPLATE_REGION_CROP", "TEMPLATE_PIECE_ROTATION"}}
        self.assertEqual(clipper.BITMAPS["TOP"], constants["TOP_STATIC_BITMAPS"])
        self.assertEqual(clipper.BITMAPS["BOTTOMS"], constants["BOT_STATIC_BITMAPS"])
        for region, box in clipper.CROPS.items():
            self.assertEqual(box, constants["TEMPLATE_REGION_CROP"][region])
        self.assertEqual(clipper.ROTATIONS, constants["TEMPLATE_PIECE_ROTATION"])
        for asset in clipper.TEMPLATE_DIR.iterdir():
            original = upstream / "template" / asset.name
            self.assertEqual(hashlib.sha256(asset.read_bytes()).digest(),
                             hashlib.sha256(original.read_bytes()).digest(), asset.name)


if __name__ == "__main__":
    unittest.main()
