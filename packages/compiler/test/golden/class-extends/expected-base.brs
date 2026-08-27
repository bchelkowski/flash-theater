function MyClass(a as string, b as integer) as Object
  prototype = {}

  private_constructor = function (self as Object, a as string, b as integer) as Object
    self.private_a = a
    self.private_b = b
    return self
  end function

  prototype.myPublicMethod = function(count as integer) as string
    return m?.private_myPrivateMethod?(count)
  end function

  prototype.private_myPrivateMethod = function(count as integer) as string
    return str(count + m?.private_b) + " " + m?.private_a
  end function

  return private_constructor(prototype, a, b)
end function
