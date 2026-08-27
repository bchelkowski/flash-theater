sub init()
  m.root = m.top.findNode("root")
  m.items = invalid
  m.matchCount = 0
end sub

function private_filterList(list as object, predicate as Function) as object
  updated = []
  for i = 0 to list?.Count?() - 1
    if (predicate(list?[i])) then
      updated.Push(list?[i])
    end if
  end for
  return updated
end function

sub private_eachItem(list as object, action as Function)
  for i = 0 to list?.Count?() - 1
    action(list?[i])
  end for
end sub

sub filterItems()
  ft_anon_1 = function(item as object) as boolean
    if (ft_relationalGuard(item?.value, m?.top?.threshold, ">")) then
      m.matchCount = m?.matchCount + 1
      return true
    end if
    return false
  end function
  m.items = private_filterList(m?.items, ft_anon_1)
end sub

sub private_logItems()
  ft_anon_1 = sub(item as object)
    print item?.value
  end sub
  private_eachItem(m?.items, ft_anon_1)
end sub

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
end sub
