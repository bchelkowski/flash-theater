sub init()
  m.a = m.top.findNode("a")
  m.result = 0
end sub

sub bump(count as integer)
  if (m?.top?.enabled) then
    ft_ternary_1 = Invalid
    if (ft_relationalGuard(count, 0, ">")) then
      ft_ternary_1 = "small"
    else
      ft_ternary_1 = "none"
    end if
    ft_ternary_2 = Invalid
    if (ft_relationalGuard(count, 10, ">")) then
      ft_ternary_2 = "big"
    else
      ft_ternary_2 = ft_ternary_1
    end if
    label = ft_ternary_2
  end if
end sub

function computeNested(cond1 as boolean, cond2 as boolean, a as integer, b as integer, c as integer) as integer
  ft_ternary_1 = Invalid
  if (cond2) then
    ft_ternary_1 = a
  else
    ft_ternary_1 = b
  end if
  ft_ternary_2 = Invalid
  if (cond1) then
    ft_ternary_2 = (ft_ternary_1)
  else
    ft_ternary_2 = c
  end if
  value = ft_ternary_2
  return value
end function

function computeEmbedded(cond as boolean, a as integer, b as integer) as integer
  ft_ternary_1 = Invalid
  if (cond) then
    ft_ternary_1 = a
  else
    ft_ternary_1 = b
  end if
  value = 1 + (ft_ternary_1)
  return value
end function

sub updateResult(cond as boolean)
  ft_ternary_1 = Invalid
  if (cond) then
    ft_ternary_1 = 1
  else
    ft_ternary_1 = 2
  end if
  m.result = ft_ternary_1
end sub

sub ft_unmount()
  if m.a <> invalid then m.a.callFunc("ft_unmount")
end sub
