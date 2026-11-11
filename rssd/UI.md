# RSSD center interface

The Center has one interface: the work centre at `/rssd`. `/` redirects to it,
and it has its own shell (`apps/frontend/src/components/rssd/shell.tsx`,
layout group `(rssd)`) with no application sidebar. Nothing in it links to the
application's own pages. Those pages still exist, because the application is
the engine behind channels and publishing, but they are not part of the
product; they open only by typing their address.

## Structure

One vertical sidebar on the left holds the brand, the navigation and the view
controls; the current tab fills the rest and starts with its own heading.
Nothing sits above it: there is no page title, top bar or row of counts. The
sidebar's controls appear only where they do something: the workspace filter
on the tabs that list work across workspaces (overview, tasks, calendar,
channels), and theme and refresh always. Loading shows on the refresh button,
not as a banner. Below 860px the sidebar becomes a compact bar with the
navigation scrolling sideways. The tabs, drawn by the view in
`apps/frontend/src/components/rssd/view/`:

| Tab | What it holds | Source |
| --- | --- | --- |
| 全局总览 | Goals and progress per workspace; goals are edited in a drawer | view, `planning.tsx` |
| 需求池 | Tasks; add a task, edit a queued one, release a claim | view, `planning.tsx` |
| 作品库 | Works, the language editor, images, per-platform text | `works.tsx`, `platform-content.tsx` |
| 发布日历 | The only calendar; a drawer reschedules, retries or opens a publication | view |
| 发布渠道 | Destinations and their state; add or edit one, connect social accounts | view, `channels-admin.tsx` |
| 设置 | Devices, workspaces and section rules, health, guestbook review, labels, account | `settings.tsx`, `configuration.tsx`, `health.tsx`, `guestbook.tsx`, `labels.tsx` |

`live-center.tsx` supplies the data and actions through the signed-in owner's
`/rssd/v1` session and opens the drawers. `/rssd/authorize` (device consent)
uses the same shell and styles.

The view is owned here. It began as a copy of the desktop client's view; the
desktop client is frozen and keeps its own copy, and the two are not
synchronized.

## What still comes from the application

- Connecting a social account. `channels-admin.tsx` lists platforms from
  `/integrations` and starts sign-in with `/integrations/social/:provider`,
  the same requests the application makes. The platform's own page then takes
  over, followed by the application's short "connecting" page, and for
  platforms that need a page or account choice (Facebook, Instagram, LinkedIn
  pages, YouTube, Google Business, Tumblr) the application's dialog, mounted by
  the shell. `proxy.ts` sends the return (`/launches?added=…`) to
  `/rssd?view=channels`, where the accounts drawer opens. Platforms that need
  a browser extension or wallet signature are listed as not connectable here.
- The sign-in pages under `/auth`.

## Style

A quiet paper palette in light and dark, Inter Tight for interface text, thin
separators and one muted green accent. Tokens are scoped to `.rssd-desktop`.
The view's classes are `cp-*`; forms, lists and the editor of the Center's own
screens use `ca-*` in `center-admin.css`. Light/dark is the `mode` cookie and a
class on `<body>` (`mode.ts`), toggled from the top bar.

## Links

`?view=overview|demands|works|calendar|channels|settings` selects a tab.
Earlier `?tab=` links keep working: `goals` opens the goals drawer on the
overview; `demands`, `works` and `calendar` open their tabs; `publications`
opens the calendar; `destinations` opens the channels; `workers`, `settings`,
`health`, `guestbooks` and `labels` open the matching settings section.

## Interaction

Active navigation is underlined, rows enter with a short fade, and controls
give restrained hover/focus feedback. Reduced-motion preferences disable
movement. A task cannot be started from the browser, which has no local
worker, and no assistant is offered there. Network uncertainty keeps the
original submission and offers recovery rather than showing success; a retried
change reuses its request id, and a refused change stays open in its drawer
with the Center's reason.
