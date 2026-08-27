' Backs the DSL's `<`/`>`/`<=`/`>=` relational-operator sugar (see
' GRAMMAR.md's "Comparison" section) — every `<left> < <right>`/`<left> >
' <right>`/`<left> <= <right>`/`<left> >= <right>` in a .thr/.flsh source
' file lowers to `ft_relationalGuard(<left>, <right>, "<op>")`, never a bare
' BrightScript `<`/`>`/`<=`/`>=`.
'
' A bare relational operator crashes at runtime when its two operands are
' different, incompatible types (e.g. comparing a string field to Invalid,
' or a number to a roAssociativeArray) — exactly the failure mode this
' helper exists to prevent. Unlike `ft_equals` (FlashTheaterSafeCompare.brs),
' there is no sane fallback VALUE for a genuinely incompatible ordering
' comparison (there's no obviously-correct answer to "is an array greater
' than a node?", unlike equality's safe `false`) — so this helper throws a
' structured error instead of guessing, catchable via this DSL's `try`/
' `catch`.
'
' Not a per-component copy — see app-compiler.ts's SafeRelational script-uri
' wiring: every component/class whose own compiled output calls
' ft_relationalGuard(...) gets exactly one <script uri="..."> pointing at
' this single shared file, deduped the same way FlashTheaterSafeCompare.brs
' already is. Kept in its own directory, separate from SafeCompare, so a
' component using only `<`/`>`/`<=`/`>=` never has to ship the equality
' helper too (and vice versa) — the same reasoning FlashTheaterSafeNot.brs
' already established.
function ft_relationalGuard(left as dynamic, right as dynamic, operator as string) as dynamic
  leftType = Type(Box(left))
  rightType = Type(Box(right))

  bothNumeric = ft_relIsNumberType(leftType) and ft_relIsNumberType(rightType)
  bothString = leftType = "roString" and rightType = "roString"

  if not (bothNumeric or bothString) then
    throw ft_relationalTypeError(leftType, rightType, operator)
  end if

  if operator = "<" then return left < right
  if operator = ">" then return left > right
  if operator = "<=" then return left <= right
  return left >= right
end function

' True for any of BrightScript's four numeric boxed-component type names, as
' returned by `Type(Box(value))` — same four subtypes `ft_isNumberType`
' (FlashTheaterSafeCompare.brs) checks, kept as its own copy here rather than
' a cross-file call so a component using only relational operators never
' needs to also ship SafeCompare's file.
function ft_relIsNumberType(typeName as string) as boolean
  return typeName = "roInt" or typeName = "roFloat" or typeName = "roDouble" or typeName = "roLongInteger"
end function

' The thrown error's shape: `message` is a human-readable sentence naming
' both mismatched types and the operator; `code` is a stable, catchable
' discriminator ("relational/type-mismatch") so a `catch e` block can branch
' on failure kind instead of parsing `e.message`.
function ft_relationalTypeError(leftType as string, rightType as string, operator as string) as object
  return { code: "relational/type-mismatch", message: "flash-theater: cannot compare " + leftType + " and " + rightType + " with '" + operator + "' — relational operators require two numbers or two strings." }
end function
