sub init()
  m.a = m.top.findNode("a")
  m.apiBaseUrlLabel = "API: " + m?.global?.ft_env?.apiBaseUrl
  m.a.text = m?.apiBaseUrlLabel
end sub

sub ft_unmount()
  if m.a <> invalid then m.a.callFunc("ft_unmount")
end sub
