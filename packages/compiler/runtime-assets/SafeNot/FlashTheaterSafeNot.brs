' Backs the DSL's `!` safe-NOT sugar (see GRAMMAR.md's "Safe NOT (!)"
' section) — every `!<operand>` in a .thr/.flsh source file lowers to
' `ft_not(<operand>)`, never a bare BrightScript `Not`.
'
' A bare `Not` crashes at runtime when its operand isn't a Boolean (e.g.
' Invalid, or a numeric field that hasn't been guarded) — exactly the
' failure mode this helper exists to prevent. `ft_not` checks the operand's
' boxed type first: only a genuine roBoolean is actually negated; anything
' else returns `false` instead of crashing, mirroring `ft_equals`'s own
' "type-check before acting, false on a mismatch" shape (see
' `runtime-assets/SafeCompare/FlashTheaterSafeCompare.brs`).
'
' Not a per-component copy — see app-compiler.ts's SafeNot script-uri
' wiring: every component/class whose own compiled output calls ft_not(...)
' gets exactly one <script uri="..."> pointing at this single shared file,
' deduped the same way SafeCompare's own ft_equals(...) wiring already is.
function ft_not(value as dynamic) as boolean
  if Type(Box(value)) <> "roBoolean" then return false
  return Not value
end function
