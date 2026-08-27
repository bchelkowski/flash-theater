sub init()
  m.root = m.top.findNode("root")
  m.out = m.top.findNode("out")
  m.summary = m.top.findNode("summary")
  m.displayName = m?.top?.profile?.user?.name
  m.summaryLabel = private_describeCache(m?.top?.cache)
  m.out.text = m?.displayName
  m.summary.text = m?.summaryLabel
end sub

sub on_profileChange(_event as object)
  m.displayName = m?.top?.profile?.user?.name
  m.out.text = m?.displayName
end sub

sub on_cacheChange(_event as object)
  m.summaryLabel = private_describeCache(m?.top?.cache)
  m.summary.text = m?.summaryLabel
end sub

sub private_logEvent(label as string)
  print label
end sub

function private_describeCache(cacheNode as object) as string
  return "cache: " + cacheNode?.tracker?.summarize?()
end function

sub private_refresh()
  m.top.cache.tracker.recordVisit()
  private_logEvent(m?.top?.cache?.tracker?.summarize?())
  m.top.cache.counters.total = 0
end sub

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
  if m.out <> invalid then m.out.callFunc("ft_unmount")
  if m.summary <> invalid then m.summary.callFunc("ft_unmount")
end sub
