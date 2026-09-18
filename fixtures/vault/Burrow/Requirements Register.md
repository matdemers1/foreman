---
aliases:
  - Burrow Requirements
  - Burrow Register
tags:
  - type/planning
  - project/burrow
  - status/active
project: burrow
created: 2026-08-10
updated: 2026-08-10
---

# Burrow — Requirements Register

> [!abstract] The spine
> 86 atomic requirements traced from discovery, research, ideation, and the red-team pass. Every SOW task cites the REQ ids it satisfies; every Must appears in at least one task. Phases: 0 Foundation · 1 Lurk Loop · 2 Comments · 3 Interact · 4 Media · 5 Explore & Inbox · 6 Sync & iPad · 7 Mod & Polish · 8 Hardening & Ship.

**Sources:** `D` = Discovery & Requirements (prior session) · `R1/R2/R3…` = this session's question rounds · `RN` = Research Notes · `RT` = red team · `ID` = ideation

---

## Auth, Accounts & Compliance

| ID | Requirement | Priority | Source | Acceptance test | Phase |
|---|---|:---:|---|---|:---:|
| REQ-001 | Authenticate via OAuth 2.0 authorization code + PKCE (installed-app client id) in ASWebAuthenticationSession | Must | D | Sign-in completes; token works against `/api/v1/me` | 0 |
| REQ-002 | Request `duration=permanent`; refresh access tokens silently; surface re-auth badge only when refresh fails | Must | D, RN | Expired token refreshes without UI; revoked account shows badge | 0 |
| REQ-003 | Support multiple accounts with switching via long-press Profile tab and in-profile menu | Must | D, R5 | Two accounts; switch swaps identity in ≤2 taps | 3 |
| REQ-004 | Add-account flows use an ephemeral web session (no cookie reuse) | Must | RT | Adding account #2 prompts fresh Reddit login | 3 |
| REQ-005 | Store tokens exclusively in Keychain; never in SwiftData, snapshots, logs, or exports | Must | D, RT | Grep of store/export artifacts finds no token material | 0 |
| REQ-006 | Register installed-app client id and file the RBP data-access request before API-consuming builds | Must | RN, R1 | Ticket filed; client id in build config | 0 |
| REQ-042 | Provide no post-submission UI anywhere | Won't | D | Code search: no `/api/submit` call site | — |

## API Client & Observability

| ID | Requirement | Priority | Source | Acceptance test | Phase |
|---|---|:---:|---|---|:---:|
| REQ-007 | Meter all API calls through a token bucket (soft 60 QPM) honoring `X-Ratelimit-*`, with exponential backoff and a countdown banner on 429 | Must | RN, R7 | Virtual-clock test: burst queues; 429 fixture triggers banner state | 0 |
| REQ-008 | Send a descriptive User-Agent and `raw_json=1` on every request | Must | RN | Request inspector shows both on all calls | 0 |
| REQ-009 | Decode tolerantly: unknown kinds/shapes render placeholder cells and log, never crash | Must | RT | Malformed fixture renders `.unsupported` cell | 0 |
| REQ-010 | Provide a debug console (Settings → Advanced): request log, bucket gauge, decode-failure log | Must | ID-R2 | Console shows live requests during a browse session | 0 |
| REQ-011 | Capture MetricKit crash diagnostics locally and list them in the debug console | Should | RT-R9 | Forced crash appears in console next launch | 7 |
| REQ-085 | No third-party dependencies except Apple-maintained OSS (`swift-markdown`) | Must | R6 | `Package.swift` audit | 0 |
| REQ-086 | No telemetry or analytics; no data leaves the device except Reddit API + iCloud | Must | ID (anti-features) | Network inspector over a session shows only reddit/CDN/iCloud hosts | 8 |

## Feed (the #1 priority)

| ID | Requirement | Priority | Source | Acceptance test | Phase |
|---|---|:---:|---|---|:---:|
| REQ-012 | App opens to the Home feed (`/best`) of the active account | Must | D | Cold launch lands in Home | 1 |
| REQ-013 | Feed scrolling drops no frames at ProMotion rates on the dogfood device | Must | D | Instruments run over 500-post scroll shows no hitches | 1 |
| REQ-014 | Relaunch paints the last feed snapshot in < 0.5s, then refreshes | Must | R6 | Stopwatch + snapshot test | 1 |
| REQ-015 | Title-tap feed switcher lists Home, multireddits, and recent subreddits | Must | R4 | Switch to a multi in 2 taps from Home | 1 |
| REQ-016 | Remember sort (incl. time range) per feed and per subreddit indefinitely | Must | D | Set r/x to Top-Month; relaunch; still Top-Month | 1 |
| REQ-017 | Dim read posts in every post-list context | Must | D | Read post appears dimmed in feed, search, profile lists | 1 |
| REQ-018 | Prune read-state older than 90 days | Must | R6 | Virtual-clock test purges old marks | 1 |
| REQ-019 | Hide posts matching keyword filters | Must | D | Filtered term absent from rendered feed | 1 |
| REQ-020 | Support advanced filter rules: domain, flair, author, subreddit, with optional expiry | Should | ID-R2 | Rule matrix unit tests; expired rule auto-disables | 7 |
| REQ-021 | Hide posts natively via `POST /api/hide` from swipe/menu | Should | ID-R2 | Hidden post gone from feed on next refresh, all devices | 3 |
| REQ-022 | Paginate with `after` cursors, deduplicate by fullname, prefetch next page at ~75% scroll | Must | RT | Duplicate-page fixture renders once | 1 |
| REQ-023 | Offer card and compact layouts with per-subreddit overrides | Should | ID-R3 | Override on r/news persists and syncs | 6 |
| REQ-024 | Pull-to-refresh shows the mascot dig; exhausted feeds show the end-of-burrow state | Should | ID-R3 | Visual check | 1 |
| REQ-025 | Restore scroll position per feed across launches and devices | Should | ID-R3 | Kill app mid-feed; relaunch resumes anchor | 6 |

## Comments

| ID | Requirement | Priority | Source | Acceptance test | Phase |
|---|---|:---:|---|---|:---:|
| REQ-026 | Render comment trees with tap-to-collapse and depth indicators | Must | D | Collapse hides subtree; indicator matches depth | 2 |
| REQ-027 | Provide a jump-to-next-top-level-comment FAB | Must | D | FAB walks top-level comments in order | 2 |
| REQ-028 | Expand `more` stubs on tap via `morechildren`, batching ≤100 ids per call | Must | D, R7 | Stub fixture expands; batching asserted | 2 |
| REQ-029 | Render core Reddit markdown: bold, italic, strikethrough, quotes, lists, code, links, spoilers (tap-to-reveal) | Must | D, RT-R9 | Golden tests per construct | 2 |
| REQ-030 | Render exotic markdown: tables, superscript, subreddit emotes, inline images/GIFs in comments | Should | D, RT-R9 | Goldens; emote fixture renders image | 7 |
| REQ-031 | Honor subreddit suggested comment sort unless the user has an explicit remembered choice | Must | ID-R2 | AMA fixture opens Q&A; user override persists | 2 |
| REQ-032 | Search within the loaded comment tree with match jumping | Should | ID-R2 | Query jumps between matches; stub hint shown | 2 |
| REQ-033 | Filter a thread to OP's comments with ancestor context (OP lens) | Should | ID-R2 | Lens shows only OP + parents | 2 |

## Interactivity

| ID | Requirement | Priority | Source | Acceptance test | Phase |
|---|---|:---:|---|---|:---:|
| REQ-035 | Vote, save, and unsave posts and comments with optimistic UI and failure rollback | Must | D | Vote reflects on reddit.com; failed vote rolls back with toast | 3 |
| REQ-036 | Compose with a markdown toolbar, live preview, and quote-reply of selected text | Must | D | Toolbar inserts syntax; preview matches renderer | 3 |
| REQ-037 | Auto-save drafts per target, restore in place, never sync | Must | D, R8 | Kill app mid-compose; reopening thread restores text | 3 |
| REQ-038 | Edit and delete own comments | Must | D | Edit round-trips; delete tombstones | 3 |
| REQ-039 | Provide four two-stage swipe slots (defaults: votes left; collapse/reply on comments, save/hide on posts right), all remappable | Must | D, R8 | Defaults act; remap persists and syncs | 3 |
| REQ-040 | Block a user from any comment/post context menu | Should | ID-R2 | Blocked author's content hidden after refresh | 3 |
| REQ-041 | Follow/unfollow posts for inbox updates | Should | ID-R2 | Followed post reply appears in inbox | 3 |
| REQ-043 | Report posts and comments with the sub's reason list | Could | RN | Report submits; confirmation toast | 7 |
| REQ-044 | Haptic feedback on vote and collapse | Should | D | Feel check on device | 3 |
| REQ-045 | Long-press context menus with previews on every Reddit entity | Should | D | Menu on post, comment, user, sub, link | 3 |

## Media

| ID | Requirement | Priority | Source | Acceptance test | Phase |
|---|---|:---:|---|---|:---:|
| REQ-046 | Fullscreen media viewer: pinch-zoom, swipe-through galleries, swipe-down dismiss | Must | D | Gallery fixture navigates; zoom + dismiss gestures work | 4 |
| REQ-047 | Gallery grid overview for direct jump to any image | Should | ID-R3 | Grid opens from viewer; tap jumps | 4 |
| REQ-048 | Play v.redd.it via `hls_url` in AVPlayer with audio, scrubbing, speed control, and double-tap ±10s; use `fallback_url` when HLS is absent | Must | D, R1, ADR-003 | HLS post plays with audio; legacy post plays via fallback | 4 |
| REQ-049 | Treat GIF/MP4 loops as scrubbable media | Should | ID-R3 | GIF pauses and scrubs | 4 |
| REQ-050 | Autoplay setting: off / on / Wi-Fi-only; inline players muted and recycled | Must | D | Setting respected on cellular vs Wi-Fi | 4 |
| REQ-051 | Swipe up from fullscreen media to peek comments | Must | D | Gesture reveals comment sheet | 4 |
| REQ-052 | Blur NSFW thumbnails until tapped; respect account `over_18`; quarantined subs require opt-in interstitial | Must | D, RN | NSFW fixture blurred; quarantine interstitial appears | 4 |
| REQ-053 | Empirically verify the mod-status NSFW exception before building NSFW UI | Must | RN, RT | Spike report in vault: explicit-content fixture via own client id | 0 |

## Subreddits, Multis, Search & Discovery

| ID | Requirement | Priority | Source | Acceptance test | Phase |
|---|---|:---:|---|---|:---:|
| REQ-054 | Subs tab lists subscriptions (paged, searchable) | Must | R4 | All subscriptions listed | 5 |
| REQ-055 | Create, edit, delete multireddits and add/remove subs from anywhere | Must | D | Multi CRUD round-trips to Reddit | 5 |
| REQ-056 | Subscribe/unsubscribe from any sub surface | Must | D | State reflects on reddit.com | 5 |
| REQ-057 | Subreddit screen: feed + header chip row (About · Rules · Wiki · sort) | Must | R5 | Chips open sheets; private/banned states render | 5 |
| REQ-058 | Show subreddit rules before the first comment in that sub | Should | ID-R3 | Rules sheet offered pre-comment | 5 |
| REQ-059 | Render subreddit wiki pages with internal link navigation | Should | ID-R3 | Wiki page renders; links navigate | 5 |
| REQ-060 | Discovery via `subreddits/popular`, autocomplete-v2, and similar-sub recommendations | Should | R7 | Empty Subs tab shows popular; search-as-you-type works | 5 |
| REQ-061 | Search posts, subreddits, and users with sort and time filters, scoped or global | Should | D | Segmented results with filters | 5 |
| REQ-062 | Keep search history (cap 100) and saved searches | Should | D | History appears pre-query; saved search pinned | 5 |
| REQ-080 | Other Discussions tab on posts via `/duplicates` | Should | ID-R3 | Crossposted link lists sibling threads | 5 |

## Inbox, Profiles & Mod

| ID | Requirement | Priority | Source | Acceptance test | Phase |
|---|---|:---:|---|---|:---:|
| REQ-063 | Inbox with segments (replies, mentions, messages; modmail if mod), unread badge, foreground-only refresh | Must | D | Reply appears; badge counts; no background activity | 5 |
| REQ-064 | Read and reply to private messages | Must | R1 | PM thread renders; reply delivers | 5 |
| REQ-065 | Modmail: list conversations, read threads, reply, archive | Should | R7 | Modmail round-trip on own sub | 7 |
| REQ-066 | Mod actions on own sub: remove, approve, lock | Should | D | Action reflects on reddit.com | 7 |
| REQ-067 | Own profile: karma breakdown, trophies, history segments (overview/comments/submitted/saved/up/down/hidden) | Should | D | Segments page correctly | 5 |
| REQ-068 | View other users' profiles with block/follow actions | Should | D | Profile renders; actions work | 5 |

## Sync, Platform & Chrome

| ID | Requirement | Priority | Source | Acceptance test | Phase |
|---|---|:---:|---|---|:---:|
| REQ-069 | Sync settings, filters, gestures, read-state, accounts metadata, sort memory via SwiftData CloudKit (private DB) | Must | D, R8 | Change on iPhone appears on iPad; sync row confirms | 6 |
| REQ-070 | Merge semantics: read-state = union; settings = LWW; drafts local-only | Must | R8, ADR-002 | Two-device conflict scenarios resolve per policy | 6 |
| REQ-071 | Deploy the CloudKit schema to production before the first TestFlight build | Must | RT | TF build syncs with dev build's data | 6 |
| REQ-072 | Export/import full app config as JSON | Should | ID-R2 | Export → wipe → import → identical settings | 6 |
| REQ-073 | iPad: Mail-style three-column layout (sidebar · posts · detail) | Must | D, R4 | Three columns on iPad landscape; media over all | 6 |
| REQ-074 | Open reddit links via share extension, `burrow://` scheme, and paste-in-search; comment permalinks open focused with ancestor trail | Must | D, RT | Share from Safari opens correct thread | 5 |
| REQ-075 | Open external links in SFSafariViewController with a Reader-mode preference | Must | D | External link opens in-app; Reader pref honored | 1 |
| REQ-076 | Themes: light, dark, OLED-black + accent colors | Should | D | All three render; accent applies | 7 |
| REQ-077 | Alternate app icons | Should | D | Icon switch works | 7 |
| REQ-078 | Optional off-by-default sounds (vote, collapse) | Could | ID-R3 | Toggle produces sounds | 7 |
| REQ-079 | Respect Dynamic Type at system defaults across all screens | Must | D | XXL type renders without truncation on core screens | 1 |
| REQ-081 | First-run: single sign-in screen straight into OAuth | Must | R5 | Fresh install reaches Home in one flow | 1 |
| REQ-082 | Five-surface tab bar: Home, Subs, Inbox, Profile + iOS 26 search-role tab | Must | R4 | Tabs present; search tab uses native role | 1 |
| REQ-083 | Render tombstones for deleted/removed/suspended content everywhere it appears | Must | RT | Deleted fixtures render tombstone component | 8 |
| REQ-084 | Shared banner component for rate-limit countdowns and offline/degraded states on all network screens | Must | RT | 429 fixture and airplane mode drive the banner | 8 |

---

## Coverage Summary

| Priority | Count |
|---|:---:|
| Must | 47 |
| Should | 26 |
| Could | 2 |
| Won't (guard) | 1 |
| **Total** | **86** *(REQ-034 retired — merged into REQ-016/031)* |

> [!success] Coverage check (updated after SOW)
> Every Must maps to ≥1 task in [[Burrow/Scope of Work|Scope of Work]] — verified in the SOW traceability matrix. Zero unmapped Musts.

## See Also
- [[Burrow/Discovery & Requirements|Discovery & Requirements]] · [[Burrow/Feature Ideas & Future Development|Feature Ideas]] · [[Burrow/Scope of Work|Scope of Work]] · [[Burrow/Risk Register|Risk Register]]
