# Link preview fonts

The preview renderer uses local SIL Open Font License 1.1 assets. Each font's license is
included beside it.

| Local file | Source | Changes |
| --- | --- | --- |
| `NotoSansCJK.otf` | [Noto Sans CJK SC Medium 2.004](https://github.com/notofonts/noto-cjk/blob/Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Medium.otf), © 2014–2021 Adobe | Retains all encoded characters, basic composition and positioning. Drops alternate glyphs and hinting. |
| `NotoSansArabic.ttf` | [Noto Sans Arabic](https://github.com/google/fonts/tree/5026800714d07231937d92eb4cceabf06e05d74e/ofl/notosansarabic) | Static instance at weight 500 and width 100. |
| `NotoSansHebrew.ttf` | [Noto Sans Hebrew](https://github.com/google/fonts/tree/5026800714d07231937d92eb4cceabf06e05d74e/ofl/notosanshebrew) | Static instance at weight 500 and width 100. |
| `NotoEmoji.ttf` | [Noto Emoji](https://github.com/google/fonts/tree/5026800714d07231937d92eb4cceabf06e05d74e/ofl/notoemoji) | Static monochrome instance at weight 500. |

The assets were generated with [FontTools 4.69.1](https://github.com/fonttools/fonttools/releases/tag/4.69.1).
Use `fonttools subset` with `--unicodes='*' --layout-features='ccmp,kern,mark,mkmk' --no-hinting`
for the CJK font. Use `fonttools varLib.instancer` with the axes in the table for the variable
fonts. The CJK asset uses Simplified Chinese variants when scripts share a code point.
