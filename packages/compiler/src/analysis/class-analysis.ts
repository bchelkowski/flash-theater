import { ConstructorFieldInit } from 'flash-parser';
import { CompileError, ThrClassAst } from '../dsl-parser/dsl-ast.js';
import { ClassShape } from './class-shape.js';

/**
 * A field/method name must be unique within a class — including a field
 * declared entirely inside the constructor (`private a: string = a`, no
 * top-level `ClassFieldDeclaration` at all, see `class-shape.ts`'s own note
 * on this) — and a field can never collide with an inherited member either:
 * a field has no `override` syntax at all (only constructors/methods do),
 * so any name collision with a base member is unconditionally an error,
 * never something a field could legitimately intend. Mirrors
 * `binding-collisions.ts`'s role for `.thr`.
 */
export function checkDuplicateClassMemberNames(classAst: ThrClassAst, baseShape: ClassShape | null): void {
  const seen = new Map<string, 'field' | 'method'>();
  const fieldNames: string[] = [];

  for (const f of classAst.fields) {
    const prior = seen.get(f.name);
    if (prior) throwDuplicate(classAst.name, f.name, prior, 'field');
    seen.set(f.name, 'field');
    fieldNames.push(f.name);
  }
  for (const f of classAst.streamFields) {
    const prior = seen.get(f.name);
    if (prior) throwDuplicate(classAst.name, f.name, prior, 'field');
    seen.set(f.name, 'field');
    fieldNames.push(f.name);
  }
  for (const s of classAst.constructorDecl?.body.statements ?? []) {
    if (!(s instanceof ConstructorFieldInit)) continue;
    const prior = seen.get(s.name);
    if (prior) throwDuplicate(classAst.name, s.name, prior, 'field');
    seen.set(s.name, 'field');
    fieldNames.push(s.name);
  }
  for (const m of classAst.methods) {
    const prior = seen.get(m.name);
    if (prior) throwDuplicate(classAst.name, m.name, prior, 'method');
    seen.set(m.name, 'method');
  }

  // Only fields are checked against the base shape here — a method sharing a base member's name is
  // exactly what `override` means, validated separately (and correctly) by `checkOverrideCoherence`.
  if (!baseShape) return;
  for (const name of fieldNames) {
    if (baseShape.allMembers.has(name)) {
      throw new CompileError({
        code: 'class/duplicate-member-name',
        message: `Field "${name}" in class "${classAst.name}" collides with a member of the same name in base class "${baseShape.className}" — a field can never override a base member (there is no "override" syntax for fields).`,
      });
    }
  }
}

function throwDuplicate(className: string, name: string, firstKind: 'field' | 'method', secondKind: 'field' | 'method'): never {
  throw new CompileError({
    code: 'class/duplicate-member-name',
    message: `Class "${className}" declares "${name}" more than once (as a ${firstKind} and a ${secondKind}) — a field/method name must be unique within a class.`,
  });
}

/**
 * TypeScript-`override`-style checking: `override` on a method requires a
 * matching base member of the same name to exist; conversely, a method that
 * redeclares a base member's name without `override` is also an error — an
 * unmarked shadow is far more likely a missing keyword than an intentional
 * new, unrelated member that just happens to share a name. Only methods are
 * checked here — a class's own constructor's override-ness is validated
 * structurally by flash-parser at parse time (`dsl/missing-override-constructor`
 * et al., see GRAMMAR.md), since that check needs no cross-file base-class
 * knowledge (only "does this class have `extends` at all").
 */
export function checkOverrideCoherence(classAst: ThrClassAst, baseShape: ClassShape | null): void {
  for (const m of classAst.methods) {
    const baseMember = baseShape?.allMembers.get(m.name);

    if (m.isOverride && !baseMember) {
      throw new CompileError({
        code: 'class/override-no-matching-member',
        message: `Method "${m.name}" in class "${classAst.name}" is marked "override" but no base class member of that name exists${baseShape ? ` on "${baseShape.className}"` : ''}.`,
      });
    }

    if (!m.isOverride && baseMember) {
      throw new CompileError({
        code: 'class/missing-override',
        message: `Method "${m.name}" in class "${classAst.name}" redeclares a member of the same name already declared on base class "${baseShape!.className}" — add "override" if that's intentional.`,
      });
    }
  }
}
