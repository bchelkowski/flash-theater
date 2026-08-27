sub init()
  m.root = m.top.findNode("root")
  m.statusLabel = m.top.findNode("statusLabel")
  m.statusText = describeStatus(m?.top?.enabled)
  m.statusLabel.text = m?.statusText
end sub

sub on_enabledChange(_event as object)
  m.statusText = describeStatus(m?.top?.enabled)
  m.statusLabel.text = m?.statusText
end sub

function describeStatus(value as boolean) as string
  if (value) then
    return "on"
  end if
  return "off"
end function

sub logStatus(value as boolean)
  print value
end sub

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
  if m.statusLabel <> invalid then m.statusLabel.callFunc("ft_unmount")
end sub
