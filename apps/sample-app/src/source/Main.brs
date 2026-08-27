sub Main()
    screen = CreateObject("roSGScreen")
    m.port = CreateObject("roMessagePort")
    screen.setMessagePort(m.port)

    ' Wires the compiler-generated <store>/<theme-template> singletons onto
    ' the global node — see source/FlashTheater/FlashTheaterGlobals.brs
    ' (generated, flash-theater:generated marker). This is the one hand-written line
    ' every flash-theater app with a store/theme needs; everything else is
    ' generated. Must run before CreateScene so m.global.ft_store/m.global.ft_theme
    ' are already valid by the time any component's init() reads them.
    FlashTheaterSetupGlobals(screen.getGlobalNode())

    scene = screen.CreateScene("MainScene")

    ' The focus manager's own last-resort fallback (when nothing else is left to focus — see
    ' runtime-assets/FocusManager's recoverFocus) needs a real Scene reference, and there's no way
    ' for a plain roSGNode to discover "the" Scene on its own — same one-hand-written-line
    ' convention as FlashTheaterSetupGlobals above. A no-op when no component uses the focus system
    ' (the global node has no "ft_focus" field at all in that case). Note: `m.global` (the implicit
    ' convenience accessor) only exists inside a SceneGraph component's own script context — plain
    ' top-level Main.brs has no such thing (confirmed live: "Interface not a member of BrightScript
    ' Component"), so this must go through screen.getGlobalNode() explicitly instead.
    globalNode = screen.getGlobalNode()
    if globalNode.hasField("ft_focus") then globalNode.ft_focus.callFunc("setSceneRef", scene)

    screen.show()

    ' MainScene is compiled from .thr (extends="Scene", see GRAMMAR.md's "Component root
    ' `extends`") — the compiler owns its generated init(), so the demo's own one-time,
    ' order-sensitive setup (seeding the store, registering routes, navigating to the first
    ' screen, setting initial focus) lives in a hand-declared `public function setup()` instead,
    ' called once here. Same one-hand-written-line convention as FlashTheaterSetupGlobals above.
    '
    ' MUST run AFTER screen.show(), not before — confirmed live on a real device (Roku Ultra):
    ' scene.callFunc(...) issued on a Scene BEFORE screen.show() hangs indefinitely (silently, no
    ' error, until the app is force-killed, which then logs "Rendezvous aborted for Scene").
    ' Isolated by bisection: the hang reproduced even with a MainScene template stripped down to a
    ' single <Rectangle> and a setup() body containing nothing but two print statements — it is a
    ' platform behavior of pre-show() Scene callFunc, not anything about this app's own component
    ' tree or the router feature that was being verified when this was found. See findings/router.md.
    scene.callFunc("setup")

    while(true)
        msg = wait(0, m.port)
        msgType = type(msg)
        if msgType = "roSGScreenEvent"
            if msg.isScreenClosed() then return
        end if
    end while
end sub
