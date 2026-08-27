sub init()
  m.card = m.top.findNode("card")
  m.global.ft_focus.callFunc("register", m.card, m.top, false)
end sub

function onKeyEvent(key as string, press as boolean) as boolean
  if m.card <> invalid and m.card.IsInFocusChain() then
    if key = "OK" then
      private_goToOther(key, press)
      return true
    end if
  end if
  if key = "up" or key = "down" or key = "left" or key = "right" then
    if press then
      if m.global.ft_focus.callFunc("navigate", key) then
        m.global.ft_focus.callFunc("startRepeat", key)
        return true
      end if
    else
      m.global.ft_focus.callFunc("stopRepeat")
      return true
    end if
  end if
  return false
end function

sub private_goToOther(_key as string, press as boolean)
  if (press) then
    m.global.ft_focus.callFunc("focusComponent", m.top.findNode("otherComponent"))
  end if
end sub

sub ft_unmount()
  if m.card <> invalid then m.card.callFunc("ft_unmount")
end sub
