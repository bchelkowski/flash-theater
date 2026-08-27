sub init()
  m.root = m.top.findNode("root")
end sub

function private_countMatches(items as object) as integer
  matches = 0
  for i = 0 to items?.Count?() - 1
    if (ft_relationalGuard(items?[i], m?.top?.threshold, ">")) then
      matches = matches + 1
    end if
  end for
  return matches
end function

function private_findFirstOver(items as object) as integer
  found = -1
  i = 0
  while ft_relationalGuard(i, items?.Count?(), "<")
    for j = i to items?.Count?() - 1
      if (ft_relationalGuard(items?[j], m?.top?.threshold, ">")) then
        found = items?[j]
      end if
    end for
    i = i + 1
  end while
  return found
end function

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
end sub
