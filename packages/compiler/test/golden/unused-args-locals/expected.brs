sub init()
  m.root = m.top.findNode("root")
  m.out = m.top.findNode("out")
  m.label = private_describe(m?.top?.count)
  m.out.text = m?.label
end sub

sub on_countChange(_event as object)
  m.label = private_describe(m?.top?.count)
  m.out.text = m?.label
end sub

function private_describe(value as integer, _unusedFlag as boolean) as string
  formatted = "count: " + str(value)
  return formatted
end function

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
  if m.out <> invalid then m.out.callFunc("ft_unmount")
end sub
