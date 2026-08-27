sub init()
  m.root = m.top.findNode("root")
  m.out = m.top.findNode("out")
  m.out.text = m?.top?.limit?.ToStr?()
  ' flash-theater:raw
  m.top.limit = m.top.limit + 1
  ' flash-theater:end-raw
end sub

sub on_limitChange(_event as object)
  m.out.text = m?.top?.limit?.ToStr?()
end sub

function private_describe() as string
  ' flash-theater:raw
  result = "limit is " + someUndeclaredHelperName().ToStr()
  ' flash-theater:end-raw
  return result
end function

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
  if m.out <> invalid then m.out.callFunc("ft_unmount")
end sub
