function Grader(score as integer) as Object
  prototype = {}

  private_constructor = function (self as Object, score as integer) as Object
    self.private_score = score
    return self
  end function

  prototype.classify = function() as string
    if (ft_relationalGuard(m?.private_score, 90, ">=")) then
      return "A"
    else if (ft_relationalGuard(m?.private_score, 80, ">=")) then
      return "B"
    else
      return "C"
    end if
  end function

  prototype.sign = function() as integer
    if (ft_relationalGuard(m?.private_score, 0, ">")) then
      return 1
    else if (ft_relationalGuard(m?.private_score, 0, "<")) then
      return -1
    else
      return 0
    end if
  end function

  return private_constructor(prototype, score)
end function
