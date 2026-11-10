# Knowledge UI (`/documents`, `/documents/:documentId`, `/search`)

All three are guard `read Document` and lazy. Hooks are `hooks/useDocuments.ts` (`useDocuments`,
`useDocument`, `useIngestText`, `useUploadDocument`, `useDeleteDocument`, `useSearch`, plus the
viewer's below), all under the `['documents']` root so one invalidation covers the family. Only
`DocumentViewPage` may import `components/ai/Markdown` — `DocumentsPage` and `SearchPage` must NOT
(`.claude/rules/ui.md`).

## Knowledge list (`DocumentsPage.tsx`, nav "Knowledge")

- The paginated documents table first, then `URLTabs` (`?tab=text|file`, like Settings) to add.
  Paste text posts `ingestTextRequestSchema` output (blank source omitted; the server defaults it
  to `upload`); Upload file checks the pick with `validateDocumentUpload` (the shared allowlist
  `DOCUMENT_UPLOAD_ACCEPT` + `MAX_UPLOAD_BYTES`) before any request, then `useUploadDocument()`
  posts multipart `file` (+ optional `title`/`source`) to `/api/ai/documents/upload`.
- Both toast `indexed (n chunks)` / `queued for …` and invalidate `documents`; the list polls
  every 5 s (`DOCUMENT_POLL_MS`) while a row is `pending` (there is no document nudge yet).
- Rows show `documentTypeLabel(contentType)` under the title and a download link
  (`filePath(fileId)`) when there is an uploaded original; every title is a
  `<Link to={documentPath(doc.id)}>`, pending and failed rows included.
- The header states that everything indexed is also available to agents (`search_knowledge` /
  `get_document`, `services/agents/tools/`). Delete shows only for own rows unless
  `delete Document` (admin+) — the route enforces.
- Visibility: both add forms carry an `AccessPicker`, each row a Visibility action (owner or
  `manage Document`) and an `AccessBadge`. `useShareableGroups()` here is the rule the picker is
  fed: every group for `manage Group`, `useMyGroups()` otherwise — exactly what
  `resolveRequestedVisibility` accepts, so the picker can never offer what the save would refuse.

## Viewer (`DocumentViewPage.tsx`, no SideNav entry)

- Tabs `?tab=document|details`. It dispatches on `fileId`, the upload kind and the status: a PDF
  embeds its original with `<object>` — **never try to detect failure, the CHILDREN are the
  fallback** — while the header always carries Download original and a Converted text toggle;
  everything else renders its text (markdown through `components/ai/Markdown`, plain types in a
  `<pre>`).
- Deep links: `?offset=` is snapped by `windowStart()` so a link and the reader's paging share one
  cache entry, `?chunk=` is the fallback when `charOffset` is null, `?q=` highlights through
  `lib/highlight.ts` as `<mark>` NODES (never `dangerouslySetInnerHTML` over uploaded text).
  Markdown still renders AS markdown; the Plain toggle is where highlighting and the passage anchor
  live, because `<mark>` cannot be threaded through react-markdown's AST.
- Hooks: `useDocumentContent(id, offset)`, `useDocumentPassages(id, filters)`,
  `useDocumentCard(id)`; `documentPollInterval(status)` is the pure decision.

## `DocumentCard` / `DocumentLink` (`components/shared/`)

- `DocumentCard` is the compact citation form and is **markdown-free by construction** — that is
  what lets it sit in the eager barrel and be used from Search and from inside `Markdown` itself
  (an anchor whose href matches `/documents/<uuid>` renders as a card). Its `excerpt` is the head of
  the text, not a summary, and there is no thumbnail.
- **`DocumentLink` beside it is the same document on ONE LINE** (icon, title, passage count) for
  dense lists — the run timeline's tool results and `research-topic`'s Sources both use it,
  through `documentLinkProps(card)` where they hold a card, so the two cannot drift. Same
  markdown-free rule, same barrel. A card is right where the document IS the content; a link is
  right where it is a reference inside something else.

## Search (`SearchPage.tsx`, nav "Search")

- `useSearch()` is mutation-style (hits are its `data`): `{ query, limit: 10, documentId? }` →
  hits with `rank`, `passage n of m` (where the passage sits in its document), RRF `score`,
  `dense #n` / `lexical #n` badges and the snippet, GROUPED under a `DocumentCard` header built
  client-side with `documentCardFromDocument` from the `useDocuments({ pageSize: 100 })` list the
  page ALREADY fetches for its filter select — no request per hit.
- A hit's "passage n of m" is a `<Link>` to `documentPath(documentId, { offset: charOffset, chunk:
  chunkId, q })`; restricting the search to one document is a separate funnel button on the card,
  so "read it" and "search only it" are not the same click.
- `?documentId=` preselects the per-document filter; `?q=` prefills the box and runs the search on
  mount (once — a `lastRun` ref stops StrictMode and the URL write from repeating it), and every
  submitted search sets `?q=` with `replace`; an empty knowledge base shows an EmptyState linking
  to `/documents`.

## Tests

`tests/ui/`: `documents-page`, `search-page`, `document-view`, `document-card`; the pure helpers in
`tests/config/document-helpers.test.ts`.
