from __future__ import annotations

import argparse
import json
import sys
import warnings
from pathlib import Path

from PIL import Image, ImageChops


TEMPLATE_DIR = Path(__file__).resolve().parent / "template"
TEMPLATE_SIZE = (1024, 1280)
MAX_DIMENSION = 4096
MAX_PIXELS = 16_000_000

BITMAPS = {
    "TOP": {
        "leftArm": (27, (127, 430)),
        "under": (30, (182, 230)),
        "leftBreast": (33, (168, 244)),
        "chest": (36, (274, 561)),
        "rightBreast": (39, (168, 244)),
        "back": (42, (439, 467)),
        "rightArm": (45, (127, 430)),
    },
    "BOTTOMS": {
        "backside": (5, (200, 162)),
        "leftCalf": (8, (779, 146)),
        "leftThigh": (11, (583, 487)),
        "chest": (14, (267, 311)),
        "rightThigh": (17, (583, 498)),
        "rightCalf": (20, (776, 147)),
        "back": (23, (278, 224)),
    },
}
TEMPLATES = {"TOP": "top_static.swf", "BOTTOMS": "bot_static.swf"}
REGIONS = {
    "TOP": {"chestTop", "backTop", "rightBreast", "rightArm", "under"},
    "BOTTOMS": {"chestBot", "backBot", "backside", "rightThigh_tt", "rightCalf"},
}
REGION_ORDER = (
    "backTop", "backBot", "backside", "rightCalf", "rightThigh_tt",
    "under", "chestTop", "rightBreast", "chestBot", "rightArm",
)
CROPS = {
    "chestTop": (363, 475, 783, 934),
    "chestBot": (405, 662, 722, 934),
    "backTop": (358, 361, 797, 828),
    "backBot": (359, 604, 637, 828),
    "backside": (255, 741, 455, 903),
    "rightThigh_tt": (248, 751, 844, 1251),
    "rightCalf": (39, 1135, 815, 1280),
    "rightBreast": (680, 469, 848, 713),
    "rightArm": (640, 355, 785, 850),
    "under": (668, 361, 806, 591),
}
ROTATIONS = {"chestTop": 27.565029053490893, "chestBot": 27.565029053490893}
SLOT_NAMES = {
    "chestTop": "chest", "chestBot": "chest",
    "backTop": "back", "backBot": "back",
    "rightThigh_tt": "rightThigh",
}
PAIRS = {
    "rightArm": ("leftArm", True),
    "rightBreast": ("leftBreast", True),
    "rightThigh": ("leftThigh", False),
    "rightCalf": ("leftCalf", False),
}
SLOT_COLORS = {
    "chestTop": (255, 0, 0),
    "backTop": (0, 255, 0),
    "rightBreast": (0, 0, 255),
    "rightArm": (255, 255, 0),
    "under": (255, 0, 255),
    "chestBot": (0, 255, 255),
    "backBot": (255, 128, 0),
    "backside": (128, 0, 255),
    "rightThigh_tt": (128, 255, 0),
    "rightCalf": (255, 0, 128),
}


def validate_size(size: tuple[int, int]) -> None:
    width, height = size
    if not (0 < width <= MAX_DIMENSION and 0 < height <= MAX_DIMENSION):
        raise ValueError("Decoded dimensions must be between 1 and 4096 pixels each")
    if width * height > MAX_PIXELS:
        raise ValueError("Decoded image must not exceed 16,000,000 pixels")


def load_image(path: str | Path, *, mask: bool = False) -> Image.Image:
    formats = {"PNG"} if mask else {"PNG", "JPEG", "WEBP"}
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                validate_size(image.size)
                if image.format not in formats:
                    raise ValueError("Mask must be PNG" if mask else "Source must be PNG, JPEG or WebP")
                if getattr(image, "n_frames", 1) != 1:
                    raise ValueError("Animated or multi-frame images are not supported")
                image.verify()
            with Image.open(path) as image:
                validate_size(image.size)
                image.load()
                return image.convert("RGBA")
    except (OSError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError(f"Invalid {'mask' if mask else 'source'} image: {path}") from exc


def threshold(image: Image.Image, level: int = 127) -> Image.Image:
    return image.point([255 if value > level else 0 for value in range(256)])


def dilate_cross(mask: Image.Image) -> Image.Image:
    result = mask.copy()
    width, height = mask.size
    for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        shifted = Image.new("L", mask.size)
        shifted.paste(mask, (dx, dy, dx + width, dy + height))
        result = ImageChops.lighter(result, shifted)
    return result


def anatomical_mask(region: str, *, dilate: bool = False) -> Image.Image:
    if region not in CROPS:
        raise ValueError(f"Unknown region: {region}")
    with Image.open(TEMPLATE_DIR / f"{region}.png") as image:
        if image.mode == "RGBA":
            mask = threshold(image.getchannel("A"))
        else:
            red, green, blue = image.convert("RGB").split()
            minimum = ImageChops.darker(ImageChops.darker(red, green), blue)
            mask = minimum.point([255 if value < 250 else 0 for value in range(256)])
    if dilate:
        mask = dilate_cross(mask)
    canvas = Image.new("L", TEMPLATE_SIZE)
    canvas.paste(mask, (0, 0))
    return canvas


def apply_selection(source: Image.Image, selection: Image.Image) -> Image.Image:
    piece = source.copy()
    piece.putalpha(ImageChops.darker(source.getchannel("A"), selection))
    return piece


def exact_color_mask(rgb: Image.Image, color: tuple[int, int, int]) -> Image.Image:
    channels = [channel.point([255 if value == target else 0 for value in range(256)])
                for channel, target in zip(rgb.split(), color)]
    return ImageChops.darker(ImageChops.darker(channels[0], channels[1]), channels[2])


def decode_mask(mask: Image.Image) -> tuple[str, Image.Image]:
    rgb = mask.convert("RGB")
    opaque = threshold(mask.getchannel("A"))
    red, green, blue = rgb.split()
    chroma = ImageChops.lighter(ImageChops.difference(red, green), ImageChops.difference(red, blue))
    if not ImageChops.multiply(chroma, opaque).getbbox():
        selection = ImageChops.darker(threshold(red), opaque)
        return "binary", selection.resize(TEMPLATE_SIZE, Image.Resampling.NEAREST)
    claimed = exact_color_mask(rgb, (0, 0, 0))
    for color in SLOT_COLORS.values():
        claimed = ImageChops.lighter(claimed, exact_color_mask(rgb, color))
    unknown = ImageChops.subtract(opaque, claimed)
    if unknown.getbbox():
        raise ValueError("Color masks must use only exact SLOT_COLORS, black or transparency")
    rgb.paste((0, 0, 0), mask=ImageChops.invert(opaque))
    return "color", rgb.resize(TEMPLATE_SIZE, Image.Resampling.NEAREST)


def extract_pieces(source: Image.Image, mask: Image.Image, modtype: str) -> dict[str, Image.Image]:
    source = source.resize(TEMPLATE_SIZE, Image.Resampling.LANCZOS)
    kind, selection = decode_mask(mask)
    pieces = {}
    if kind == "binary":
        selected = apply_selection(source, selection)
        visible = threshold(selected.getchannel("A"), 0)
        count = visible.histogram()[255]
        if not count:
            raise ValueError("Mask selects no visible source pixels")
        for region in REGION_ORDER:
            overlap = ImageChops.darker(visible, anatomical_mask(region)).histogram()[255]
            minimum = 0.015 if region == "rightArm" else 0.05
            if overlap / count >= minimum:
                pieces[region] = apply_selection(selected, anatomical_mask(region, dilate=True))
    else:
        for region in REGION_ORDER:
            piece = apply_selection(source, exact_color_mask(selection, SLOT_COLORS[region]))
            if piece.getchannel("A").getbbox():
                pieces[region] = piece
    if not pieces:
        raise ValueError("Empty mask or no template overlap with visible source pixels")
    pieces = {region: piece for region, piece in pieces.items() if region in REGIONS[modtype]}
    if not pieces:
        raise ValueError(f"Mask does not overlap any {modtype} regions (modtype mismatch)")
    return pieces


def transform_piece(piece: Image.Image, region: str, overfit_px: int) -> Image.Image:
    piece = piece.crop(CROPS[region])
    if overfit_px:
        width, height = piece.size
        expanded = (width + 2 * overfit_px, height + 2 * overfit_px)
        validate_size(expanded)
        piece = piece.resize(expanded, Image.Resampling.LANCZOS)
        piece = piece.crop((overfit_px, overfit_px, overfit_px + width, overfit_px + height))
    if region in ROTATIONS:
        piece = piece.rotate(ROTATIONS[region], resample=Image.Resampling.BICUBIC, expand=True)
        bounds = threshold(piece.getchannel("A"), 10).getbbox()
        if bounds:
            piece = piece.crop(bounds)
    return piece


def paired_piece(piece: Image.Image, mirror: bool) -> Image.Image:
    if mirror:
        piece = piece.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    red, green, blue, alpha = piece.split()
    table = [value * 4 // 5 for value in range(256)]
    return Image.merge("RGBA", (red.point(table), green.point(table), blue.point(table), alpha))


def prepare(image: str | Path, mask: str | Path, modtype: str,
            overfit_px: int, output: str | Path) -> dict:
    if modtype not in BITMAPS:
        raise ValueError("modtype must be TOP or BOTTOMS")
    if type(overfit_px) is not int or overfit_px < 0:
        raise ValueError("overfit-px must be a nonnegative integer")
    for region in REGIONS[modtype]:
        left, top, right, bottom = CROPS[region]
        validate_size((right - left + 2 * overfit_px, bottom - top + 2 * overfit_px))
    template = (TEMPLATE_DIR / TEMPLATES[modtype]).resolve()
    if not template.is_file():
        raise ValueError(f"Bundled template is missing: {template}")
    source = load_image(image)
    manual_mask = load_image(mask, mask=True)
    pieces = extract_pieces(source, manual_mask, modtype)
    processed = {}
    regions = []
    for region, piece in pieces.items():
        piece = transform_piece(piece, region, overfit_px)
        if piece.getchannel("A").getbbox():
            processed[SLOT_NAMES.get(region, region)] = piece
            regions.append(region)
    if not processed:
        raise ValueError("Selection has no visible pixels inside the fixed template crops")
    for right, (left, mirror) in PAIRS.items():
        if right in processed:
            processed[left] = paired_piece(processed[right], mirror)
    bitmaps = {}
    for slot, (bitmap_id, size) in BITMAPS[modtype].items():
        piece = processed.get(slot)
        bitmaps[bitmap_id] = (piece.resize(size, Image.Resampling.LANCZOS) if piece is not None
                              else Image.new("RGBA", size))
    if not any(piece.getchannel("A").getbbox() for piece in bitmaps.values()):
        raise ValueError("Selection is empty after bitmap sizing")
    images_dir = Path(output) / "images"
    expected = {f"{bitmap_id}.png" for bitmap_id in bitmaps}
    if images_dir.exists() and any(path.name not in expected or not path.is_file()
                                   for path in images_dir.iterdir()):
        raise ValueError("Output images directory contains unrelated files; use a fresh output directory")
    images_dir.mkdir(parents=True, exist_ok=True)
    for bitmap_id, piece in bitmaps.items():
        piece.save(images_dir / f"{bitmap_id}.png", "PNG")
    return {"template": str(template), "regions": regions}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Prepare manual costume bitmaps for FFDec -importImages")
    parser.add_argument("--image", required=True, type=Path, help="PNG, JPEG or WebP source, at most 4096 per side / 16MP")
    parser.add_argument("--mask", required=True, type=Path, help="PNG: grayscale >127 keeps pixels; exact SLOT_COLORS route slots; alpha <=127 excludes")
    parser.add_argument("--modtype", required=True, choices=tuple(BITMAPS))
    parser.add_argument("--overfit-px", required=True, type=int, help="Nonnegative expansion per side; expanded crops must fit 4096 per side / 16MP")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = prepare(args.image, args.mask, args.modtype, args.overfit_px, args.output)
    except (ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
