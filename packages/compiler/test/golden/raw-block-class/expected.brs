function RawBlockClass(a as string) as Object
  prototype = {}

  private_constructor = function (self as Object, a as string) as Object
    self.private_a = a
    ' flash-theater:raw
    print "constructing"
    ' flash-theater:end-raw
    return self
  end function

  prototype.describe = function() as string
    ' flash-theater:raw
    result = "a is " + m.a
    ' flash-theater:end-raw
    return result
  end function

  return private_constructor(prototype, a)
end function
