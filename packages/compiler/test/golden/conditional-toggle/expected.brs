sub init()
  m.root = m.top.findNode("root")
  m.countLabel = m.top.findNode("countLabel")
  m["$$ft_if_1"] = m.top.findNode("ft_if_1")
  m.badge = m.top.findNode("badge")
  m.hasFavorites = ft_relationalGuard(m?.top?.favoriteCount, 0, ">")
  m.countLabel.text = m?.top?.favoriteCount
  m["$$ft_if_1"].visible = m?.hasFavorites
end sub

sub on_favoriteCountChange(_event as object)
  m.hasFavorites = ft_relationalGuard(m?.top?.favoriteCount, 0, ">")
  m.countLabel.text = m?.top?.favoriteCount
  m["$$ft_if_1"].visible = m?.hasFavorites
end sub

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
  if m.countLabel <> invalid then m.countLabel.callFunc("ft_unmount")
  if m["$$ft_if_1"] <> invalid then m["$$ft_if_1"].callFunc("ft_unmount")
  if m.badge <> invalid then m.badge.callFunc("ft_unmount")
end sub
