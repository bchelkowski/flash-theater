function ItemFilter(threshold as integer) as Object
  prototype = {}

  private_constructor = function (self as Object, threshold as integer) as Object
    self.private_threshold = threshold
    return self
  end function

  prototype.private_filterList = function(list as object, predicate as Function) as object
    updated = []
    for i = 0 to list?.Count?() - 1
      if (predicate(list?[i])) then
        updated.Push(list?[i])
      end if
    end for
    return updated
  end function

  prototype.positives = function(items as object) as object
    ft_anon_1 = function(item as integer) as boolean
      if (ft_relationalGuard(item, m?.private_threshold, ">")) then
        return true
      end if
      return false
    end function
    return m?.private_filterList?(items, ft_anon_1)
  end function

  return private_constructor(prototype, threshold)
end function
