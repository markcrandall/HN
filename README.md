# HN Tracker

A Hacker News reader with per-site and per-user blocklists. Installable as a web
app; live at <https://markcrandall.github.io/HN/>.

Block a site and every story from it disappears, including its subdomains:
blocking `reuters.com` also covers `www.reuters.com`. Block a user and their
stories go the same way. The Show Blocked view turns the list inside out so you
can see and undo what you have hidden.

## Install it

Open the link on a phone and use "Add to Home screen" (Chrome offers to install
it; on iOS it is in the Share sheet). Installed, it runs full screen, and the
Android back gesture closes an open panel instead of leaving the app.

## Where your blocklists live

In your browser, on this site's origin, and nowhere else. They are not synced,
not uploaded, and not shared between browsers or devices. Clearing "Cookies and
other site data" erases them, so use **Export backup** now and then. The backup
carries the blocklists and the saved stories together. **Import / merge** always
merges: it adds what is missing and never replaces what you have, and it still
accepts the older blocklist-only backups.

## Saved

Every story in the feed has a **save** button. Saved stories collect on the
**Saved** tab, newest first, showing the same information as the feed rows
without the score, each with a delete button. The filter box works there too.

Saved is your own list, so it behaves differently from the feed in three ways:
it never fetches and Refresh does nothing on it, blocking a site does not hide a
story you had already saved, and delete is immediate with no undo.

## Undo

Every block, unblock and import can be reversed with the undo icon in the tabs
row or in either panel. The stack lasts for the session and is emptied when the
app is closed. Undoing an import asks first, because it removes everything that
import brought in.

## Refreshing

Nothing refreshes on its own. The first launch loads the visible tab, and after
that Refresh is yours to tap. It fetches the tab you are looking at, about 500
stories. If a fetch fails while stories are already on screen, they stay and the
failure is reported; if there is nothing to show, the list says so until you try
again.

## The files

Plain static files, no build step.

| File | What it is |
| --- | --- |
| `index.html` | Markup |
| `app.css` | All styles, one breakpoint at 640px |
| `app.js` | All behaviour |
| `sw.js` | Service worker: precaches the shell, revalidates it each launch |
| `manifest.json` | Web app manifest |
| `icon.svg` | Source of the three PNG icons |
| `fonts/` | Atkinson Hyperlegible, weights 400 and 700 |

To work on it, serve the folder over HTTP rather than opening `index.html` from
disk; service workers and `localStorage` both need a real origin.
