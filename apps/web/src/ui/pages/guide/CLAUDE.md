# Guide UI (`/guide`, the header `?`)

The in-app Guide (`docs/CONCEPTS.md` §18). Also covers `components/guide/`, `lib/guide.ts`,
`lib/guideAsk.ts`, `lib/guideScreens.ts` and `components/shared/GuideLink.tsx`. Query keys:
`queryKeys.guide`.

## Reader (`pages/guide/`)

- `GuideReader` — `/guide?path=…#heading`, no guard: the server answers each reader with their
  audience's pages. `GuideToc` — the rail, grouped by part and section in the server's order.
  `ReaderLayout` — full-bleed, resizable Ask pane, width in `localStorage['guide-ask-width']`.
- `GuideMarkdown` + `remarkGuide` — heading ids from the SERVER's outline, callouts, links between
  pages → reader URLs, `shot:<id>` → the image route.
- `pages/guide/**` is a lazy page and **the ONE place raw HTML renders** (`rehype-raw`, `script`
  dropped) — Guide pages are our own committed content; model output, documents and chat keep
  `skipHtml`.

## Help and Ask (`components/guide/`)

- `GuideHelp` (the header `?` and the `?` key, a slide-over) and `GuideChatProvider` (the one
  conversation, held at shell level above the routes; `screenForRoute(pathname, search)` hint per
  ask) sit in the eager shell, so the chat body is `lazy(() => import('./GuideChat'))` and the AG-UI
  client `await import('@/ui/lib/guideAsk')` — `tests/config/ui-bundle.test.ts` pins both.
- `GuideChat` (lazy) answers through `components/ai/Markdown` with in-app links for `/guide?` hrefs.
  `useGuideConversation` is abortable; a failed exchange never goes back as history.
- `lib/guide.ts` — TOC/page query options, `staleTime: Infinity`. `lib/guideAsk.ts` — the lazy
  AG-UI client, `CUSTOM kit.guide.answer`. `lib/guideScreens.ts` — `screenForRoute`.

## Contextual help links

A contextual help link is `<GuideLink path={GUIDE_SCREEN_PAGES.x} />` (`components/shared`,
markdown-free and in the barrel), never a page path typed inline; a new screen gets its key in
`@rocketpod/shared/guide-screens` and its line in `ui/lib/guideScreens.ts` (`screenForRoute` —
fixed vocabulary only, never a URL segment).

## Tests

`tests/ui/guide.test.tsx`; the bundle pins in `tests/config/ui-bundle.test.ts`.
