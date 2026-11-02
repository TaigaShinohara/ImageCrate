# ImageCrateのLiquid Glassアイコン

制作日: 2026-11-02。内蔵画像生成ツールで制作。

画像を選んでまとめて保存する用途を、重なった写真カード2枚と浅い透明なトレイで表す。既存UIのインディゴ（`#6351d9`）を基調に、白・シアン・ラベンダーの反射と厚いガラスの縁を使う。文字や保存状態を表す記号は含めない。

## ファイルと使用箇所

- `assets/branding/imagecrate-liquid-glass-source.png`: 生成原本、1254×1254、RGBA。生成後のデザイン加工なし。
- `assets/branding/imagecrate-liquid-glass-1024.png`: 1024×1024のPNG。共有・再書き出し用。
- `extension/icons/icon-{16,32,48,64,128}.png`: Chromeと作業画面用。原本からmacOSの`sips`で各サイズへ縮小。
- Manifestの`icons`と`action.default_icon`: 16／32／48／128px。
- 作業画面: ヘッダーは128px画像を38 CSS pxで表示。ページタイトルが名前を持つため画像の`alt`は空。faviconは16／32px。

角丸タイルの外側は透過。実行時に外部素材・フォント・通信・追加権限を使わない。通常Chromeへの反映には拡張機能の再読み込みと作業タブの開き直しが必要。

## 生成プロンプト

内蔵画像生成ツールを使用（`transparent_background: true`）。

```text
Use case: logo-brand
Asset type: production app icon for ImageCrate, a Chrome extension for choosing images and saving a collection.
Primary request: Create one refined Liquid Glass icon. The symbol is two overlapping photo cards held together in a small shallow transparent glass crate/tray. This is one bold unified symbol, not a collage.
Composition: square 1:1 canvas, large centered icon. A beautifully rounded square indigo backing tile occupies about 92% of the canvas, with a very small truly transparent outer margin. The card-and-tray symbol fills about 78% of the tile. Near-front view with subtle dimensional perspective, balanced and compact. Front card contains a large simple mountain silhouette and one round sun; back card offset slightly upward to communicate a collection. Tray is low with a thick rounded lip, no grid lines.
Style: polished contemporary Liquid Glass material, physically convincing thick clear glass, softly inflated rounded edges, precise glossy highlights, subtle refraction and translucent layering. Indigo/violet brand color inspired by #6351d9, with restrained icy cyan and lavender light refracted along the glass edges. Bright frosted white photo glyph with indigo depth, strong figure-ground separation. Backing tile is a luminous rich indigo gradient, not black.
Lighting: soft studio lighting from upper left, controlled white specular edge lights, gentle internal caustics, calm premium finish. Keep the silhouette clean and legible at 16-32 px. Use broad surfaces and chunky edges.
Text: none.
Constraints: one finished icon only. No lettering, no wordmark, no checkmark, no download arrow, no extra symbols, no sparkles, no surrounding scenery, no presentation board, no visible checkerboard. Actual alpha transparency only outside the rounded-square backing tile; keep tile and symbol fully rendered. Do not copy an existing app icon.
```
