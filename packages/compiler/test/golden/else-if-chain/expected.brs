sub init()
  m.root = m.top.findNode("root")
  m.out = m.top.findNode("out")
  m.grade = private_classify(m?.top?.score)
  m.out.text = m?.grade
end sub

sub on_scoreChange(_event as object)
  m.grade = private_classify(m?.top?.score)
  m.out.text = m?.grade
end sub

function private_classify(value as integer) as string
  if (ft_relationalGuard(value, 90, ">=")) then
    return "A"
  else if (ft_relationalGuard(value, 80, ">=")) then
    return "B"
  else
    return "C"
  end if
end function

function sign(value as integer) as integer
  if (ft_relationalGuard(value, 0, ">")) then
    return 1
  else if (ft_relationalGuard(value, 0, "<")) then
    return -1
  else
    return 0
  end if
end function

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
  if m.out <> invalid then m.out.callFunc("ft_unmount")
end sub
