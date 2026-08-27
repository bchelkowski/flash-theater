sub init()
  m.root = m.top.findNode("root")
  m.title = m.top.findNode("title")
  m["$$ft_each_1"] = m.top.findNode("ft_each_1")
  m["$$ft_each_1_keys"] = []
  m["$$ft_each_1_nodes"] = {}
  m.schedule = invalid
  m.title.text = m?.top?.prefix
  EachBasicFixture__reconcile_each_1()
end sub

sub on_prefixChange(_event as object)
  EachBasicFixture__reconcile_each_1()
  m.title.text = m?.top?.prefix
end sub

function EachBasicFixture__each_key_to_string(key as dynamic) as string
  if type(key) = "roString" or type(key) = "String" then return key
  return key.ToStr()
end function

sub EachBasicFixture__reconcile_each_1()
  ft_collection = m?.schedule
  if type(ft_collection) = "roSGNode" then
    ft_collection = ft_collection.getChildren(-1, 0)
  end if
  ft_newKeys = []
  ft_keepSet = {}
  for ft_i = 0 to ft_collection.Count() - 1
    day = ft_collection[ft_i]
    ft_key = EachBasicFixture__each_key_to_string(day?.id)
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
      m["$$ft_each_1"].removeChild(m["$$ft_each_1_nodes"][ft_oldKey])
      m["$$ft_each_1_nodes"].Delete(ft_oldKey)
    end if
  end for

  ft_newNodes = {}
  for ft_i = 0 to ft_collection.Count() - 1
    day = ft_collection[ft_i]
    ft_key = ft_newKeys[ft_i]
    if m["$$ft_each_1_nodes"].DoesExist(ft_key) then
      ft_node = m["$$ft_each_1_nodes"][ft_key]
      EachBasicFixture__update_item_each_1(ft_key, day, ft_node)
    else
      ft_node = EachBasicFixture__create_item_each_1(ft_key, day)
    end if
    m["$$ft_each_1"].insertChild(ft_node, ft_i)
    ft_newNodes[ft_key] = ft_node
  end for

  m["$$ft_each_1_keys"] = ft_newKeys
  m["$$ft_each_1_nodes"] = ft_newNodes
end sub

function EachBasicFixture__create_item_each_1(ft_key as string, day as object) as object
  ft_item = CreateObject("roSGNode", "Group")
  ft_n1 = CreateObject("roSGNode", "Label")
  ft_n1.id = "row_" + ft_key
  ft_n1.text = m?.top?.prefix + day?.title
  ft_item.appendChild(ft_n1)
  return ft_item
end function

sub EachBasicFixture__update_item_each_1(ft_key as string, day as object, ft_item as object)
  ft_u1 = ft_item.findNode("row_" + ft_key)
  ft_u1.text = m?.top?.prefix + day?.title
end sub

sub ft_unmount()
  if m.root <> invalid then m.root.callFunc("ft_unmount")
  if m.title <> invalid then m.title.callFunc("ft_unmount")
  if m["$$ft_each_1"] <> invalid then m["$$ft_each_1"].callFunc("ft_unmount")
end sub
