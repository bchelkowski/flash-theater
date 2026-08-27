sub init()
  m.root = m.top.findNode("root")
  m.summary = m.top.findNode("summary")
  m.showInput = false
  m.inputValue = ""
  if m?.showInput and m["$$ft_if_1"] = invalid then
    BindInDestroyFixture__create_if_1()
  else if not (m?.showInput) and m["$$ft_if_1"] <> invalid then
    BindInDestroyFixture__destroy_if_1()
  end if
end sub

sub on_bind_input_textChange(event as object)
  m.inputValue = event.GetData()
  if m["$$ft_if_1"] <> invalid then
  m.echo.text = m?.inputValue
  end if
end sub

sub BindInDestroyFixture__create_if_1()
  m["$$ft_if_1"] = CreateObject("roSGNode", "Group")
  m.input = CreateObject("roSGNode", "TextEditBox")
  m.input.id = "input"
  m.input.ObserveFieldScoped("text", "on_bind_input_textChange")
  m["$$ft_if_1"].appendChild(m.input)
  m.echo = CreateObject("roSGNode", "Label")
  m.echo.id = "echo"
  m.echo.text = m?.inputValue
  m["$$ft_if_1"].appendChild(m.echo)
  ft_idx = 0
  ft_idx = ft_idx + 1
  m.root.insertChild(m["$$ft_if_1"], ft_idx)
end sub

sub BindInDestroyFixture__destroy_if_1()
  if m["$$ft_if_1"] <> invalid then
    if m.input <> invalid then
      m.input.UnobserveFieldScoped("text")
    end if
    if m.input <> invalid then
      m.input.callFunc("ft_unmount")
    end if
    if m.echo <> invalid then
      m.echo.callFunc("ft_unmount")
    end if
    m.root.removeChild(m["$$ft_if_1"])
    m.input = invalid
    m.echo = invalid
    m["$$ft_if_1"] = invalid
  end if
end sub

sub toggleInput()
  m.showInput = not m?.showInput
  if m?.showInput and m["$$ft_if_1"] = invalid then
    BindInDestroyFixture__create_if_1()
  else if not (m?.showInput) and m["$$ft_if_1"] <> invalid then
    BindInDestroyFixture__destroy_if_1()
  end if
end sub

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
  if m.summary <> invalid then m.summary.callFunc("ft_unmount")
  if m["$$ft_if_1"] <> invalid then m["$$ft_if_1"].callFunc("ft_unmount")
  if m.input <> invalid then m.input.callFunc("ft_unmount")
  if m.echo <> invalid then m.echo.callFunc("ft_unmount")
end sub
