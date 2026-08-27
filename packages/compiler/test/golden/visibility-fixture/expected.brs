sub init()
  m.root = m.top.findNode("root")
  m.statusLabel = m.top.findNode("statusLabel")
  m.debugLabel = m.top.findNode("debugLabel")
  m.statusText = formatStatus(m?.top?.enabled)
  m.debugText = private_describePrivate(m?.top?.enabled)
  m.statusLabel.text = m?.statusText
  m.debugLabel.text = m?.debugText
end sub

sub on_enabledChange(_event as object)
  m.statusText = formatStatus(m?.top?.enabled)
  m.debugText = private_describePrivate(m?.top?.enabled)
  m.statusLabel.text = m?.statusText
  m.debugLabel.text = m?.debugText
end sub

function formatStatus(value as boolean) as string
  if (value) then
    return "Status: ON"
  end if
  return "Status: OFF"
end function

function private_describePrivate(value as boolean) as string
  if (value) then return "debug:on"
  return "debug:off"
end function

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
  if m.statusLabel <> invalid then m.statusLabel.callFunc("ft_unmount")
  if m.debugLabel <> invalid then m.debugLabel.callFunc("ft_unmount")
end sub
