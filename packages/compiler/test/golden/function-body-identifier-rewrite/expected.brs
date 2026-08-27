sub init()
  m.root = m.top.findNode("root")
  m.out = m.top.findNode("out")
  m.doubled = m?.top?.score * 2
  m.summary = private_describe()
  m.out.text = m?.summary
end sub

sub on_scoreChange(_event as object)
  m.doubled = m?.top?.score * 2
end sub

function private_describe() as string
  if (m?.top?.enabled) then
    return "on: " + str(m?.doubled)
  end if
  return "off"
end function

function echoScore(score as integer) as integer
  return score
end function

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
  if m.out <> invalid then m.out.callFunc("ft_unmount")
end sub
