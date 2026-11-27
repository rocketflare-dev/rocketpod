# The style step

`rp-design` §4, or the whole run with `/rp-design --brand <file>`. The goal is a look that reads as
theirs: a palette, type, density, tone and shape they chose, that passes the kit's contrast floors.
That means WCAG AA: 4.5:1 for text, 3:1 for controls, the focus ring and chart series, in light and
dark.

## The kit's default, so you know what you are changing

Blue on zinc: one blue accent (`#2563eb` light, `#60a5fa` dark), a cool grey ramp, white chrome
and panels on a light grey canvas, borders rather than shadows, the system sans and mono stacks,
5px corners on controls and 6px on panels, comfortable density. The rail (`--rail-*`) is the white
nav, the five chart series (`--series-1…5`) are blue, teal, orange, violet and grey, and the
flare (`--flare`) is the logo's gold. Every colour is a hex in
`apps/web/src/shared/theme-tokens.css` and the two `[data-theme]` blocks of
`apps/web/src/ui/index.css`; the header of `index.css` lists every token. It is a default, not a
brand.

Show them the running app or `pnpm design:docs --open` before asking anything: most people decide
faster against something real.

## The questions, one at a time

Give your recommendation and its reason each time, as in `SKILL.md`.

1. **Density.** Comfortable, the default, suits most apps. Compact suits screens people work in
   all day (dispatch, a ledger, a queue). Record the choice and the screens it applies to in
   `DESIGN.md`.
2. **Tone.** Quiet, the kit's default, lets their data carry the colour. Warmer or more expressive
   means a stronger primary, a serif for headings, or a larger radius. Never more state colours or
   decoration.
3. **Shape.** The radius (`--radius-control`, `--radius-panel`, `--radius-popover`) and the depth
   (`--shadow-panel`, `--shadow-popover`). A panel has a shadow or a border, never both. Squarer
   corners read as a tool; rounder read as consumer.
4. **Palette.** Their primary, accent or neutrals. On an `oklch()` palette on one hue the simplest
   brand is `--brand-hue`, which turns the whole shell keeping every lightness so the floors hold;
   the kit's palette is hex, so there a brand sets `--color-primary` and its tones. The state
   colours (info, success, warning, error) and the flare keep their own hue under any brand.
5. **Type.** The sans face, and optionally a heading serif: `--font-heading` in `@theme` sets the
   face of h1–h3 alone (page and section titles, the sign-in heading) and defaults to the sans.
   Find a free equivalent of their face.
6. **The sign-in image.** Offer three choices: keep the kit's drawing in their colours; their own
   imagery (only artwork they own, never their logo redrawn by you); or no picture, the app's name
   and tagline alone. Either way, ask for the tagline: one line in their words, recorded as
   `app.tagline` in `design.json`, which the rename writes into the sign-in panel. These are code
   changes, so they happen after sign-off, with the rename.

## What you may take from their brand

- **Inputs:** a pasted image (a logo, a photo of their signage, a screenshot of their site), a
  website address, or a brand-guide PDF. With a website, read its CSS for the colours it actually
  uses before trusting a screenshot.
- **Take:** the primary colour, an accent if they have one, whether their neutrals lean warm or
  cool, and the feel of their type: geometric, humanist, serif, condensed.
- **Never take:** their logo or icon artwork, font files, or a commercial font by name. Find a free
  equivalent for the type feel, and say which one and why it is close. Their real logo goes in by
  hand later (`rp-adapt` checklist row (f)).

Show what you extracted before writing anything: three to five swatches, the font pairing, and
where each came from ("the button colour on your booking page").

## Write `docs/design/brand.css`

`brand.css` uses the same blocks as the two token files and holds only what it changes:

```css
@theme {
  --font-sans: "Hanken Grotesk Variable", ui-sans-serif, system-ui, sans-serif;
  --font-heading: "Fraunces Variable", Georgia, serif;   /* optional: headings only */
}
@plugin "daisyui/theme" { name: "any-light"; --color-primary: #b45309; }
[data-theme="any-light"] {
  --surface-active: color-mix(in srgb, #b45309 8%, #ffffff);
  --focus-ring: #b45309;
  --rail-active: color-mix(in srgb, #b45309 8%, #ffffff);
  --rail-focus-ring: #b45309;
  --selection-surface: #fde68a;
  --tone-primary-surface: #fffbeb;
  --tone-primary-border: #fcd34d;
  --series-1: #b45309;
}
[data-theme="any-dark"] { --color-primary: #fbbf24; }
```

- A block matches by its name's `-light` / `-dark` ending, so any prefix works.
- On an `oklch()` palette, `@theme { --brand-hue: <degrees or a colour>; }` is applied first and
  every other property lands on top of the turned palette; on the kit's hex palette it is reported
  and ignored.
- A brand may set any token the two files define: colours, the rail (`--rail-*`), the chart
  series (`--series-1` to `-5`), the selection, depth, the fonts and the radii. A name neither
  file defines is reported and ignored.
- An explicit primary moves its derived tones too: `--focus-ring`, `--surface-active`,
  `--tone-primary-*`, `--rail-active`, `--rail-focus-ring` and `--selection-surface`. The check
  below warns about each one left at the kit's value.
- Dark mode is not the light palette inverted: pick a lighter tone of the same hue, the way the
  kit pairs blue-600 with blue-400.
- A new font needs its `@fontsource-variable/*` package in `apps/web/package.json` and an import
  in `apps/web/src/ui/main.tsx`. That is a code change, so it is made with the rename.

## Nudge until it passes

```
pnpm design:docs --contrast
```

This checks the tokens with `brand.css` layered on, using the same pairs and floors as
`tests/ui/contrast.test.ts`: text on every surface, the rail's text on the rail, its hover and its
selection, each chart series on a panel, ink on the selection, and the flare on the sign-in panel.
It prints each failing pair with its ratio. To fix a failure, move the tone's lightness and keep
the hue. A brand colour too light for white text usually needs a darker shade for buttons and
links, with the original kept for large surfaces.

Show them a before and after for every tone you moved:

| Token | Their colour | Adjusted | Why |
|---|---|---|---|

Re-run until it exits 0, then render the pages (`rp-design` §7). They judge the result in their own
style, and that, not the table, is when they say yes.

## Record it

Write `docs/design/06-brand.md`:
- what the style was borrowed from;
- the palette before and after;
- the fonts, the density, the tone and the shape;
- the sign-in image chosen, and the tagline;
- what was left for later (the logo, their own sign-in imagery, any tone they want a designer to
  look at).

Then `docs/design/DESIGN.md` (SKILL.md §5): the same decisions as rules a builder follows, short.

The style reaches the app only at the rename (`rp-adapt` checklist rows (e) and (f)), after
sign-off. Re-running this step when a real brand guide arrives replaces `brand.css`. After the
rename, `pnpm design:docs --apply-brand` writes it into the two token files, and `pnpm web test:ui`
confirms it. When a later kit release brings a new default look, `pnpm design:docs
--adopt-default-look` takes it and re-applies `brand.css` on top; it runs only when asked.
