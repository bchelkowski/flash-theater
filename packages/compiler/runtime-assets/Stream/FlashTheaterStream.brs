' Backs the DSL's `stream` primitive (see GRAMMAR.md's "stream" section) — a
' per-component-instance, BehaviorSubject-like pub-sub value used for
' imperative, reactive communication between different objects (especially
' .flsh class instances) living inside the SAME component/node. Never for
' node-to-node communication — that stays field/binding, unchanged.
'
' ft_createStream() returns a plain associative array — the exact same
' "prototype object" convention codegen/class-emitter.ts already uses for a
' .flsh class instance (function-valued members closing over `m`, bound
' automatically by BrightScript when invoked as `instance.method()`), just
' with no constructor/self-threading needed since there are no external
' constructor args to plumb through.
'
' BehaviorSubject semantics: `.subscribe(subscriber)` immediately replays the
' last emitted value to the new subscriber (if `.emit` has ever been called)
' before returning, then appends `subscriber` to the subscriber list; `.emit
' (value)` stores the new value and invokes every subscriber, in
' subscription order. No unsubscribe in v1 — mirrors this compiler's own
' taskManager.onAlertChanged(...) precedent (GRAMMAR.md's "Task manager"
' section), which has none either; a stream's own subscriber list is bounded
' by its owning m/prototype's lifetime.
'
' `subscriber` is either a bare callable Function/Sub value (the ordinary
' case — a `.thr` component's own inline anonymous-function subscriber), or
' a `{target: <object>, action: <methodName as string>}` dispatch descriptor.
' The descriptor form exists specifically for subscribing FROM a `.flsh`
' class method that must write back into ITS OWN instance state — confirmed
' live (real Roku device) that a Function value's own `m` binding does NOT
' reliably survive being stored in an array and invoked later once detached
' from the SceneGraph node it closed over: this is fine for a `.thr`
' component (whose `m` is a real, persistent node), but for a plain
' associative-array "prototype object" instance (a `.flsh` class has no
' SceneGraph identity at all), a callback created inside one of its own
' methods loses its `m` the moment it's invoked from a different call frame
' (`ft_invokeStreamSubscriber` below, called from `.emit`) — the write
' silently lands on the wrong object instead of crashing, since
' associative-array field assignment never fails. A local variable captured
' before the closure fails even harder (confirmed live: "'Dot' Operator
' attempted with invalid BrightScript Component or interface reference" —
' BrightScript anonymous functions do not close over enclosing locals at
' all, only `m`, and evidently not reliably even that for a plain AA). The
' `{target, action}` descriptor sidesteps the whole problem: it carries only
' ordinary DATA (an object reference and a string), which — unlike a
' Function value — persists across the store/invoke boundary with no
' special binding to lose. Dispatching it back to a real
' `target[action](value)` call at invocation time is the SAME `instance.
' method()`-shaped call every other class method call in this codebase
' already relies on, which is confirmed reliable everywhere else.
'
' Not a per-component copy — see app-compiler.ts's Stream script-uri wiring:
' every component/class whose own compiled output calls ft_createStream(...)
' gets exactly one <script uri="..."> pointing at this single shared file,
' deduped the same way a .flsh class's own transitive imports already are.
function ft_createStream() as object
  stream = {}
  stream.hasValue = false
  stream.value = invalid
  stream.subscribers = []

  stream.emit = sub(newValue as dynamic)
    m.value = newValue
    m.hasValue = true
    for each subscriber in m.subscribers
      ft_invokeStreamSubscriber(subscriber, newValue)
    end for
  end sub

  stream.subscribe = sub(subscriber as dynamic)
    if m.hasValue then ft_invokeStreamSubscriber(subscriber, m.value)
    m.subscribers.Push(subscriber)
  end sub

  return stream
end function

' Shared dispatch for both `subscriber` shapes `ft_createStream()`'s own doc comment describes —
' a plain Function/Sub value is invoked directly; a `{target, action}` descriptor is dispatched as
' a real `target.action(value)`-shaped call via bracket notation (the only reliable way to invoke a
' dynamically-named method while still getting `m` correctly bound to `target` for that one call).
sub ft_invokeStreamSubscriber(subscriber as dynamic, value as dynamic)
  subscriberType = Type(subscriber)
  if subscriberType = "roFunction" or subscriberType = "Function" or subscriberType = "Sub"
    subscriber(value)
  else
    subscriber.target[subscriber.action](value)
  end if
end sub
