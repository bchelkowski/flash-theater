sub init()
  m.root = m.top.findNode("root")
  m.input = m.top.findNode("input")
  m.echo = m.top.findNode("echo")
  m.inputValue = ""
  m.input.ObserveFieldScoped("text", "on_bind_input_textChange")
  m.echo.text = m?.inputValue
end sub

sub on_bind_input_textChange(event as object)
  m.inputValue = event.GetData()
  m.echo.text = m?.inputValue
end sub

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
  if m.input <> invalid then m.input.callFunc("ft_unmount")
  if m.echo <> invalid then m.echo.callFunc("ft_unmount")
end sub
