# Target features

The bar tsuzuri has to clear. tsuzuri aims to feel like Inoreader, and the owner named eight things that, once covered, make it good enough (2026-11-12). Everything else Inoreader has comes after these.

## The eight

| # | Feature | Inoreader | tsuzuri (as of 2026-11-13) |
| --- | --- | --- | --- |
| 1 | Labels or tags on feeds themselves | Folders; one feed can sit in several. Tags are per article | Not designed. OPML import currently discards folder structure |
| 2 | Turning a page into a feed with XPath | Web feeds, but details fall short (images do not show) | Planned in P5 as declarative YAML rules. Image extraction is in scope from the first version |
| 3 | A strong API | Weak: Custom plan only, tight rate limits | CLI, MCP server and the daemon's HTTP JSON API work today |
| 4 | Fine-grained control over how lists look | Display mode, sort order and grouping per feed, folder and tag | Not designed; the web UI is P4 |
| 5 | Paging through articles from the keyboard | Yes, see below | Not designed; the web UI is P4 |
| 6 | Search across all feeds | Search in feeds | Done: hybrid search (PGroonga + pgvector), P2 |
| 7 | Suggesting similar feeds | Topics and feed analytics, built from all users' data | Deferred. A service that returns similar sites could feed this; unverified |
| 8 | Searching feeds you are not subscribed to | Global search and feed finder | Deferred. Inoreader appears to build this from crawling and other users' subscriptions; a single-user install needs an outside index |

## Inoreader's screen, for 4 and 5

### Display

- Five display modes: List (1), Expanded (2), Column (3), Card (4), Magazine (5). The number is the shortcut.
- Each feed, folder and tag keeps its own display mode. Sort order (newest or oldest first) and grouping inside a folder or tag (by feed or by date) are set in the same place.
- Account-wide settings cover colour theme, font size and which buttons show. Custom CSS is available on Pro.
- Magazine view does not mark articles read on scroll by default; a setting changes that.

### Keyboard shortcuts

| Area | Keys | Action |
| --- | --- | --- |
| Article | J / K | Next / previous article, opened |
| Article | N / P | Move focus to next / previous article without opening |
| Article | Space / arrows | Scroll the list (unverified, see below) / move one item |
| Article | O / V / B | Toggle open / open in new tab / open in background tab |
| Article | W / Q | Load full content / translate the article |
| Article | M / Shift+A / Shift+M / Ctrl+M | Toggle read / mark all read / mark below read / mark above read |
| Article | F / L / T / E | Read later / like / tag / email |
| Tree | Shift+J / Shift+K / Shift+O / Shift+X | Next / previous feed or folder, open it, expand or collapse folder |
| Tree | Shift+D / Shift+R | Delete / rename feed or folder |
| Go to | G→D / G→A / G→F / G→U / G→T | Dashboard / all articles / starred / a feed / a folder or tag |
| View | 1–5 / Shift+1–3 | Display mode / unread, all, starred |
| View | + / − / 0 | Larger / smaller / reset font |
| Global | A / R / \ / . / H | Add subscription / refresh / search / quick access (jump to a feed or folder by name) / shortcut list |

- This table comes from a third-party summary updated 2025-10. The authoritative list is the one Inoreader shows when you press H; compare against it before copying any key.
- Checked against Inoreader's current help (the reading panel page): F is Read later, W loads full content, Q translates, J / K move through the list, O or Enter opens and closes, V opens the original page, + / − / 0 change text size.
- Space is not on that help page. A 2015 Inoreader post says it scrolls the list; another source says it now opens the next article. Check the H list before implementing it.
- Opening with J/K and reading on with Space comes from Google Reader. FreshRSS and Miniflux have similar keys; their exact lists have not been checked.

## Sources

- Feature list: <https://www.inoreader.com/pricing> (rendered 2026-11-12)
- Reading panel: <https://www.inoreader.com/help/basic/getting-started/what-is-the-reading-panel> (official, current help; checked 2026-11-13)
- Display settings: <https://www.inoreader.com/blog/2024/11/organize-your-content-and-customize-your-account.html> (official, 2024-11)
- Shortcuts: <https://tutorialtactic.com/blog/inoreader-shortcuts/> (third party, 2025-10) and <https://www.inoreader.com/blog/2015/05/inoreader-how-to-save-time-with.html> (official, 2015)
- Magazine view: <https://www.inoreader.com/blog/2015/04/presenting-magazine-view-clear-all.html> (official, 2015)
