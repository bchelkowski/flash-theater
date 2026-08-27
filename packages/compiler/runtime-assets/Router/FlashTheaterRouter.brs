' flash-theater:runtime — hand-authored, not generated from a .thr file. Auto-copied by the CLI
' into an app's output whenever any component uses the router (see cli.ts). Do not edit per-app;
' change this file in packages/compiler/runtime-assets/Router instead.
'
' Global routing singleton — the currently activated route plus a private back-journey history
' stack. See findings/router.md for the full design. Scoped to no URL/query-string composition —
' `path`/`params` stay separate values, never joined into a single parseable string. Nested-route MATCHING is entirely
' FlashTheaterRouterOutlet's own job (any number of outlets may be mounted at once, nested
' arbitrarily) — this node only holds the single currently-activated route's data, plus
' `renderedPath` (a private "how deep has rendering settled" marker two-or-more nested outlets
' coordinate through) and `activatedRoute.routeConfig` (which outlet of these two fields does what
' is explained on `navigate()`/on `FlashTheaterRouterOutlet.brs`'s own top comment).
'
' `m.top.activatedRoute` is always REASSIGNED wholesale, never mutated in place — a SceneGraph
' field observer only fires on reassignment of the field itself, exactly like the store's own
' `set()` (see runtime-assets/Store/Store.brs).

sub init()
  m.top.activatedRoute = _emptyRoute()
  m.top.renderedPath = ""
  m.top.changeToken = 0
  m._history = []
  ' Backs claimInnermostTransition()/releaseInnermostTransition() below — see that function's own
  ' doc comment.
  m._innermostTransitionOwner = invalid
  m._innermostTransitionToken = -1
end sub

function _emptyRoute() as object
  return { path: "", params: {}, backJourneyData: {}, routeConfig: invalid, isBackJourney: false, skipInHistory: false }
end function

' Registers the app's whole route tree — an array of {path, component, [children]} entries.
' `path` is a single path SEGMENT at that nesting level (e.g. "browse", "schedule", or "" for an
' index/default child), never a full URL; `component` is the SceneGraph component NAME
' FlashTheaterRouterOutlet will CreateObject() when this route activates; `children` is an
' optional nested array of the exact same shape, matched by a NESTED outlet inside whatever
' component this route's own outlet mounts. Called once, typically from the app's own hand-called
' `setup()` (the same convention MainScene.thr already uses to seed the store) via
' `router.setRouting([...])`. See GRAMMAR.md's "Router" section.
' The app's whole top-level route tree — read directly off `m.top.routing` (a plain field, not a
' callFunc) by a ROOT FlashTheaterRouterOutlet (one with no enclosing outlet — see that file's own
' top comment for how it tells the two cases apart) to seed its own candidate route list. See this
' field's own <field id="routing"> doc comment in the .xml for why this is a field, not a function.
sub setRouting(routing as object)
  m.top.routing = routing
end sub

' Changes the currently activated route. `routeData` is {path, params, [backJourneyData],
' [isBackJourney], [skipInHistory]} — `path` is always the FULL path (every segment from the
' root, "/"-joined, e.g. "/browse/schedule"), never a single segment; decomposing that back down
' into per-outlet segments is FlashTheaterRouterOutlet's own job, not this node's.
'
' Pushes the OUTGOING route onto history (a frozen snapshot, never a live reference — see
' _historySnapshot()) unless skipInHistory was requested, THEN overwrites activatedRoute — needs
' to happen in that order, since the snapshot is of the route being LEFT, not the one being
' entered. back() re-enters this exact sub with isBackJourney/skipInHistory both forced true, so
' popping the stack never re-pushes the entry it just popped — one code path drives both
' directions, deliberately (see back() below).
'
' Deliberately does NOT guard against navigating to an identical route. `params` may itself
' contain nested arrays/AAs, so a correct deep-equality check here isn't a cheap primitive
' comparison. Calling `router.navigate(...)` on an unchanged route is harmless either way — at
' worst, one redundant history entry (a `back()` press from there is a same-route no-op, not a
' crash or corruption).
'
' `m.top.changeToken` is bumped LAST, once `activatedRoute` already holds the new route's data in
' full — every FlashTheaterRouterOutlet observes THIS field, never `activatedRoute` directly (see
' that runtime asset's own top comment for why: a plain, monotonically-increasing integer's
' field-change notification is unambiguous, unlike reassigning a complex assocarray value).
sub navigate(routeData as object)
  ' Opens a fresh focus transition before any outlet reacts — every outlet about to mount will
  ' PROPOSE its own entry target rather than grabbing focus itself, and the compiler-emitted
  ' applyPendingFocus() call sitting right after the author's own router.navigate(...)/router.back()
  ' statement applies the winner from a shallow enough call depth to actually establish real key
  ' routing. See FlashTheaterFocusManager.brs's "Deferred focus application" section for the full
  ' rationale (Roku will not route key events for a SetFocus() reached via 2+ nested callFunc hops).
  ' Clearing here also discards any stale proposal left by an unrelated earlier focus(...) call.
  ' Guarded — a router-using app doesn't necessarily also use the focus system.
  hasFocus = m.global.HasField("ft_focus")
  if hasFocus then m.global.ft_focus.callFunc("beginFocusTransition")

  ' The `path <> ""` guard excludes the router's own uninitialized sentinel (see init()'s
  ' _emptyRoute()) — without it, the very FIRST navigate() call in an app's whole lifetime pushes a
  ' phantom history entry pointing at "" (nothing ever matches an empty path), so a single "back"
  ' press on the very first screen popped it and left the entire app blank with no way back or
  ' forward. Confirmed live as a real, reported bug: "back from the first page and everything
  ' disappears." A real app route can never legitimately have `path = ""` (every navigate() call
  ' passes a full, "/"-prefixed path), so this only ever excludes the sentinel, never real history.
  if not _getProp(routeData, "skipInHistory", false) and m.top.activatedRoute.path <> "" then
    m._history.Push(_historySnapshot(m.top.activatedRoute))
  end if

  m.top.activatedRoute = {
    path: _getProp(routeData, "path", ""),
    params: _getProp(routeData, "params", {}),
    backJourneyData: _getProp(routeData, "backJourneyData", {}),
    routeConfig: invalid,
    isBackJourney: _getProp(routeData, "isBackJourney", false),
    skipInHistory: _getProp(routeData, "skipInHistory", false)
  }

  ' Arms FlashTheaterFocusManager's own deferred-restoration suppression for the INCOMING route, now
  ' that activatedRoute holds its final resolved path/params — unconditionally, for every journey
  ' (forward or back), before it's even known which outlet(s) will end up mounting anything or
  ' whether that mount will be gated/animated. See FlashTheaterFocusManager.brs's own
  ' beginSuppressedNavigation() doc comment for the full "stay vacant until the destination's real
  ' content exists" rationale — every outlet's own _revealMountedChild() unconditionally calls
  ' resolveRouteFocusTarget() on its own reveal, which clears this flag as a side effect the moment
  ' it runs, so arming it here before any outlet has even reacted is always safe.
  if hasFocus then
    incomingRouteKey = m.top.activatedRoute.path + "?" + FormatJson(m.top.activatedRoute.params)
    m.global.ft_focus.callFunc("beginSuppressedNavigation", incomingRouteKey)
  end if

  m.top.changeToken = m.top.changeToken + 1
end sub

' Pops the most recent history entry and re-enters navigate() on it, forcing isBackJourney/
' skipInHistory so the same code path drives both directions without re-pushing what it just
' popped. Returns false (and does nothing else) when history is empty — the signal the generated
' back-key fallthrough (codegen/brs-emitter.ts's emitOnKeyEventFunction) uses to NOT consume the
' key, letting an unhandled "back" reach the Scene, where Roku's own documented default behavior
' exits the app — exactly the "once on the first route, stop handling back" requirement.
function back() as boolean
  if m._history.Count() = 0 then return false

  previous = m._history.Pop()
  previous.isBackJourney = true
  previous.skipInHistory = true
  navigate(previous)
  return true
end function

' Clears the back-journey history, optionally reseeding it with one root entry — for an app that
' wants to establish a fresh "can't go back past here" boundary (e.g. after a login flow
' completes, going back should never return to the login screen). No forward-navigation concept
' exists in this feature (deliberately — see GRAMMAR.md's "Router" section) — this is purely a
' stack reset, not a history-rewrite.
sub resetHistory(rootPath = "" as string)
  m._history = []
  if rootPath <> "" then
    root = _emptyRoute()
    root.path = rootPath
    m._history.Push(root)
  end if
end sub

' Merges `data` into the CURRENT route's own backJourneyData — e.g. remembering where the user
' had scrolled to right before navigating away — without discarding anything already stored there
' (a previous appendBackJourneyData call, or data set by whatever navigate() call activated this
' route in the first place). See updateBackJourneyData below for the full-overwrite counterpart.
sub appendBackJourneyData(data as object)
  current = m.top.activatedRoute
  merged = current.backJourneyData
  if merged = invalid then merged = {}
  merged.Append(data)
  current.backJourneyData = merged
  m.top.activatedRoute = current
end sub

' Completely overwrites the current route's own backJourneyData, unlike appendBackJourneyData's merge.
sub updateBackJourneyData(data as object)
  current = m.top.activatedRoute
  current.backJourneyData = data
  m.top.activatedRoute = current
end sub

' A frozen copy of `route`'s own path/params/backJourneyData — never a live reference, so a later
' mutation of the CURRENT activatedRoute (e.g. appendBackJourneyData) can never reach back and
' silently rewrite an already-pushed history entry. `routeConfig` is deliberately reset to
' `invalid`, not preserved: re-navigating to a restored history entry re-matches it from scratch
' against the current route tree (via FlashTheaterRouterOutlet's own matching cascade), the exact
' same way any other navigate() call already does — carrying along a stale routeConfig reference
' would be redundant at best, wrong at worst (e.g. after a resetRouting-style change, not itself a
' feature yet, but no reason to make history data depend on the tree never changing).
function _historySnapshot(route as object) as object
  return { path: route.path, params: route.params, backJourneyData: route.backJourneyData, routeConfig: invalid, isBackJourney: false, skipInHistory: false }
end function

' `aa[key]` if present, else `defaultValue` — every property `navigate()`'s own `routeData`
' argument reads is OPTIONAL from the DSL's own point of view (`router.navigate(path)` — the
' single-argument form — omits params/backJourneyData/isBackJourney/skipInHistory entirely; even
' the two-argument form never supplies backJourneyData/isBackJourney/skipInHistory, since those
' are set through their own dedicated action calls instead), so every read here defends against a
' missing key rather than assuming the caller always provides a fully-shaped AA.
function _getProp(aa as object, key as string, defaultValue as dynamic) as dynamic
  value = aa[key]
  if value = invalid then return defaultValue
  return value
end function

' Backs the "only ONE loading spinner visible at once, even when a single navigation causes more
' than one nested FlashTheaterRouterOutlet to gate a mount at the same time" rule — see
' findings/router-transitions.md. `outlet` calls this right before it would show its own spinner;
' `true` means it won the claim (show it), `false` means some OTHER outlet already claimed this
' same navigation cycle (stay silent, but still genuinely wait on its own child's readiness — only
' the VISIBLE spinner is suppressed, not the gate itself).
'
' "First claim within a navigation cycle wins" (keyed on `m.top.changeToken`, bumped once per
' navigate()/back() call — see that field's own doc comment above) is what makes this resolve to
' the INNERMOST outlet, not the outermost: nested outlets construct inside-out (a nested outlet's
' whole init()/_mountRoute() cascade runs as part of the ENCLOSING outlet's own CreateObject call,
' inside that outlet's own _mountRouteImmediate — see FlashTheaterRouterOutlet.brs's own top
' comment), so if both an outer and an inner outlet are gating a mount in the same navigation, the
' inner one's own claim attempt always happens chronologically FIRST (nested inside the outer's own
' CreateObject), with the outer one's own claim attempt (later in its own _mountRouteImmediate,
' after CreateObject returns) arriving second and being rejected.
function claimInnermostTransition(outlet as object) as boolean
  if m.top.changeToken = m._innermostTransitionToken then return false
  m._innermostTransitionOwner = outlet
  m._innermostTransitionToken = m.top.changeToken
  return true
end function

' Releases a claim `outlet` itself won — guarded against clearing some OTHER outlet's own,
' independently-claimed-later ownership (shouldn't happen given claimInnermostTransition's own
' per-changeToken exclusivity, but cheap to guard against regardless). Not strictly required for
' correctness (the next claimInnermostTransition call already resets cleanly once `changeToken`
' advances to the next navigation), but avoids holding a stale node reference indefinitely between
' navigations.
'
' `IsSameNode()`, never `<>`/`=` — confirmed live (Roku Ultra, 2026-08-18) that comparing two
' roSGNode references with `<>` throws "Type Mismatch. Operator "<>" can't be applied to "roSGNode"
' and "roSGNode"." at runtime, the exact same platform fact findings/focus-system.md already
' documents for every other node-identity check in this codebase (see e.g.
' FlashTheaterFocusManager.brs's own `IsSameNode()` usage) — missed here on first pass since this
' is the one node-to-node comparison in this feature (every other `<>` in this file/
' FlashTheaterRouterOutlet.brs compares against `invalid`, a string, or a boolean, all of which are
' safe). `m._innermostTransitionOwner` can be `invalid` (no claim outstanding) — guarded before
' calling `IsSameNode()` on it, which would itself throw on an invalid receiver.
sub releaseInnermostTransition(outlet as object)
  if m._innermostTransitionOwner = invalid then return
  if not m._innermostTransitionOwner.IsSameNode(outlet) then return
  m._innermostTransitionOwner = invalid
end sub
