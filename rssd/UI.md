# RSSD center interface

The `/rssd` page uses the desktop client's work-centre view. Its source is
`desktop/src/center/preview/` in `scholay-rssd/rssd`; the copy under
`apps/frontend/src/components/rssd/desktop-ui/` and the assets under
`apps/frontend/public/rssd-ui/` are generated there by `npm run center:ui:sync`
and are not edited here. `live-center.tsx` supplies this Center's data to that
view through the signed-in owner's `/rssd/v1` session.

Visual thesis: the desktop's quiet paper palette in light and dark, Inter Tight
for interface text, thin separators and one muted green accent. The tokens are
scoped to `.rssd-desktop`, so the rest of the application shell is unchanged.
The shell's light/dark switch drives the page's mode.

Content plan: overview, demand pool, publication calendar and channels lead;
tasks and publications open in a side drawer. The management screens (works and
the language editor, publication records, devices, destinations, workspaces,
goals, schedule changes, health, guestbooks, labels) are the last tab,
"作品与管理", and load when first opened. `?view=` selects a tab of the new
view; every earlier `?tab=` link except `overview` still opens its management
screen.

Interaction thesis: active navigation is underlined, rows enter with a short
fade, and controls give restrained hover/focus feedback. Reduced-motion
preferences disable movement. A task cannot be started from the browser, which
has no local worker. Network uncertainty keeps the original submission and
offers recovery rather than showing success; a retried edit reuses its request
id.
