sub init()
  m.root = m.top.findNode("root")
  m.first = m.top.findNode("first")
  m.last = m.top.findNode("last")
  m.showMiddle = false
  if m?.showMiddle and m["$$ft_if_1"] = invalid then
    ConditionalDestroySiblingsFixture__create_if_1()
  else if not (m?.showMiddle) and m["$$ft_if_1"] <> invalid then
    ConditionalDestroySiblingsFixture__destroy_if_1()
  end if
end sub

sub ConditionalDestroySiblingsFixture__create_if_1()
  m["$$ft_if_1"] = CreateObject("roSGNode", "Group")
  m.middle = CreateObject("roSGNode", "Label")
  m.middle.id = "middle"
  m.middle.text = "middle"
  m["$$ft_if_1"].appendChild(m.middle)
  ft_idx = 0
  ft_idx = ft_idx + 1
  m.root.insertChild(m["$$ft_if_1"], ft_idx)
end sub

sub ConditionalDestroySiblingsFixture__destroy_if_1()
  if m["$$ft_if_1"] <> invalid then
    if m.middle <> invalid then
      m.middle.callFunc("ft_unmount")
    end if
    m.root.removeChild(m["$$ft_if_1"])
    m.middle = invalid
    m["$$ft_if_1"] = invalid
  end if
end sub

sub toggleMiddle()
  m.showMiddle = not m?.showMiddle
  if m?.showMiddle and m["$$ft_if_1"] = invalid then
    ConditionalDestroySiblingsFixture__create_if_1()
  else if not (m?.showMiddle) and m["$$ft_if_1"] <> invalid then
    ConditionalDestroySiblingsFixture__destroy_if_1()
  end if
end sub

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
  if m.first <> invalid then m.first.callFunc("ft_unmount")
  if m.last <> invalid then m.last.callFunc("ft_unmount")
  if m["$$ft_if_1"] <> invalid then m["$$ft_if_1"].callFunc("ft_unmount")
  if m.middle <> invalid then m.middle.callFunc("ft_unmount")
end sub
