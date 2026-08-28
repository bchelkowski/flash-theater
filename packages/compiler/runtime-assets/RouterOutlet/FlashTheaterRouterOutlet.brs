' flash-theater:runtime — hand-authored, not generated from a .thr file. Auto-copied by the CLI
' into an app's output whenever any component uses the router (see cli.ts). Do not edit per-app;
' change this file in packages/compiler/runtime-assets/RouterOutlet instead. Instantiated directly
' in a .thr template like any other referenced component (`<FlashTheaterRouterOutlet id="..."/>`)
' — an ordinary component, never itself a global singleton, unlike FlashTheaterRouter.
'
' Renders whichever component the app's route tree (see FlashTheaterRouter.brs's setRouting())
' currently matches at THIS outlet's own nesting level, rebuilding it fresh (destroy + CreateObject,
' never patched in place) whenever that specific match changes — never on every navigate() call
' app-wide. This is the actual mechanism behind "a parent route renders a persistent menu, child
' routes swap inside it for free": any number of FlashTheaterRouterOutlet instances may be mounted
' at once, nested arbitrarily deep (one inside whatever component an OUTER outlet's own matched
' route mounted) — each one independently matches the router's current full target path against
' its OWN slice of the route tree and independently decides whether ITS OWN match changed, so an
' ancestor outlet whose own match is unaffected never rebuilds just because a deeper, unrelated
' sibling segment changed.
'
' See findings/router.md for the full matching mechanism, and findings/router-transitions.md for
' this file's own animated-transition/loading-gate mechanism (navigate-out:/navigate-in:/
' back-out:/back-in:, loadingComponent, router.markReady()) — this compiler's own flatter data
' model (no URL string, no async middleware chain, no generic virtual-DOM renderer —
' CreateObject/AppendChild/RemoveChild are done by hand here since flash-theater has no generic
' renderer to do it for us) and "always rebuild fresh" philosophy (no props-diffing/keep-alive of
' an already-mounted component — this compiler deliberately never does that, for the
' memory/lifecycle reasons GRAMMAR.md's "Router" section explains).
'
' A route's own "am I the deepest/leaf outlet for the CURRENT navigation" status (`isLeaf`, in
' _update() below) decides whether this outlet's own rebuild decision also depends on `params` —
' an intermediate/ancestor outlet whose own matched route ENTRY hasn't changed must NEVER rebuild
' just because some unrelated, deeper param changed; only the outlet whose own match's full path
' exactly equals the router's current target path (nothing deeper left for another, nested outlet
' to claim) treats a params change as its own trigger to rebuild too. Params are compared via
' FormatJson() (a safe, well-defined string comparison, a real standard Roku global function)
' rather than a hand-rolled deep-equality walk over the params AA — BrightScript "="/"<>" on two
' roAssociativeArray/roArray values is not reliably defined for nested complex values (comparing
' two SceneGraph node references the same way is confirmed to throw a runtime Type Mismatch — see
' findings/focus-system.md), and `params` may itself hold nested arrays/AAs.

sub init()
  m._router = m.global.ft_router
  m._parentPath = m._router.renderedPath

  ' Which candidate routes belong to THIS outlet: the app's whole top-level route tree if no
  ' enclosing outlet has matched anything yet this navigation (a ROOT outlet — `routeConfig` is
  ' still whatever the LAST completed navigate() reset it to, invalid), or the specific parent
  ' route's own `children` if an enclosing outlet's own _mountRoute() already ran (a NESTED
  ' outlet, constructed synchronously as part of that enclosing outlet's own CreateObject call —
  ' see _mountRoute() below).
  '
  ' `m._isRoot` (not a captured routes SNAPSHOT) is what's remembered here — confirmed live that a
  ' ROOT outlet's own init() always runs BEFORE the app's `setup()` has had any chance to call
  ' `router.setRouting(...)` (it's a static template child of the Scene, constructed during
  ' CreateScene, while setRouting() is only ever called later, by hand, from setup()) — caching
  ' `m._router.routing`'s VALUE here once would permanently freeze it at "[]" (an empty array, the
  ' router's own init()-time default), silently matching nothing forever. A ROOT outlet therefore
  ' re-reads `m._router.routing` live, every `_update()` — see _candidateRoutes() below. A NESTED
  ' outlet has no such problem: it's only ever constructed by an ENCLOSING outlet's own
  ' _mountRoute(), strictly AFTER that route's `children` already exists, so capturing
  ' `routeConfig.children` once, here, is safe — if the enclosing route ever changed, this whole
  ' component (and this outlet inside it) would already have been torn down and recreated by the
  ' ENCLOSING outlet, so there is no scenario where an already-alive nested outlet's own candidate
  ' list needs to change mid-lifetime.
  routeConfig = m._router.activatedRoute.routeConfig
  m._isRoot = (routeConfig = invalid)
  if not m._isRoot then
    m._candidateRoutes = routeConfig.children
    if m._candidateRoutes = invalid then m._candidateRoutes = []
  end if

  m.currentChild = invalid
  m._renderedRoute = invalid
  m._renderedParamsJson = ""
  m._renderedFullPath = ""
  ' The GLOBAL route key active at the moment m.currentChild was actually created (see
  ' _mountRouteImmediate() below) — deliberately a per-CHILD-INSTANCE snapshot, not re-derived from
  ' m._router.activatedRoute at read time, so it stays correct even if a LATER, overlapping
  ' navigate() call has since moved activatedRoute on to some other target while this specific
  ' child is still the one actually mounted (a real, tested scenario — see
  ' _cancelInFlightTransition()'s own "rapid re-navigation" doc comment). See
  ' findings/router-focus-integration.md.
  m._renderedGlobalRouteKey = ""

  ' Transition/loading-gate bookkeeping — see findings/router-transitions.md for the full design.
  ' `m._armedAnim` is whichever single Animation node (the current out: OR in:, never both at once)
  ' this outlet currently has its own "state" ObserveFieldScoped on — the one thing
  ' _cancelInFlightTransition() needs to stop/unobserve to safely interrupt an in-flight swap.
  m._armedAnim = invalid
  m._pendingRoute = invalid
  m._pendingFullPath = ""
  m._pendingParamsJson = ""
  m._pendingIsBackJourney = false
  m._pendingInAnim = invalid
  m._currentChildFocusUnregistered = false
  m._readyObservedChild = invalid
  m._loadingTimer = invalid
  m._minDurationTimer = invalid
  m._loadingTimespan = invalid
  m._spinnerNode = invalid
  m._spinnerClaimed = false

  m._router.ObserveFieldScoped("changeToken", "_onRouterChanged")

  ' Unconditional, not gated on "only if something is already active" — for a NESTED outlet,
  ' the enclosing outlet only ever creates this component AFTER a real match already exists, so
  ' there is real work to do immediately; for the ROOT outlet, created before the app's own
  ' `setup()` has necessarily called `router.navigate(...)` for the first time, this correctly
  ' finds no match yet and renders nothing, exactly the right initial state.
  _update()
end sub

sub _onRouterChanged(_event as object)
  _update()
end sub

function _candidateRoutes() as object
  if m._isRoot then return m._router.routing
  return m._candidateRoutes
end function

sub _update()
  target = m._router.activatedRoute
  matched = _findMatchingRoute(target.path)

  if matched = invalid then
    _clearView()
    return
  end if

  fullPath = _buildPath(m._parentPath, matched.path)
  isLeaf = (fullPath = target.path)

  paramsJson = ""
  if isLeaf then paramsJson = FormatJson(target.params)

  sameRoute = (m._renderedRoute <> invalid) and (m._renderedRoute.path = matched.path)
  sameParams = (not isLeaf) or (paramsJson = m._renderedParamsJson)
  if sameRoute and sameParams then return

  _mountRoute(matched, fullPath, paramsJson)
end sub

' Which of this outlet's own wired-in animation node fields applies for the current navigation
' DIRECTION (`isBackJourney`, read straight off `activatedRoute` — see FlashTheaterRouter.brs's own
' `navigate()`/`back()`) and PHASE ("out"/"in") — `invalid` when that direction/phase combination
' was never configured on this outlet's own template usage (an unconfigured phase keeps the exact
' pre-feature instant behavior for that case, see GRAMMAR.md's "Router" section).
function _resolveAnim(isBackJourney as boolean, phase as string) as dynamic
  if phase = "out"
    if isBackJourney then return m.top.ft_backOutAnim else return m.top.ft_navigateOutAnim
  end if
  if isBackJourney then return m.top.ft_backInAnim else return m.top.ft_navigateInAnim
end function

' Snaps every leaf field-interpolator under `anim` (recursing through a SequentialAnimation/
' ParallelAnimation wrapper, same shape animation-emitter.ts itself emits) to its own FIRST
' keyframe value, writing straight to `m.top` (this outlet's own node) — safe to assume `m.top` as
' the target for every interpolator because `analysis/router-transitions.ts`'s own
' `router/transition-target-must-be-outlet` check already rejected, at compile time, any
' navigate-out:/navigate-in:/back-out:/back-in: animation whose own effective target isn't this
' outlet's own id. Called right before CreateObject-ing the next screen, teleporting the outlet's
' own translation (or whatever field the in: animation targets) to the position its own "in"
' animation is about to start playing FROM — see findings/router-transitions.md's own "teleport
' model" writeup for why a single shared outlet node (not two co-mounted children) needs this reset
' between the out phase and the in phase.
sub _snapToFirstKeyframe(anim as object)
  for each child in anim.GetChildren(-1, 0)
    subtype = child.subtype()
    if subtype = "FloatFieldInterpolator" or subtype = "Vector2DFieldInterpolator" or subtype = "ColorFieldInterpolator"
      fieldToInterp = child.fieldToInterp
      dotPos = Instr(1, fieldToInterp, ".")
      if dotPos > 0
        fieldName = Mid(fieldToInterp, dotPos + 1)
        keyValue = child.keyValue
        if keyValue <> invalid and keyValue.Count() > 0 then m.top[fieldName] = keyValue[0]
      end if
    else
      _snapToFirstKeyframe(child)
    end if
  end for
end sub

sub _mountRoute(route as object, fullPath as string, paramsJson as string)
  ' Cancels whatever a PREVIOUS, still-in-flight _mountRoute call left dangling (a still-playing
  ' out:/in: animation, an unsettled loading gate) before starting fresh against this newest target
  ' — a real scenario on a remote (rapid back-to-back navigation), and more likely now that a
  ' loadingComponent gate can genuinely wait on real async work. See its own doc comment.
  _cancelInFlightTransition()

  isBackJourney = m._router.activatedRoute.isBackJourney
  outAnim = _resolveAnim(isBackJourney, "out")

  ' Deferred-restoration suppression (FlashTheaterFocusManager's own beginSuppressedNavigation()) is
  ' now armed by FlashTheaterRouter's own navigate(), unconditionally, BEFORE this outlet (or any
  ' other) even sees the changed `changeToken` — not here. Two real gaps were found and fixed the
  ' hard way in earlier versions of this file: arming only inside _beginLoadingGate() (too late once
  ' an out: animation delayed the real mount past the compiler-emitted applyPendingFocus() follow-up),
  ' and arming only for a back journey (a content-initiated forward router.navigate() — e.g. a routed
  ' screen's own on:key[OK] handler, not the persistent sidebar menu — genuinely loses focus too, and
  ' had no suppression at all). Both are now moot: the router is the one place that genuinely knows
  ' "the route being left/entered" for the WHOLE app, not just one outlet's own slice of the route
  ' tree, so arming lives there instead of being re-derived, per-outlet, from local fullPath/
  ' paramsJson values that don't even equal the global route for a non-leaf outlet. See
  ' findings/router-focus-integration.md for the full history.
  '
  ' No prior child to animate away from (first mount ever through this outlet), or this direction
  ' has no configured out: animation — today's exact instant swap, just relocated into
  ' _mountRouteImmediate so both paths share one mounting implementation. Tearing down any existing
  ' child here is a harmless no-op when there isn't one (see _teardownCurrentChildImmediate).
  ' `false` (not `viaAsyncBoundary`): this whole branch runs synchronously, still within the same
  ' native dispatch as the caller — see _mountRouteImmediate's own doc comment on that parameter.
  if m.currentChild = invalid or outAnim = invalid
    _teardownCurrentChildImmediate()
    _mountRouteImmediate(route, fullPath, paramsJson, isBackJourney, false)
    return
  end if

  ' Stash the target so _onOutAnimStopped's deferred continuation knows what to build once the
  ' outgoing screen has actually finished leaving.
  m._pendingRoute = route
  m._pendingFullPath = fullPath
  m._pendingParamsJson = paramsJson
  m._pendingIsBackJourney = isBackJourney

  ' Focus safety at exit-START, not deferred — mirrors Layer 2's own conditional-block-emitter.ts
  ' exit-start unregister exactly, same reasoning: FlashTheaterFocusManager's candidate scoring has
  ' no `visible` check, so the outgoing screen (still fully attached, just about to slide) must not
  ' stay a live LRUD target while its exit animation plays.
  _unregisterCurrentChildFocus()

  outAnim.ObserveFieldScoped("state", "_onOutAnimStopped")
  m._armedAnim = outAnim
  outAnim.control = "start"
end sub

sub _onOutAnimStopped(event as object)
  if event.GetData() <> "stopped" then return

  if m._armedAnim <> invalid
    m._armedAnim.UnobserveFieldScoped("state")
    m._armedAnim = invalid
  end if

  ' The exact same two lines _teardownCurrentChildImmediate always runs, just relocated to fire
  ' here (once the outlet is actually fully off-screen) instead of synchronously at the top of
  ' _mountRoute — unregisterSubtree already ran, above in _mountRoute, before the animation started.
  m.currentChild.callFunc("ft_unmount")
  m.top.RemoveChild(m.currentChild)
  m.currentChild = invalid

  ' `true`: reached from this animation's own "state" observer firing on a later render-thread
  ' pass — a genuinely independent native callback relative to whatever originally called
  ' router.navigate(...)/router.back() — see _mountRouteImmediate's own doc comment.
  _mountRouteImmediate(m._pendingRoute, m._pendingFullPath, m._pendingParamsJson, m._pendingIsBackJourney, true)
end sub

' The actual construct-and-attach step, shared by both the "no out: animation, do it now" path in
' _mountRoute and the "out: animation just finished" continuation in _onOutAnimStopped. Snaps this
' outlet's own translation to the in: animation's first keyframe (if any) BEFORE creating the new
' child — at this point the outlet has zero children (the old one, if any, has already been torn
' down by the caller), so the snap only repositions the empty outlet itself, which the freshly
' AppendChild-ed screen then inherits.
'
' `viaAsyncBoundary` is `true` when this call itself was already reached via a native callback
' boundary independent of the original router.navigate(...)/router.back() caller (i.e. from
' _onOutAnimStopped) — `false` when called directly, synchronously, from _mountRoute. This decides
' whether the NON-gated reveal branch below (`_revealMountedChild(inAnim, ...)`) needs to perform a
' second, later application of focus itself, or whether the ordinary compiler-emitted
' applyPendingFocus() follow-up (running immediately after router.navigate(...)/router.back()
' returns) is still the correct, sufficient, one-hop application — see _revealMountedChild's own
' doc comment for the full reasoning. The GATED branch (_beginLoadingGate) never needs this value:
' any loading-gate settlement is unconditionally reached via its own later, independent native
' callback (a field observer or Timer "fire"), regardless of how _mountRouteImmediate itself was
' reached.
sub _mountRouteImmediate(route as object, fullPath as string, paramsJson as string, isBackJourney as boolean, viaAsyncBoundary as boolean)
  ' Advance the router's own shared "how deep has rendering settled" state BEFORE creating the new
  ' child, so a NESTED outlet about to be constructed inside it (if the new component's own
  ' template contains one) reads the correct parent context via its own init() above — see this
  ' file's own top comment and FlashTheaterRouter.brs's matching one. Deliberately does NOT bump
  ' `changeToken` — nothing needs to be notified of this bookkeeping update; an already-alive
  ' outlet elsewhere never re-reads `routeConfig` after its own construction, and any FRESH nested
  ' outlet about to be built reads it directly, synchronously, in its own init() above.
  m._router.renderedPath = fullPath
  activated = m._router.activatedRoute
  activated.routeConfig = route
  m._router.activatedRoute = activated

  inAnim = _resolveAnim(isBackJourney, "in")
  if inAnim <> invalid then _snapToFirstKeyframe(inAnim)

  m.currentChild = CreateObject("roSGNode", route.component)
  m.top.AppendChild(m.currentChild)
  m._currentChildFocusUnregistered = false

  m._renderedRoute = route
  m._renderedParamsJson = paramsJson
  m._renderedFullPath = fullPath
  ' Snapshotted HERE, once, for this specific child instance — see this field's own doc comment in
  ' init() for why a live re-read of m._router.activatedRoute at capture/restore time isn't safe.
  m._renderedGlobalRouteKey = m._router.activatedRoute.path + "?" + FormatJson(m._router.activatedRoute.params)

  ' A router-mounted screen has no equivalent to MainScene's own hand-called
  ' `scene.callFunc("setup")` (see apps/sample-app/source/Main.brs) — nothing else external ever
  ' calls it, since the outlet creates it anonymously. Calling it here, unconditionally, gives
  ' every router-mounted screen the SAME one-time, order-sensitive post-construction hook
  ' MainScene already has, using the exact same convention/name — safe to call even when the
  ' mounted component declares no `setup` at all: `callFunc(...)` on an undeclared interface
  ' function fails silently (no crash, no error — confirmed in this codebase's own findings), so
  ' this is a harmless no-op for a component that doesn't need one.
  m.currentChild.callFunc("setup")

  ' `ft_routeReady <> true` (not just "loadingComponent configured") — `setup()` may have already
  ' called router.markReady() SYNCHRONOUSLY, above, before this gate would ever start observing the
  ' field (the common case for every screen in this demo app except RouterTransitionDemo — see
  ' Shell.thr's own top comment). ft_routeReady's own compiled default is `false` specifically so
  ' this read can tell that apart from "setup() never called markReady() at all" (LoadingDemoScreen,
  ' which deliberately relies on falling through to loadingTimeout) — both used to read back `true`
  ' after setup() when the field's own default was also `true`, which is what silently swallowed a
  ' synchronous markReady() call: _beginLoadingGate would unconditionally reset the field to `false`
  ' and start observing AFTER the one-and-only markReady() call had already fired, so the observer
  ' could then only ever be satisfied by the loadingTimeout fallback — never the real signal. See
  ' findings/router-transitions.md.
  loadingComponent = m.top.loadingComponent
  if loadingComponent <> invalid and loadingComponent <> "" and m.currentChild.ft_routeReady <> true
    _beginLoadingGate(inAnim, loadingComponent)
  else
    _revealMountedChild(inAnim, viaAsyncBoundary)
  end if
end sub

' Hides the just-mounted (still invisible) child behind `loadingComponent` until it signals
' readiness (`router.markReady()`, which compiles to a plain `ft_routeReady` field flip on the
' CALLING component's own top — see identifier-rewrite.ts's buildRouterActionReplacement) or
' `loadingTimeout` seconds elapse, whichever comes first — see findings/router-transitions.md for
' why this is a real readiness gate, not a cosmetic minimum-duration cover. The visible spinner
' itself is only actually created/shown when this outlet WINS the innermost-transition claim (see
' _showSpinner) — an ancestor outlet mid-transition at the same time still runs this whole gate
' (still genuinely waits on its own child's readiness), it just never shows a competing spinner.
'
' Only ever called when `ft_routeReady` is still `false` — `_mountRouteImmediate`'s own caller
' already checked and took the immediate-reveal path otherwise (setup() having synchronously called
' markReady() already). No need to reset the field to `false` here, then — it already is.
'
' Does NOT itself arm FlashTheaterFocusManager's own deferred-restoration suppression — that now
' happens unconditionally, earlier, in FlashTheaterRouter's own navigate(), before this outlet even
' sees the changed `changeToken`, let alone knows whether this function will end up being called at
' all (see _mountRoute()'s own doc comment for why arming it this late — or only for a back journey
' — used to be a real bug).
sub _beginLoadingGate(inAnim as dynamic, loadingComponent as string)
  m._pendingInAnim = inAnim
  m.currentChild.visible = false
  m._readyObservedChild = m.currentChild
  m.currentChild.ObserveFieldScoped("ft_routeReady", "_onChildRouteReady")

  m._loadingTimespan = CreateObject("roTimespan")
  m._loadingTimespan.Mark()

  timeout = m.top.loadingTimeout
  if timeout <= 0 then timeout = 5
  m._loadingTimer = CreateObject("roSGNode", "Timer")
  m._loadingTimer.duration = timeout
  m._loadingTimer.repeat = false
  m._loadingTimer.ObserveFieldScoped("fire", "_onLoadingTimeout")
  m._loadingTimer.control = "start"

  if m._router.callFunc("claimInnermostTransition", m.top)
    m._spinnerClaimed = true
    _showSpinner(loadingComponent)
  end if
end sub

sub _onChildRouteReady(event as object)
  if event.GetData() <> true then return
  _settleLoadingGate()
end sub

sub _onLoadingTimeout(event as object)
  _settleLoadingGate()
end sub

' Fires once readiness is known (real signal or forced by timeout) — stops watching for either,
' then enforces `loadingMinDuration` as a floor on how long the spinner stayed up (measured via the
' roTimespan marked when the gate began), waiting out whatever's left of it before actually
' revealing the mounted screen. A `loadingMinDuration` of 0 (the default) reveals immediately once
' ready, no extra wait.
sub _settleLoadingGate()
  if m._readyObservedChild <> invalid
    m._readyObservedChild.UnobserveFieldScoped("ft_routeReady")
    m._readyObservedChild = invalid
  end if
  if m._loadingTimer <> invalid
    m._loadingTimer.UnobserveFieldScoped("fire")
    m._loadingTimer = invalid
  end if

  elapsedMs = 0
  if m._loadingTimespan <> invalid then elapsedMs = m._loadingTimespan.TotalMilliseconds()
  remaining = m.top.loadingMinDuration - (elapsedMs / 1000)

  if remaining > 0
    m._minDurationTimer = CreateObject("roSGNode", "Timer")
    m._minDurationTimer.duration = remaining
    m._minDurationTimer.repeat = false
    m._minDurationTimer.ObserveFieldScoped("fire", "_onMinDurationElapsed")
    m._minDurationTimer.control = "start"
  else
    _revealMountedChild(m._pendingInAnim, true)
  end if
end sub

sub _onMinDurationElapsed(event as object)
  if m._minDurationTimer <> invalid
    m._minDurationTimer.UnobserveFieldScoped("fire")
    m._minDurationTimer = invalid
  end if
  _revealMountedChild(m._pendingInAnim, true)
end sub

' Reveals the mounted child (hiding/releasing the loading spinner first, if this outlet had
' claimed it), resolves and proposes its entry focus target, and starts its own in: animation if
' configured — the terminal step of every mount path (immediate, post-out-animation, or
' post-loading-gate all funnel through here).
'
' `cameFromAsyncBoundary` distinguishes whether THIS specific call is reached still within the SAME
' native dispatch as whatever originally called router.navigate(...)/router.back() (`false`), or via
' a genuinely later, independent native callback (`true`) — a settled loading gate
' (_settleLoadingGate()/_onMinDurationElapsed(), always `true`, unconditionally — see their own call
' sites), OR an out: animation's own "state" observer firing after it finishes
' (_mountRouteImmediate's `viaAsyncBoundary` parameter, threaded straight through when this function
' is reached via the non-gated branch). This distinction is what makes it safe to call
' applyPendingFocus() a SECOND time, below, only when `true` — see FlashTheaterFocusManager.brs's
' own "Deferred focus application" section for why 2+ nested callFunc hops from the
' CURRENTLY-EXECUTING native handler silently fail to route real key events; a later, independent
' native dispatch resets that budget, but still being inside the original one does not.
'
' Getting this wrong in the other direction (arming FlashTheaterFocusManager's own suppression only
' once a loading gate was already known to be needed, rather than unconditionally up front in
' _mountRoute()) was a confirmed live bug: with an out: animation configured (apps/sample-app's own
' Shell.thr — a real, live configuration, not a rare edge case), the compiler-emitted
' applyPendingFocus() follow-up runs the moment router.back() returns — which happens as soon as the
' exit animation is merely ARMED, long before this function (or the gate it might lead to) ever
' runs — so an arm-late design always missed that window. See _mountRoute()'s own doc comment for
' the fix and findings/router-focus-integration.md for the full writeup.
sub _revealMountedChild(inAnim as dynamic, cameFromAsyncBoundary as boolean)
  if m._spinnerClaimed
    _hideSpinner()
    m._router.callFunc("releaseInnermostTransition", m.top)
    m._spinnerClaimed = false
  end if

  m.currentChild.visible = true

  ' PROPOSES where focus should land, rather than moving it here — this code runs deep inside the
  ' navigation cascade (the author's handler -> router.navigate -> this outlet's own field observer
  ' -> here), and Roku will not establish real key-event routing for a SetFocus() reached through
  ' 2+ nested callFunc hops (confirmed live; see findings/focus-system.md). Recording a proposal is
  ' pure bookkeeping and safe at any depth; the compiler emits a shallow applyPendingFocus() call
  ' right after the author's own router.navigate(...)/router.back() statement, which is what
  ' actually performs the move. See FlashTheaterFocusManager.brs's "Deferred focus application".
  '
  ' Guarded — a router-using app doesn't necessarily also use the focus system (independently
  ' gated features; see compile.ts's usesFocusSystem/usesRouter), so ft_focus may not exist at
  ' all, same convention Main.brs's own `if globalNode.hasField("ft_focus")` already establishes.
  if m.global.HasField("ft_focus") then
    ft_focus = m.global.ft_focus
    routeKey = m._renderedGlobalRouteKey

    ' Only non-invalid when THIS reveal is settling a suppressed navigation (forward OR back — see
    ' FlashTheaterRouter's own navigate(), which arms this unconditionally for every journey) for
    ' THIS exact route — see FlashTheaterFocusManager.brs's resolveRouteFocusTarget(), which now
    ' searches Scene-wide, not just this outlet's own freshly-mounted `m.currentChild` — the
    ' remembered element may not live inside any outlet's mounted content at all (persistent chrome,
    ' a sibling outlet). Every other reveal (a route with no captured memory of its own, an unrelated
    ' outlet's own reveal) gets invalid back immediately and falls through to today's ordinary
    ' resolveEntryTarget() below, unchanged. This call ALSO clears the suppression flag as a side
    ' effect whenever routeKey matches, whether or not it finds a candidate — which is what keeps the
    ' fully-synchronous path (below) correct even though navigate() arms suppression unconditionally
    ' for every journey: by the time the compiler-emitted applyPendingFocus() follow-up runs (still
    ' within the same dispatch, for a synchronous mount), the flag has already been cleared right
    ' here, so that call proceeds exactly as it always has, whether a target was found or not.
    restoredTarget = ft_focus.callFunc("resolveRouteFocusTarget", routeKey)
    if restoredTarget = invalid then restoredTarget = ft_focus.callFunc("resolveEntryTarget", m.currentChild)
    ft_focus.callFunc("proposeFocusTarget", restoredTarget)

    ' Only reached when `cameFromAsyncBoundary` is true — i.e. this reveal happened via a native
    ' callback genuinely independent of whatever called router.navigate(...)/router.back()
    ' (an out: animation finishing, and/or a loading gate settling). In that case the
    ' compiler-emitted applyPendingFocus() follow-up already ran and found nothing to apply (nothing
    ' had been proposed yet), and nothing else will ever call it again for this route unless this
    ' does — see this sub's own doc comment for why calling it from here is safe specifically on
    ' this path, and would NOT be safe on the fully-synchronous one.
    if cameFromAsyncBoundary then ft_focus.callFunc("applyPendingFocus")
  end if

  if inAnim <> invalid
    inAnim.ObserveFieldScoped("state", "_onInAnimStopped")
    m._armedAnim = inAnim
    inAnim.control = "start"
  end if
end sub

sub _onInAnimStopped(event as object)
  if event.GetData() <> "stopped" then return
  if m._armedAnim <> invalid
    m._armedAnim.UnobserveFieldScoped("state")
    m._armedAnim = invalid
  end if
end sub

' Lazily creates (once) and shows the `loadingComponent`-named node, centered on this outlet's own
' declared `width`/`height` — see GRAMMAR.md's "Router" section for why an outlet needs those two
' fields at all (Group has no size of its own). Assumes the component itself renders centered on
' its own translation (true of Roku's built-in BusySpinner; a custom component should follow the
' same convention) — see GRAMMAR.md's own "Known limitations" for the alternative if it doesn't.
'
' The spinner is a CHILD of this outlet (`m.top`), which is itself the thing navigate-out:/in:/
' back-out:/in: animates — so its own translation is relative to the outlet's CURRENT (possibly
' off-screen, mid-slide-parked) position, not the screen. Every call here recomputes the spinner's
' own translation to CANCEL OUT the outlet's own current `m.top.translation`, so it renders at a
' fixed `[width/2, height/2]` relative to the outlet's OWN UNTRANSLATED origin regardless of where
' the outlet itself currently sits — confirmed live this is required, not optional: the gate only
' ever begins once the outlet is already parked at an off-screen "in" keyframe (see
' _snapToFirstKeyframe), and the outlet's own translation stays fixed for the gate's whole
' duration, so this compensation only needs to run once per `_showSpinner` call, not per frame.
sub _showSpinner(loadingComponent as string)
  if m._spinnerNode = invalid
    m._spinnerNode = CreateObject("roSGNode", loadingComponent)
    m.top.AppendChild(m._spinnerNode)
  end if
  current = m.top.translation
  m._spinnerNode.translation = [(m.top.width / 2) - current[0], (m.top.height / 2) - current[1]]
  m._spinnerNode.visible = true
end sub

sub _hideSpinner()
  if m._spinnerNode <> invalid then m._spinnerNode.visible = false
end sub

' Interrupts whatever a PREVIOUS _mountRoute call left in flight — a still-playing out:/in:
' animation, or an unsettled loading gate (still waiting on ft_routeReady/loadingTimeout/
' loadingMinDuration) — before a NEW _mountRoute call proceeds against a different target. Mirrors
' Layer 2's own "cancel in-flight exit on rapid re-toggle" precedent
' (conditional-block-emitter.ts's emitToggleTransitionCascadeLines) rather than leaving rapid
' back-to-back navigation undefined. A deliberately ORDINARY idle outlet (nothing armed, nothing
' pending, no loading wait in progress) reaching a fresh _mountRoute call is the everyday
' steady-state case, untouched by this function — `wasPending`/`hadArmedAnim`/`hadLoadingWait`
' being all false skips the teardown below entirely, leaving _mountRoute's own explicit
' immediate-path teardown as the only place that removes an ordinarily-settled current child.
sub _cancelInFlightTransition()
  wasPending = m._pendingRoute <> invalid
  hadArmedAnim = m._armedAnim <> invalid
  hadLoadingWait = m._readyObservedChild <> invalid or m._loadingTimer <> invalid or m._minDurationTimer <> invalid

  if m._armedAnim <> invalid
    ' Order matters — confirmed live as a real crash (Roku Ultra, 2026-08-18) with the two lines
    ' swapped. ObserveFieldScoped callbacks fire SYNCHRONOUSLY on Roku: setting `.control = "stop"`
    ' while still observing "state" re-enters _onOutAnimStopped/_onInAnimStopped RIGHT HERE, which
    ' tears down/rebuilds the child and reassigns m._armedAnim to a brand-new animation — all before
    ' this call ever reaches its own `.UnobserveFieldScoped(...)` line. That line then ran against whatever
    ' m._armedAnim had been reentrantly reassigned to, not what this function captured, and crashed
    ' with "Interface not a member of BrightScript Component". Capturing+clearing m._armedAnim FIRST,
    ' then unobserving BEFORE stopping, makes the reentrant path impossible: by the time `.control =
    ' "stop"` runs, this observer is already detached, so the state change it causes has no callback
    ' left to invoke.
    armedAnim = m._armedAnim
    m._armedAnim = invalid
    armedAnim.UnobserveFieldScoped("state")
    armedAnim.control = "stop"
  end if
  if m._loadingTimer <> invalid
    m._loadingTimer.UnobserveFieldScoped("fire")
    m._loadingTimer = invalid
  end if
  if m._minDurationTimer <> invalid
    m._minDurationTimer.UnobserveFieldScoped("fire")
    m._minDurationTimer = invalid
  end if
  if m._readyObservedChild <> invalid
    m._readyObservedChild.UnobserveFieldScoped("ft_routeReady")
    m._readyObservedChild = invalid
  end if
  if m._spinnerClaimed
    _hideSpinner()
    m._router.callFunc("releaseInnermostTransition", m.top)
    m._spinnerClaimed = false
  end if

  m._pendingRoute = invalid
  m._pendingInAnim = invalid

  if wasPending or hadArmedAnim or hadLoadingWait then _teardownCurrentChildImmediate()
end sub

sub _clearView()
  _cancelInFlightTransition()
  _teardownCurrentChildImmediate()
  m._renderedRoute = invalid
  m._renderedParamsJson = ""
  m._renderedFullPath = ""
end sub

' Must run BEFORE RemoveChild — FlashTheaterFocusManager's unregisterSubtree (and
' mostRecentlyFocusedWithin's own indexOfNode() check) walk each node's own GetParent()/registry
' state, which only works while the node is still attached (same requirement plain unregister()
' already has).
'
' Captures `mostRecentlyFocusedWithin(m.currentChild)` — the last element ACTUALLY focused ANYWHERE
' inside THIS outlet's own outgoing content, including inside a NESTED custom component (e.g. a
' `ScheduleList` row) — not `currentlyFocused()` (whatever holds focus literally right now) and not
' a plain owner-identity lookup either. Two real gaps, found live, one after the other:
' (1) `currentlyFocused()` differs from "what was last focused inside this content" whenever the
'     user stepped back to a persistent menu (or anywhere else outside this route's own content)
'     before actually pressing the navigation trigger — the ordinary way to navigate in this
'     framework's own canonical "persistent side menu" layout.
' (2) An owner-identity-only lookup (the ORIGINAL fix for (1), `lastFocusedFor(m.currentChild)`)
'     still missed anything registered under a NESTED component's own owner — `register()`'s own
'     `owner` is always the DIRECTLY enclosing component's `m.top`, never a distant ancestor, so a
'     `ScheduleList` row's owner is `ScheduleList` itself, never `ScheduleScreen`
'     (`m.currentChild`) — `mostRecentlyFocusedWithin` matches by actual NODE ancestry instead,
'     which finds it regardless of nesting depth.
' Both confirmed live as the exact same reported symptom: a Schedule list row correctly focused,
' then the user stepping back to the sidebar to navigate elsewhere, then Back — the row was never
' restored, only whichever sidebar item happened to be focused (which, since the sidebar is never
' actually torn down, never even genuinely lost focus in the first place — see this function's own
' entry in findings/router-focus-integration.md for why that made the bug easy to misread as
' "restoration happened" when it hadn't).
'
' Keyed by `m._renderedGlobalRouteKey` — a snapshot taken once, when THIS currentChild was actually
' created (see _mountRouteImmediate()), not re-derived from m._router.activatedRoute here —
' activatedRoute has already moved on to the INCOMING route by the time this runs, and re-reading it
' live would also break under an interrupted/rapid re-navigation (see _cancelInFlightTransition(),
' which can reach this same function for a STALE, still-mounted child while a completely different
' navigation is already underway).
sub _unregisterCurrentChildFocus()
  if m.currentChild = invalid then return
  if m._currentChildFocusUnregistered then return
  if m.global.HasField("ft_focus") then
    lastFocused = m.global.ft_focus.callFunc("mostRecentlyFocusedWithin", m.currentChild)
    m.global.ft_focus.callFunc("captureRouteFocusMemory", m._renderedGlobalRouteKey, lastFocused)
    m.global.ft_focus.callFunc("unregisterSubtree", m.currentChild, invalid)
  end if
  m._currentChildFocusUnregistered = true
end sub

sub _teardownCurrentChildImmediate()
  if m.currentChild = invalid then return
  _unregisterCurrentChildFocus()
  ' The compiler-manufactured "this component is about to be removed" hook (every compiled .thr
  ' component declares ft_unmount unconditionally — see naming.ts's UNMOUNT_FUNCTION_NAME doc
  ' comment) — safe to call unconditionally the same way "setup" above is: callFunc on an
  ' undeclared interface function fails silently, so this is a no-op for a hand-authored child that
  ' never got one. Same ordering requirement as unregisterSubtree above — must run before RemoveChild
  ' while the subtree is still attached.
  m.currentChild.callFunc("ft_unmount")
  m.top.RemoveChild(m.currentChild)
  m.currentChild = invalid
end sub

' This outlet is itself an ordinary roSGNode that can be nested inside an ancestor's own
' {#if:destroy} subtree — its own generated destroy sub will guardedly callFunc("ft_unmount") on
' this outlet's cached id, same as any other nested custom component. Forward the cascade to
' whichever screen this outlet currently has mounted, so a Timer-using router-mounted screen still
' gets cleaned up even when the OUTLET itself (not the screen) is what's being torn down. No
' RemoveChild here — the ancestor's own removeChild on this outlet's wrapper takes the whole
' subtree, m.currentChild included, at once; this sub only needs to forward the cascade.
sub ft_unmount()
  if m.currentChild <> invalid then m.currentChild.callFunc("ft_unmount")
end sub

' The first entry in this outlet's own candidate routes (see _candidateRoutes() above) whose own
' full path (this outlet's own m._parentPath joined with the candidate's own path segment) is a
' genuine prefix match of `targetPath` — see this file's own top comment. An empty-segment
' candidate ("" — an index/default child route) matches only when `targetPath` is EXACTLY this
' outlet's own parent path, with nothing further — this compiler never composes params into the
' path string at all.
function _findMatchingRoute(targetPath as string) as dynamic
  for each route in _candidateRoutes()
    if route.path = "" then
      if targetPath = m._parentPath then return route
    else
      fullPath = _buildPath(m._parentPath, route.path)
      startsWithFullPath = (Left(targetPath, Len(fullPath)) = fullPath)
      isWholeSegmentMatch = (Len(targetPath) = Len(fullPath)) or (Mid(targetPath, Len(fullPath) + 1, 1) = "/")
      if startsWithFullPath and isWholeSegmentMatch then return route
    end if
  end for
  return invalid
end function

' Joins a parent path and a single child SEGMENT into a full path — "" + "browse" => "/browse",
' "/browse" + "schedule" => "/browse/schedule", "/browse" + "" (an index/default child) =>
' "/browse" unchanged.
function _buildPath(parentPath as string, segment as string) as string
  if segment = "" then return parentPath
  if parentPath = "" or parentPath = "/" then return "/" + segment
  return parentPath + "/" + segment
end function
