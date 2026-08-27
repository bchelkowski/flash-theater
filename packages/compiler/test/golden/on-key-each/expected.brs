sub init()
  m.root = m.top.findNode("root")
  m["$$ft_each_1"] = m.top.findNode("ft_each_1")
  m["$$ft_each_1_keys"] = []
  m["$$ft_each_1_nodes"] = {}
  m["$$ft_each_1_items"] = {}
  OnKeyEachFixture__reconcile_each_1()
end sub

sub on_scheduleChange(_event as object)
  OnKeyEachFixture__reconcile_each_1()
end sub

function OnKeyEachFixture__each_key_to_string(key as dynamic) as string
  if type(key) = "roString" or type(key) = "String" then return key
  return key.ToStr()
end function

sub OnKeyEachFixture__reconcile_each_1()
  ft_collection = m?.top?.schedule
  if type(ft_collection) = "roSGNode" then
    ft_collection = ft_collection.getChildren(-1, 0)
  end if
  ft_newKeys = []
  ft_keepSet = {}
  for ft_i = 0 to ft_collection.Count() - 1
    item = ft_collection[ft_i]
    ft_key = OnKeyEachFixture__each_key_to_string(item?.id)
    ft_newKeys.Push(ft_key)
    ft_keepSet[ft_key] = true
  end for

  for each ft_oldKey in m["$$ft_each_1_keys"]
    if not ft_keepSet.DoesExist(ft_oldKey) then
      ft_focusTarget = m["$$ft_each_1_nodes"][ft_oldKey].findNode("row_" + ft_oldKey)
      if ft_focusTarget <> invalid then
        m.global.ft_focus.callFunc("unregister", ft_focusTarget)
      end if
      m["$$ft_each_1_nodes"][ft_oldKey].callFunc("ft_unmount")
      ft_unmountTarget = m["$$ft_each_1_nodes"][ft_oldKey].findNode("row_" + ft_oldKey)
      if ft_unmountTarget <> invalid then
        ft_unmountTarget.callFunc("ft_unmount")
      end if
      m["$$ft_each_1"].removeChild(m["$$ft_each_1_nodes"][ft_oldKey])
      m["$$ft_each_1_nodes"].Delete(ft_oldKey)
      m["$$ft_each_1_items"].Delete(ft_oldKey)
    end if
  end for

  ft_newNodes = {}
  ft_newItems = {}
  for ft_i = 0 to ft_collection.Count() - 1
    item = ft_collection[ft_i]
    ft_key = ft_newKeys[ft_i]
    if m["$$ft_each_1_nodes"].DoesExist(ft_key) then
      ft_node = m["$$ft_each_1_nodes"][ft_key]
      OnKeyEachFixture__update_item_each_1(ft_key, item, ft_node)
    else
      ft_node = OnKeyEachFixture__create_item_each_1(ft_key, item)
    end if
    m["$$ft_each_1"].insertChild(ft_node, ft_i)
    ft_newNodes[ft_key] = ft_node
    ft_newItems[ft_key] = item
  end for

  m["$$ft_each_1_keys"] = ft_newKeys
  m["$$ft_each_1_nodes"] = ft_newNodes
  m["$$ft_each_1_items"] = ft_newItems
  m.global.ft_focus.callFunc("recoverFocusFor", m.top)
end sub

function OnKeyEachFixture__create_item_each_1(ft_key as string, item as object) as object
  ft_item = CreateObject("roSGNode", "Group")
  ft_n1 = CreateObject("roSGNode", "Rectangle")
  ft_n1.id = "row_" + ft_key
  ft_n1.focusable = "true"
  m.global.ft_focus.callFunc("register", ft_n1, m.top, false)
  ft_item.appendChild(ft_n1)
  return ft_item
end function

sub OnKeyEachFixture__update_item_each_1(ft_key as string, item as object, ft_item as object)
end sub

function onKeyEvent(key as string, press as boolean) as boolean
  for each ft_focusKey in m["$$ft_each_1_nodes"]
    ft_focusItem = m["$$ft_each_1_nodes"][ft_focusKey]
    ft_focusTarget = ft_focusItem.findNode("row_" + ft_focusKey)
    if ft_focusTarget <> invalid and ft_focusTarget.IsInFocusChain() then
      item = m["$$ft_each_1_items"][ft_focusKey]
      if key = "OK" then
        private_selectItem(key, press, item)
        return true
      end if
      fallback(key, press, item)
      return true
    end if
  end for
  if key = "up" or key = "down" or key = "left" or key = "right" then
    if press then
      if m.global.ft_focus.callFunc("navigate", key) then
        m.global.ft_focus.callFunc("startRepeat", key)
        return true
      end if
    else
      m.global.ft_focus.callFunc("stopRepeat")
      return true
    end if
  end if
  return false
end function

sub private_selectItem(_key as string, _press as boolean, _item as object)

end sub

sub fallback(_key as string, _press as boolean, _item as object)

end sub

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
  if m["$$ft_each_1"] <> invalid then m["$$ft_each_1"].callFunc("ft_unmount")
end sub
