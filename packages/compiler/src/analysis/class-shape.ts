import { ConstructorFieldInit } from 'flash-parser';
import { ClassVisibility, ThrClassAst } from '../dsl-parser/dsl-ast.js';

export interface ClassMemberInfo {
  readonly name: string;
  readonly kind: 'field' | 'method';
  readonly visibility: ClassVisibility;
  /** `kind === 'method'`'s own declared return type (`ClassMethodDecl.returnType`) — `null` for a method with no return-type clause (compiles to a BrightScript `sub`, has no value) and always `null` for `kind === 'field'` (a field's value type isn't declared anywhere in this DSL). Consulted by `analysis/derived-type-check.ts` to resolve a `derived` expression's `ClassName(...).methodName(...)` call to this method's own return type. */
  readonly returnType: string | null;
}

/**
 * A class's member table — mirrors `ThemeShape`'s role for theme
 * validation. `ownMembers` is this class's own fields/methods only;
 * `allMembers` is `ownMembers` layered on top of the base class's own
 * `allMembers` (walked once, at `buildClassShape` time, not re-walked per
 * lookup) — an own member always wins over an inherited one of the same
 * name, which is exactly what `override` means. The constructor is
 * deliberately NOT a member here: it's never accessed via `m.<name>` in
 * generated code (see `codegen/class-emitter.ts`), so it plays no part in
 * the `m.<name>` → `m.private_<name>`/`self.<name>` resolution this shape
 * exists for.
 */
export interface ClassShape {
  readonly className: string;
  readonly baseName: string | null;
  readonly ownMembers: ReadonlyMap<string, ClassMemberInfo>;
  readonly allMembers: ReadonlyMap<string, ClassMemberInfo>;
}

/** A field member's `returnType` is always `null` (a field's value type isn't declared anywhere in this DSL — see `ClassMemberInfo.returnType`'s own doc comment) — shared by every one of `buildClassShape`'s three field-collecting loops below instead of repeating the literal. */
function fieldMember(name: string, visibility: ClassVisibility): ClassMemberInfo {
  return { name, kind: 'field', visibility, returnType: null };
}

export function buildClassShape(classAst: ThrClassAst, baseShape: ClassShape | null): ClassShape {
  const ownMembers = new Map<string, ClassMemberInfo>();
  for (const f of classAst.fields) ownMembers.set(f.name, fieldMember(f.name, f.visibility));
  // A stream field resolves for `m.<name>` purposes exactly like an ordinary field — `kind: 'field'`
  // is correct here, no new `ClassMemberInfo` kind needed (see ClassStreamFieldDecl's own doc comment
  // in dsl-ast.ts for why it's a separate array from `.fields` despite resolving identically here).
  for (const s of classAst.streamFields) ownMembers.set(s.name, fieldMember(s.name, s.visibility));
  // A field can also be declared entirely inside the constructor — `private a: string = a` with no
  // matching top-level `ClassFieldDeclaration` at all (the worked example in GRAMMAR.md's "class
  // declarations" section does exactly this for constructor-parameter-assigned fields). Both forms
  // declare a real instance field; `m.<name>` resolution must see either one.
  for (const s of classAst.constructorDecl?.body.statements ?? []) {
    if (s instanceof ConstructorFieldInit) ownMembers.set(s.name, fieldMember(s.name, s.visibility));
  }
  for (const m of classAst.methods) ownMembers.set(m.name, { name: m.name, kind: 'method', visibility: m.visibility, returnType: m.returnType });

  const allMembers = new Map<string, ClassMemberInfo>(baseShape ? baseShape.allMembers : []);
  for (const [name, info] of ownMembers) allMembers.set(name, info);

  return { className: classAst.name, baseName: classAst.baseName, ownMembers, allMembers };
}
