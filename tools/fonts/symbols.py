# 从 Iosevka 里抠出终端常用的符号，做成 web/public/fonts/moco-symbols.woff2，挂在终端字体后面。
# iOS 的等宽字体没有 ⏺ 这类符号，系统会拿 Apple Color Emoji 顶上，画出两格宽的彩色图标，后一格把它盖掉一半。
# 默认显示成 emoji 的字（东亚宽度 W/F，比如 ✅⚡）不收，让它们照常走 emoji。
# 制表符和方块要拼成连续的线和面（Claude Code 的小人、分隔线）。xterm.js 的 DOM 渲染器照字体画，不会把字形撑满格子；
# Iosevka 的字只有 0.5em 宽、1.25em 高，放进 JetBrains Mono、Fira Code 0.6em 宽、1.32em 高的格子里，横竖都露缝。
# 所以把这两段拉到 0.6em 宽，上下各多出一点，相邻的格子叠上而不是留缝。
# 用法：cd web && pnpm install && python3 ../tools/fonts/symbols.py
import shutil
import unicodedata
from pathlib import Path

from fontTools import subset
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

web = Path(__file__).resolve().parents[2] / 'web'
pkg = web / 'node_modules/@fontsource/iosevka'
out = web / 'public/fonts'

RANGES = [
    (0x2190, 0x21FF),  # 箭头
    (0x2300, 0x23FF),  # 技术符号：⏺ ⏵ ⎿
    (0x2500, 0x259F),  # 制表符、方块
    (0x25A0, 0x25FF),  # 几何图形：● ◐
    (0x2600, 0x26FF),  # 杂项符号
    (0x2700, 0x27BF),  # 装饰符号：❯ ✻ ✶
    (0x2800, 0x28FF),  # 盲文，转圈动画常用
    (0x2B00, 0x2BFF),  # 杂项符号和箭头
]

font = TTFont(pkg / 'files/iosevka-latin-400-normal.woff2')
cmap = font.getBestCmap()
wanted = [
    cp for lo, hi in RANGES for cp in range(lo, hi + 1)
    if cp in cmap and unicodedata.east_asian_width(chr(cp)) not in ('W', 'F')
]
opts = subset.Options()
opts.flavor = 'woff2'
opts.layout_features = []
opts.name_IDs = ['*']
sub = subset.Subsetter(opts)
sub.populate(unicodes=wanted)
sub.subset(font)

STRETCH = (0x2500, 0x259F)  # 制表符、方块
WIDTH = 600                 # 1000 单位一个 em
TOP, BOTTOM = 1060, -360    # JetBrains Mono 是 1020/-300，Fira Code 是 990/-322
SRC_TOP, SRC_BOTTOM = 965, -285
sx = WIDTH / 500
sy = (TOP - BOTTOM) / (SRC_TOP - SRC_BOTTOM)
glyphs = font.getGlyphSet()
stretched = {}
for cp, name in font.getBestCmap().items():
    if STRETCH[0] <= cp <= STRETCH[1]:
        # 有的字是拿别的字拼的：先拆成轮廓，全算完再写回去，免得拼进来的那个已经拉过一次
        outline = DecomposingRecordingPen(glyphs)
        glyphs[name].draw(outline)
        pen = TTGlyphPen(None)
        outline.replay(TransformPen(pen, (sx, 0, 0, sy, 0, BOTTOM - SRC_BOTTOM * sy)))
        stretched[name] = pen.glyph()
for name, glyph in stretched.items():
    font['glyf'][name] = glyph
    glyph.recalcBounds(font['glyf'])
    font['hmtx'][name] = (WIDTH, getattr(glyph, 'xMin', 0))
out.mkdir(parents=True, exist_ok=True)
font.flavor = 'woff2'
font.save(out / 'moco-symbols.woff2')
shutil.copy(pkg / 'LICENSE', out / 'moco-symbols-LICENSE.txt')
print(f'{len(wanted)} 个字形，{(out / "moco-symbols.woff2").stat().st_size // 1024}KB')
