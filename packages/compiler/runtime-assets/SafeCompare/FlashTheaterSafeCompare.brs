' Backs the DSL's `==`/`!=` comparison sugar (see GRAMMAR.md's "Comparison
' (==/!=)" section) — every `<left> == <right>`/`<left> != <right>` in a
' .thr/.flsh source file lowers to `ft_equals(<left>, <right>)`/
' `Not ft_equals(<left>, <right>)`, never a bare BrightScript `=`/`<>`.
'
' A bare `=` crashes at runtime when its two operands are different,
' incompatible types (e.g. comparing an integer field to Invalid, or a
' string to a roAssociativeArray) — exactly the failure mode this helper
' exists to prevent, while still comparing BY VALUE like JavaScript's `==`:
' two operands of different NUMERIC subtypes (Integer vs Float, LongInteger
' vs Double, ...) compare equal when their values match, never forced
' unequal just because BrightScript happened to box them differently — see
' `ft_isNumberType` below. An roArray/roAssociativeArray compares by
' *reference identity* (`roUtils.isSameObject`), never by deep content
' equality — matching JavaScript's own `==`/`===` on objects/arrays. An
' roSGNode compares via the dedicated `isSameNode` identity check (after
' confirming both sides share the same `subtype()`), since a generic
' identity check is not guaranteed safe for SceneGraph nodes the way it is
' for a plain array/associative array.
'
' Not a per-component copy — see app-compiler.ts's SafeCompare script-uri
' wiring: every component/class whose own compiled output calls
' ft_equals(...) gets exactly one <script uri="..."> pointing at this single
' shared file, deduped the same way a .flsh class's own transitive imports
' already are.
function ft_equals(left as dynamic, right as dynamic) as boolean
  leftType = Type(Box(left))
  rightType = Type(Box(right))

  leftIsNumber = ft_isNumberType(leftType)
  rightIsNumber = ft_isNumberType(rightType)
  if leftIsNumber or rightIsNumber then return leftIsNumber and rightIsNumber and left = right

  if leftType <> rightType then return false

  if leftType = "roSGNode" then
    if left.subtype() <> right.subtype() then return false
    return left.isSameNode(right)
  end if

  if leftType = "roArray" or leftType = "roAssociativeArray" then
    return CreateObject("roUtils").isSameObject(left, right)
  end if

  return left = right
end function

' True for any of BrightScript's four numeric boxed-component type names, as
' returned by `Type(Box(value))` — Integer/Float/Double/LongInteger each box
' to a DISTINCT roXxx component, so `ft_equals` cannot compare their boxed
' type names for equality the way it does for every other type (that would
' make `3 == 3.0` false, which defeats the point of a crash-safe "are these
' equal" check). Once BOTH operands are confirmed numeric — of any of these
' four subtypes, not necessarily the same one — `ft_equals` falls through to
' the real `=` operator directly: safe and correct, since BrightScript
' promotes mixed-numeric-subtype operands before comparing rather than
' crashing (unlike a genuine type mismatch, e.g. Integer vs Invalid, which
' `=` does crash on — the original failure mode this whole helper exists to
' prevent).
function ft_isNumberType(typeName as string) as boolean
  return typeName = "roInt" or typeName = "roFloat" or typeName = "roDouble" or typeName = "roLongInteger"
end function
