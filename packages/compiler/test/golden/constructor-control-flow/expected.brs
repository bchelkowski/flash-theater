function ItemTotal(items as object) as Object
  prototype = {}

  private_constructor = function (self as Object, items as object) as Object
    sum = 0
    for each item in items
      sum = sum + item
    end for
    self.private_total = sum
    return self
  end function

  prototype.retryUntilPositive = function(attempts as integer) as integer
    tries = 0
    while ft_relationalGuard(tries, attempts, "<")
      if (ft_relationalGuard(m?.private_total, 0, ">")) then
        return m?.private_total
      end if
      tries = tries + 1
    end while
    return -1
  end function

  prototype.safeTotal = function() as integer
    result = 0
    try
      result = m?.private_total
    catch e
      result = 0
    end try
    return result
  end function

  return private_constructor(prototype, items)
end function
