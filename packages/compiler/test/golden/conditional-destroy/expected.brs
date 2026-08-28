sub init()
  m.root = m.top.findNode("root")
  m.summary = m.top.findNode("summary")
  m.showDetails = false
  if m?.showDetails and m["$$ft_if_1"] = invalid then
    ConditionalDestroyFixture__create_if_1()
  else if not (m?.showDetails) and m["$$ft_if_1"] <> invalid then
    ConditionalDestroyFixture__destroy_if_1()
  end if
end sub

sub ConditionalDestroyFixture__create_if_1()
  m["$$ft_if_1"] = CreateObject("roSGNode", "Group")
  m.detailTitle = CreateObject("roSGNode", "Label")
  m.detailTitle.id = "detailTitle"
  m.detailTitle.text = "Details"
  m["$$ft_if_1"].appendChild(m.detailTitle)
  m.detailBody = CreateObject("roSGNode", "Label")
  m.detailBody.id = "detailBody"
  m.detailBody.text = m?.showDetails?.toStr?()
  m["$$ft_if_1"].appendChild(m.detailBody)
  ft_idx = 0
  ft_idx = ft_idx + 1
  m.root.insertChild(m["$$ft_if_1"], ft_idx)
end sub

sub ConditionalDestroyFixture__destroy_if_1()
  if m["$$ft_if_1"] <> invalid then
    m.global.ft_focus.callFunc("unregisterSubtree", m["$$ft_if_1"], m.top)
    if m.detailTitle <> invalid then
      m.detailTitle.callFunc("ft_unmount")
    end if
    if m.detailBody <> invalid then
      m.detailBody.callFunc("ft_unmount")
    end if
    m.root.removeChild(m["$$ft_if_1"])
    m.detailTitle = invalid
    m.detailBody = invalid
    m["$$ft_if_1"] = invalid
    m.global.ft_focus.callFunc("recoverFocusFor", m.top)
  end if
end sub

sub toggleDetails()
  m.showDetails = not m?.showDetails
  if m?.showDetails and m["$$ft_if_1"] = invalid then
    ConditionalDestroyFixture__create_if_1()
  else if not (m?.showDetails) and m["$$ft_if_1"] <> invalid then
    ConditionalDestroyFixture__destroy_if_1()
  end if
  if m["$$ft_if_1"] <> invalid then
  m.detailBody.text = m?.showDetails?.toStr?()
  end if
end sub

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
  if m.summary <> invalid then m.summary.callFunc("ft_unmount")
  if m["$$ft_if_1"] <> invalid then m["$$ft_if_1"].callFunc("ft_unmount")
  if m.detailTitle <> invalid then m.detailTitle.callFunc("ft_unmount")
  if m.detailBody <> invalid then m.detailBody.callFunc("ft_unmount")
end sub
