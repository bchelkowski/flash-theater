/**
 * Emits `<theme-template>`/`<theme>` as a headless SceneGraph `Node`
 * component: one `assocarray` field per top-level group (no `value=` — set
 * in `init()` instead, same precedent as `state`'s private-member init),
 * plus a public `switchTheme(name)` function. Not built on the shared
 * `emitXml`/`emitBrs` pipeline `compileThrSource` (`compile.ts`) uses for a
 * component — a theme's interface shape (assocarray group fields, a
 * per-variant literal table, a `switchTheme` dispatcher) is different enough
 * from the field/derived/state/function grammar those emitters print that
 * reusing them would mean threading theme-specific cases through code that
 * otherwise has nothing to do with themes. The store has no equivalent
 * emitter at all anymore — it's a fixed, hand-authored runtime asset (see
 * `packages/compiler/runtime-assets/Store`), never compiled from user DSL.
 */
import { ThemeShape, ThemeShapeNode } from '../analysis/global-bindings.js';
import { themeGroupVariantTableName } from './naming.js';

export const SWITCH_THEME_FUNCTION_NAME = 'switchTheme';

export interface CompiledTheme {
  componentName: string;
  xml: string;
  brs: string;
}

export function compileTheme(shape: ThemeShape, componentName: string): CompiledTheme {
  return { componentName, xml: emitThemeXml(shape, componentName), brs: emitThemeBrs(shape) };
}

function emitThemeXml(shape: ThemeShape, componentName: string): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="utf-8" ?>');
  lines.push(`<component name="${componentName}" extends="Node">`);
  lines.push('  <interface>');
  for (const groupName of shape.topLevelGroups.keys()) {
    lines.push(`    <field id="${groupName}" type="assocarray" />`);
  }
  lines.push(`    <function name="${SWITCH_THEME_FUNCTION_NAME}" />`);
  lines.push('  </interface>');
  lines.push(`  <script type="text/brightscript" uri="${componentName}.brs" />`);
  lines.push('</component>');
  lines.push('');
  return lines.join('\n');
}

function emitThemeBrs(shape: ThemeShape): string {
  const init = emitThemeInitFunction(shape);
  const switchFn = emitSwitchThemeFunction(shape);
  return [init, switchFn].join('\n\n') + '\n';
}

function emitThemeInitFunction(shape: ThemeShape): string {
  const lines = ['sub init()'];

  // One private per-(group, variant) AA-literal table, stored on `m` (see naming.ts's
  // `private_` convention — a plain `m.x` member, not part of the XML interface).
  for (const variantName of shape.variantNames) {
    const resolved = shape.resolvedVariants.get(variantName)!;
    for (const [groupName, groupNode] of shape.topLevelGroups) {
      const literal = emitGroupLiteral(groupNode, [groupName], resolved.values, '  ');
      lines.push(`  m.${themeGroupVariantTableName(groupName, variantName)} = ${literal}`);
    }
  }

  // Initial active theme — the three-tier fallback: an explicit default="name" on
  // <theme-template>, else the first-declared variant, else (no variants at all) the
  // template's own literal defaults directly.
  const initialVariantName = resolveInitialVariantName(shape);
  for (const [groupName, groupNode] of shape.topLevelGroups) {
    const literal = initialVariantName
      ? `m.${themeGroupVariantTableName(groupName, initialVariantName)}`
      : emitGroupLiteral(groupNode, [groupName], shape.templateDefaults, '  ');
    lines.push(`  m.top.${groupName} = ${literal}`);
  }
  lines.push(`  m.currentThemeName = "${initialVariantName ?? ''}"`);

  lines.push('end sub');
  return lines.join('\n');
}

/**
 * Given a runtime variant name (a string — can't be statically checked), a
 * no-op that keeps the current theme and prints a debug line for an unknown
 * name (never a crash), else re-assigns every top-level group field to that
 * variant's literal table (firing each group's `ObserveFieldScoped`
 * cascade everywhere it's consumed) and updates `m.currentThemeName`.
 */
function emitSwitchThemeFunction(shape: ThemeShape): string {
  const lines = [`function ${SWITCH_THEME_FUNCTION_NAME}(name as string) as void`];

  if (shape.variantNames.length === 0) {
    lines.push('  print "flash-theater: switchTheme() called, but this app has no theme variants — ignoring."');
    lines.push('end function');
    return lines.join('\n');
  }

  lines.push('  isKnownVariant = false');
  for (const variantName of shape.variantNames) {
    lines.push(`  if (name = "${variantName}") then`);
    lines.push('    isKnownVariant = true');
    for (const groupName of shape.topLevelGroups.keys()) {
      lines.push(`    m.top.${groupName} = m.${themeGroupVariantTableName(groupName, variantName)}`);
    }
    lines.push('  end if');
  }
  lines.push('  if (not isKnownVariant) then');
  lines.push('    print "flash-theater: switchTheme() called with an unknown theme variant name — ignoring: "; name');
  lines.push('    return');
  lines.push('  end if');
  lines.push('  m.currentThemeName = name');

  lines.push('end function');
  return lines.join('\n');
}

function resolveInitialVariantName(shape: ThemeShape): string | null {
  if (shape.defaultVariantName && shape.resolvedVariants.has(shape.defaultVariantName)) return shape.defaultVariantName;
  if (shape.variantNames.length > 0) return shape.variantNames[0];
  return null;
}

/** Recursively prints a BrightScript AA literal for one top-level group's resolved values — newline-separated fields, no trailing commas needed (BrightScript accepts either separator). */
function emitGroupLiteral(node: ThemeShapeNode, path: readonly string[], values: ReadonlyMap<string, string>, indent: string): string {
  if (node.kind === 'leaf') {
    const literal = values.get(path.join('.'));
    if (literal === undefined) throw new Error(`internal: no resolved value for theme path "${path.join('.')}"`);
    return literal;
  }

  const innerIndent = `${indent}  `;
  const lines = ['{'];
  for (const [childName, childNode] of node.children) {
    lines.push(`${innerIndent}${childName}: ${emitGroupLiteral(childNode, [...path, childName], values, innerIndent)}`);
  }
  lines.push(`${indent}}`);
  return lines.join('\n');
}
