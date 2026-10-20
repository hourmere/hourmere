# Regenerate brand raster assets

The PNG and ICO assets in `apps/site/public` are committed build inputs. Regenerate them
only after changing the brand SVG or sharing card. From the repository root, with Node 26:

```sh
(
  brand_tools=$(mktemp -d "${TMPDIR:-/tmp}/hourmere-brand-tools.XXXXXX")
  trap 'rm -rf "$brand_tools"' EXIT
  npm install --prefix "$brand_tools" --cache "$brand_tools/cache" \
    --no-save --package-lock=false --ignore-scripts \
    --no-audit --no-fund sharp@0.35.5 fontkit@2.0.4 wawoff2@2.0.1
  node apps/site/scripts/generate-brand-assets.ts "$brand_tools"
)
```

This installs the pinned one-off tools into a disposable directory and removes that exact
directory afterward. It does not change the workspace manifests or lockfile. Text is outlined
from the workspace's pinned Manrope font, so generation does not depend on installed fonts.
Review the exported images and run `npm test -- apps/site/src/brand-assets.test.ts --maxWorkers=2`.

The site keeps `sharp` for PNG dimensions, alpha and corner-pixel regression assertions;
`jsdom` for semantic DOM assertions; `postcss` for CSS rule assertions; and `parse5` for the
built HTML link checker and its tests. `fontkit`, its types and `wawoff2` are generation-only
and are deliberately absent from the workspace dependencies. All four retained tools are
development dependencies. The Docker build prunes development and optional packages, then
copies only the server, shared packages and built web app into its runtime image; it does
not copy the site.
