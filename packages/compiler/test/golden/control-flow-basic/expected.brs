sub init()
  m.root = m.top.findNode("root")
  m.out = m.top.findNode("out")
  m.total = 0
  m.out.text = m?.total?.ToStr?()
end sub

function private_sumTo() as integer
  result = 0
  for i = 0 to m?.top?.limit step 1
    result = result + i
  end for
  return result
end function

function private_listNames(names as object) as string
  joined = ""
  for each name in names
    joined = joined + name + ","
  end for
  return joined
end function

sub private_countDown()
  i = m?.top?.limit
  while ft_relationalGuard(i, 0, ">")
    print i
    i = i - 1
  end while
end sub

function private_safeDivide(a as integer, b as integer) as integer
  result = 0
  try
    result = a / b
  catch e
    result = e?.number
  end try
  return result
end function

sub recompute()
  m.total = private_sumTo()
  m.out.text = m?.total?.ToStr?()
end sub

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
  if m.out <> invalid then m.out.callFunc("ft_unmount")
end sub
