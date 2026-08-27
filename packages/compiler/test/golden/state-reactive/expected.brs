sub init()
  m.root = m.top.findNode("root")
  m.out = m.top.findNode("out")
  m.count = 0
  m.label = private_describe(m?.count)
  m.out.text = m?.label
end sub

function private_describe(value as integer) as string
  return "count: " + str(value)
end function

sub bump()
  if (m?.top?.enabled) then
    m.count = m?.count + 1
    m.label = private_describe(m?.count)
    m.out.text = m?.label
  end if
end sub

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
  if m.out <> invalid then m.out.callFunc("ft_unmount")
end sub
