# Website rem sizing

## Inventory

The baseline covers styles authored in `apps/site` at `88803b6da`. The inventory parses
CSS files and Astro and Worker style blocks with PostCSS. It also includes the inline
`--logo-size` value because the logo wordmark derives its font size from it. Generated
CSS, dependency styles, intrinsic image dimensions and CSS examples in documentation
are outside the inventory.

Each cell counts declarations containing a `px` length. A shorthand or a `clamp()`
counts once, even when it contains several lengths. Spacing includes margins, scroll
margins, padding, gaps and both definitions of the container gutter. Other lengths
include box and grid dimensions, positioning offsets, borders, radii, shadows, focus
outlines and visually hidden dimensions. The final column counts media query conditions
containing a pixel length.

| Component or style source | Font size | Spacing | Line height | Other lengths | Queries | Risk when converting |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Shared page and container foundations in `global.css` | 1 | 3 | 0 | 12 | 1 | High. Body type, container gutters and keyboard focus affect the homepage, legal pages and 404. |
| Shared buttons, sections, grids and cards in `global.css` | 5 | 9 | 0 | 6 | 0 | High. Fluid headings, grid track minima and button height affect multiple routes and form states. |
| `SiteHeader.astro` and its navigation | 1 | 6 | 0 | 4 | 1 | High. Wrapping, breakpoint visibility and touch targets need coverage. |
| `Logo.astro` in the header and footer | 1 | 1 | 0 | 0 | 0 | Medium. The wordmark and both theme-specific images share a size variable. |
| `SiteFooter.astro` and its link groups | 3 | 8 | 0 | 5 | 1 | Medium. Columns and long links must wrap around their touch targets. |
| Homepage hero, CTA row and getting-started steps in `index.astro` | 4 | 14 | 0 | 9 | 1 | High. Check both fluid text and the transition to a two-column hero. |
| Other homepage sections in `index.astro` | 5 | 16 | 0 | 9 | 2 | High. Grouped layouts, pricing cards and wrapping FAQ summaries share constrained space. |
| `BookingPreview.astro` | 9 | 12 | 0 | 13 | 0 | High. Preview dates and times sit in fixed-count grid columns. |
| `WaitlistForm.astro` | 3 | 8 | 0 | 7 | 0 | High. The input, button and status text must fit in the same area in each state. |
| `Legal.astro` article for `/privacy` and `/terms` | 6 | 19 | 0 | 6 | 0 | Medium. Long links, the contents list, anchor spacing and print layout need coverage. |
| `404.astro` | 1 | 4 | 0 | 0 | 0 | Low. The heading and two action links have a straightforward layout. |
| Standalone `embed-test/index.astro` harness | 1 | 3 | 0 | 2 | 0 | Medium. Keep the fixed-height widget fixture usable while scaling the host controls. |
| Worker waitlist error page in `worker/index.ts` | 0 | 0 | 0 | 3 | 0 | Low. Text and spacing already scale. Check the return link and its focus state. |
| Documentation overrides in `starlight.css`, `DocsPageTitle.astro` and `DocsFooter.astro` | 0 | 0 | 0 | 4 | 1 | Low for authored type. Revisit table accessibility and the short-screen navigation rule only if their geometry changes. |
| **Total** | **40** | **103** | **0** | **80** | **7** | |

The 40 font-size sources contain 47 pixel lengths and the 103 spacing declarations
contain 122. Existing line heights are unitless or inherited. `Base.astro` and the
privacy and terms page templates contribute no pixel sizing of their own. The
documentation title, prose overrides and footer already use relative units or
Starlight's type tokens.

## Legal article slice

`Legal.astro` uses relative sizing for the article's heading, prose, callouts,
contents list, anchor spacing and back-to-contents links. The article also sets
relative typography and spacing where the legal header and body use global
styles. The conversion uses 16 CSS pixels per rem at the default browser text
size. On narrow screens, larger browser text can wrap the legal contents into
one column. The privacy and terms pages share this layout.

This slice covers all 6 baseline font-size and 19 spacing declarations in
`Legal.astro`, as well as its article width cap, contents column width and
back-to-contents minimum target height. The remaining direct pixel lengths in
the legal layout are border strokes and a corner radius.

## Remaining one-day chunks

Across the remaining sources, 34 font-size and 84 spacing declarations still carry
pixel lengths. Each chunk below is estimated at one working day including browser
checks, for a total of eight days. Start with foundations and shared components
before routes that use them.

| Chunk | Scope | Acceptance focus |
| --- | --- | --- |
| 1 | Shared foundations in `global.css`, `SiteHeader.astro` and `Logo.astro` | Mobile navigation, skip link focus, brand alignment, theme variants and shared container widths. |
| 2 | Shared buttons, sections, grids and cards in `global.css`, plus `SiteFooter.astro` | Touch targets, grid wrapping, focus outlines and footer columns. |
| 3 | Homepage hero, CTA row and getting-started steps | Fluid heading sizing, wrapping actions and the hero breakpoint. |
| 4 | Booking preview | Fit of seven day columns, available-time labels and card header at larger text sizes. |
| 5 | Remaining homepage sections, including pricing, FAQs and closing CTA | Pricing grid readability, wrapped FAQ labels, list markers and long copy. |
| 6 | Waitlist form and Worker error page | Input and action sizing, feedback in all form states, and the no-JavaScript return link. |
| 7 | Custom 404 and standalone embed test page | Long headings and actions at narrow widths, plus the test widget's host layout. |
| 8 | Documentation geometry review and site-wide recheck | Confirm the existing documentation sizing, table reflow, short-screen navigation and fixed-pixel exceptions. |

For each conversion, compare computed sizes at a 16px browser default and check
200% text at 320 CSS pixels for clipping, overlap and horizontal page scroll.
Check both sides of affected breakpoints. Review fixed lengths by purpose,
particularly border strokes, focus outlines, visually hidden boxes and widget
fixture dimensions.
