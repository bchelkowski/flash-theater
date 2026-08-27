# Template attribute values: write raw `<`/`>`/`&`, never pre-escape — the compiler's own XML emitter already does it

A static (or dynamic-expression-literal) template attribute value containing `<`, `>`, or `&`
should be written with the RAW character in the `.thr` source (`text="env.<name> reads"`), never
pre-escaped by hand (`text="env.&lt;name&gt; reads"`). The compiler's own XML emitter re-escapes a
raw `<`/`>`/`&` into valid XML (`&lt;`/`&gt;`/`&amp;`) automatically when generating the final
`.xml` — that's the SAME representation a hand-pre-escaped source string produces, so both compile
without error. The difference shows up only at runtime: Roku's own XML parser un-escapes
`&lt;`/`&gt;` back into literal `<`/`>` when it reads the generated `.xml` and sets the `Label`'s
`text` field — but if the AUTHOR already wrote the literal ENTITY CODE in the `.thr` source, the
compiler re-escapes THAT text too (`&` in `&lt;` becomes `&amp;`), so the string that ends up
rendered on screen is the entity code itself (`env.&lt;name&gt; reads`), not the intended `<`/`>`
characters — silently wrong, no compile error, no diagnostic, and easy to miss in a code review
since the generated `.xml` looks perfectly valid either way.

**Confirmed live 2026-08-26** in four separate `.thr` files across three different demo apps
(`environments-demo`'s `EnvVariableReadsDemo.thr`/`OverridesAndManifestDemo.thr`,
`statements-demo`'s `SafeOperatorsDemo.thr`, `template-and-binding-demo`'s `BindDemo.thr`) — all
four had manually pre-escaped a literal `<`/`>` in a `text="..."` attribute, and all four rendered
the literal entity code on screen instead of the intended character. A raw `<`/`>` (even something
that looks tag-like, e.g. `</`) is safe to write directly in an attribute value — the DSL's
template parser resolves attribute-value boundaries by the surrounding quotes, not by scanning for
`<`/`>` inside them, so it does not get misparsed as a new tag or a closing tag.

**Fix, and the general rule**: write the raw character every time; let the compiler's own XML
emitter handle escaping for the generated file. If a real screenshot shows literal `&lt;`/`&gt;`/
`&amp;` text on a Roku screen, check the `.thr` source for a hand-written entity code in that
attribute's value — this is the one authoring mistake that produces exactly that symptom.
