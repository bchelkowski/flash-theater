sub init()
  m.root = m.top.findNode("root")
  m.lastKey = ""
end sub

function private_makeGreeter() as object
  greet = function(name as string) as string
    return "Hello, " + name
  end function
  return greet
end function

function private_runDemo() as string
  greeter = private_makeGreeter()
  return greeter("World")
end function

sub registerHandler()
  onSelect = sub(key as string, press as boolean)
    if (press) then
      print m?.top?.prefix + key
    end if
  end sub
  onSelect("OK", true)
  m.lastKey = "OK"
end sub

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
end sub
