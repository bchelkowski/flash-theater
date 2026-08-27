sub init()
  m.background = m.top.findNode("background")
  m.highlight = m.top.findNode("highlight")
  m.labelsContainer = m.top.findNode("labelsContainer")
  m.titleLabel = m.top.findNode("titleLabel")
  m.dayNameLabel = m.top.findNode("dayNameLabel")
  m.isGridFocused = ft_relationalGuard(m?.top?.focusPercent, 0.5, ">")
  m.highlightColor = private_pickColor(m?.top?.gridHasFocus, "0x0057FFFF", "0x3A3A3AFF")
  m.highlightOpacity = private_pickOpacity(m?.isGridFocused)
  m.textColor = private_pickColor(m?.isGridFocused, "0xFFFFFFFF", "0x9A9A9AFF")
  m.contentOpacity = private_pickContentOpacity(m?.top?.itemContent)
  m.titleText = private_itemContentTitle(m?.top?.itemContent)
  m.dayNameText = private_itemContentDayName(m?.top?.itemContent)
  m.background.setFields({width: m?.top?.width, height: m?.top?.height})
  m.highlight.setFields({width: m?.top?.width, height: m?.top?.height, color: m?.highlightColor, opacity: m?.highlightOpacity})
  m.labelsContainer.translation = [m?.top?.width / 2, m?.top?.height / 2]
  m.titleLabel.setFields({text: m?.titleText, color: m?.textColor, opacity: m?.contentOpacity})
  m.dayNameLabel.setFields({text: m?.dayNameText, color: m?.textColor, opacity: m?.contentOpacity})
end sub

sub on_widthChange(_event as object)
  m.background.width = m?.top?.width
  m.highlight.width = m?.top?.width
  m.labelsContainer.translation = [m?.top?.width / 2, m?.top?.height / 2]
end sub

sub on_heightChange(_event as object)
  m.background.height = m?.top?.height
  m.highlight.height = m?.top?.height
  m.labelsContainer.translation = [m?.top?.width / 2, m?.top?.height / 2]
end sub

sub on_focusPercentChange(_event as object)
  m.isGridFocused = ft_relationalGuard(m?.top?.focusPercent, 0.5, ">")
  m.highlightOpacity = private_pickOpacity(m?.isGridFocused)
  m.textColor = private_pickColor(m?.isGridFocused, "0xFFFFFFFF", "0x9A9A9AFF")
  m.highlight.opacity = m?.highlightOpacity
  m.titleLabel.color = m?.textColor
  m.dayNameLabel.color = m?.textColor
end sub

sub on_gridHasFocusChange(_event as object)
  m.highlightColor = private_pickColor(m?.top?.gridHasFocus, "0x0057FFFF", "0x3A3A3AFF")
  m.highlight.color = m?.highlightColor
end sub

sub on_itemContentChange(_event as object)
  m.contentOpacity = private_pickContentOpacity(m?.top?.itemContent)
  m.titleText = private_itemContentTitle(m?.top?.itemContent)
  m.dayNameText = private_itemContentDayName(m?.top?.itemContent)
  m.titleLabel.text = m?.titleText
  m.titleLabel.opacity = m?.contentOpacity
  m.dayNameLabel.text = m?.dayNameText
  m.dayNameLabel.opacity = m?.contentOpacity
end sub

function private_pickColor(condition as boolean, whenTrue as string, whenFalse as string) as string
  if (condition) then
    return whenTrue
  end if
  return whenFalse
end function

function private_pickOpacity(condition as boolean) as float
  if (condition) then return 1.0
  return 0.0
end function

function private_pickContentOpacity(content as object) as float
  if (content = invalid) then
    return 0.4
  end if
  if (content?.isContentAvailable) then
    return 1.0
  end if
  return 0.4
end function

function private_itemContentTitle(content as object) as string
  if (content = invalid) then return ""
  return content?.title
end function

function private_itemContentDayName(content as object) as string
  if (content = invalid) then return ""
  return UCase(content?.dayName)
end function

sub ft_unmount()
  if m.background <> invalid then m.background.callFunc("ft_unmount")
  if m.highlight <> invalid then m.highlight.callFunc("ft_unmount")
  if m.labelsContainer <> invalid then m.labelsContainer.callFunc("ft_unmount")
  if m.titleLabel <> invalid then m.titleLabel.callFunc("ft_unmount")
  if m.dayNameLabel <> invalid then m.dayNameLabel.callFunc("ft_unmount")
end sub
