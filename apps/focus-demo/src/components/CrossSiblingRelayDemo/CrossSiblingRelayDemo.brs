' Chapter 5/7 — deliberately kept hand-written, NOT compiled from .thr, unlike every other
' component in this app. The project's one worked example of a hand-composed component
' interoperating cleanly with already-.thr-compiled children underneath it, AND (since the
' chapter/router conversion) the worked example of a hand-authored, non-.thr component used
' directly as a router route's own `component:` target — see router.astro's own "Not supported"
' note: such a screen can still be gated by loadingComponent, but since it can't call
' router.markReady(), it always falls back to loadingTimeout (not exercised by this chapter,
' which mounts instantly). GRAMMAR.md's "Cross-component focus transfer between siblings" section
' cites this exact file as the canonical "hand-wired ObserveFieldScoped, no template of its own"
' case. Leave it this way on purpose.
'
' Composes ScrollFocusDemo (a uniform grid + a few irregular non-grid-aligned cards — see its own
' buildGrid()), SimpleFocusItem (a standalone focusable leaf, no focusable children of its own),
' and FocusGroup (a small static container with its own multiple focusable children) as three
' real .thr siblings, exercising navigate() against genuinely mixed geometry. Both dummies are
' plain Rectangle+Label; the highlight on focus comes entirely from
' FlashTheaterFocusManager.moveFocusTo()'s generic color swap.
'
' Two deliberate demos of non-LRUD, author-triggered focus transfer, each showing a different
' valid shape of it (see findings/focus-system.md for why only one of these two shapes is
' actually valid — focus(<id>) can only ever reach a component's OWN descendants, never an
' arbitrary sibling):
' - FocusGroup's own on:key[OK] (see FocusGroup.thr) calls focus("row0") directly — valid,
'   because row0 IS FocusGroup's own child.
' - SimpleFocusItem's on:key[OK]/on:key[play] do NOT call focus(...) at all (FocusGroup/
'   ScrollFocusDemo are its SIBLINGS, not its children — reaching them via id would break
'   encapsulation). Instead SimpleFocusItem sets its own outbound focusRequest field; THIS file
'   (the parent that actually owns all three siblings) observes that field and reacts by calling
'   focusComponent itself, on whichever sibling it names — the same child->parent->child relay
'   shape bind: already uses for ordinary data, just hand-wired here since this file has no
'   compiled template of its own to write bind: in.
'
' Scaled by hand — ft_scale/ft_scaleFactor are the exact same runtime primitives the DSL's own
' `scale` modifier lowers to (see GRAMMAR.md's "scale" section); a hand-written component has no
' compiler to generate the call for it, so this wires the Scale script include itself
' (CrossSiblingRelayDemo.xml) and reads m.global.ft_scaleFactor directly. Only the three
' children's own translation needs scaling here — each child's OWN internal sizes are already
' scaled inside its own compiled .thr.
sub init()
  m.scrollFocusDemo = m.top.createChild("ScrollFocusDemo")
  ' Suppresses ScrollFocusDemo's own "2/7 — cross-component LRUD..." chapter chrome (title/
  ' subtitle/hint) — that text is only correct when ScrollFocusDemo is mounted as its own
  ' standalone chapter 2, not composed in here as one of three siblings under chapter 5. Confirmed
  ' live: without this, the screen showed "2/7" at the top while the bottom hint correctly read
  ' "Chapter 5/7" — see ScrollFocusDemo.thr's own `standalone` field doc comment.
  m.scrollFocusDemo.standalone = false
  m.entered = false

  factor = m.global.ft_scaleFactor

  ' Deliberately NOT centered under wide1 (ScrollFocusDemo's irregular card just above this, at
  ' local (0,900) width 640, rendered x-span ~100-740) — this box (x=40, width 220, span 40-260)
  ' only partially overlaps wide1's span, an ordinary "mostly below, ordinarily offset" layout,
  ' not pixel-aligned. navigate()'s bounding-box-overlap rule is what makes "down" from wide1
  ' correctly reach this box despite the offset. See findings/focus-system.md.
  m.simpleItem = m.top.createChild("SimpleFocusItem")
  m.simpleItem.translation = [ft_scale(40, factor), ft_scale(620, factor)]
  m.simpleItem.label = "Simple item"

  m.focusGroup = m.top.createChild("FocusGroup")
  m.focusGroup.translation = [ft_scale(900, factor), ft_scale(600, factor)]

  ' The child->parent relay for SimpleFocusItem's cross-sibling focus requests — see this file's
  ' own top-of-file comment. focusRequest is an ordinary declared field on SimpleFocusItem;
  ' ObserveFieldScoped is exactly what a compiled bind: would generate here too, hand-wired since
  ' this file has no template of its own to write bind: in.
  m.simpleItem.ObserveFieldScoped("focusRequest", "onFocusRequestChange")
end sub

' Reacts to SimpleFocusItem setting its own focusRequest field (on:key[OK]/on:key[play] there) by
' calling focusComponent on the NAMED SIBLING itself — valid here specifically because FocusGroup
' and ScrollFocusDemo are this component's own children, the same reason FocusGroup.thr's own
' focus("row0") call is valid for row0. Resets focusRequest back to "" immediately after acting
' on it so the next request — even to the same target — is a genuine "" -> "<target>" transition
' ObserveFieldScoped will actually fire on (repeatedly writing the SAME value would never refire).
' That reset write recurses into this same handler once, harmlessly, via the early request = ""
' return below.
sub onFocusRequestChange(event as object)
  request = event.GetData()
  if request = "" then return
  m.simpleItem.focusRequest = ""

  if request = "focusGroup" then
    m.global.ft_focus.callFunc("focusComponent", m.focusGroup)
  else if request = "scrollFocusDemo" then
    ' ScrollFocusDemo is now a thin chrome wrapper around a nested ScrollableTileGrid child (see
    ' that file's own top comment) — the tiles register with THAT component as owner, not
    ' ScrollFocusDemo itself, so focusComponent must target it directly (exact-owner-identity
    ' match, same constraint documented in ScrollFocusDemo.thr's own top comment).
    m.global.ft_focus.callFunc("focusComponent", m.scrollFocusDemo.findNode("tileGrid"))
  end if
end sub

' Called unconditionally by FlashTheaterRouterOutlet right after creating this component
' (`m.currentChild.callFunc("setup")` — safe even for a hand-authored component with no `setup`
' at all, but this one declares it deliberately) — the SAME synchronous mount-cascade hook every
' .thr-compiled router-mounted screen gets, just invoked here by hand instead of by the DSL.
'
' Unlike the ORIGINAL (pre-conversion) version of this file — which was the app's own ROOT SCENE,
' created during CreateScene() before source/Main.brs ever calls screen.show(), and had to defer
' its own first real focus move to the first live onKeyEvent (a SetFocus() issued that early
' never establishes a real root-to-leaf focus chain — confirmed live, see
' findings/focus-system.md) — this component is now created by the router well after the app has
' already booted and is live, so no such deferral is needed: claimFocusIfVacant is called
' directly, synchronously, from setup() itself, exactly where every other router-mounted chapter
' in this app resolves its own default focus.
'
' claimFocusIfVacant matches a registration by EXACT owner identity — SimpleFocusItem's own
' compiled init() already calls register(m.box, m.top, true) for its default-focus="true") box
' (see SimpleFocusItem.thr's own top comment), so m.simpleItem here is the right owner to pass:
' this claims SimpleFocusItem's own box as the chapter's entry point, the same registry-based
' mechanism apps/sample-app's LoadingDemoScreen.thr already proves live for "claim a default focus
' outside the router's own automatic proposal path." NOT independently live-device-confirmed for
' THIS specific call site (a hand-written component's own setup(), rather than a .thr one's) —
' see findings/focus-demo-app.md.
' Order matters: claim THIS chapter's own intended entry point (simpleItem) before letting
' ScrollFocusDemo populate itself — ScrollFocusDemo's own setup() (see that file's top comment)
' ALSO calls claimFocusIfVacant on its own nested tileGrid now, so if it ran first here it would
' win the vacancy race and silently override this chapter's own choice of entry point.
sub setup()
  m.global.ft_focus.callFunc("claimFocusIfVacant", m.simpleItem)
  m.scrollFocusDemo.callFunc("setup")
end sub
