sub init()
  m.out = m.top.findNode("out")
  m.message = ""
  m.dataLoaded = ft_createStream()
  m.out.text = m?.message
end sub

sub private_loadData()
  m.dataLoaded.emit("payload-ready")
end sub

sub setup()
  ft_anon_1 = sub(value as string)
    m.message = value
    m.out.text = m?.message
  end sub
  m.dataLoaded.subscribe(ft_anon_1)
end sub

sub ft_unmount()
  if m.out <> invalid then m.out.callFunc("ft_unmount")
end sub
