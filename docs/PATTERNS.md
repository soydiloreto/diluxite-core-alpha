# Diluxite — Frontend patterns

How we keep the web app coherent and predictable as it grows. These are the
small set of rules that everything in `apps/web/src/` follows; new code that
breaks them should either change the pattern (with a note here) or be
refactored before merge.

## 1. Data lives in `AppContext`; views just read it

The whole app reads its global state through `useApp()` (see
`apps/web/src/shell/AppContext.tsx`). The provider lives once at the App
root and exposes both **state** (notes, folders, tags, orgs, spaces…) and
**actions** (mutations + invalidators).

Why: every screen that shows the same data needs to react the same way.
Putting the canonical state in one place removes the "did I remember to
update X too?" cognitive load.

```tsx
// ✅ Right — read from context, no props chain.
function MyView() {
  const { notes, openNote } = useApp();
  return notes.map(n => <Row key={n.id} onClick={() => openNote(n.id)}>{n.title}</Row>);
}

// ❌ Wrong — duplicating fetch + state.
function MyView() {
  const [notes, setNotes] = useState([]);
  useEffect(() => { fetch('/api/notes').then(...).then(setNotes); }, []);
  // …now anyone else who needs notes has to do this dance too.
}
```

## 2. Mutate → Invalidate (never edit shared state by hand)

When a view mutates server state, it should:

1. Call the corresponding `api.<verb>` method.
2. On success, call the matching invalidator on `AppContext`.

Never reach into `AppContext` to patch the cached value by hand — that
would put the burden on every mutation to know what every other view needs.

### Invalidators

| Mutation kind | Invalidator(s) | Why |
|---|---|---|
| Note save (single) | `refreshAll()` | Notes / tags / folders of the active workspace. |
| Bulk note mutation (search & replace, bulk delete, scripted backfill) | `refreshAll()` | Same scope, large change set. |
| Org create / rename / delete / member change | `refreshOrgs()` | Drives the TopBar OrgIndicator + the AdminConsole org label. |
| Workspace create / rename / delete | `refreshSpaces()` (+ `refreshAll()` if the active one changed) | Drives the WorkspaceSelector and the global picker. |

```tsx
// ✅ Right — one mutation, one invalidator.
async function rename(ws: Space, name: string) {
  await api.renameWorkspace(ws.id, name);
  await refreshSpaces();         // global state re-fetched, every consumer re-renders
}

// ❌ Wrong — patching local copies in two places.
async function rename(ws: Space, name: string) {
  await api.renameWorkspace(ws.id, name);
  setLocalList(xs => xs.map(x => x.id === ws.id ? { ...x, name } : x));
  // …and the WorkspaceSelector keeps showing the old name forever.
}
```

If a mutation crosses scopes (e.g. deleting a workspace also evicts notes),
invalidate **both** — that's why `WorkspacesTab` calls
`Promise.all([refreshSpaces(), refreshAll()])`.

## 3. Sidebar slot is single-tenant (no "two sidebars")

The Activity Bar drives which **activity** owns the sidebar slot. There is
**one** sidebar at any moment:

- Explorer / Search / Favourites / Recent → notes views own it.
- Admin → `<AdminSidebar />` replaces it entirely.

That mirrors how VS Code's Source Control / Search / Extensions
activities work — selecting an activity swaps the contents of the same
panel, it doesn't open a second one. Don't nest a second navigation
sidebar inside the main area.

## 4. Mobile-first, breakpoints opt-in

Everything below `md` (`< 768px`) is the **default**. Tailwind utilities
without a prefix apply to mobile; `sm:` / `md:` / `lg:` add desktop
flourishes. The chrome adapts to:

| Element | mobile (`< md`) | desktop (`>= md`) |
|---|---|---|
| Activity Bar | 48-px column, always visible | same |
| Sidebar | `fixed` drawer, 80vw wide, dim backdrop | `static` panel, user-resizable |
| TopBar workspace selector | hidden (use the sidebar) | visible, centered |
| TopBar org indicator | hidden (open admin to switch) | visible, right-aligned |
| Editor | full-width, no preview by default | split editor + preview |
| Admin Console | scrolls vertically, single column | same with wider max-width |

Rules of thumb:
- Tap targets are **at least 36×36 px** (use `h-9 w-9 p-2` or larger).
- Long text gets `truncate` + `title="…"` for the full value.
- Drawers and modals close on backdrop tap and on `Escape`.

## 5. Errors surface in-view, not in alerts

Every async action that can fail (rename, invite, delete) shows the error
in the same panel that triggered it — not in `window.alert`. The pattern:

```tsx
const [error, setError] = useState<string | null>(null);
try {
  await api.something();
  await refreshOrgs();
} catch (e) {
  setError(e instanceof Error ? e.message : String(e));
}

// Render
{error && (
  <p className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded p-2">
    {error}
  </p>
)}
```

## 6. Local component state is for ephemeral UI only

A `useState` is fine for things that don't outlive the component: form
input values, "is this menu open", scroll position, hover, etc. Anything
that another screen also cares about goes through `AppContext`. When in
doubt, ask: "would another view need to react to this changing?". If yes
→ context. If no → local state.

## 7. Test through the rendered DOM, not implementation

Every new view ships with a `*.test.tsx` next to it that:

- Uses `renderWithCtx` (`apps/web/test/render-with-ctx.tsx`) to provide a
  minimal `AppCtx` — pass in spies for the actions you want to assert.
- Queries by accessible name / role / `data-testid`, never by class.
- Asserts the user-visible outcome, not internal state.

See `apps/web/src/shell/views/SearchView.test.tsx` for the
mutation-invalidates-state pattern: it stubs `refreshAll` and asserts it
was called instead of poking at the notes list.

---

## Back-end mirrors (`apps/api/`, `packages/db/`)

The same shape applies on the server: handlers in `apps/api/src/app.ts`
go through repositories in `packages/db/src/*-repository.ts`, which own
the SQL. Cross-cutting concerns (auth, RLS identity) live in middleware,
not sprinkled across handlers. See `docs/MULTI-TENANT.md` for the RLS
plumbing.
