sub init()
  m.out = m.top.findNode("out")
  m.global.ft_store.observeFieldScoped("count", "on_store_countChange")
  m.count = m.global.ft_store.count
  m.doubled = m?.count * 2
end sub

sub on_store_countChange(_event as object)
  m.count = m.global.ft_store.count
  m.doubled = m?.count * 2
end sub

sub private_bump()
  m.global.ft_store.callFunc("set", "count", m?.count + 1)
end sub

sub ft_unmount()
  if m.out <> invalid then m.out.callFunc("ft_unmount")
end sub
