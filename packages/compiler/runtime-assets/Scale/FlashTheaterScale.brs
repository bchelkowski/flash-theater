' Backs the DSL's `scale` modifier (see GRAMMAR.md's "scale" section) — every
' `scale field`/`scale state`/`scale derived`/`scale watch`/`scale read`
' declaration, and every `scale <local> = <expr>`/`scale state <name> = <expr>`
' function-body assignment, lowers to `ft_scale(<value>, <factor>)`.
'
' `<factor>` is always the app's ONE, once-computed `ft_scaleFactor` global
' field (`actual device display width / configured design-resolution width`,
' seeded at app boot by `FlashTheaterSetupGlobals` — see app-compiler.ts's
' `emitFlashTheaterGlobalsBrs`) — never recomputed here, and never read from
' `m`/`m.global` internally: every call site passes it in explicitly, since
' inside a .flsh class method `m` is a plain associative array, never a node
' (see findings/class-pipeline-global-singleton-access.md's `GetGlobalAA()` entry), so a
' helper that reached into `m.global` itself would silently break there.
'
' Only a real number, an array, or an associative array (each checked one
' level deep, never recursively into a nested array/AA), is ever scaled —
' element-wise for an array, per-key for an AA: numeric elements/values are
' scaled, non-numeric ones in the same array/AA pass through untouched.
' Anything else (a string, a boolean, an roSGNode, invalid, ...) passes
' through completely unchanged. This "trust the shape, do nothing surprising"
' runtime looseness matches `ft_equals`'s own philosophy in
' FlashTheaterSafeCompare.brs, not a new convention.
'
' Not a per-component copy — see app-compiler.ts's Scale script-uri wiring:
' every component/class whose own compiled output calls ft_scale(...) gets
' exactly one <script uri="..."> pointing at this single shared file, deduped
' the same way a .flsh class's own transitive imports already are.
function ft_scale(value as dynamic, factor as float) as dynamic
  valueType = Type(Box(value))

  if ft_isScaleNumberType(valueType) then
    if valueType = "roInt" or valueType = "roLongInteger" then return Int(value * factor)
    return value * factor
  end if

  if valueType = "roArray" then
    result = []
    for each item in value
      itemType = Type(Box(item))
      if ft_isScaleNumberType(itemType) then
        if itemType = "roInt" or itemType = "roLongInteger" then
          result.Push(Int(item * factor))
        else
          result.Push(item * factor)
        end if
      else
        result.Push(item)
      end if
    end for
    return result
  end if

  if valueType = "roAssociativeArray" then
    result = {}
    for each key in value
      item = value[key]
      itemType = Type(Box(item))
      if ft_isScaleNumberType(itemType) then
        if itemType = "roInt" or itemType = "roLongInteger" then
          result[key] = Int(item * factor)
        else
          result[key] = item * factor
        end if
      else
        result[key] = item
      end if
    end for
    return result
  end if

  return value
end function

' True for any of BrightScript's four numeric boxed-component type names, as
' returned by `Type(Box(value))` — see FlashTheaterSafeCompare.brs's own
' `ft_isNumberType` for the identical check; duplicated here (not shared)
' since Scale and SafeCompare are independent, optionally-wired runtime
' assets, and this codebase never makes one depend on the other.
function ft_isScaleNumberType(typeName as string) as boolean
  return typeName = "roInt" or typeName = "roFloat" or typeName = "roDouble" or typeName = "roLongInteger"
end function
