import json
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ARIAL = r"C:\Windows\Fonts\arial.ttf"
ARIAL_BD = r"C:\Windows\Fonts\arialbd.ttf"
MSYH = r"C:\Windows\Fonts\msyh.ttc"
MSYH_BD = r"C:\Windows\Fonts\msyhbd.ttc"

with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as f:
    VER = json.load(f).get("version", "1.2.0")


def get_font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def load_icon(px):
    for name in ("assets/app-icon.png", "assets/whale-256.png"):
        p = os.path.join(ROOT, name)
        if os.path.exists(p):
            try:
                return Image.open(p).convert("RGBA").resize((px, px), Image.LANCZOS)
            except Exception:
                pass
    return None


def ctext(draw, cx, y, text, font, fill):
    w = draw.textlength(text, font=font)
    draw.text((cx - w / 2, y), text, font=font, fill=fill)


def make_dialog():
    W, H = 493, 312
    SIDE_W = 164

    # 1. Base image (Right area: clean white #FFFFFF)
    img = Image.new("RGB", (W, H), (255, 255, 255))

    # 2. Left sidebar gradient (#0F172A -> #1E3A8A -> #1D4ED8)
    sidebar_top = (15, 23, 42)     # #0F172A (slate-900)
    sidebar_mid = (30, 58, 138)    # #1E3A8A (blue-900)
    sidebar_bot = (29, 78, 216)    # #1D4ED8 (blue-700)

    side_img = Image.new("RGB", (SIDE_W, H))
    px = side_img.load()
    for y in range(H):
        t = y / (H - 1)
        if t < 0.5:
            t2 = t * 2.0
            c = tuple(int(sidebar_top[i] + (sidebar_mid[i] - sidebar_top[i]) * t2) for i in range(3))
        else:
            t2 = (t - 0.5) * 2.0
            c = tuple(int(sidebar_mid[i] + (sidebar_bot[i] - sidebar_mid[i]) * t2) for i in range(3))
        for x in range(SIDE_W):
            px[x, y] = c

    # Atmospheric glow effects
    glow = Image.new("RGBA", (SIDE_W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-40, -30, 140, 130), fill=(56, 189, 248, 70))   # sky-400
    gd.ellipse((20, 180, 200, 340), fill=(99, 102, 241, 60))    # indigo-500
    glow = glow.filter(ImageFilter.GaussianBlur(24))

    side_composite = Image.alpha_composite(side_img.convert("RGBA"), glow).convert("RGB")
    img.paste(side_composite, (0, 0))

    # Divider line between sidebar and right content
    d = ImageDraw.Draw(img)
    d.line((SIDE_W, 0, SIDE_W, H), fill=(226, 232, 240), width=1)  # #E2E8F0

    # Draw sidebar elements
    side_draw = ImageDraw.Draw(img)
    cx = SIDE_W / 2

    # App Icon with soft halo
    icon = load_icon(64)
    if icon is not None:
        img.paste(icon, (int(cx - 32), 34), icon)
    else:
        side_draw.ellipse((cx - 30, 34, cx + 30, 94), outline=(96, 165, 250), width=3)

    # Title
    ctext(side_draw, cx, 110, "DeepSeek", get_font(ARIAL_BD, 18), (255, 255, 255))
    ctext(side_draw, cx, 133, "Harness", get_font(ARIAL_BD, 18), (147, 197, 253))  # blue-300

    # Subtitle
    ctext(side_draw, cx, 163, "智能桌面工作台", get_font(MSYH, 11), (224, 231, 255))

    # Divider line in sidebar
    side_draw.line((24, 188, SIDE_W - 24, 188), fill=(71, 85, 105), width=1)

    # Bullet / feature highlights
    ctext(side_draw, cx, 202, "官方运行时 · 纯净解耦", get_font(MSYH, 9), (148, 163, 184))
    ctext(side_draw, cx, 222, "三核工作台 · 开箱即用", get_font(MSYH, 9), (148, 163, 184))

    # Version footer
    ctext(side_draw, cx, 282, f"v{VER}", get_font(ARIAL, 9), (100, 116, 139))

    return img


def make_banner():
    W, H = 493, 58

    # Clean header: soft light gradient #F8FAFC -> #FFFFFF
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)

    # Soft gradient background
    left_c = (248, 250, 252)   # #F8FAFC
    right_c = (255, 255, 255)
    px = img.load()
    for x in range(W):
        t = x / (W - 1)
        c = tuple(int(left_c[i] + (right_c[i] - left_c[i]) * t) for i in range(3))
        for y in range(H - 1):
            px[x, y] = c

    # Bottom border line
    d.line((0, H - 1, W, H - 1), fill=(226, 232, 240), width=1)

    # Icon on the right side
    icon = load_icon(42)
    if icon is not None:
        img.paste(icon, (W - 54, 8), icon)
    else:
        d.ellipse((W - 54, 8, W - 12, 50), outline=(59, 130, 246), width=2)

    return img


if __name__ == "__main__":
    dialog = make_dialog()
    banner = make_banner()

    dialog_bmp = os.path.join(HERE, "msiDialog.bmp")
    dialog_png = os.path.join(HERE, "msiDialog.png")
    banner_bmp = os.path.join(HERE, "msiBanner.bmp")
    banner_png = os.path.join(HERE, "msiBanner.png")

    dialog.save(dialog_bmp, "BMP")
    dialog.save(dialog_png, "PNG")
    banner.save(banner_bmp, "BMP")
    banner.save(banner_png, "PNG")

    print(f"Generated msiDialog: {dialog.size}, mode: {dialog.mode} -> {dialog_bmp}")
    print(f"Generated msiBanner: {banner.size}, mode: {banner.mode} -> {banner_bmp}")
