# RSSD center interface

`/rssd` is this Center's home: `/` redirects to it, and it has its own shell
(`apps/frontend/src/components/rssd/shell.tsx`, layout group `(rssd)`) with no
application sidebar. The publishing tools (post editor, media, analytics,
account and channel authorization) keep the application's own layout and are
linked from the top bar; their sidebar links back to the work centre.

The work-centre view lives in `apps/frontend/src/components/rssd/view/` and is
owned here. It started as a copy of the desktop client's view
(`desktop/src/center/preview/` in `scholay-rssd/rssd`); the desktop client is
frozen and keeps its own copy, so the two are no longer synchronized.
`live-center.tsx` supplies this Center's data through the signed-in owner's
`/rssd/v1` session.

Visual thesis: a quiet paper palette in light and dark, Inter Tight for
interface text, thin separators and one muted green accent. The tokens are
scoped to `.rssd-desktop`. Light/dark is the `mode` cookie and a class on
`<body>`, shared with the publishing tools.

Content plan: overview, demand pool, publication calendar and channels. There
is one calendar. A publication opens in a drawer where a queued one can be
rescheduled, a stopped one sent again under its original identity, a published
one opened, and a native post opened in the publishing tools. The screens not
yet moved into the view (works and the language editor, creating demands,
goals, devices, destinations, workspaces, health, guestbooks, labels) are the
last tab, "作品与管理", and load when first opened.

Links: `?view=demands|calendar|channels` selects a tab. Earlier links keep
working: `?tab=calendar` and `?tab=publications` open the calendar, and the
other `?tab=` values open their management screen.

Interaction thesis: active navigation is underlined, rows enter with a short
fade, and controls give restrained hover/focus feedback. Reduced-motion
preferences disable movement. A task cannot be started from the browser, which
has no local worker, and no assistant is offered there. Network uncertainty
keeps the original submission and offers recovery rather than showing success;
a retried change reuses its request id, and a refused schedule change stays
open in the drawer with the Center's reason.
