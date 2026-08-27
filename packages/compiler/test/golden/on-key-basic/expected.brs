sub init()
  m.root = m.top.findNode("root")
  m.card = m.top.findNode("card")
end sub

function onKeyEvent(key as string, press as boolean) as boolean
  if m.card <> invalid and m.card.IsInFocusChain() then
    if key = "OK" then
      private_selectItem(key, press)
      return true
    end if
    if key = "play" then
      private_selectItem(key, press)
      return true
    end if
    fallback(key, press)
    return true
  end if
  if m.root <> invalid and m.root.IsInFocusChain() then
    if key = "back" then
      private_goBack(key, press)
      return true
    end if
  end if
  return false
end function

sub private_selectItem(_key as string, _press as boolean)

end sub

sub fallback(_key as string, _press as boolean)

end sub

sub private_goBack(_key as string, _press as boolean)

end sub

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
  if m.card <> invalid then m.card.callFunc("ft_unmount")
end sub
