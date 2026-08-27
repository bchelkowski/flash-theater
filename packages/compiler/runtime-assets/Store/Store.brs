' flash-theater:runtime — hand-authored, not generated from a .thr file. Auto-copied by the CLI
' into an app's output whenever any component uses the store (see cli.ts). Do not edit per-app;
' change this file in packages/compiler/runtime-assets/Store instead.

sub init()
end sub

' Adds/updates a top-level store key, exactly like an ordinary SceneGraph field. This is the only
' way a value is ever written into the store; reads are plain field access (m.global.ft_store.<key>),
' which is what makes the reactivity free: an ObserveField/ObserveFieldScoped on this node fires
' whenever a key is reassigned here, exactly like any other SceneGraph field.
'
' AddFields() only ADDS a field that doesn't exist yet — per Roku's own ifSGNodeField docs, "If the
' field already exists, no change occurs," confirmed live on a real device (a second `store(x) = ...`
' write silently no-op'd, verified by printing m.top[key] immediately after the AddFields call).
' SetField() updates an existing field's value (and still fires observers) but does not create a
' new one, so a hasField() branch is required either way.
sub set(key as string, value as dynamic)
  if m.top.hasField(key)
    m.top.setField(key, value)
  else
    fields = {}
    fields[key] = value
    m.top.addFields(fields)
  end if
end sub
