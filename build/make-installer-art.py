# build/make-installer-art.py — 生成 NSIS 安装器配图（24-bit BMP，无 alpha）
#   installerSidebar 164x314（白色简约侧栏，欢迎/完成页）
#   installerHeader  150x57（白色顶栏，目录/进度页）
# 另存同名 .png 供预览。版本号从 package.json 读取，改版后重跑即可。
import json
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ARIAL = r"C:\Windows\Fonts\arial.ttf"
ARIAL_BD = r"C:\Windows\Fonts\arialbd.ttf"
MSYH = r"C:\Windows\Fonts\msyh.ttc"

with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as f:
    VER = json.load(f).get("version", "")


def font(path, size):
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


def ctext(d, cx, y, s, fnt, fill):
    w = d.textlength(s, font=fnt)
    d.text((cx - w / 2, y), s, font=fnt, fill=fill)


def sidebar():
    W, H = 164, 314
    top, bot = (255, 255, 255), (240, 243, 247)
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        t = y / (H - 1)
        c = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3))
        for x in range(W):
            px[x, y] = c
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.ellipse((-70, -70, 150, 120), fill=(210, 227, 252, 120))
    g.ellipse((30, 200, 230, 380), fill=(243, 232, 255, 100))
    glow = glow.filter(ImageFilter.GaussianBlur(28))
    img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
    d = ImageDraw.Draw(img)
    icon = load_icon(68)
    if icon is not None:
        img.paste(icon, (46, 42), icon)
    else:
        d.ellipse((57, 42, 107, 92), outline=(26, 115, 232), width=3)
    ctext(d, W / 2, 120, "DeepSeek", font(ARIAL_BD, 17), (31, 31, 31))
    ctext(d, W / 2, 142, "Harness", font(ARIAL_BD, 17), (31, 31, 31))
    ctext(d, W / 2, 172, "桌面壳 · 开箱即用", font(MSYH, 11), (95, 99, 104))
    d.line((28, 202, 136, 202), fill=(218, 220, 224))
    ctext(d, W / 2, 212, "默认 D 盘 · 可改路径", font(MSYH, 10), (95, 99, 104))
    ctext(d, W / 2, 290, "v%s" % VER, font(ARIAL, 9), (154, 160, 166))
    return img


def header():
    W, H = 150, 57
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)
    icon = load_icon(36)
    if icon is not None:
        img.paste(icon, (8, 10), icon)
    else:
        d.ellipse((8, 10, 44, 46), outline=(26, 115, 232), width=2)
    f = font(ARIAL_BD, 10)
    if d.textlength("DeepSeek Harness", font=f) > 94:
        f = font(ARIAL_BD, 9)
    d.text((50, 12), "DeepSeek Harness", font=f, fill=(31, 31, 31))
    d.text((50, 30), "桌面安装程序", font=font(MSYH, 9), fill=(95, 99, 104))
    return img


sb = sidebar()
hd = header()
sb.save(os.path.join(HERE, "installerSidebar.bmp"), "BMP")
sb.save(os.path.join(HERE, "installerSidebar.png"), "PNG")
hd.save(os.path.join(HERE, "installerHeader.bmp"), "BMP")
hd.save(os.path.join(HERE, "installerHeader.png"), "PNG")
print("sidebar:", sb.size, sb.mode, "header:", hd.size, hd.mode, "version:", VER)
