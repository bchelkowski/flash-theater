' flash-theater:runtime — hand-authored, not generated from a .thr file. Auto-copied by the CLI
' into an app's output whenever any component uses the focus system (see cli.ts). Do not edit
' per-app; change this file in packages/compiler/runtime-assets/FocusManager instead.
'
' Holds one flat, cross-component registry of every `focusable`-bearing node in the whole running
' app (every component's generated init()/create sub registers its own focusable nodes here — see
' codegen/brs-emitter.ts and codegen/conditional-block-emitter.ts). Each entry is
' `{node: <focusable node>, owner: <owning component instance's own m.top>}`, not a bare node —
' `owner` is what lets navigate() search within the currently-focused node's own component first
' (see that function below). Node-reference equality via plain "=" throws a runtime Type Mismatch
' on roSGNode (confirmed live — see findings/focus-system.md), so every comparison here
' goes through IsSameNode() instead.
'
' Every real focus move (navigate()'s winning candidate, recoverFocusFor()'s target) routes through
' moveFocusTo(), which also auto-scrolls the nearest opted-in ancestor (a component declaring
' ordinary `scrollOffsetX`/`scrollOffsetY` fields) so the newly-focused node stays in view — see
' scrollIntoView() below and findings/focus-system.md.

' Hold-to-repeat tuning for startRepeat()/onRepeatTimerFire() below — delay-then-accelerate, not a
' fixed rate: a pause after the immediate first move (so a quick tap never triggers a second hop),
' then repeats that start at a comfortable pace and speed up the longer the button stays held.
function repeatTuning() as object
  return { initialDelay: 0.45, startInterval: 0.2, minInterval: 0.06, accelFactor: 0.85 }
end function

sub init()
  m.registry = []
  m.sceneRef = invalid
  m.lastFocused = invalid
  m.lastFocusedColor = invalid

  ' THE single source of truth for "what has focus right now" — the one registered leaf this
  ' framework last moved real focus to (see moveFocusTo(), the only writer). Every derived answer
  ' — isFocused/isInFocusChain on subscribing components, focusPath, "did this owner just lose
  ' focus" — is recomputed from THIS one value in one pass, which is precisely why two components
  ' can never both report isFocused = true: there is one value and one writer, not N independent
  ' per-component observers that could disagree. Deliberately NOT derived from the native
  ' hasFocus()/IsInFocusChain() fields: confirmed live that those can report focus on a node that
  ' real key events never reach (see findings/focus-system.md's "2+ nested callFunc hops" entry),
  ' so they are not a trustworthy basis for state a .thr author reacts to.
  m.focusedNode = invalid

  ' Scene-to-leaf path of the currently focused node, rebuilt on every real focus move — see
  ' rebuildFocusPath()/getFocusPath() below. Purely diagnostic: it exists so "what exactly has
  ' focus, and through which ancestors" is answerable at any moment without guessing.
  m.focusPath = []

  ' Components that declared `isFocused`/`isInFocusChain` in their own .thr and therefore want
  ' those two fields kept up to date — see registerFocusState()/updateFocusState(). Empty (and
  ' updateFocusState a no-op loop) for every app whose components never mention either name: the
  ' compiler emits no registerFocusState() call at all in that case, so there is zero cost.
  m.focusStateSubscribers = []

  ' The pending focus target for the CURRENT transition — see proposeFocusTarget()/
  ' requestFocusTarget()/applyPendingFocus() for the whole mechanism and why it exists (the
  ' platform's 2+-callFunc-hop limitation makes a focus grab from deep inside a mount cascade
  ' silently fail to route real key events).
  m.pendingTarget = invalid
  m.pendingIsExplicit = false

  ' Set for the whole duration of a router navigation's own mount (forward or back — a resolved
  ' path+params key, see captureRouteFocusMemory()/beginSuppressedNavigation()/
  ' resolveRouteFocusTarget() below) — arms applyPendingFocus()'s own "stay vacant, don't recover"
  ' branch for exactly that navigation, instead of its ordinary immediate fallback.
  m.suppressedNavRouteKey = invalid

  ' Set by unregister()/unregisterSubtree() when the node they remove is the one that currently
  ' holds focus — the owner whose content just went away. recoverFocusFor() acts ONLY for this
  ' owner, which is what stops an unrelated component's reconcile from grabbing focus during
  ' another component's construction (see recoverFocusFor()'s own doc comment).
  m.focusLostFromOwner = invalid

  ' Per-owner "last focused" memory, most-recent-first — see rememberLastFocused()/
  ' lastFocusedFor() below and navigate()'s own doc comment for why this exists.
  m.lastFocusedByOwner = []

  ' Per-ROUTE "last focused" memory — keyed by the OUTGOING route's own resolved path+params string
  ' at the moment router.navigate()/router.back() was called, not a node reference (unlike
  ' m.lastFocusedByOwner above), because a router-mounted screen is always a brand-new component
  ' instance on every visit (see runtime-assets/RouterOutlet's own "always rebuild fresh"
  ' philosophy) — the old node reference is simply gone by the time the same route is revisited.
  ' Each entry is `{routeKey, idChain}`, where idChain is the focused element's own id chain
  ' (innermost first) up to the Scene — whatever was ACTUALLY focused at that moment, regardless of
  ' whether it lived inside the route being left, inside persistent chrome, or inside some other,
  ' unrelated outlet's own content entirely. See captureRouteFocusMemory() below for how it's
  ' recorded (from FlashTheaterRouter's own navigate(), the one place that genuinely knows "the
  ' route being left" for the whole app, not just one outlet's own slice of it) and
  ' resolveRouteFocusTarget() for how it's re-resolved, Scene-wide, once that same route mounts again.
  m.lastFocusedByRouteKey = []

  ' m.repeatTimer is deliberately NOT created here — see startRepeat()'s own comment for why.
  m.repeatTimer = invalid
  m.repeatKey = invalid
  m.repeatCount = 1
  m.repeatNextInterval = 0
end sub

' Called once from the app's own hand-written Main.brs, right after CreateScene — there is no
' reliable way for a plain roSGNode to discover "the" Scene on its own, so it's handed in
' explicitly, the same one-hand-written-line convention store/theme already established.
sub setSceneRef(scene as object)
  m.sceneRef = scene
end sub

' Idempotent — a dynamic focusable="{expr}" element's registration is driven by the same reactive
' cascade its value's own dependencies already re-run (see codegen/brs-emitter.ts's
' emitBindingAssignment), which can legitimately re-fire "still true" more than once without the
' boolean actually changing; registering the same node twice would leave a stale duplicate entry
' behind that unregister() (a single-entry removal) could never fully clean up. `owner` is the
' registrant's owning component instance's own root node (generated call sites always pass their
' own `m.top`) — see this file's own top-of-file doc comment for why.
'
' `isDefault` (true only for an element with a static `default-focus="true"` attribute — see
' analysis/focusable-elements.ts, GRAMMAR.md's "Focus system" section) marks this entry as its own
' owner's EXPLICIT default focus target — firstRegistrantOfOwner() below prefers it over plain
' registration order. A DSL author's own compile-time check (checkAtMostOneDefaultFocus) already
' guarantees at most one `isDefault: true` entry per owner reaches this function.
sub register(node as object, owner as object, isDefault as boolean)
  if indexOfNode(node) = -1 then
    m.registry.Push({ node: node, owner: owner, isDefault: isDefault })
  end if
end sub

' Called BEFORE removeChild by generated teardown code, so IsInFocusChain() is still valid on
' `node`. Deliberately does NOT reassign focus itself, even when `node` currently holds it —
' confirmed live that calling SetFocus here and then letting the *caller* perform further tree
' mutations (an {#each} reconcile's later reposition pass, which unconditionally re-InsertChilds
' every surviving item to support reordering) silently clears focus again, exactly like removing
' the focused node itself does. The caller must call `recoverFocusFor(<its own m.top>)` itself,
' exactly once, after *all* of its own tree mutations for this pass are done — see that function
' below.
sub unregister(node as object)
  idx = indexOfNode(node)
  if idx >= 0 then
    noteFocusLoss(node, m.registry[idx].owner)
    m.registry.Delete(idx)
  end if
end sub

' Records that `node` — if it is the node currently holding focus — is going away, and whose
' content it was. This is what makes automatic focus recovery PRECISE instead of opportunistic:
' recoverFocusFor() acts only for the owner named here, so a reconcile running inside some OTHER,
' unrelated component (very common — a child component's own {#each} reconcile runs while a whole
' new screen is still being constructed around it) can never grab focus that was never its own to
' begin with. Confirmed live as a real bug before this existed: a nested ScheduleList's own
' reconcile fired during a fresh ScheduleScreen mount, grabbed an arbitrary registrant from the
' flat app-wide registry, and — by recording it as that screen's "last focused" — permanently
' defeated the screen's own default-focus="true" element. See findings/focus-system.md.
sub noteFocusLoss(node as object, owner as object)
  if m.focusedNode = invalid then return
  if not m.focusedNode.IsSameNode(node) then return
  m.focusLostFromOwner = owner
  m.focusedNode = invalid
  rebuildFocusPath()
  updateFocusState()
end sub

' Bulk counterpart to unregister() — removes every registry entry whose OWNER is `root` itself or
' anywhere in `root`'s own subtree, in one pass. Needed for a router-swapped subtree (see
' runtime-assets/RouterOutlet): destroying an entire route's component tree removes possibly-many
' focusable descendants whose specific ids/owners are compile-time-unknown (an arbitrary,
' dynamically-CreateObject'd component, unlike a {#if:destroy}/{#each} teardown, which always
' knows exactly which static ids it's removing and unregisters each individually) — a single
' `unregister(node)` call per descendant isn't an option here, since the caller has no way to
' enumerate them. Called BEFORE RemoveChild, same requirement `unregister()` already documents
' (GetParent() needs the still-attached tree) — see FlashTheaterRouterOutlet.brs's own call site.
'
' `recoveryOwner` (`invalid` for RouterOutlet's own call, which handles its own post-mount focus
' proposal separately) is the enclosing `.thr` component's own `m.top` for a `{#if:destroy}`
' destroy sub's call (see codegen/conditional-block-emitter.ts's emitConditionalDestroySub) —
' NEEDED so that component's own LATER, deliberately-deferred `recoverFocusFor(m.top)` call (run
' AFTER RemoveChild, so it never targets something a sibling teardown in the same cascade is about
' to remove too — see recoverFocusFor's own doc comment) can still succeed even when the lost focus
' belonged to a NESTED CUSTOM COMPONENT's own content (registered under THAT component's own m.top,
' not the enclosing one). `recoverFocusFor`'s own match is a trivial IsSameNode() compare with no
' tree-walking of its own — by the time it runs, RemoveChild has already cut `root`'s own link to
' its former parent, so any ancestry walk attempted AT THAT POINT (from the nested owner up to the
' enclosing m.top) would fail partway, right at the cut link. Rewriting m.focusLostFromOwner to
' `recoveryOwner` HERE instead — while `root` is still fully attached and the walk is guaranteed to
' succeed — sidesteps that entirely. See issues/focus-destroy-nested-component-orphaned-registration.md.
sub unregisterSubtree(root as object, recoveryOwner as object)
  i = m.registry.Count() - 1
  while i >= 0
    if isDescendantOrSelf(m.registry[i].owner, root) then
      noteFocusLoss(m.registry[i].node, m.registry[i].owner)
      m.registry.Delete(i)
    end if
    i = i - 1
  end while

  ' A destroyed subtree can also contain components that were subscribing to isFocused/
  ' isInFocusChain updates — drop those too, or updateFocusState() would keep writing fields on
  ' detached nodes forever (harmless per write, but an unbounded leak across many navigations).
  i = m.focusStateSubscribers.Count() - 1
  while i >= 0
    if isDescendantOrSelf(m.focusStateSubscribers[i], root) then m.focusStateSubscribers.Delete(i)
    i = i - 1
  end while

  if recoveryOwner <> invalid and m.focusLostFromOwner <> invalid and isDescendantOrSelf(root, recoveryOwner) then
    m.focusLostFromOwner = recoveryOwner
  end if
end sub

' True when `node` IS `root`, or `root` is one of `node`'s ancestors — walks GetParent() up from
' `node`, same "no reference equality, only IsSameNode()" discipline every other node comparison
' in this file already follows (see this file's own top comment).
function isDescendantOrSelf(node as object, root as object) as boolean
  walker = node
  while walker <> invalid
    if walker.IsSameNode(root) then return true
    walker = walker.GetParent()
  end while
  return false
end function

' Called by FlashTheaterRouterOutlet's own _unregisterCurrentChildFocus(), BEFORE unregisterSubtree
' runs — records `node`'s own ancestor id chain (innermost first, up to the Scene), keyed by the
' OUTGOING route's own resolved path+params (`routeKey`, read from that outlet's own
' `m._renderedGlobalRouteKey` — a per-child-instance snapshot, since `m._router.activatedRoute`
' itself has already moved on to the INCOMING route by the time this runs). A no-op when `node` is
' `invalid` (nothing worth remembering) or has no id-bearing ancestor at all.
'
' Deliberately takes `node` as a parameter rather than reading `currentlyFocused()` itself: the
' caller passes `mostRecentlyFocusedWithin(m.currentChild)` — the last element ACTUALLY focused
' ANYWHERE inside the outgoing route's own content (including inside a nested custom component),
' continuously tracked by rememberLastFocused() (called from every real moveFocusTo(), regardless of
' what's focused NOW) — not whatever happens to hold literal focus at this exact instant. Those two
' differ whenever the user stepped back to a persistent menu (or anywhere else outside this route's
' own content) to actually TRIGGER the navigation — a normal, common interaction in the canonical
' "persistent side menu" TV layout this framework's own vacuum rule is built around. Using
' `currentlyFocused()` here would silently capture the menu item instead of whatever the user was
' actually last looking at inside this route — confirmed live as a real, reported bug (a Schedule
' list row correctly focused, then the user stepping back to the sidebar menu to navigate elsewhere,
' then Back — the row was never restored). See findings/router-focus-integration.md.
'
' A routed screen's own content is always a brand-new component instance on every visit (routed
' screens are never reused, see this file's own top comment), so the old node reference for THAT
' case is long gone by the next visit — re-identifying by `id` (see resolveRouteFocusTarget()) is
' what makes restoration work regardless.
sub captureRouteFocusMemory(routeKey as string, node as dynamic)
  if node = invalid then return

  idChain = []
  walker = node
  while walker <> invalid
    if walker.id <> "" then idChain.Push(walker.id)
    walker = walker.GetParent()
  end while
  if idChain.Count() = 0 then return

  i = 0
  while i < m.lastFocusedByRouteKey.Count()
    if m.lastFocusedByRouteKey[i].routeKey = routeKey then
      m.lastFocusedByRouteKey.Delete(i)
    else
      i = i + 1
    end if
  end while
  m.lastFocusedByRouteKey.Unshift({ routeKey: routeKey, idChain: idChain })
end sub

' Re-asserts focus after `owner`'s own tree mutations — but ONLY when `owner` is the component
' that actually just lost the focused node (recorded by noteFocusLoss() during unregister()/
' unregisterSubtree()). Every other call is a cheap no-op. Two call sites, both unconditional, both
' calling this exactly once after all of their own mutations for the pass are done: compiler-
' generated {#if:destroy}/{#each} teardown/reconcile code (see codegen/conditional-block-emitter.ts
' and codegen/each-block-emitter.ts), synchronously, right after its own mutations — and
' applyPendingFocus() (below), as its own fallback when a router navigation proposed no replacement
' target at all (a routed screen with no focusable content of its own — see that function's own
' doc comment for why THAT call site, not FlashTheaterRouterOutlet's own teardown, is where it
' safely belongs).
'
' This owner scoping is the whole point, and replaces an earlier, deliberately blunt global
' version ("if NOTHING in the app holds focus, grab m.registry[0]"). That version was wrong in a
' way that only showed up once components nested: during a fresh screen's construction there is
' legitimately no focus anywhere yet, so a nested child component's own reconcile would fire,
' see the vacuum, and grab an arbitrary registrant belonging to a COMPLETELY DIFFERENT component
' — then record it via moveFocusTo()'s rememberLastFocused(), which permanently defeated the
' screen's own default-focus="true" element (enterOwner() prefers remembered focus over the
' declared default). Confirmed live; see findings/focus-system.md.
'
' Falls back, in order: this owner's own default-focus/first registrant → wherever focus most
' recently was in some OTHER still-registered component (the "a dialog closed, put me back where I
' was" case) → the Scene itself, so at minimum the back key keeps working.
sub recoverFocusFor(owner as object)
  if m.focusLostFromOwner = invalid then return
  if not m.focusLostFromOwner.IsSameNode(owner) then return
  m.focusLostFromOwner = invalid

  ' Something else already legitimately took focus during this same cascade — nothing to recover.
  if currentlyFocused() <> invalid then return

  target = firstRegistrantOfOwner(owner)
  if target = invalid then target = mostRecentlyFocusedElsewhere(owner)

  if target <> invalid then
    moveFocusTo(target)
  else if m.sceneRef <> invalid then
    m.sceneRef.SetFocus(true)
    m.focusedNode = invalid
    rebuildFocusPath()
    updateFocusState()
  end if
end sub

' Claims `owner`'s own default (or first registered) element, but ONLY if nothing in the whole app
' currently holds focus — a genuine, currently-existing vacuum, not specifically "something owner
' itself just lost" the way recoverFocusFor() tracks. This is the explicit escape hatch for content
' that appears well after the ordinary init()/setup()/reconcile cascade has already settled — the
' common case being a hand-wired Timer simulating an async load (no built-in async primitive of its
' own; see GRAMMAR.md's "Focus system"). A component's own {#if:destroy}/{#each} create path does
' NOT call this automatically, and that is deliberate, not an oversight: doing so would reintroduce
' the exact ordering bug recoverFocusFor()'s owner-scoping exists to prevent (a nested child
' component's own reconcile firing DURING an enclosing component's still-incomplete construction,
' claiming a vacuum the enclosing component's own not-yet-run entry decision should have had first
' refusal on). Calling this explicitly from a genuinely async callback (a Timer's own "fire" field
' observer, not a synchronous construction path) is safe precisely because every synchronous mount
' decision has already run to completion by the time such a callback fires — there is no "who
' decides first" race left to lose. Confirmed live; see findings/focus-system.md.
sub claimFocusIfVacant(owner as object)
  if currentlyFocused() <> invalid then return
  target = firstRegistrantOfOwner(owner)
  if target <> invalid then moveFocusTo(target)
end sub

' The most recently focused still-registered node belonging to any owner OTHER than `excludeOwner`
' — `m.lastFocusedByOwner` is kept most-recent-first by rememberLastFocused(), so the first
' surviving entry found is genuinely the latest. This is what makes "close an overlay/dialog and
' land back where you were" work automatically, with no per-app bookkeeping: the overlay's own
' teardown reports the loss, its own component has no registrants left, and focus returns to the
' component the user was in beforehand.
function mostRecentlyFocusedElsewhere(excludeOwner as object) as dynamic
  for i = 0 to m.lastFocusedByOwner.Count() - 1
    entry = m.lastFocusedByOwner[i]
    if not entry.owner.IsSameNode(excludeOwner) then
      if indexOfNode(entry.node) >= 0 then return entry.node
    end if
  end for
  return invalid
end function

' SetFocus(true) plus the scroll-into-view follow-up and highlight swap every real focus move
' needs — the single choke point both navigate() and recoverFocusFor() route their winning target
' through, so both behaviors are automatic for any focus change, not something a .thr author has
' to wire up per navigation path. Also exposed on the component interface so hand-written app code
' (see MainScene.brs's "replay" handler) gets the same treatment for a focus move it triggers
' directly, instead of calling node.SetFocus(true) itself and silently missing both.
sub moveFocusTo(node as object)
  restoreLastFocusedColor()
  node.SetFocus(true)
  highlightFocused(node)
  scrollIntoView(node)
  rememberLastFocused(node)

  ' The single point where "what has focus" changes, hence the single point where every derived
  ' answer is recomputed — see m.focusedNode's own comment in init() for why this being the ONLY
  ' writer is what guarantees two components can never both report isFocused = true.
  m.focusedNode = node
  m.focusLostFromOwner = invalid
  rebuildFocusPath()
  updateFocusState()
end sub

' Recomputes `isFocused`/`isInFocusChain` for every subscribing component, in one pass, from the
' single m.focusedNode value:
'   - isFocused      — this component OWNS the focused leaf (focus is directly in this component's
'                      own template, not merely somewhere in a nested child component).
'   - isInFocusChain — the focused leaf is anywhere inside this component's subtree, INCLUDING
'                      inside a nested child component.
' So a persistent chrome component wrapping a router outlet reads isInFocusChain = true while the
' mounted screen holds focus, but isFocused = false — the distinction a real app needs to style
' "this section is active" separately from "this exact control is selected".
'
' Writes only on actual change: these are ordinary SceneGraph fields, and rewriting the same value
' would still fire every observer bound to them (an author's `derived`, a template binding), so an
' unconditional write would turn one real focus move into a storm of redundant recomputation.
sub updateFocusState()
  focusedOwner = invalid
  if m.focusedNode <> invalid then focusedOwner = ownerOf(m.focusedNode)

  for i = 0 to m.focusStateSubscribers.Count() - 1
    subscriber = m.focusStateSubscribers[i]

    isFocused = false
    isInChain = false
    if m.focusedNode <> invalid then
      if focusedOwner <> invalid then isFocused = focusedOwner.IsSameNode(subscriber)
      isInChain = isDescendantOrSelf(m.focusedNode, subscriber)
    end if

    if subscriber.isFocused <> isFocused then subscriber.setField("isFocused", isFocused)
    if subscriber.isInFocusChain <> isInChain then subscriber.setField("isInFocusChain", isInChain)
  end for
end sub

' Called once from a component's own generated init(), and ONLY for a component whose .thr
' actually references `isFocused`/`isInFocusChain` somewhere (see compile.ts's
' usesFocusStateAnywhere) — a component that never mentions either name emits no call here, gets
' no fields, and costs nothing at runtime.
sub registerFocusState(owner as object)
  for i = 0 to m.focusStateSubscribers.Count() - 1
    if m.focusStateSubscribers[i].IsSameNode(owner) then return
  end for
  m.focusStateSubscribers.Push(owner)
  updateFocusState()
end sub

' Rebuilds the Scene-to-leaf ancestor path of the currently focused node. Diagnostic only — see
' getFocusPath()/getFocusPathString(), which exist so an app (or a live debugging session) can
' always answer "what has focus, and where does it sit in the tree" from the framework's own
' authoritative record rather than from the native fields, which are not always truthful.
sub rebuildFocusPath()
  path = []
  walker = m.focusedNode
  while walker <> invalid
    path.Unshift({ id: walker.id, subtype: walker.Subtype() })
    walker = walker.GetParent()
  end while
  m.focusPath = path
end sub

function getFocusPath() as object
  return m.focusPath
end function

' The same path as a single readable line, e.g.
' "Scene > Group > Shell > Group#childOutlet > HomeScreen > Rectangle#prompt" — for logging.
function getFocusPathString() as string
  if m.focusPath.Count() = 0 then return "<nothing focused>"
  parts = []
  for i = 0 to m.focusPath.Count() - 1
    entry = m.focusPath[i]
    label = entry.subtype
    if entry.id <> "" then label = label + "#" + entry.id
    parts.Push(label)
  end for
  result = parts[0]
  for i = 1 to parts.Count() - 1
    result = result + " > " + parts[i]
  end for
  return result
end function

' The framework's own authoritative "what has focus right now", or invalid — deliberately NOT the
' native focus fields; see m.focusedNode's own comment in init().
function focusedNode() as dynamic
  return m.focusedNode
end function

' Which specific node should receive focus when entering `owner`'s content from outside it: that
' owner's own remembered last-focused element if it has one (see lastFocusedFor()), otherwise
' `fallbackNode` — the caller's own idea of a reasonable default (navigate()'s cross-owner
' geometric winner, or firstRegistrantOfOwner() for an explicit, non-geometric jump like
' focusComponent() below). Shared by both so "which element inside a just-entered component gets
' focus" has exactly one implementation.
function enterOwner(owner as object, fallbackNode as dynamic) as dynamic
  remembered = lastFocusedFor(owner)
  if remembered <> invalid then return remembered
  return fallbackNode
end function

' `owner`'s own explicitly-declared default-focus registrant if it has one (see register()'s
' `isDefault` parameter and GRAMMAR.md's "Focus system" section), otherwise the first
' still-registered node belonging to `owner` in registration order — matches recoverFocusFor()'s own
' "first remaining registrant" fallback for the no-default case, and there's no meaningful
' geometric anchor here since, unlike navigate(), there's no direction or currently-focused
' position to search from. `invalid` if `owner` has no registered content at all (e.g. it hasn't
' rendered any focusable elements yet — a {#each}-driven grid still gated behind
' {#if:destroy loaded}).
'
' This is what makes a freshly `CreateObject`'d component (a router-mounted screen, in
' particular — see runtime-assets/RouterOutlet) land focus on its own declared default the moment
' it's entered, with no router-specific code anywhere in this file: a brand-new node instance can
' never have any `lastFocusedByOwner` memory (that memory is keyed by node reference, and this is
' a node that didn't exist a moment ago), so enterOwner()'s fallback to this function is exactly
' what fires on every such entry.
function firstRegistrantOfOwner(owner as object) as dynamic
  declared = declaredDefaultOfOwner(owner)
  if declared <> invalid then return declared

  for i = 0 to m.registry.Count() - 1
    entry = m.registry[i]
    if entry.owner.IsSameNode(owner) then return entry.node
  end for
  return invalid
end function

' Just `owner`'s EXPLICITLY declared default-focus="true" registrant, with no registration-order
' fallback — `invalid` when the author declared none. Kept separate from firstRegistrantOfOwner()
' because the two callers want different things when nothing is declared:
'   - entering a component non-directionally (focus(<id>), a router mount) has no spatial anchor at
'     all, so "first registered" is the only sensible fallback — firstRegistrantOfOwner();
'   - entering by LRUD (navigate()'s cross-owner pass) DOES have a spatial anchor, and falling back
'     to registration order there would be strictly worse than the geometric winner the search
'     already computed — so that caller falls back to geometry instead, and uses this function only
'     to let an explicitly declared default override it.
' Either way a declared default-focus="true" wins, which is what makes the attribute mean the same
' thing however focus arrives.
function declaredDefaultOfOwner(owner as object) as dynamic
  for i = 0 to m.registry.Count() - 1
    entry = m.registry[i]
    if entry.owner.IsSameNode(owner) and entry.isDefault then return entry.node
  end for
  return invalid
end function

' Explicit, non-directional focus transfer — the runtime side of the `focus(<expr>)` DSL statement
' sugar (see identifier-rewrite.ts's rewriteFocusStatement). `target` always arrives as a plain node
' reference already — the compiler wraps every `focus(<id>)` call in `m.top.findNode(<id>)` at the
' CALL SITE, scoped to the calling component's own subtree, so by the time this function ever runs
' it has no way to reach outside whatever `m.top.findNode` already resolved. Deliberately not
' resolved here against the whole scene (an earlier version did this, accepting a bare string and
' calling `m.sceneRef.findNode` — reachable from anywhere in the app, which broke the framework's
' own parent-mediated data-flow discipline: a component could "teleport" focus into a totally
' unrelated branch of the tree it has no business knowing about, the same way it could never
' directly reach into an unrelated sibling's `state`. See findings/focus-system.md for the
' real-world case this restriction exists for; reaching a sibling now has to go through a parent
' that owns both, exactly like any other cross-branch signal in this framework — the child sets an
' outbound `field`, the parent reacts and calls `focus(<childId>)`/`callFunc("focusComponent",
' <ownChildNode>)` itself, since the sibling IS the parent's own child.) A no-op if `target` is
' invalid (the id didn't resolve to a real descendant) or has no registered focusable content.
'
' `target` is polymorphic in a second, DELIBERATE way — it can be either:
' - a specific, already-*registered* focusable leaf (e.g. `focus("row0")` resolving straight to a
'   `focusable="true"` element) — focused directly, no further search; or
' - a *component's own root* (an `owner` value, exactly what `register()` stores against each of
'   ITS OWN focusable descendants — e.g. `MainScene.brs`'s `m.focusGroup`/`m.scrollFocusDemo`,
'   passed directly since a hand-composed parent already holds its own children's references) —
'   entered via `enterOwner()`/`firstRegistrantOfOwner()`, same as `navigate()`'s cross-owner case:
'   that component's own remembered last-focused element if it has one, otherwise its first
'   registered descendant. Which of these two `target` is gets decided by `indexOfNode(target)`: a
'   node individually present in the registry is a leaf (case 1); a component root is never itself
'   an entry (only ITS OWN descendants are, with `owner` pointing back to it), so it falls to case
'   2. Confirmed live as a real, silent bug before this dual check existed: `focus("row0")` looked
'   up `row0` correctly, but `focusComponent` unconditionally ran the component-entry branch on it —
'   scanning the registry for something whose OWNER equals `row0` (nothing does; `row0` is a leaf,
'   never an owner) always came back invalid, so the call silently did nothing at all.
'
' Reuses enterOwner() so a component entered via case 2 honors its own remembered last focus exactly
' like a cross-owner navigate() move does; falls back to firstRegistrantOfOwner() the first time a
' component is ever entered, before it has any focus memory of its own. Deliberately a single
' callFunc hop from whatever onKeyEvent is currently executing — see findings/focus-system.md's "2+
' nested callFunc hops doesn't route events" entry; moveFocusTo()/enterOwner()/
' firstRegistrantOfOwner() below are all plain in-file calls, not further roSGNode.CallFunc() hops,
' so calling this once from an on:key handler (via `focus(...)`) stays within the one-hop budget
' confirmed to actually work on a real device.
sub focusComponent(target as object)
  entered = resolveEntryTarget(target)
  if entered = invalid then return

  ' Recorded as an EXPLICIT request as well as being applied immediately. The immediate
  ' moveFocusTo() is what makes an ordinary `focus(<id>)` from an on:key handler work exactly as
  ' before (shallow enough to establish real key routing). The recorded request is what makes the
  ' SAME statement also work when it runs deep inside a router mount cascade — an author writing
  ' `focus("somethingElse")` in a router-mounted screen's own setup() is 3 callFunc hops from the
  ' live handler (onKeyEvent -> navigate -> setup -> focusComponent), well past the platform's
  ' limit, so the immediate call there sets IsInFocusChain but silently fails to route real key
  ' events. applyPendingFocus(), emitted by the compiler as a shallow sibling statement right
  ' after the router.navigate(...)/router.back() call, then re-applies it from a depth that works.
  ' Marked explicit so it overrides the vacuum rule: the author asked for this focus move by name,
  ' so it is allowed to take focus away from whatever currently holds it.
  requestFocusTarget(entered)
  moveFocusTo(entered)
end sub

' Which specific node a focus entry into `target` should land on, without performing the move —
' the shared resolution step behind both focusComponent() (immediate) and the router outlet's own
' deferred proposal (see proposeFocusTarget()). `invalid` when `target` is invalid or has no
' registered focusable content at all. See focusComponent()'s doc comment above for why `target`
' is polymorphic (a registered leaf, or a whole component's root).
function resolveEntryTarget(target as object) as dynamic
  if target = invalid then return invalid
  if indexOfNode(target) >= 0 then return target
  return enterOwner(target, firstRegistrantOfOwner(target))
end function

' ---------------------------------------------------------------------------------------------
' Deferred focus application — the mechanism that makes focus survive a router navigation.
'
' Roku will not establish real key-event routing for a SetFocus() reached through two or more
' nested callFunc hops from whatever native handler is currently executing (confirmed live, more
' than once — see findings/focus-system.md). A router navigation is inherently deep: the author's
' handler calls router.navigate(...) [hop 1], the router bumps a field, each mounted outlet's own
' field observer runs, and the newly created screen's focus grab would sit at hop 2 or deeper. So
' the mount cascade does not focus anything itself — it only RECORDS what should be focused (pure
' bookkeeping, safe at any depth) — and the compiler emits one shallow applyPendingFocus() call as
' a sibling statement right after the author's own router.navigate(...)/router.back(), which is
' within the one-hop budget that actually works.
' ---------------------------------------------------------------------------------------------

' Clears any leftover proposal at the START of a navigation (called by FlashTheaterRouter.navigate).
' Without this, an explicit focus(...) performed earlier, in some unrelated handler, would still be
' sitting in m.pendingTarget and would hijack the next navigation's own focus decision.
'
' Also clears any suppression armed by a PREVIOUS, now-superseded navigation (see
' beginSuppressedNavigation() below) — so a rapid re-navigation (e.g. Back pressed twice before the
' first gate ever settles) always starts this fresh navigation's own cascade with a clean slate.
' Safe even though that earlier gate's own observer/timer is being torn down in this very same
' navigate() call (FlashTheaterRouterOutlet's own _cancelInFlightTransition()): the observer/timer is
' always fully unobserved before this navigation ever reaches its own suppression decision, so the
' abandoned gate can never fire late and misuse a suppression meant for a different route.
sub beginFocusTransition()
  m.pendingTarget = invalid
  m.pendingIsExplicit = false
  m.suppressedNavRouteKey = invalid
end sub

' Arms the "stay vacant, wait for the real content" branch in applyPendingFocus() below for the
' navigation currently mounting `routeKey` — called by FlashTheaterRouterOutlet's own _mountRoute(),
' unconditionally, for EVERY journey (forward or back), before it's even known whether this mount
' will end up gated or animated. Without this, applyPendingFocus()'s own imminent call (the
' compiler-emitted shallow follow-up right after router.navigate()/router.back() returns) would
' immediately fall back to recoverFocusFor(), landing focus on some unrelated element before the
' destination route's real content even exists — see resolveRouteFocusTarget() below for how this
' gets resolved for real, once the mount (gate, exit animation, or both) actually settles.
'
' Needed for forward navigation too, not just back: a router-mounted screen's own focusable content
' (not just a persistent sidebar menu) can itself trigger router.navigate() — e.g. an on:key[OK]
' handler on a routed screen's own default-focus element — which genuinely destroys the
' currently-focused node on the way out, exactly like a back journey does. Without suppression on
' that leg too, the same early applyPendingFocus() follow-up falls into recoverFocusFor() and lands
' focus on whatever else was most recently focused (e.g. a persistent sidebar) — permanently, since
' that then defeats the vacuum rule for both the forward destination's own default-focus proposal AND
' any later back-navigation's own correctly-resolved restoration. See
' findings/router-focus-integration.md.
sub beginSuppressedNavigation(routeKey as string)
  m.suppressedNavRouteKey = routeKey
end sub

' An AUTOMATIC candidate, offered by a router outlet for the screen it just mounted. First writer
' wins, and nested outlets construct inside-out (a nested outlet's whole init() runs as part of the
' enclosing outlet's own CreateObject call), so the DEEPEST outlet that actually mounted focusable
' content is the one whose candidate survives — which is the correct target, since that is the leaf
' content the user is navigating to. An outer outlet whose own mounted component has no focusable
' content of its own (persistent chrome) resolves to invalid and never competes at all.
' Never overrides an explicit request.
sub proposeFocusTarget(node as object)
  if node = invalid then return
  if m.pendingIsExplicit then return
  if m.pendingTarget <> invalid then return
  m.pendingTarget = node
end sub

' An EXPLICIT request — the author named this target via focus(<id>). Always wins over any
' automatic candidate, regardless of ordering or nesting depth, and is applied even when something
' else currently holds focus.
sub requestFocusTarget(node as object)
  if node = invalid then return
  m.pendingTarget = node
  m.pendingIsExplicit = true
end sub

' Applies whatever the transition settled on, then clears it. Emitted by the compiler as a shallow
' sibling statement immediately after every router.navigate(...)/router.back() statement.
'
' THE VACUUM RULE: an AUTOMATIC candidate is applied only when nothing currently holds focus.
' Focus is never taken away from a living focus by the default machinery — only ever filled in
' where it is missing. This is what makes the ordinary TV pattern work correctly: with focus in a
' persistent side menu, switching tabs swaps the content beside it without yanking focus out of the
' menu mid-navigation. When focus WAS inside the content being replaced, destroying it leaves a
' genuine vacuum, and the freshly mounted screen's own default-focus="true" element fills it.
' An EXPLICIT request (focus(<id>)) deliberately bypasses this — see requestFocusTarget().
sub applyPendingFocus()
  target = m.pendingTarget
  isExplicit = m.pendingIsExplicit
  m.pendingTarget = invalid
  m.pendingIsExplicit = false

  if target = invalid then
    ' Nothing was proposed for whatever this navigation mounted — the ordinary reason is a routed
    ' screen with NO focusable content of its own (every focusable element lives one level further
    ' down, inside child components it merely composes — resolveEntryTarget()/
    ' firstRegistrantOfOwner() correctly resolve to invalid there; apps/sample-app's CardsScreen.thr
    ' is a real example, every focusable element belongs to one of its own RichCard children, never
    ' to CardsScreen itself). Ordinarily that's harmless: whatever already held focus (typically a
    ' persistent menu) simply keeps it, untouched.
    '
    ' But if focus was ACTUALLY destroyed as part of THIS SAME navigation — the outgoing screen's
    ' own focused element, torn down by FlashTheaterRouterOutlet's _teardownCurrentChild() a moment
    ' ago (recorded via noteFocusLoss() as m.focusLostFromOwner) — that reasoning breaks down: there
    ' is no "whatever already held focus" left to fall back on, since it no longer exists. Confirmed
    ' live as a real, reported bug: back-navigating out of a focused element on one routed screen
    ' (e.g. LoadingDemoScreen's readyButton) into another with no focusable content of its own (e.g.
    ' CardsScreen) left focus permanently empty — nothing was ever proposed, so this function
    ' returned immediately, before ever reaching the ordinary vacuum-rule check below.
    '
    ' recoverFocusFor() already has exactly the right fallback chain for this (this owner's own
    ' default/first registrant → wherever focus most recently was in some OTHER still-registered
    ' component → the Scene) — it's simply never been reachable from a router navigation before,
    ' since FlashTheaterRouterOutlet's own teardown never calls it directly (unlike a compiler-
    ' generated {#if:destroy}/{#each} teardown, which does, synchronously, right after its own
    ' mutations). Calling it here instead of there is what keeps this safe: this function is ALREADY
    ' the one shallow, single-hop call site every router navigation's own real focus move goes
    ' through (see this file's own "Deferred focus application" section above) — calling
    ' recoverFocusFor() (and therefore moveFocusTo()) from deep inside the mount cascade itself would
    ' reintroduce the exact "SetFocus() reached via 2+ nested callFunc hops doesn't route real key
    ' events" problem that whole mechanism exists to avoid. A no-op when nothing was actually lost
    ' this cascade (m.focusLostFromOwner invalid) — recoverFocusFor() already guards on that itself.
    '
    ' Except: a navigation (forward or back) whose destination hasn't actually mounted/settled yet
    ' (m.suppressedNavRouteKey — see beginSuppressedNavigation()) must NOT recover here at all — the
    ' whole point is to stay vacant until the real content exists, then restore the element that was
    ' focused in that same view last time (see resolveRouteFocusTarget(), called later from
    ' FlashTheaterRouterOutlet's own _revealMountedChild() once the mount settles). Falling into
    ' recoverFocusFor() here would defeat that by landing focus on a fallback element the moment
    ' router.navigate()/router.back() returns, well before the destination is ready — and, since that
    ' fallback then holds focus non-vacantly, would ALSO silently defeat the later restoration once it
    ' finally resolves (the vacuum rule correctly refuses to steal focus a second time).
    if m.suppressedNavRouteKey <> invalid then return
    recoverFocusFor(m.focusLostFromOwner)
    return
  end if

  if not isExplicit and currentlyFocused() <> invalid then return
  moveFocusTo(target)
end sub

' Called by FlashTheaterRouterOutlet's own _revealMountedChild(), on EVERY reveal (forward or back,
' gated or immediate, animated or not) — resolves which node should receive focus, without moving it
' (see resolveEntryTarget()'s own doc comment for why a "propose, don't apply" step is required at
' this depth). Returns `invalid` unless `routeKey` is the SAME route this file is currently holding a
' suppression for (a different outlet's own, unrelated reveal must not consume or misfire this) —
' clears the suppression either way, since this mount has now settled one way or another.
'
' Walks the remembered id chain (see captureRouteFocusMemory() above) innermost-first, re-locating
' each id via m.sceneRef.FindNode() — scoped to the WHOLE app, not just whichever outlet's own
' content happens to be settling right now, since the remembered element may not live inside any
' outlet's mounted content at all (persistent chrome, a sibling outlet). Returns the first result
' that is also currently a REGISTERED, focusable node (indexOfNode() >= 0), not merely any node
' sharing that id (a captured ancestor may not itself be focusable). This is what makes "focus the
' parent, then its parent, and so on" fall out for free: idChain already holds every id-bearing
' ancestor, most-specific first, and the registered-node check alone decides which one is a valid
' landing target. Returns `invalid` when there's no memory for this route at all, or nothing in the
' chain resolves to a live registrant — the caller falls back to today's ordinary
' resolveEntryTarget().
'
' Whichever outlet happens to call this FIRST for a matching routeKey wins the search (the flag
' clears as a side effect on the first matching call, regardless of outcome) — safe precisely
' because the search is Scene-wide: it doesn't matter which outlet's own reveal triggered the call,
' since the remembered node (wherever it actually lives) is found the same way either way.
function resolveRouteFocusTarget(routeKey as string) as dynamic
  if m.suppressedNavRouteKey = invalid then return invalid
  if m.suppressedNavRouteKey <> routeKey then return invalid
  m.suppressedNavRouteKey = invalid
  if m.sceneRef = invalid then return invalid

  for i = 0 to m.lastFocusedByRouteKey.Count() - 1
    entry = m.lastFocusedByRouteKey[i]
    if entry.routeKey = routeKey then
      for each id in entry.idChain
        candidate = m.sceneRef.FindNode(id)
        if candidate <> invalid and indexOfNode(candidate) >= 0 then return candidate
      end for
      return invalid
    end if
  end for
  return invalid
end function

' Records `node` as the most recently focused element belonging to its own owner — see
' lastFocusedFor() and navigate()'s own doc comment for why this exists and how it's used. A no-op
' if `node` isn't actually registered (shouldn't happen through the normal moveFocusTo() call
' sites, but harmless either way).
'
' The list is kept MOST-RECENT-FIRST (the touched entry moves to the front), not in first-seen
' order — mostRecentlyFocusedElsewhere() walks it front-to-back and relies on that ordering to
' answer "where was the user before this component took over" correctly when more than two
' components are involved. lastFocusedFor()'s own per-owner lookup is unaffected by the ordering.
sub rememberLastFocused(node as object)
  owner = ownerOf(node)
  if owner = invalid then return
  for i = 0 to m.lastFocusedByOwner.Count() - 1
    if m.lastFocusedByOwner[i].owner.IsSameNode(owner) then
      m.lastFocusedByOwner.Delete(i)
      exit for
    end if
  end for
  m.lastFocusedByOwner.Unshift({ owner: owner, node: node })
end sub

' The most recently focused node whose own registered NODE (not necessarily its OWNER) lies inside
' `root`'s own subtree, or `invalid` if nothing under `root` was ever focused, or the remembered
' node was since unregistered (e.g. an {#each} reconcile removed it — a stale memory is worse than
' none, so it's discarded rather than returned). Walks `m.lastFocusedByOwner` most-recent-first
' (same ordering `mostRecentlyFocusedElsewhere()` above relies on), checking node ancestry via
' `isDescendantOrSelf()`, NOT `entry.owner.IsSameNode(root)` — deliberately: `register()`'s own
' `owner` is always the DIRECTLY enclosing component's own `m.top`, so a focusable element inside a
' NESTED custom component (e.g. a `ScheduleList` row inside `ScheduleScreen`) is registered under
' the nested component's OWN owner, never the outer `root` directly. Matching by owner identity
' alone would silently miss every such case — confirmed live as a real, reported bug: a `ScheduleList`
' row correctly focused, then the user stepping back to the sidebar menu before navigating away, then
' Back — the row was never restored, because the earlier (owner-identity-only) version of this
' lookup found no entry whose OWNER was `ScheduleScreen` itself. See
' FlashTheaterRouterOutlet.brs's own _unregisterCurrentChildFocus() (the sole caller) and
' findings/router-focus-integration.md.
function mostRecentlyFocusedWithin(root as object) as dynamic
  for i = 0 to m.lastFocusedByOwner.Count() - 1
    candidate = m.lastFocusedByOwner[i].node
    if isDescendantOrSelf(candidate, root) and indexOfNode(candidate) >= 0 then return candidate
  end for
  return invalid
end function

' The node most recently focused within `owner`'s own registered content SPECIFICALLY (exact owner
' identity, unlike mostRecentlyFocusedWithin()'s ancestry-based search above) — or `invalid` if none
' is remembered yet, or the remembered node was since unregistered. Pre-existing, load-bearing
' function: enterOwner() below (used by both cross-component navigate() and focusComponent()) relies
' on exact-owner semantics — "what did THIS specific component itself last focus", not "what was
' focused somewhere in or under it" — since a NESTED child component's own remembered focus is that
' CHILD's own concern to resurface via its own, separate enterOwner() call when navigation actually
' reaches it, not something an OUTER component's entry decision should reach into directly.
function lastFocusedFor(owner as object) as dynamic
  for i = 0 to m.lastFocusedByOwner.Count() - 1
    if m.lastFocusedByOwner[i].owner.IsSameNode(owner) then
      candidate = m.lastFocusedByOwner[i].node
      if indexOfNode(candidate) >= 0 then return candidate
      return invalid
    end if
  end for
  return invalid
end function

' The registered owner of `node`, or `invalid` if `node` isn't currently registered.
function ownerOf(node as object) as dynamic
  idx = indexOfNode(node)
  if idx = -1 then return invalid
  return m.registry[idx].owner
end function

' Generic focus highlight — reuses the node's own existing `color` field (real and present on
' every colorable node type: Rectangle, Poster, Label, ...), swapping in a fixed highlight color
' and remembering the original to restore on the next focus move. Deliberately not a new
' `field`/attribute convention (unlike scrollOffsetX/Y): a per-{#each}-item node like a grid tile
' is a plain dynamically-created SceneGraph node, not a compiled .thr component of its own, so
' there is no natural place for a .thr author to declare a custom field on it — reusing the
' built-in `color` field needs zero compiler changes and works for any focusable node, in any app,
' automatically. A no-op on a node with no `color` field (e.g. a plain Group).
sub highlightFocused(node as object)
  if node.HasField("color") then
    m.lastFocusedColor = node.color
    node.color = "0xFFCC00FF"
    m.lastFocused = node
  else
    m.lastFocused = invalid
    m.lastFocusedColor = invalid
  end if
end sub

' Restores whichever node highlightFocused() last touched, if any — called before every new focus
' move so exactly one node is ever highlighted at a time. Safe to call on a since-destroyed node
' (an {#each} reconcile may have removed it): reading/writing a field on a detached roSGNode ref is
' harmless, it simply has no visible effect once the node is out of the render tree.
sub restoreLastFocusedColor()
  if m.lastFocused <> invalid then
    m.lastFocused.color = m.lastFocusedColor
  end if
end sub

' Arms hold-to-repeat for `key` — called by the generated onKeyEvent fallthrough right after the
' immediate, one-shot navigate() a press already triggered (see codegen/brs-emitter.ts), and by the
' compiled `jumpFocus(<direction>, <count>, <press>)` statement right after a successful
' navigateBy() (see codegen/brs-emitter.ts's printJumpFocusStatement). Roku does not auto-repeat
' onKeyEvent while a button stays physically held — it fires exactly once on press and once on
' release — so continuous navigation while held is this component's own responsibility, the same
' way RowList/MarkupGrid's built-in fast-scroll-while-held behavior isn't something onKeyEvent
' gives an app for free either. `control = "start"` on a Timer already running restarts it cleanly
' from zero, so calling this again for a second press (before the first ever released) is safe and
' simply re-arms with a fresh delay.
'
' `count` defaults to 1 (an ordinary single-step directional repeat) — every existing call site
' (the generated LRUD fallthrough) passes only `key` and gets byte-for-byte the same behavior as
' before this parameter was added. A `jumpFocus` caller passes its own jump size instead, so
' onRepeatTimerFire() below re-jumps by the SAME count on every fire, using the exact same
' delay/acceleration timings either way — deliberately not a separately-tuned mechanism, see
' repeatTuning() above.
'
' The Timer node is created here, lazily, on first actual use — NOT in init(). Confirmed live:
' CreateObject("roSGNode", "Timer") fails (returns invalid, not a runtime error by itself) when
' called from init(), because FlashTheaterFocusManager's own init() runs via Main.brs's
' FlashTheaterSetupGlobals(), *before* screen.CreateScene() — Roku cannot construct a Timer node
' before a Scene/render thread exists yet. The failure itself is silent; the crash comes one line
' later, setting a field on the resulting invalid value ("Invalid value for left-side of
' expression"), which drops the whole app into the BrightScript Micro Debugger — indistinguishable
' from a hang from the outside, no UI ever renders. startRepeat() is never called before the first
' real onKeyEvent, which is necessarily well after CreateScene()/screen.show(), so creating the
' Timer here instead sidesteps the whole problem — same "defer to actual first use" fix as
' apps/focus-demo's MainScene.brs needed for its own SetFocus()-before-show() issue.
sub startRepeat(key as string, count = 1 as integer)
  if m.repeatTimer = invalid then
    m.repeatTimer = CreateObject("roSGNode", "Timer")
    m.repeatTimer.repeat = false
    m.repeatTimer.ObserveFieldScoped("fire", "onRepeatTimerFire")
  end if
  tuning = repeatTuning()
  m.repeatKey = key
  m.repeatCount = count
  m.repeatNextInterval = tuning.startInterval
  m.repeatTimer.duration = tuning.initialDelay
  m.repeatTimer.control = "start"
end sub

' Cancels any pending/running repeat — called on every key release for a direction key (and every
' release the compiled `jumpFocus(...)` statement sees — see printJumpFocusStatement), whether or
' not a repeat was actually armed. A no-op if startRepeat() was never called yet (m.repeatTimer
' still invalid — e.g. a directional key was pressed and released without navigate() ever
' succeeding, so startRepeat() never ran).
sub stopRepeat()
  if m.repeatTimer <> invalid then m.repeatTimer.control = "stop"
  m.repeatKey = invalid
  m.repeatCount = 1
end sub

' Each fire performs one more navigate() (or, when m.repeatCount > 1, one more navigateBy() jump of
' that same size) in the held direction, then re-arms the timer with a shorter duration (down to a
' floor) for the next one — this shrinking-duration restart, not the Timer's own repeat=true, is
' what produces acceleration instead of a flat rate, identically for both cases. Stops itself once
' the move finds no further candidate (e.g. the held direction has reached the edge of the
' registry's content) rather than continuing to fire uselessly until release. `_event` (the fired
' field's roSGNodeEvent) is unused — ObserveFieldScoped's callback signature requires the param
' regardless.
sub onRepeatTimerFire(_event as object)
  if m.repeatKey = invalid then return

  if m.repeatCount > 1 then
    moved = navigateBy(m.repeatKey, m.repeatCount)
  else
    moved = navigate(m.repeatKey)
  end if
  if not moved then
    stopRepeat()
    return
  end if

  tuning = repeatTuning()
  m.repeatTimer.duration = m.repeatNextInterval
  m.repeatTimer.control = "start"
  m.repeatNextInterval = m.repeatNextInterval * tuning.accelFactor
  if m.repeatNextInterval < tuning.minInterval then m.repeatNextInterval = tuning.minInterval
end sub

' Walks up from a newly-focused node looking for the nearest ancestor that opts into auto-scroll —
' detected via HasField("scrollOffsetX")/("scrollOffsetY"), ordinary fields any .thr component can
' declare with zero new DSL grammar (ordinary `field scrollOffsetX: float = 0`, bound via a normal
' `translation="{[-scrollOffsetX, -scrollOffsetY]}"` dynamic attribute on whatever inner content
' actually needs to move) — ordinary setField() calls on the found ancestor, nothing else. Single-
' level nearest-ancestor only: stops at the first opted-in ancestor found, deliberately not
' composing across nested scroll regions (same treatment as the nested-focusable rule). A no-op
' when no ancestor in the chain opts in.
'
' The viewport window is that ancestor's own FIRST child, not the ancestor itself — every compiled
' .thr component's root SceneGraph node is always a bare Group (see app-compiler.ts's fixed
' extends="Group" wrapping), and a `field` always lands on that wrapper, never on the template's own
' declared root element; the wrapper's first child is always the template's real, single root
' element (Rectangle/Poster/...).
'
' **Two BoundingRect() facts confirmed live while building this, both the opposite of what the
' first version of this function assumed (see findings/focus-system.md for the full device trace)**:
' 1. BoundingRect() does NOT compose ancestor transforms — it reports a node's own translation and
'    size relative to its own immediate parent only. (The pre-existing "BoundingRect() is reliable"
'    finding this function's first draft leaned on only ever tested a *direct child* of `m.top`,
'    where "relative to immediate parent" and "fully composited" are indistinguishable — a gap
'    invisible until a genuinely nested case, like a tile under `{#each}`/`{#if:destroy}`/`track`/
'    `viewport`, was actually measured.)
' 2. BoundingRect() DOES auto-expand to the union of a node's own box and every descendant's
'    rendered extent once children overflow it — including a node's own POSITION component, not
'    just its width/height: once scrolled content shifts past a box's edge, the union's corner on
'    that side moves outward too.
'
' Because of (1), comparing two different nodes' BoundingRect() values is only meaningful when both
' share the same immediate parent — never true here (`node` and `viewportNode` share no parent), and
' — despite what an earlier version of this file's own comment claimed — not reliably true for
' `navigate()`'s LRUD scoring either: that reasoning ("every registered focusable element sits at the
' same uniform nesting depth, so the missing ancestor offset cancels out") only holds when comparing
' siblings *within one component's own registry*. It breaks the moment two components each register
' their own focusable elements into the same flat, app-wide registry (the actual, intended design —
' see this file's own top-of-file doc comment) — each component's "immediate parent" sits at a
' different, unrelated absolute screen position, so the "missing" offset is a different constant per
' component, not a shared one that cancels out. Confirmed live: `navigate()` picked a `ScheduleList`
' row as the nearest "right" neighbor of a `ScrollFocusDemo` tile (see findings/focus-system.md) —
' `navigate()` now uses `absoluteRect()` (below), the same translation-summing-to-root approach as
' this function, instead of `BoundingRect()`, for exactly this reason. Because of
' (2), neither position works anyway once measured on a node with overflowing descendants. The fix
' for both: never call BoundingRect() on `viewportNode` or on any intermediate wrapper between
' `node` and `scrollNode` — read each one's own `translation` field directly instead (a raw,
' untouched-by-rendering value) and manually sum the chain from `node` up to (not including)
' `scrollNode`, landing in the same coordinate space `viewportNode.translation` is already
' expressed in. `node.BoundingRect()` is still used for the focused leaf's own width/height only
' (its position component is discarded) — safe as long as the focused element itself has no
' overflowing descendants of its own (true for an ordinary focusable leaf).
sub scrollIntoView(node as object)
  scrollNode = node.GetParent()
  while scrollNode <> invalid
    if scrollNode.HasField("scrollOffsetX") and scrollNode.HasField("scrollOffsetY") then
      viewportNode = scrollNode.GetChild(0)
      ' Position AND size both come from viewportNode's own declared fields, never BoundingRect() —
      ' confirmed live that BoundingRect()'s auto-union-with-descendants distortion (see the doc
      ' comment above) corrupts its position component too, not just width/height, once scrolled
      ' content shifts past the node's own edge: unlike a zero-size wrapper Group (whose own "point"
      ' stays the union's own corner as long as every descendant's local offset is non-negative),
      ' viewportNode has a real box of its own, so descendant content that shifts past its edge
      ' grows the union outward on that side, moving the reported x/y along with it.
      viewportX = viewportNode.translation[0]
      viewportY = viewportNode.translation[1]
      viewportWidth = viewportNode.width
      viewportHeight = viewportNode.height

      ' Same reasoning: sum each intermediate ancestor's own `translation` field, never
      ' BoundingRect() — a wrapper Group between `node` and `scrollNode` (an {#each}/{#if:destroy}
      ' block's synthetic wrapper) has no box of its own, so its BoundingRect() would otherwise be
      ' just as susceptible to the same auto-union distortion once any sibling subtree overflows it.
      leafSize = node.BoundingRect()
      targetX = 0
      targetY = 0
      walker = node
      while walker <> invalid and not walker.IsSameNode(scrollNode)
        targetX = targetX + walker.translation[0]
        targetY = targetY + walker.translation[1]
        walker = walker.GetParent()
      end while
      targetWidth = leafSize.width
      targetHeight = leafSize.height

      ' Deterministic, not incremental — computed purely from the target's own LOGICAL position
      ' (as if scrollOffsetX/Y were 0; add back the CURRENT offset, since the walk above already
      ' subtracted it via the scrolled ancestor's own live translation) plus target/viewport
      ' geometry, with no dependency on the current scrollOffsetX/Y at all. The previous version
      ' adjusted incrementally from whatever offset happened to already be set, and left it
      ' completely UNCHANGED whenever the target already appeared "in view" under that
      ' (path-dependent) offset. Confirmed live as a real reported bug: navigating to the same
      ' element via a different route left it rendered at a different on-screen position depending
      ' on scroll history, so the exact same press from "the same" focused element inconsistently
      ' did or didn't find a genuinely below/above/left/right neighbor in a different component —
      ' sometimes finding it, sometimes not, sometimes finding the wrong one, purely as a function
      ' of the path taken to get there, not the current logical state. A single formula per axis
      ' (flush the target's trailing edge against the viewport's trailing edge, or 0 if that would
      ' be negative — content already fits without scrolling) replaces the old
      ' two-branch-plus-no-op structure entirely, and always produces the same result for the same
      ' target regardless of how it was reached.
      logicalTargetX = targetX + scrollNode.scrollOffsetX
      logicalTargetY = targetY + scrollNode.scrollOffsetY

      offX = logicalTargetX + targetWidth - viewportX - viewportWidth
      if offX < 0 then offX = 0

      offY = logicalTargetY + targetHeight - viewportY - viewportHeight
      if offY < 0 then offY = 0

      scrollNode.setField("scrollOffsetX", offX)
      scrollNode.setField("scrollOffsetY", offY)
      return
    end if
    scrollNode = scrollNode.GetParent()
  end while
end sub

' Directional nearest-neighbor grid navigation (standard spatial-navigation scoring — see
' bestCandidate() below for the exact rule) — moves real focus from whichever registrant currently
' has it to the nearest registrant in `direction`. Returns whether a target was found and focused,
' so the caller's generated onKeyEvent knows whether to return true (handled) or let the key event
' keep bubbling.
'
' Two-pass, not one flat search: the currently-focused node's own component is searched first —
' every other registrant with the SAME owner (see register()'s own doc comment) that genuinely
' overlaps the cross axis (see bestCandidate()'s own doc comment), regardless of how far away it
' is along the primary axis. Only once that finds nothing (a genuine boundary: no more
' same-component content in this direction) does the search widen to the whole app-wide registry,
' any OTHER owner (bestCandidate()'s own owner check flips from "must match" to "must differ" —
' a same-owner registrant is never a valid cross-owner candidate, even if it would otherwise score
' closer than a genuine cross-owner one). Without this exclusion, a same-owner sibling the
' same-owner pass had already correctly exhausted/rejected could silently out-score a real
' cross-owner candidate and win pass two anyway — confirmed live as the actual cause of "Left
' does nothing" from TaskDemoScreen's 2-column button grid and from a ScheduleList day row: the
' winning "candidate" turned out to belong to the exiting component itself, so navigate() reentered
' that SAME owner via enterOwner(), which resolved back to the node already focused (its own most
' recently remembered focus) — a real move that visibly did nothing. See
' findings/focus-runtime-registry.md.
' Without the two-pass split itself, a component whose own content spans a wide area (e.g. a
' scrollable grid) could have navigate() jump out to a geometrically-closer *different* component's
' content before ever reaching its own remaining content in that direction — confirmed live as a
' real, reported "focus feels like it's mixing everything" complaint; see findings/focus-system.md.
'
' Deliberately NO fallback for a direction where neither pass finds a genuinely overlapping
' candidate: a candidate that doesn't overlap the cross axis (see bestCandidate()) is never
' considered a match at all — an earlier version tried a same-sign-but-non-overlapping "fallback"
' tier as a last resort, which reintroduced the exact bug the overlap rule exists to prevent
' (something only diagonally related winning just because *nothing* else was found), explicitly
' reported live: "if there's nothing to the left, don't navigate at all, even if something is above
' or below." Returning `false` here — no move, key event keeps bubbling — is the correct outcome
' for a genuine directional boundary, not a bug to work around.
'
' When the search DOES cross into a different component (the same-owner pass found nothing, the
' any-OTHER-owner pass did), the specific element handed focus is decided by that component, not by raw
' geometry, in this order: its own most-recently-focused element if it has one (see
' rememberLastFocused()/lastFocusedFor()), else its explicitly declared default-focus="true"
' element if it has one (declaredDefaultOfOwner), else bestCandidate()'s geometric winner. This is
' deliberate: which element within a *different* component should receive focus is that
' component's own concern, the same way recoverFocusFor() already resumes wherever focus last was
' rather than re-deriving it from scratch — bestCandidate()'s geometric result decides *which
' component* to enter (the nearest one with a genuine candidate), and only picks the element too
' when that component has expressed no preference of its own. Confirmed live as the expected
' behavior: navigating out of a component and back should return to where you left off in it, not
' wherever a fresh geometric search happens to prefer at that moment — reported live as "what focus
' a component sets internally is that component's own business." Honouring the declared default
' here too is what makes default-focus="true" mean one single thing no matter how focus arrives
' (router mount, focus(<id>), or an arrow key from a neighbouring component).
' The cross-owner pass (below) deliberately does NOT reuse `focusedRect` — a candidate is judged
' against the WHOLE exiting component's own combined bounding box, not just the single leaf that
' happened to hold focus. Confirmed live as a real, reported bug: a component with several
' focusable children spanning a range on the cross axis (e.g. three stacked rows) could have its
' own same-owner pass correctly exhaust itself from one particular child (the bottom row), then
' have the cross-owner pass wrongly find nothing, because that one child's own narrow slice of the
' cross axis didn't overlap a neighboring component that the component AS A WHOLE plainly does
' border (the neighbor lines up with an earlier row, just not the specific row last focused). The
' same-owner pass still boundary-checks correctly for THIS reason: whether the currently-focused
' node itself has a further same-owner neighbor in `direction` only depends on that node's own
' position, not the whole component's footprint. See ownerBoundingRect() below and
' findings/focus-system.md.
'
' The owner-bounding-box widening is deliberately SKIPPED when the exiting owner is itself a
' scrollable component (HasField("scrollOffsetX")/("scrollOffsetY") — the same detection this file
' already uses for scrollIntoView()/clippedToOwnViewport()). Confirmed live as a real regression
' when first tried unconditionally: for a component like ScrollFocusDemo, "the whole component's
' bounding box" means the union of its ENTIRE virtual scrollable content (every tile, including
' ones nowhere near the current viewport) — a huge rect whose center can sit far from where the
' user is actually exiting, badly distorting the cross-owner distance score (confirmed live:
' pressing Down from `wide1`, at the edge of ScrollFocusDemo's own same-owner search, wrongly
' out-scored the correct `SimpleFocusItem` target in favor of the far-away `FocusGroup`, purely
' because the huge union's center sat much closer to `FocusGroup`). A small, non-scrollable
' component like `FocusGroup` has no such distortion — its "whole bounding box" IS effectively its
' visible footprint, since there's nothing off-screen to union in. For a scrollable owner, the
' currently-focused leaf's own rect remains the right proxy for "where the user is exiting from" —
' `scrollIntoView()` already keeps it meaningfully positioned within the viewport, which the owner's
' full virtual extent is not.
function navigate(key as string) as boolean
  direction = keyToDirection(key)
  if direction = invalid then return false

  focusedEntry = currentlyFocusedEntry()
  if focusedEntry = invalid then return false

  focusedRect = absoluteRect(focusedEntry.node)

  best = stepOnce(direction, focusedEntry, focusedRect)
  if best = invalid then return false

  moveFocusTo(best)
  return true
end function

' Resolves the single next candidate navigate(direction) would land on, from an arbitrary starting
' `fromEntry`/`fromRect` — the exact same same-owner-then-cross-owner two-pass search (including
' cross-owner landing-element resolution via enterOwner()) navigate() itself performs, extracted so
' navigateBy() below can repeat it multiple times per press without navigate()'s own single-call
' moveFocusTo() commit happening on every intermediate hop. Returns the winning node, or invalid if
' `direction` has no further candidate from this starting point — a genuine boundary, same
' semantics as bestCandidate() returning invalid.
function stepOnce(direction as string, fromEntry as object, fromRect as object) as dynamic
  best = bestCandidate(direction, fromEntry, fromRect, true)
  if best <> invalid then return best

  ownerRect = fromRect
  isScrollableOwner = fromEntry.owner.HasField("scrollOffsetX") and fromEntry.owner.HasField("scrollOffsetY")
  if not isScrollableOwner then ownerRect = ownerBoundingRect(fromEntry.owner)
  crossOwnerBest = bestCandidate(direction, fromEntry, ownerRect, false)
  if crossOwnerBest = invalid then return invalid

  targetOwner = ownerOf(crossOwnerBest)
  preferred = declaredDefaultOfOwner(targetOwner)
  if preferred = invalid then preferred = crossOwnerBest
  return enterOwner(targetOwner, preferred)
end function

' `jumpFocus(<direction>, <count>, <press>)`'s runtime counterpart — RowList-style multi-item jump.
' Repeats bestCandidate()'s SAME-OWNER-ONLY search up to `count` times from the currently-focused
' element, stopping early (accepting fewer hops) the moment a hop finds nothing — this alone
' produces the "jump to the end if fewer than N items remain" behavior, no special-casing needed.
' Commits with moveFocusTo() exactly ONCE, on the final landing node only — never per intermediate
' hop, since moveFocusTo() also triggers the highlight-color swap and scrollIntoView(); calling it
' `count` times per press would visibly flash/scroll through every intermediate stop instead of
' producing one clean jump. Returns true if it moved at least one hop, false if the very first hop
' already found nothing (already at a boundary) or `count` is not positive.
'
' Deliberately does NOT call stepOnce() (which navigate()'s own single-press LRUD fallthrough uses,
' and which includes a cross-owner fallback — "press up from the top row reaches the header" is
' exactly that fallback, and stays correct for ordinary arrow keys). A held jumpFocus() jump must
' stay confined to the SAME owner it started in — confirmed live as a real bug: a list bound to
' `on:key[rewind]="{jumpUp()}"` (meant to keep REWIND "captured" while any row in it holds focus)
' let a press from the topmost row escape to a completely different owner (a header `Label` above
' the list) the moment the same-owner search ran out, because the very first hop already fell
' through stepOnce()'s cross-owner pass and "found" the header — one hop counts as movement,
' `landing` was no longer invalid, and the call committed to it. This also means the documented
' "held REWIND from a short list's own bottom row lands exactly on its top row, never past it"
' guarantee was never actually true in the multi-hop (more hops requested than same-owner rows
' remain) case — it only happened to hold in whatever configuration was device-tested, not because
' of any real boundary enforcement. Restricting every hop to the same owner as the start makes both
' guarantees actually true: a jump can end AT the boundary (nearest same-owner row), never AT or
' past a different owner entirely.
'
' Hop-based (reusing bestCandidate()'s existing geometric search) rather than registry-index-based
' on purpose: `m.registry` stores no ordering/index field (see register() above), so array
' position is not a reliable "list order" once {#each} has reconciled/reordered its own items — see
' findings/focus-runtime-registry.md.
function navigateBy(key as string, count as integer) as boolean
  direction = keyToDirection(key)
  if direction = invalid then return false
  if count < 1 then return false

  focusedEntry = currentlyFocusedEntry()
  if focusedEntry = invalid then return false

  currentEntry = focusedEntry
  currentRect = absoluteRect(focusedEntry.node)
  landing = invalid

  for i = 1 to count
    nextNode = bestCandidate(direction, currentEntry, currentRect, true)
    if nextNode = invalid then exit for
    landing = nextNode
    currentEntry = { node: nextNode, owner: ownerOf(nextNode) }
    currentRect = absoluteRect(nextNode)
  end for

  if landing = invalid then return false
  moveFocusTo(landing)
  return true
end function

' Scores every registry entry other than `focusedEntry` in `direction` from `focusedRect`,
' returning the nearest genuinely-overlapping candidate node — or `invalid` if none qualify. When
' `sameOwnerOnly` is `true`, an entry whose `owner` isn't the same component instance as
' `focusedEntry.owner` is skipped entirely (not merely scored worse).
'
' Standard spatial-navigation rule, not a simple "which axis has the bigger offset" cone test: a
' candidate counts as being "in" `direction` **only** when its bounding box genuinely overlaps the
' focused box on the perpendicular axis (any overlap at all, however small) — e.g. for "down", the
' candidate's horizontal span overlaps the focused element's horizontal span, and the candidate
' sits below. Same-sign-but-non-overlapping ("genuinely diagonal, nothing really lines up") is
' never a match, not even as a fallback — see navigate()'s own doc comment for why. Among
' overlapping candidates, the nearest by primary-axis distance wins.
'
' A prior version used a 45°-cone test (primary-axis offset must exceed the perpendicular one) —
' confirmed live as too strict for perfectly ordinary layouts: two elements mostly stacked
' vertically but with a realistic horizontal offset (different widths, padding, not pixel-aligned)
' could have a perpendicular offset that exceeds the small primary-axis gap between them, wrongly
' excluding a candidate a real user would obviously consider "the one below" — reported live as
' "this shouldn't require changing the layout, real production content won't be pixel-aligned
' either." The overlap test fixes this the standard way (the same rule CSS Spatial Navigation and
' most game-UI focus engines use): whether the two boxes overlap along the cross axis, not how the
' two raw distances compare. See findings/focus-system.md.
'
' Every candidate is also gated on isGenuinelyVisible() before it's scored at all, in BOTH passes
' (same-owner and cross-owner alike) — a registrant currently hidden (its own `visible=false`, or
' any ancestor's) is never a match, full stop, not merely scored worse. Fixes two things that used
' to be the same underlying gap: (1) a same-owner OR cross-owner candidate that's a hidden
' toggle-mode (`{#if}`) block's own descendant — registered unconditionally at mount regardless of
' the block's current `visible` state (see GRAMMAR.md's "Conditional rendering" — toggle-mode
' content stays registered while hidden, by design; only the animation-aware `transition:`/`out:`
' path unregisters on hide) — could still win a directional search and silently consume the key
' press, confirmed live via `apps/animation-demo`'s `TogglePresetDemo`: `navigate("right")` from a
' visible `trigger` matched its own sibling `panel` on the CROSS-owner fallback pass even though
' `panel` was invisible the whole time (scored against the owner's whole bounding box, which
' `panel` sits inside geometrically even though it doesn't overlap `trigger`'s own small rect —
' see ownerBoundingRect()'s own doc comment). (2) the same class of bug could equally happen on the
' SAME-owner pass — a hidden sibling in one's own component was never actually reachable by a real
' key press before this fix either, just less likely to be noticed since same-owner geometry tends
' to be tighter. See findings/focus-system.md.
function bestCandidate(direction as string, focusedEntry as object, focusedRect as object, sameOwnerOnly as boolean) as dynamic
  best = invalid
  bestScore = 0

  for i = 0 to m.registry.Count() - 1
    entry = m.registry[i]
    if not entry.node.IsSameNode(focusedEntry.node) and isGenuinelyVisible(entry.node) and entry.owner.IsSameNode(focusedEntry.owner) = sameOwnerOnly then
      candRect = absoluteRect(entry.node)

      ' A *cross-owner* candidate's rect is clipped to its own scroll ancestor's current viewport
      ' window before scoring — not merely gated on "does it overlap at all" (see
      ' clippedToOwnViewport()'s own doc comment for why the distinction matters). A same-owner
      ' candidate is exempt and always uses its full, unclipped rect: within one scrollable
      ' component, a not-yet-visible neighbor is the ordinary, expected case (that's the whole
      ' point of scroll-into-view — navigating one more tile scrolls the next one into view);
      ' clipping it here would break ordinary in-component navigation entirely.
      if not sameOwnerOnly then candRect = clippedToOwnViewport(entry.node, candRect)

      if candRect <> invalid then
        dx = (candRect.x + candRect.width / 2) - (focusedRect.x + focusedRect.width / 2)
        dy = (candRect.y + candRect.height / 2) - (focusedRect.y + focusedRect.height / 2)

        valid = false
        primary = 0
        perp = 0
        overlaps = false

        if direction = "right" and dx > 0 then
          valid = true
          primary = dx
          perp = Abs(dy)
          overlaps = rangesOverlap(focusedRect.y, focusedRect.height, candRect.y, candRect.height)
        else if direction = "left" and dx < 0 then
          valid = true
          primary = -dx
          perp = Abs(dy)
          overlaps = rangesOverlap(focusedRect.y, focusedRect.height, candRect.y, candRect.height)
        else if direction = "down" and dy > 0 then
          valid = true
          primary = dy
          perp = Abs(dx)
          overlaps = rangesOverlap(focusedRect.x, focusedRect.width, candRect.x, candRect.width)
        else if direction = "up" and dy < 0 then
          valid = true
          primary = -dy
          perp = Abs(dx)
          overlaps = rangesOverlap(focusedRect.x, focusedRect.width, candRect.x, candRect.width)
        end if

        if valid and overlaps then
          score = primary + perp * 2
          if best = invalid or score < bestScore then
            best = entry.node
            bestScore = score
          end if
        end if
      end if
    end if
  end for

  return best
end function

' True when the two 1-D ranges [aStart, aStart+aLen) and [bStart, bStart+bLen) share any point —
' the cross-axis "genuinely lines up" test bestCandidate() uses for both X and Y.
function rangesOverlap(aStart as float, aLen as float, bStart as float, bLen as float) as boolean
  return aStart < bStart + bLen and bStart < aStart + aLen
end function

' `rect` clipped to `node`'s own scroll ancestor's current viewport window — the SAME rect
' unchanged if `node` has no scrolling ancestor, the geometrically clipped (smaller) rect if it
' does and is at least partially visible, or `invalid` if it's entirely scrolled/clipped out of
' view. Only ever called for a *cross-owner* candidate (see bestCandidate()'s own call site) — this
' is specifically about not jumping *into* a scrollable component's content the user can't
' currently see, from a *different* component.
'
' Deliberately clips the RECT used for scoring, not just a boolean "is it visible at all" gate —
' confirmed live that a boolean gate alone isn't enough: an oversized element only PARTIALLY
' scrolled into view (most of its height still off-screen, a sliver peeking in) still passed an
' "any overlap" check, but its full, unclipped center point remained far outside the visible
' sliver, letting it out-score a fully-visible, correctly-positioned candidate belonging to a
' completely different component purely because raw distance favored the oversized element's true
' (mostly invisible) center. Clipping the rect to the actually-visible portion before computing
' its center fixes this at the source — the same value a sighted user would perceive as "where that
' thing actually is right now," not where its full underlying content happens to extend.
function clippedToOwnViewport(node as object, rect as object) as dynamic
  scrollNode = node.GetParent()
  while scrollNode <> invalid
    if scrollNode.HasField("scrollOffsetX") and scrollNode.HasField("scrollOffsetY") then
      viewportRect = scrollViewportRect(scrollNode)

      x1 = rect.x
      if viewportRect.x > x1 then x1 = viewportRect.x
      y1 = rect.y
      if viewportRect.y > y1 then y1 = viewportRect.y

      x2 = rect.x + rect.width
      if viewportRect.x + viewportRect.width < x2 then x2 = viewportRect.x + viewportRect.width
      y2 = rect.y + rect.height
      if viewportRect.y + viewportRect.height < y2 then y2 = viewportRect.y + viewportRect.height

      if x2 <= x1 or y2 <= y1 then return invalid

      return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
    end if
    scrollNode = scrollNode.GetParent()
  end while
  return rect
end function

' Absolute position and size of `scrollNode`'s own viewport window (its first child — see
' scrollIntoView()'s own doc comment for why that convention holds) — position/size read from the
' viewport node's own declared `translation`/`width`/`height` fields plus an ancestor-translation
' walk, deliberately never `BoundingRect()`, for the exact same auto-union-with-descendants reason
' scrollIntoView() already avoids it (see this file's own findings above).
function scrollViewportRect(scrollNode as object) as object
  viewportNode = scrollNode.GetChild(0)
  x = 0
  y = 0
  walker = viewportNode
  while walker <> invalid
    x = x + walker.translation[0]
    y = y + walker.translation[1]
    walker = walker.GetParent()
  end while
  return { x: x, y: y, width: viewportNode.width, height: viewportNode.height }
end function

' Absolute on-screen position AND size of `node`, safe to compare across sibling *and*
' cross-component candidates alike — unlike BoundingRect() (relative to the node's own immediate
' parent only, see this file's own findings above), this sums `translation` from `node` itself all
' the way up to the Scene root, so two nodes from entirely different components (different screen
' regions, each with their own uniform-nesting-depth registry entries) land in the same coordinate
' space. Only `node`'s own BoundingRect() is used, and only for its width/height (never its
' position) — safe since an ordinary focusable leaf has no overflowing descendants of its own, same
' assumption scrollIntoView already relies on.
function absoluteRect(node as object) as object
  size = node.BoundingRect()
  x = 0
  y = 0
  walker = node
  while walker <> invalid
    x = x + walker.translation[0]
    y = y + walker.translation[1]
    walker = walker.GetParent()
  end while
  return { x: x, y: y, width: size.width, height: size.height }
end function

' Union of absoluteRect() over every currently-registered node belonging to `owner` — the whole
' exiting component's own combined footprint, not just whichever single leaf last held focus.
' Reduces to exactly that leaf's own rect when `owner` has only one registered node (e.g. a
' single-leaf component like SimpleFocusItem), so single-leaf-component navigate() behavior is
' unchanged by this function's introduction. Used only as the cross-owner search's frame rect for a
' NON-scrollable owner (see navigate()'s own call site, which skips this entirely for a scrollable
' owner — a big scrollable grid's "whole footprint" is its entire virtual content, a poor proxy for
' where the user is actually exiting from; see navigate()'s own doc comment for the confirmed-live
' regression this guard exists to prevent). The same-owner pass still needs the currently-focused
' node's own precise rect, not this union, since sibling-to-sibling comparisons within one
' component should stay leaf-accurate regardless of scrollability.
function ownerBoundingRect(owner as object) as object
  result = invalid
  for i = 0 to m.registry.Count() - 1
    entry = m.registry[i]
    if entry.owner.IsSameNode(owner) then
      rect = absoluteRect(entry.node)
      if result = invalid then
        result = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      else
        x2 = result.x + result.width
        y2 = result.y + result.height
        if rect.x < result.x then result.x = rect.x
        if rect.y < result.y then result.y = rect.y
        if rect.x + rect.width > x2 then x2 = rect.x + rect.width
        if rect.y + rect.height > y2 then y2 = rect.y + rect.height
        result.width = x2 - result.x
        result.height = y2 - result.y
      end if
    end if
  end for
  return result
end function

' Whether `node` is actually visible on screen right now — `false` if `node` itself, or ANY
' ancestor up to the Scene root, has `visible = false`. A single-node check on `node` alone is not
' enough: Roku's own `visible` field is INHERITED — a hidden ancestor (e.g. a toggle-mode `{#if}`
' block's synthetic `Group` wrapper, see GRAMMAR.md's "Conditional rendering") hides every
' descendant regardless of the descendant's own value, and a focusable leaf's own `visible` is
' essentially never touched directly (the block's WRAPPER is what toggles). Same ancestor-walk
' shape absoluteRect()/scrollIntoView() already use for summing `translation`, checking `visible`
' at each step instead. `HasField` guards a node type with no `visible` field at all (shouldn't
' happen for anything actually registered as focusable or one of its ancestors, both always visual
' node types by construction, but cheap to check rather than assume).
function isGenuinelyVisible(node as object) as boolean
  walker = node
  while walker <> invalid
    if walker.HasField("visible") and not walker.visible then return false
    walker = walker.GetParent()
  end while
  return true
end function

function indexOfNode(node as object) as integer
  for i = 0 to m.registry.Count() - 1
    if m.registry[i].node.IsSameNode(node) then return i
  end for
  return -1
end function

' Returns the registry entry ({node, owner}) currently in the focus chain, or invalid if nothing
' registered here currently holds focus. navigate() needs the owner as well as the node (to scope
' its first search pass); currentlyFocused() below is the plain-node-only convenience wrapper for
' every other caller that doesn't.
'
' Reads m.focusedNode — the framework's own authoritative single-writer record (see that field's
' own doc comment in init()) — NOT node.IsInFocusChain(), despite this being the one place in the
' whole file that used to query it. Confirmed live as a real, reported bug: destroying a
' router-swapped subtree that currently holds focus (e.g. pressing OK on a routed screen's own
' focused "back" button, which both tears down that screen AND mounts a new one in the same
' key-press cascade — see runtime-assets/RouterOutlet's _teardownCurrentChild()) leaves at least
' one UNRELATED, still-registered node (whatever most recently held focus before the destroyed
' node did) reporting a stale IsInFocusChain() = true even though real key routing no longer
' reaches it. applyPendingFocus()'s vacuum-rule check (this function's own caller, below) then
' wrongly concluded "something already has focus" and skipped moveFocusTo() on the freshly
' mounted screen's own proposed target — leaving BOTH m.focusedNode (already cleared by
' noteFocusLoss() during the teardown) AND real native focus in a permanent limbo nothing ever
' recovers, since every OTHER focus-recovery path in this file also gates on this same check. See
' findings/focus-system.md.
function currentlyFocusedEntry() as dynamic
  if m.focusedNode = invalid then return invalid
  idx = indexOfNode(m.focusedNode)
  if idx = -1 then return invalid
  return m.registry[idx]
end function

function currentlyFocused() as object
  entry = currentlyFocusedEntry()
  if entry = invalid then return invalid
  return entry.node
end function

function keyToDirection(key as string) as dynamic
  if key = "up" then return "up"
  if key = "down" then return "down"
  if key = "left" then return "left"
  if key = "right" then return "right"
  return invalid
end function
