# 10 — UI Design

Design direction for the three screens (Chats, Scheduled, Settings). Modelled on the current generation of cloud-agent apps: a calm, dark-first workspace with a narrow sidebar, a centred composer, and a transcript that makes every agent action visible. Clarity over decoration; every visual decision serves reading streamed output for long stretches.

Stack: Next.js 16 App Router · React 19 · Tailwind CSS v4 (`@theme` tokens) · shadcn/ui (CLI 4, Base UI primitives) · Lucide icons · `next/font` (self-hosted, no runtime font fetch).

## 1. Direction

| Attribute | Decision |
|---|---|
| Mood | Quiet, technical, premium. Dark mode primary; light mode fully supported through the same semantic tokens; follows system by default with a toggle in the sidebar footer. |
| Style | Modern dark: layered neutral surfaces (no pure black), hairline borders, restrained accent, no gradients or glass effects in the app chrome. Depth through surface steps, not shadows. |
| Density | Medium. Sidebar and tables are compact; transcript is generous (line-height 1.6) because it is read, not scanned. |
| Motion | Subtle. 150–250 ms ease-out for state changes; streaming text appears without per-character animation; `prefers-reduced-motion` honoured. |
| Voice | Short, direct microcopy. Empty-state headline: **"What should we build?"** Composer placeholder: **"Describe a task or ask a question…"** |

## 2. Tokens (Tailwind v4 `@theme` + shadcn semantic variables)

Neutral "graphite" scale; one accent for interactive/informational state; three status hues. All pairs below meet WCAG AA (≥ 4.5:1 for text, ≥ 3:1 for UI).

| Token | Dark | Light | Use |
|---|---|---|---|
| `--background` | `#0E0F12` | `#FAFAFA` | app canvas |
| `--sidebar` | `#121418` | `#F3F4F6` | sidebar surface |
| `--card` / `--popover` | `#16181D` | `#FFFFFF` | cards, dialogs, composer |
| `--muted` | `#1C1F25` | `#EEF0F3` | secondary surfaces, code blocks |
| `--border` | `#262A31` | `#E4E6EA` | hairlines (1 px) |
| `--input` | `#2B3038` | `#D9DCE1` | input borders |
| `--foreground` | `#F2F3F5` | `#121417` | primary text (15.6:1 / 16.9:1) |
| `--muted-foreground` | `#9AA1AC` | `#5B6270` | secondary text (7.1:1 / 6.5:1) |
| `--primary` | `#F2F3F5` | `#121417` | primary button (inverted: light-on-dark / dark-on-light) |
| `--primary-foreground` | `#0E0F12` | `#FAFAFA` | text on primary |
| `--accent` | `#7AA2FF` | `#2F5BEA` | links, focus ring, selected nav, "running" state |
| `--success` | `#4ADE80` | `#15803D` | succeeded, saved |
| `--warning` | `#FBBF24` | `#B45309` | preparing, queued, restored-notice |
| `--destructive` | `#F87171` | `#DC2626` | failed, remove, delete |
| `--ring` | `--accent` | `--accent` | focus ring (2 px, offset 2 px) |
| `--radius` | `10px` | | cards/inputs; buttons `8px`; pills `9999px` |

Spacing scale: 4 px base (`4/8/12/16/20/24/32/40/48/64`). Sidebar width 260 px. Content max-width 840 px centred (transcript + composer). Page gutters 24 px.

Typography (`next/font`): **Inter** (UI, 14 px base in chrome, 15 px in transcript, 1.5/1.6 line-height; weights 400/500/600) and **JetBrains Mono** (code, tool output, cron strings, secrets mask; 13 px). Headline in empty state: 28 px/600. Tabular numerals for times and counts.

Icons: Lucide, 16 px in nav/buttons, 18 px in cards, stroke 1.75. Never emoji as icons.

## 3. App shell

```
┌──────────────┬──────────────────────────────────────────────────────────────┐
│  ◇ Agent     │                                                              │
│    Hangar  ⌕ │                                                              │
│              │                                                              │
│  ✎ New chat  │                                                              │
│  ◷ Scheduled │                        ( main content )                      │
│  ⚙ Settings  │                                                              │
│              │                                                              │
│  CHATS       │                                                              │
│  • Fix auth… │                                                              │
│    Add tests │                                                              │
│    Explain…  │                                                              │
│  ARCHIVED ▸  │                                                              │
│              │                                                              │
│──────────────│                                                              │
│ ● docker ✓   │                                                              │
│ ☾ theme      │                                                              │
└──────────────┴──────────────────────────────────────────────────────────────┘
```

- **Sidebar** (260 px, `--sidebar`, right hairline): wordmark + search (filters chats by title, `⌘K`); primary nav with icons — *New chat*, *Scheduled*, *Settings*; section label **CHATS** (uppercase 11 px, `--muted-foreground`, letter-spacing .06em) followed by active chats sorted by `updatedAt`, each row: title (truncate), tiny status dot (running = accent pulse, failed = destructive) on the right; collapsible **ARCHIVED** group; footer: environment pill (`docker ✓` / `docker ✗` from `/api/health`, click → doctor details dialog), theme toggle. Active route has `--muted` background + accent 2 px left bar.
- **Header** (per page, 48 px, hairline bottom): page title or chat title (inline-editable), repo chip (`owner/repo · branch`), workspace status pill, overflow menu (Archive / Restore / Delete / Copy chat id).
- Keyboard: `⌘K` search, `⌘N` new chat, `Enter` send (`Shift+Enter` inserts a newline; `⌘/Ctrl+Enter` also sends), `Esc` cancel turn (with confirm), `⌘,` settings. Shown in tooltips.

## 4. Screens

### 4.1 New chat (home, `/chats/new`) — the reference composition

```
                               ◇
                      What should we build?

   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
   │ ⌖ Explore and│ │ ⚒ Build a    │ │ ⟳ Review code│ │ ✚ Fix issues │
   │   understand │ │   new feature│ │   and suggest│ │   and        │
   │   code       │ │   or tool    │ │   changes    │ │   failures   │
   └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘

   ┌────────────────────────────────────────────────────────────────┐
   │ ▢ Choose repository ▾     ⑂ main ▾                             │
   ├────────────────────────────────────────────────────────────────┤
   │ Describe a task or ask a question…                             │
   │                                                                │
   │                                      gpt-5.6-sol    [ ↑ Send ] │
   └────────────────────────────────────────────────────────────────┘
```

- Vertically centred composition (logo mark 40 px → headline → 4 suggestion cards → composer), max-width 840 px.
- **Suggestion cards** (4-up ≥ 1024 px, 2-up at 768 px): 1 px border, `--card`, radius 10, 16 px padding, Lucide icon tinted per card (accent / warning / success / destructive at 80 % — the only decorative colour in the app), 14 px text. Click → fills the composer with a starter prompt and focuses it.
- **Composer** (`--card`, border `--input`, radius 12): top row with **repository picker** (command palette listing repos from the PAT, searchable, recent first) and **branch picker** (defaults to the repo default branch); textarea auto-grows 1→8 rows; bottom row: model id in `--muted-foreground` mono (read-only, from config) and a circular primary **Send** button (disabled until repo + non-empty prompt). When secrets are missing, the composer is replaced by an inline notice card: *"Add your GitHub token and OpenAI key in Settings to start."* with a button.
- Creating: button shows spinner, composer locks, navigation to `/chats/:id` as soon as the chat row exists (optimistic).

### 4.2 Chat (`/chats/:id`)

```
┌ Fix flaky auth test        ▢ acme/api · agent/k3x9 · ● Running 00:42   ⋯ ┐
│                                                                           │
│  ┌ You ──────────────────────────────────────────────────────────────┐    │
│  │ The login test is flaky on CI. Find out why and fix it.            │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│                                                                           │
│  ⟲ Preparing workspace · cloned acme/api@main → agent/k3x9        2.1 s   │
│                                                                           │
│  I'll start by locating the test and its recent history.                  │
│                                                                           │
│  ▸ run_shell  rg -n "login" tests/                          exit 0 · 0.3 s │
│  ▾ read_file  tests/auth/login.test.ts:1-80                         0.1 s │
│    ┌───────────────────────────────────────────────┐                      │
│    │  1  import { login } from '../../src/auth'    │  (mono, 13 px,       │
│    │  2  …                                         │   collapsible,        │
│    └───────────────────────────────────────────────┘   max 20 lines)       │
│  ▸ write_file tests/auth/login.test.ts                     +12 −4 · 0.1 s │
│  ▸ run_shell  pnpm test tests/auth                  ● running…   00:12 ⏹  │
│                                                                           │
│  ▍ (streaming text cursor)                                                │
│                                                                           │
├───────────────────────────────────────────────────────────────────────────┤
│  Describe the next step…                              gpt-5.6-sol  [ ↑ ]  │
└───────────────────────────────────────────────────────────────────────────┘
```

- **Transcript** scrolls; auto-follow while at bottom, "↓ Jump to latest" pill when the user scrolls up. User messages in a subtle `--muted` bubble aligned left with a "You" label; assistant text as plain prose (Markdown rendered: headings, lists, code fences with copy button).
- **Tool call rows** are the core of the design: one line each, collapsed by default, `▸` chevron, tool name in mono with accent tint, argument summary truncated, trailing exit code/duration in `--muted-foreground`; running rows show a pulsing dot and live elapsed time; failed rows show destructive exit code; expanded rows reveal redacted args and the first 8 KB of output in a mono block (copy button, "truncated — N KB total" footer).
- **System notices** (workspace recreated, archived, limits reached) are centred, small, `--warning` icon + text, no bubble.
- **Status pill** in header: Queued (muted) → Preparing (warning) → Running (accent, pulse, elapsed) → Done (success, fades after 5 s) / Failed (destructive, click → error) / Cancelled. A **Stop** button appears while running.
- **Archived chat**: read-only transcript, banner at top *"This chat is archived. Restore it to continue in a fresh workspace."* with **Restore** button; after restore a system notice appears and the composer unlocks.
- Errors: turn failure renders an inline error card (title, redacted message, "Retry" which re-sends the last prompt); auth errors link to Settings; missing image links to README anchor.
- Connection: SSE drop shows a thin top bar "Reconnecting…"; replay fills the gap silently.

### 4.3 Scheduled (`/scheduled`)

```
┌ Scheduled jobs                                               [ + New job ] ┐
│                                                                            │
│  NAME            SCHEDULE            REPO · BRANCH     LAST RUN   NEXT RUN │
│  Nightly tests   0 2 * * *  (UTC)    acme/api · main   ● ok 2h   in 21h  ● │
│  Dep audit       0 9 * * 1  (UTC)    acme/web · main   ✕ fail 6d in 2d   ○ │
│  Changelog       */30 * * * *        acme/api · main   ● ok 12m  in 18m  ● │
│                                                                            │
│  (row click → job detail)                                                  │
└────────────────────────────────────────────────────────────────────────────┘
```

- Table (shadcn `Table`), dense rows 44 px; schedule shown as cron in mono + human-readable tooltip ("every day at 02:00 UTC"); status icons + text (never colour alone); toggle switch for enabled on the right; row menu: Run now / Edit / Delete.
- **Job dialog** (create/edit, shadcn `Dialog`, 520 px): Name · Repository + Branch pickers (same as composer) · Cron input (mono) with live preview line *"Runs every weekday at 09:00 (next: Mon 09:00)"* and inline error for invalid expressions · Timezone combobox (IANA, default system) · Prompt textarea (6 rows) · Enabled switch · Save. Validation inline under fields.
- **Job detail** (`/scheduled/:id`): header with name, schedule, toggle, Run now; runs table (started, duration, trigger, status, tokens) newest first; click → **run drawer** (shadcn `Sheet`, 720 px) showing the same transcript component as chat in read-only mode (streams live via SSE while running, with Stop).
- Empty state: icon + *"No scheduled jobs yet."* + short explainer + New job button.

### 4.4 Settings (`/settings`)

```
┌ Settings                                                                  ┐
│                                                                           │
│  Credentials                                                              │
│  Stored encrypted on this machine. Injected into workspaces at start.     │
│                                                                           │
│  GitHub Personal Access Token                                             │
│  ┌───────────────────────────────────────┐  [ Replace ]  [ Remove ]       │
│  │ ••••••••••••••••••••••••••••••••abcd  │  updated 3 days ago             │
│  └───────────────────────────────────────┘                                │
│  Needs repo scope (read + push) for the repositories you want to use.     │
│                                                                           │
│  OpenAI API key                                                           │
│  ┌───────────────────────────────────────┐  [ Save ]                      │
│  │ sk-…  (type=password)                 │  not set                       │
│  └───────────────────────────────────────┘                                │
│                                                                           │
│  Model  gpt-5.6-sol   (from OPENAI_MODEL)                                 │
│                                                                           │
│  Environment                                                              │
│  Instance default · web :3000 · postgres :3001 · redis :3002 · docker ✓   │
└───────────────────────────────────────────────────────────────────────────┘
```

- Two cards: **Credentials** and **Environment** (read-only doctor summary). Inputs `type=password`, never pre-filled; once set, the field shows the mask `••••••••<last4>` in mono and switches to Replace/Remove actions (Remove confirms in an `AlertDialog`). Save shows a success toast *"GitHub token saved"*; errors inline. Helper text under each field states required scopes and that values never leave the machine except to GitHub/OpenAI.

## 5. Components (shadcn/ui + project components)

shadcn: `Button`, `Input`, `Textarea`, `Dialog`, `AlertDialog`, `Sheet`, `Command` (repo/branch pickers, ⌘K), `DropdownMenu`, `Tooltip`, `Switch`, `Table`, `Badge`, `Card`, `Separator`, `ScrollArea`, `Sonner` (toasts), `Skeleton`, `Collapsible`, `Tabs` (run drawer: Transcript / Raw output).

Project components: `AppSidebar`, `ChatList`, `Composer` (+ `RepoPicker`, `BranchPicker`), `Transcript` (+ `UserMessage`, `AssistantMarkdown`, `ToolCallRow`, `SystemNotice`, `StreamCursor`), `StatusPill`, `SuggestionCard`, `CronField` (+ `CronPreview`), `RunsTable`, `RunDrawer`, `SecretField`, `EnvSummary`, `EmptyState`, `ErrorCard`.

## 6. States

| State | Treatment |
|---|---|
| Loading | Skeletons matching final layout (sidebar rows, table rows, transcript blocks); never spinners for page loads. Buttons show inline spinner + disabled. |
| Empty | Icon (Lucide, 32 px, muted) + one-line headline + one-line help + primary action. |
| Error | Inline `ErrorCard` near the cause; toast only for background failures; every error has a next action. |
| Streaming | Cursor block `▍` at end of assistant text; running tool row pulse; header pill elapsed timer. The composer is locked for the duration and says so — the API refuses a second turn with `TURN_IN_PROGRESS`, and a disabled textarea receives no key events, so an unexplained lock reads as a composer that has stopped working. |
| Offline / infra down | Sidebar footer pill turns destructive; composer notice explains which dependency is down (from `/api/health`). |

## 7. Motion

- Enter/exit of dialogs, sheets, toasts: 200 ms, `cubic-bezier(.16,1,.3,1)`; fade + 8 px translate.
- Collapsible tool rows: height via `grid-template-rows` 0fr→1fr (no `height` animation).
- Status pill colour transitions 150 ms; pulse is `opacity` only.
- `prefers-reduced-motion: reduce` disables pulses and translates; opacity only.

## 8. Accessibility

- Contrast verified for every token pair in both themes (table in §2); status always paired with text/icon.
- Full keyboard path: sidebar → composer → transcript tool rows (focusable, Enter to expand) → header actions; visible 2 px accent focus ring everywhere; roving tabindex in lists.
- `aria-live="polite"` region for status pill changes and final assistant message; tool output blocks `role="log"`.
- Icon-only buttons carry `aria-label`; inputs have visible labels; errors linked via `aria-describedby`.
- Targets ≥ 40 px on desktop (44 px on touch widths); text never below 12 px (11 px only for uppercase section labels with increased tracking).

## 9. Responsive

Desktop-first (this is a developer tool): designed at 1440 and 1280; sidebar collapses to a 56 px icon rail at < 1024 px and becomes an overlay drawer at < 768 px; suggestion cards 4→2→1 columns; tables gain horizontal scroll inside their container; composer sticks to the bottom with safe-area padding. No horizontal page scroll at 375 px.

## 10. Pre-delivery checklist (Phase 6)

- [ ] Tokens only — no raw hex in components; both themes verified side by side
- [ ] Lucide icons only; no emoji
- [ ] `cursor-pointer` and hover/focus states on every interactive element (150–250 ms)
- [ ] Keyboard-only walkthrough of all three flows
- [ ] `prefers-reduced-motion` respected; no layout-shifting animations
- [ ] Skeletons reserve space (CLS < 0.1); long lists virtualised (transcript > 500 rows, runs > 200)
- [ ] 375 / 768 / 1024 / 1440 px checked; no horizontal scroll
- [ ] Lighthouse accessibility ≥ 95 on `/chats/new`, `/scheduled`, `/settings`
- [ ] Microcopy reviewed: short, specific, action-oriented; no jargon leaks (container ids only behind "Copy" actions)
