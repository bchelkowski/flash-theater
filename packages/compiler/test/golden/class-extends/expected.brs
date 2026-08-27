function MyExtendedClass(a as string, b as integer, c as integer) as Object
  prototype = MyClass(a, b)

  private_constructor = function (self as Object, a as string, b as integer, c as integer) as Object
    self.private_c = c
    return self
  end function

  prototype.myPublicMethod = function(count as integer) as string
    return m?.private_myPrivateMethod2?(count)
  end function

  prototype.private_myPrivateMethod2 = function(count as integer) as string
    return str(count + m?.private_b + m?.private_c) + " " + m?.private_a
  end function

  return private_constructor(prototype, a, b, c)
end function
