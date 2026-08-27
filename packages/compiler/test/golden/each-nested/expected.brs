sub init()
  m.root = m.top.findNode("root")
  m["$$ft_each_1"] = m.top.findNode("ft_each_1")
  m["$$ft_each_2_keys"] = {}
  m["$$ft_each_2_nodes"] = {}
  m["$$ft_each_1_keys"] = []
  m["$$ft_each_1_nodes"] = {}
  m.schedule = invalid
  EachNestedFixture__reconcile_each_1()
end sub

function EachNestedFixture__each_key_to_string(key as dynamic) as string
  if type(key) = "roString" or type(key) = "String" then return key
  return key.ToStr()
end function

sub EachNestedFixture__reconcile_each_1()
  ft_collection = m?.schedule
  if type(ft_collection) = "roSGNode" then
    ft_collection = ft_collection.getChildren(-1, 0)
  end if
  ft_newKeys = []
  ft_keepSet = {}
  for ft_i = 0 to ft_collection.Count() - 1
    day = ft_collection[ft_i]
    ft_key = EachNestedFixture__each_key_to_string(day?.id)
    ft_newKeys.Push(ft_key)
    ft_keepSet[ft_key] = true
  end for

  for each ft_oldKey in m["$$ft_each_1_keys"]
    if not ft_keepSet.DoesExist(ft_oldKey) then
      m["$$ft_each_1_nodes"][ft_oldKey].callFunc("ft_unmount")
      ft_unmountTarget = m["$$ft_each_1_nodes"][ft_oldKey].findNode("row_" + ft_oldKey)
      if ft_unmountTarget <> invalid then
        ft_unmountTarget.callFunc("ft_unmount")
      end if
      ft_unmountTarget = m["$$ft_each_1_nodes"][ft_oldKey].findNode("badge_" + ft_oldKey)
      if ft_unmountTarget <> invalid then
        ft_unmountTarget.callFunc("ft_unmount")
      end if
      m["$$ft_each_1"].removeChild(m["$$ft_each_1_nodes"][ft_oldKey])
      m["$$ft_each_1_nodes"].Delete(ft_oldKey)
      m["$$ft_each_2_keys"].Delete(ft_oldKey)
      m["$$ft_each_2_nodes"].Delete(ft_oldKey)
    end if
  end for

  ft_newNodes = {}
  for ft_i = 0 to ft_collection.Count() - 1
    day = ft_collection[ft_i]
    ft_key = ft_newKeys[ft_i]
    if m["$$ft_each_1_nodes"].DoesExist(ft_key) then
      ft_node = m["$$ft_each_1_nodes"][ft_key]
      EachNestedFixture__update_item_each_1(ft_key, day, ft_node)
    else
      ft_node = EachNestedFixture__create_item_each_1(ft_key, day)
    end if
    m["$$ft_each_1"].insertChild(ft_node, ft_i)
    ft_newNodes[ft_key] = ft_node
  end for

  m["$$ft_each_1_keys"] = ft_newKeys
  m["$$ft_each_1_nodes"] = ft_newNodes
end sub

function EachNestedFixture__create_item_each_1(ft_key as string, day as object) as object
  ft_item = CreateObject("roSGNode", "Group")
  ft_n1 = CreateObject("roSGNode", "Label")
  ft_n1.id = "row_" + ft_key
  ft_n1.text = day?.title
  ft_item.appendChild(ft_n1)
  if day?.isToday then
    ft_n2 = CreateObject("roSGNode", "Group")
    ft_n2.id = "ft_if_1_" + ft_key
    ft_item.appendChild(ft_n2)
    ft_n3 = CreateObject("roSGNode", "Label")
    ft_n3.id = "badge_" + ft_key
    ft_n3.text = "Today!"
    ft_n2.appendChild(ft_n3)
  end if
  ft_n4 = CreateObject("roSGNode", "Group")
  ft_n4.id = "ft_each_2_" + ft_key
  ft_item.appendChild(ft_n4)
  m["$$ft_each_2_keys"][ft_key] = []
  m["$$ft_each_2_nodes"][ft_key] = {}
  ft_coll_ft_each_2 = day?.events
  if type(ft_coll_ft_each_2) = "roSGNode" then
    ft_coll_ft_each_2 = ft_coll_ft_each_2.getChildren(-1, 0)
  end if
  ft_newKeys_ft_each_2 = []
  ft_keepSet_ft_each_2 = {}
  for ft_i_ft_each_2 = 0 to ft_coll_ft_each_2.Count() - 1
    event = ft_coll_ft_each_2[ft_i_ft_each_2]
    ft_key_ft_each_2 = EachNestedFixture__each_key_to_string(event?.id)
    ft_newKeys_ft_each_2.Push(ft_key_ft_each_2)
    ft_keepSet_ft_each_2[ft_key_ft_each_2] = true
  end for

  for each ft_oldKey_ft_each_2 in m["$$ft_each_2_keys"][ft_key]
    if not ft_keepSet_ft_each_2.DoesExist(ft_oldKey_ft_each_2) then
      m["$$ft_each_2_nodes"][ft_key][ft_oldKey_ft_each_2].callFunc("ft_unmount")
      ft_unmountTarget_ft_each_2 = m["$$ft_each_2_nodes"][ft_key][ft_oldKey_ft_each_2].findNode("eventLabel_" + ft_oldKey_ft_each_2)
      if ft_unmountTarget_ft_each_2 <> invalid then
        ft_unmountTarget_ft_each_2.callFunc("ft_unmount")
      end if
      ft_n4.removeChild(m["$$ft_each_2_nodes"][ft_key][ft_oldKey_ft_each_2])
      m["$$ft_each_2_nodes"][ft_key].Delete(ft_oldKey_ft_each_2)
    end if
  end for

  ft_newNodes_ft_each_2 = {}
  for ft_i_ft_each_2 = 0 to ft_coll_ft_each_2.Count() - 1
    event = ft_coll_ft_each_2[ft_i_ft_each_2]
    ft_key_ft_each_2 = ft_newKeys_ft_each_2[ft_i_ft_each_2]
    if m["$$ft_each_2_nodes"][ft_key].DoesExist(ft_key_ft_each_2) then
      ft_node_ft_each_2 = m["$$ft_each_2_nodes"][ft_key][ft_key_ft_each_2]
      ft_u5 = ft_node_ft_each_2.findNode("eventLabel_" + ft_key_ft_each_2)
      ft_u5.text = event?.name
    else
      ft_node_ft_each_2 = CreateObject("roSGNode", "Group")
      ft_n6 = CreateObject("roSGNode", "Label")
      ft_n6.id = "eventLabel_" + ft_key_ft_each_2
      ft_n6.text = event?.name
      ft_node_ft_each_2.appendChild(ft_n6)
    end if
    ft_n4.insertChild(ft_node_ft_each_2, ft_i_ft_each_2)
    ft_newNodes_ft_each_2[ft_key_ft_each_2] = ft_node_ft_each_2
  end for

  m["$$ft_each_2_keys"][ft_key] = ft_newKeys_ft_each_2
  m["$$ft_each_2_nodes"][ft_key] = ft_newNodes_ft_each_2
  return ft_item
end function

sub EachNestedFixture__update_item_each_1(ft_key as string, day as object, ft_item as object)
  ft_u1 = ft_item.findNode("row_" + ft_key)
  ft_u1.text = day?.title
  ft_u2 = ft_item.findNode("ft_if_1_" + ft_key)
  if day?.isToday and ft_u2 = invalid then
    ft_n3 = CreateObject("roSGNode", "Group")
    ft_n3.id = "ft_if_1_" + ft_key
    ft_item.appendChild(ft_n3)
    ft_n4 = CreateObject("roSGNode", "Label")
    ft_n4.id = "badge_" + ft_key
    ft_n4.text = "Today!"
    ft_n3.appendChild(ft_n4)
  else if not (day?.isToday) and ft_u2 <> invalid then
    ft_u2.callFunc("ft_unmount")
    ft_unmountTarget5 = ft_item.findNode("badge_" + ft_key)
    if ft_unmountTarget5 <> invalid then
      ft_unmountTarget5.callFunc("ft_unmount")
    end if
    ft_item.removeChild(ft_u2)
  else if day?.isToday then
  end if
  ft_u6 = ft_item.findNode("ft_each_2_" + ft_key)
  ft_coll_ft_each_2 = day?.events
  if type(ft_coll_ft_each_2) = "roSGNode" then
    ft_coll_ft_each_2 = ft_coll_ft_each_2.getChildren(-1, 0)
  end if
  ft_newKeys_ft_each_2 = []
  ft_keepSet_ft_each_2 = {}
  for ft_i_ft_each_2 = 0 to ft_coll_ft_each_2.Count() - 1
    event = ft_coll_ft_each_2[ft_i_ft_each_2]
    ft_key_ft_each_2 = EachNestedFixture__each_key_to_string(event?.id)
    ft_newKeys_ft_each_2.Push(ft_key_ft_each_2)
    ft_keepSet_ft_each_2[ft_key_ft_each_2] = true
  end for

  for each ft_oldKey_ft_each_2 in m["$$ft_each_2_keys"][ft_key]
    if not ft_keepSet_ft_each_2.DoesExist(ft_oldKey_ft_each_2) then
      m["$$ft_each_2_nodes"][ft_key][ft_oldKey_ft_each_2].callFunc("ft_unmount")
      ft_unmountTarget_ft_each_2 = m["$$ft_each_2_nodes"][ft_key][ft_oldKey_ft_each_2].findNode("eventLabel_" + ft_oldKey_ft_each_2)
      if ft_unmountTarget_ft_each_2 <> invalid then
        ft_unmountTarget_ft_each_2.callFunc("ft_unmount")
      end if
      ft_u6.removeChild(m["$$ft_each_2_nodes"][ft_key][ft_oldKey_ft_each_2])
      m["$$ft_each_2_nodes"][ft_key].Delete(ft_oldKey_ft_each_2)
    end if
  end for

  ft_newNodes_ft_each_2 = {}
  for ft_i_ft_each_2 = 0 to ft_coll_ft_each_2.Count() - 1
    event = ft_coll_ft_each_2[ft_i_ft_each_2]
    ft_key_ft_each_2 = ft_newKeys_ft_each_2[ft_i_ft_each_2]
    if m["$$ft_each_2_nodes"][ft_key].DoesExist(ft_key_ft_each_2) then
      ft_node_ft_each_2 = m["$$ft_each_2_nodes"][ft_key][ft_key_ft_each_2]
      ft_u7 = ft_node_ft_each_2.findNode("eventLabel_" + ft_key_ft_each_2)
      ft_u7.text = event?.name
    else
      ft_node_ft_each_2 = CreateObject("roSGNode", "Group")
      ft_n8 = CreateObject("roSGNode", "Label")
      ft_n8.id = "eventLabel_" + ft_key_ft_each_2
      ft_n8.text = event?.name
      ft_node_ft_each_2.appendChild(ft_n8)
    end if
    ft_u6.insertChild(ft_node_ft_each_2, ft_i_ft_each_2)
    ft_newNodes_ft_each_2[ft_key_ft_each_2] = ft_node_ft_each_2
  end for

  m["$$ft_each_2_keys"][ft_key] = ft_newKeys_ft_each_2
  m["$$ft_each_2_nodes"][ft_key] = ft_newNodes_ft_each_2
end sub

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
  if m["$$ft_each_1"] <> invalid then m["$$ft_each_1"].callFunc("ft_unmount")
  if m["$$ft_if_1"] <> invalid then m["$$ft_if_1"].callFunc("ft_unmount")
  if m.badge <> invalid then m.badge.callFunc("ft_unmount")
end sub
