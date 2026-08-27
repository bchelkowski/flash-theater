import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import { compileThrSource, CompiledThrFile } from '../../src/compile.js';
import { validateGeneratedBrs } from '../../src/validate-generated-brs.js';
import { CompileError } from '../../src/dsl-parser/dsl-ast.js';

function compileFixture(fixtureDir: string, componentName: string): CompiledThrFile {
  const path = fileURLToPath(new URL(`${fixtureDir}/input.thr`, import.meta.url));
  const source = readFileSync(path, 'utf8');
  return compileThrSource(source, componentName);
}

function readExpected(fixtureDir: string, fileName: string): string {
  const path = fileURLToPath(new URL(`${fixtureDir}/${fileName}`, import.meta.url));
  return readFileSync(path, 'utf8');
}

describe('codegen golden files', () => {
  describe('schedule-date-menu-item (ScheduleDateMenuItem)', () => {
    const fixtureDir = '../golden/schedule-date-menu-item';
    const actual = compileFixture(fixtureDir, 'ScheduleDateMenuItem');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('visibility-fixture (private/public visibility → private_-prefix)', () => {
    const fixtureDir = '../golden/visibility-fixture';
    const actual = compileFixture(fixtureDir, 'VisibilityFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('prefixes only the private function, leaving the public one unchanged', () => {
      expect(actual.brs).to.include('function formatStatus(');
      expect(actual.brs).to.include('function private_describePrivate(');
      expect(actual.brs).to.not.include('function describePrivate(');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('optional-chaining-basic (?./?[/?( inserted into generated .brs — assignment targets, bare void-context call statements, and bare-identifier callees all stay plain)', () => {
    const fixtureDir = '../golden/optional-chaining-basic';
    const actual = compileFixture(fixtureDir, 'OptionalChainingBasic');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('chains a multi-hop derived read and its single-hop template binding', () => {
      expect(actual.brs).to.include('m.displayName = m?.top?.profile?.user?.name');
      expect(actual.brs).to.include('m.out.text = m?.displayName');
    });

    it('leaves a bare void-context call statement fully untouched, but still chains its own call argument', () => {
      expect(actual.brs).to.include('m.top.cache.tracker.recordVisit()');
      expect(actual.brs).to.include('private_logEvent(m?.top?.cache?.tracker?.summarize?())');
    });

    it('leaves a multi-hop assignment target fully untouched', () => {
      expect(actual.brs).to.include('m.top.cache.counters.total = 0');
    });

    it('leaves a bare-identifier callee unwrapped even in a genuine read context (a derived RHS, not a void statement) — Roku rejects `?(` on a plain global function name', () => {
      expect(actual.brs).to.include('m.summaryLabel = private_describeCache(m?.top?.cache)');
      // ...but a call whose OWN callee is itself a chain, inside that bare call, still gets `?(`.
      expect(actual.brs).to.include('return "cache: " + cacheNode?.tracker?.summarize?()');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('function-body-identifier-rewrite (field/derived references inside a function body)', () => {
    const fixtureDir = '../golden/function-body-identifier-rewrite';
    const actual = compileFixture(fixtureDir, 'FunctionBodyRewriteFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('rewrites a field inside an if-condition and a derived inside a return statement', () => {
      expect(actual.brs).to.include('if (m?.top?.enabled) then');
      expect(actual.brs).to.include('str(m?.doubled)');
    });

    it('leaves a parameter that shadows a field name unrewritten', () => {
      expect(actual.brs).to.include('function echoScore(score as integer) as integer\n  return score\nend function');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('else-if-chain (if / else if / else)', () => {
    const fixtureDir = '../golden/else-if-chain';
    const actual = compileFixture(fixtureDir, 'ElseIfChainFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('flattens a block-form else-if chain into one else-if/end-if, not nested end-ifs', () => {
      expect(actual.brs).to.include(
        'if (ft_relationalGuard(value, 90, ">=")) then\n    return "A"\n  else if (ft_relationalGuard(value, 80, ">=")) then\n    return "B"\n  else\n    return "C"\n  end if',
      );
    });

    it('flattens a fully inline else-if chain into the same canonical block form', () => {
      expect(actual.brs).to.include(
        'if (ft_relationalGuard(value, 0, ">")) then\n    return 1\n  else if (ft_relationalGuard(value, 0, "<")) then\n    return -1\n  else\n    return 0\n  end if',
      );
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('state-reactive (state declaration, read, write, and its reactive cascade)', () => {
    const fixtureDir = '../golden/state-reactive';
    const actual = compileFixture(fixtureDir, 'StateFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('never emits a <field> or onChange for state — it stays a private m.x member', () => {
      expect(actual.xml).to.not.include('count');
      expect(actual.brs).to.not.include('on_countChange');
    });

    it('initializes state in init() directly, since there is no XML value= for it', () => {
      expect(actual.brs).to.include('m.count = 0');
    });

    it('inlines the reactive cascade at the state write site, not in a generated sub', () => {
      expect(actual.brs).to.include(
        'if (m?.top?.enabled) then\n    m.count = m?.count + 1\n    m.label = private_describe(m?.count)\n    m.out.text = m?.label\n  end if',
      );
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('watch-function-body-only (a watch/derived pair consumed only from a plain function body, never a template expression, still gets its ObserveFieldScoped cascade wired)', () => {
    // Regression test for a bug found live: sourcesNeedingCascade in template-bindings.ts used to
    // union only the template-derived binding maps (affectedBySource/affectedBySourceBlocks/
    // affectedByEachSourceBlocks), never graph.dependentsOfSource — so a watch whose only consumer
    // was a plain function (not the template) never got observeFieldScoped registered, and its
    // dependent derived() silently went stale after the first store write. See
    // findings/reactivity-state.md.
    const fixtureDir = '../golden/watch-function-body-only';
    const actual = compileFixture(fixtureDir, 'WatchFunctionBodyOnlyFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('registers ObserveFieldScoped on the store field even though it is never read from the template', () => {
      expect(actual.brs).to.include('m.global.ft_store.observeFieldScoped("count", "on_store_countChange")');
    });

    it('recomputes the dependent derived() inside the change handler, not just at init', () => {
      expect(actual.brs).to.include('sub on_store_countChange(_event as object)\n  m.count = m.global.ft_store.count\n  m.doubled = m?.count * 2\nend sub');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('stream-basic (a declared stream, emit from one function, subscribe with an anonymous-function callback from another)', () => {
    const fixtureDir = '../golden/stream-basic';
    const actual = compileFixture(fixtureDir, 'StreamBasic');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('never emits a <field> for the stream — it stays a private m.x member, exactly like derived/state', () => {
      expect(actual.xml).to.not.include('dataLoaded');
    });

    it('initializes the stream via ft_createStream() in init()', () => {
      expect(actual.brs).to.include('m.dataLoaded = ft_createStream()');
    });

    it('emits .emit(...) as an ordinary passthrough call, no special rewriting', () => {
      expect(actual.brs).to.include('m.dataLoaded.emit("payload-ready")');
    });

    it('hoists the .subscribe(...) callback to a ft_anon_N temp var via the existing Tier-2 anonymous-function mechanism', () => {
      expect(actual.brs).to.include('ft_anon_1 = sub(value as string)');
      expect(actual.brs).to.include('m.dataLoaded.subscribe(ft_anon_1)');
    });

    it('sets usesStreamHelper', () => {
      expect(actual.usesStreamHelper).to.be.true;
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('void-sub-fixture (no return-type clause compiles to sub, a declared return type stays function)', () => {
    const fixtureDir = '../golden/void-sub-fixture';
    const actual = compileFixture(fixtureDir, 'VoidSubFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('emits a sub (no "as" clause) for the function with no return-type annotation', () => {
      expect(actual.brs).to.include('sub logStatus(value as boolean)');
      expect(actual.brs).to.include('end sub');
      expect(actual.brs).to.not.include('function logStatus');
    });

    it('still emits function ... as <Type> for the function with a return-type annotation', () => {
      expect(actual.brs).to.include('function describeStatus(value as boolean) as string');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('unused-args-locals (unused parameter gets "_"-prefixed, unused pure local is elided)', () => {
    const fixtureDir = '../golden/unused-args-locals';
    const actual = compileFixture(fixtureDir, 'UnusedArgsLocalsFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('prefixes the unused parameter with "_", leaving the used one alone', () => {
      expect(actual.brs).to.include('function private_describe(value as integer, _unusedFlag as boolean) as string');
    });

    it('elides the unused pure local entirely, keeping the used one', () => {
      expect(actual.brs).to.not.include('unusedTotal');
      expect(actual.brs).to.include('formatted = "count: " + str(value)');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('conditional-toggle ({#if} compiles to an always-present synthetic Group with a visible binding)', () => {
    const fixtureDir = '../golden/conditional-toggle';
    const actual = compileFixture(fixtureDir, 'ConditionalToggleFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('conditional-destroy ({#if:destroy} hand-constructs/tears down its subtree at runtime)', () => {
    const fixtureDir = '../golden/conditional-destroy';
    const actual = compileFixture(fixtureDir, 'ConditionalDestroyFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('conditional-destroy-siblings (runtime sibling-insertion-index for a middle destroy-mode block)', () => {
    const fixtureDir = '../golden/conditional-destroy-siblings';
    const actual = compileFixture(fixtureDir, 'ConditionalDestroySiblingsFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('computes a runtime insertion index of 1, landing the block between its two always-present siblings', () => {
      // Inserts into m.root (the block's real container — its template parent), not m.top; root
      // itself is never counted in this index since precedingSiblings only tracks root's *other*
      // children, and root is the insertion target here, not an implicit extra sibling of itself.
      expect(actual.brs).to.include('ft_idx = 0\n  ft_idx = ft_idx + 1\n  m.root.insertChild(m["$$ft_if_1"], ft_idx)');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('each-basic ({#each} compiles to an always-present wrapper Group, reconciled by a keyed add/remove/reposition diff)', () => {
    const fixtureDir = '../golden/each-basic';
    const actual = compileFixture(fixtureDir, 'EachBasicFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('never statically renders the item body — the wrapper Group is self-closing in the XML', () => {
      expect(actual.xml).to.include('<Group id="ft_each_1" />');
      expect(actual.xml).to.not.include('day.title');
    });

    it('registers the collection source AND a component-wide field referenced only inside the item body, both triggering the same reconcile sub', () => {
      expect(actual.brs).to.include('sub on_prefixChange(_event as object)\n  EachBasicFixture__reconcile_each_1()\n  m.title.text = m?.top?.prefix\nend sub');
    });

    it('cascades ft_unmount to a removed item — direct call on the item root, then a guarded findNode cascade to the root\'s own id, both before removeChild', () => {
      expect(actual.brs).to.include(
        [
          '      m["$$ft_each_1_nodes"][ft_oldKey].callFunc("ft_unmount")',
          '      ft_unmountTarget = m["$$ft_each_1_nodes"][ft_oldKey].findNode("row_" + ft_oldKey)',
          '      if ft_unmountTarget <> invalid then',
          '        ft_unmountTarget.callFunc("ft_unmount")',
          '      end if',
          '      m["$$ft_each_1"].removeChild(m["$$ft_each_1_nodes"][ft_oldKey])',
        ].join('\n'),
      );
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('each-in-destroy-if ({#each} nested inside {#if:destroy} — the "reverse" nesting direction)', () => {
    const fixtureDir = '../golden/each-in-destroy-if';
    const actual = compileFixture(fixtureDir, 'EachInDestroyIfFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('never statically renders the each wrapper — it does not exist until the destroy-mode ancestor mounts', () => {
      expect(actual.xml).to.not.include('ft_each_1');
      expect(actual.xml).to.equal('<?xml version="1.0" encoding="utf-8" ?>\n<component name="EachInDestroyIfFixture" extends="Group">\n  <interface>\n    <field id="hasLoaded" type="boolean" value="false" onChange="on_hasLoadedChange" />\n    <field id="ft_routeReady" type="boolean" value="false" />\n    <function name="ft_unmount" />\n  </interface>\n  <children>\n    <Rectangle id="root" />\n  </children>\n  <script type="text/brightscript" uri="EachInDestroyIfFixture.brs" />\n</component>\n');
    });

    it('constructs the each wrapper, initializes its keys/nodes state, and reconciles it once, inside the ancestor\'s create sub', () => {
      expect(actual.brs).to.include(
        [
          'sub EachInDestroyIfFixture__create_if_1()',
          '  m["$$ft_if_1"] = CreateObject("roSGNode", "Group")',
          '  m["$$ft_each_1"] = CreateObject("roSGNode", "Group")',
          '  m["$$ft_if_1"].appendChild(m["$$ft_each_1"])',
          '  m["$$ft_each_1_keys"] = []',
          '  m["$$ft_each_1_nodes"] = {}',
          '  EachInDestroyIfFixture__reconcile_each_1()',
        ].join('\n'),
      );
    });

    it('nulls the each wrapper and its keys/nodes state on teardown', () => {
      expect(actual.brs).to.include('m["$$ft_each_1"] = invalid\n    m["$$ft_each_1_keys"] = invalid\n    m["$$ft_each_1_nodes"] = invalid');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('each-nested (a nested {#if:destroy} AND a nested {#each} inside the same {#each} body — the "forward" nesting direction)', () => {
    const fixtureDir = '../golden/each-nested';
    const actual = compileFixture(fixtureDir, 'EachNestedFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('assigns the nested each a globally-unique id, distinct from its enclosing each', () => {
      expect(actual.brs).to.include('.id = "ft_each_2_" + ft_key');
      // The nested each's own _keys/_nodes dict is keyed under its *own* id (ft_each_2) at
      // m-scope, distinct from its enclosing each's own dict (ft_each_1) — never reusing the
      // enclosing each's id for itself (the bug this fixture guards against: an earlier version
      // of the analysis restarted its id counter per-subtree, so a nested each ended up sharing
      // its enclosing each's own id).
      expect(actual.brs).to.include('m["$$ft_each_2_keys"]');
      expect(actual.brs).to.include('m["$$ft_each_1_keys"]');
    });

    it('never caches per-item state in any field — no compound nested state, no per-node AddFields ref; both the nested if:destroy and the nested each are re-resolved via findNode against their own unique, key-suffixed id', () => {
      expect(actual.brs).to.not.include('ft_state');
      expect(actual.brs).to.not.include('AddFields');
      // Both the nested if:destroy's mount check and the nested each's wrapper lookup resolve via
      // findNode against a unique id (the compile-time-known literal suffixed with the item's own
      // reconcile key) — nothing is ever cached in a field, so there's no stale-reference class of
      // bug to worry about (see each-block-emitter.ts's class doc comment).
      expect(actual.brs).to.match(/ft_item\.findNode\("ft_if_1_" \+ ft_key\)/);
      expect(actual.brs).to.match(/ft_item\.findNode\("ft_each_2_" \+ ft_key\)/);
    });

    it('cascades ft_unmount to a whole removed outer item, to a nested if:destroy block torn down while its item survives, and to a nested each\'s own removed items', () => {
      // Outer item removal (reconcile loop): direct call on the item root, then findNode-based
      // cascade to both the nested if:destroy's own badge and the nested each's own wrapper id.
      expect(actual.brs).to.include('m["$$ft_each_1_nodes"][ft_oldKey].callFunc("ft_unmount")');
      expect(actual.brs).to.include('m["$$ft_each_1_nodes"][ft_oldKey].findNode("badge_" + ft_oldKey)');
      // Nested if:destroy transitioning true->false while its OWN item survives (update-item sub):
      // direct call on the found wrapper, then a findNode-based cascade to its own badge child —
      // resolved via the overall item root (ft_item), not the found wrapper itself.
      expect(actual.brs).to.include('ft_u2.callFunc("ft_unmount")');
      expect(actual.brs).to.match(/ft_item\.findNode\("badge_" \+ ft_key\)/);
      // The nested each's own item removal (both inside create_item's first-ever reconcile AND
      // update_item's later ones) gets the identical direct-call-then-cascade treatment, scoped
      // with its own blockId suffix so it never collides with the outer each's temp names.
      expect(actual.brs).to.include('m["$$ft_each_2_nodes"][ft_key][ft_oldKey_ft_each_2].callFunc("ft_unmount")');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('each-node-collection ({#each} over a SceneGraph node — iterates its children via getChildren, not array indexing)', () => {
    const fixtureDir = '../golden/each-node-collection';
    const actual = compileFixture(fixtureDir, 'EachNodeCollectionFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('converts the collection to its children array only when it is a node at runtime, leaving a plain array collection untouched', () => {
      expect(actual.brs).to.include('ft_collection = m?.top?.container');
      // top-level each wrapper cache/bookkeeping is compiler-owned, $$-bracket-accessed.
      expect(actual.brs).to.include('m["$$ft_each_1"] = m.top.findNode("ft_each_1")');
      expect(actual.brs).to.include('if type(ft_collection) = "roSGNode" then\n    ft_collection = ft_collection.getChildren(-1, 0)\n  end if');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('bind-basic (bind: on a statically-present element — one-directional child-to-state)', () => {
    const fixtureDir = '../golden/bind-basic';
    const actual = compileFixture(fixtureDir, 'BindBasicFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('registers ObserveFieldScoped on the bound child field in init(), not a push into it', () => {
      expect(actual.brs).to.include('m.input.ObserveFieldScoped("text", "on_bind_input_textChange")');
      expect(actual.brs).to.not.include('m.input.text =');
    });

    it('the reverse handler writes state from event.GetData() and runs the ordinary cascade, no equality guard', () => {
      expect(actual.brs).to.include('sub on_bind_input_textChange(event as object)\n  m.inputValue = event.GetData()\n  m.echo.text = m?.inputValue\nend sub');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('bind-in-destroy (bind: nested inside {#if:destroy} — observe on create, guarded unobserve on destroy)', () => {
    const fixtureDir = '../golden/bind-in-destroy';
    const actual = compileFixture(fixtureDir, 'BindInDestroyFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('registers ObserveFieldScoped inline inside the generated create sub, not in init()', () => {
      const initSection = actual.brs.split('\n\n')[0];
      expect(initSection).to.not.include('ObserveFieldScoped');
      expect(actual.brs).to.include('sub BindInDestroyFixture__create_if_1()');
      expect(actual.brs).to.include('m.input.ObserveFieldScoped("text", "on_bind_input_textChange")');
    });

    it('individually guards UnobserveField in the generated destroy sub', () => {
      expect(actual.brs).to.include('if m.input <> invalid then\n      m.input.UnobserveFieldScoped("text")\n    end if');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('on-key-basic (on:key[...] deepest-first priority chain, specific-then-wildcard, key/press injection)', () => {
    const fixtureDir = '../golden/on-key-basic';
    const actual = compileFixture(fixtureDir, 'OnKeyBasicFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('never emits on:key into the XML — it is entirely .brs-side', () => {
      expect(actual.xml).to.not.include('on:key');
    });

    it('checks the descendant "card" before the ancestor "root" — deepest-first bubbling simulation', () => {
      const cardIndex = actual.brs.indexOf('if m.card <> invalid');
      const rootIndex = actual.brs.indexOf('if m.root <> invalid');
      expect(cardIndex).to.be.greaterThan(-1);
      expect(rootIndex).to.be.greaterThan(-1);
      expect(cardIndex).to.be.lessThan(rootIndex);
    });

    it('tries every specific key before falling through to that element\'s own wildcard', () => {
      expect(actual.brs).to.include(
        ['    if key = "OK" then', '      private_selectItem(key, press)', '      return true', '    end if'].join('\n'),
      );
      expect(actual.brs).to.include(
        ['    if key = "play" then', '      private_selectItem(key, press)', '      return true', '    end if', '    fallback(key, press)', '    return true'].join('\n'),
      );
    });

    it('falls through to false when nothing in this component handled the key, letting real Roku bubbling continue to a parent custom component', () => {
      expect(actual.brs.trim().endsWith('return false\nend function')).to.be.false; // more subs follow onKeyEvent in this fixture
      expect(actual.brs).to.include('  end if\n  return false\nend function');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('ternary-basic (cond ? a : b — chained, nested, and embedded-in-a-larger-expression, both assignment and state-write hosts)', () => {
    const fixtureDir = '../golden/ternary-basic';
    const actual = compileFixture(fixtureDir, 'TernaryBasicFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('lowers a plain-assignment ternary chain into hoisted temp-var + if/else blocks, innermost first', () => {
      expect(actual.brs).to.include(
        [
          '    ft_ternary_1 = Invalid',
          '    if (ft_relationalGuard(count, 0, ">")) then',
          '      ft_ternary_1 = "small"',
          '    else',
          '      ft_ternary_1 = "none"',
          '    end if',
          '    ft_ternary_2 = Invalid',
          '    if (ft_relationalGuard(count, 10, ">")) then',
          '      ft_ternary_2 = "big"',
          '    else',
          '      ft_ternary_2 = ft_ternary_1',
          '    end if',
          '    label = ft_ternary_2',
        ].join('\n'),
      );
    });

    it('matches the worked example line-for-line: a ternary nested in the true branch, parenthesized', () => {
      expect(actual.brs).to.include(
        [
          '  ft_ternary_1 = Invalid',
          '  if (cond2) then',
          '    ft_ternary_1 = a',
          '  else',
          '    ft_ternary_1 = b',
          '  end if',
          '  ft_ternary_2 = Invalid',
          '  if (cond1) then',
          '    ft_ternary_2 = (ft_ternary_1)', // parens preserved verbatim from the source's own "(cond2 ? a : b)"
          '  else',
          '    ft_ternary_2 = c',
          '  end if',
          '  value = ft_ternary_2',
        ].join('\n'),
      );
    });

    it('embeds a hoisted ternary temp var back into a larger surrounding expression, with no stray whitespace', () => {
      expect(actual.brs).to.include('  value = 1 + (ft_ternary_1)');
    });

    it('lowers a ternary-bearing state write with the same hoisting, followed by the ordinary state cascade', () => {
      expect(actual.brs).to.include(
        ['sub updateResult(cond as boolean)', '  ft_ternary_1 = Invalid', '  if (cond) then', '    ft_ternary_1 = 1', '  else', '    ft_ternary_1 = 2', '  end if', '  m.result = ft_ternary_1', 'end sub'].join('\n'),
      );
    });

    it('resets the temp-var counter per function — every function starts again at ft_ternary_1', () => {
      const occurrences = actual.brs.match(/ft_ternary_1 = Invalid/g) ?? [];
      expect(occurrences).to.have.lengthOf(4); // bump, computeNested, computeEmbedded, updateResult
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('env-basic (env.<name> — reads a declared environment variable, baked as a literal AA field)', () => {
    const fixtureDir = '../golden/env-basic';
    const source = readFileSync(fileURLToPath(new URL(`${fixtureDir}/input.thr`, import.meta.url)), 'utf8');
    const actual = compileThrSource(source, 'EnvBasicFixture', { globalBindings: { theme: null, envVariableNames: new Set(['apiBaseUrl']) } });

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('splices only the "env" root, leaving the ".apiBaseUrl" member text from the source untouched', () => {
      expect(actual.brs).to.include('m.apiBaseUrlLabel = "API: " + m?.global?.ft_env?.apiBaseUrl');
    });

    it('sets usesEnv', () => {
      expect(actual.usesEnv).to.equal(true);
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('focus-call (focus(<expr>) DSL sugar inside an on:key handler)', () => {
    const fixtureDir = '../golden/focus-call';
    const actual = compileFixture(fixtureDir, 'FocusCallFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('compiles focus("otherComponent") to a ft_-prefixed focusComponent callFunc, the id wrapped in m.top.findNode — scoped to this component\'s own subtree, never the whole scene', () => {
      expect(actual.brs).to.include('m.global.ft_focus.callFunc("focusComponent", m.top.findNode("otherComponent"))');
    });

    it('sets usesFocusSystem even though the call itself contributes no XML', () => {
      expect(actual.usesFocusSystem).to.be.true;
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('on-key-each (on:key[...] + focusable inside {#each} — per-row handlers, the _items companion dict)', () => {
    const fixtureDir = '../golden/on-key-each';
    const actual = compileFixture(fixtureDir, 'OnKeyEachFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('maintains an _items companion dict in lock-step with _keys/_nodes', () => {
      expect(actual.brs).to.include('m["$$ft_each_1_items"] = {}');
      expect(actual.brs).to.include('ft_newItems[ft_key] = item');
      expect(actual.brs).to.include('m["$$ft_each_1_items"] = ft_newItems');
      expect(actual.brs).to.include('m["$$ft_each_1_items"].Delete(ft_oldKey)');
    });

    it('registers a per-item focusable row at construction and unregisters it before removal', () => {
      expect(actual.brs).to.include('m.global.ft_focus.callFunc("register", ft_n1, m.top, false)');
      expect(actual.brs).to.include(
        'ft_focusTarget = m["$$ft_each_1_nodes"][ft_oldKey].findNode("row_" + ft_oldKey)\n      if ft_focusTarget <> invalid then\n        m.global.ft_focus.callFunc("unregister", ft_focusTarget)',
      );
    });

    it('does NOT try to findNode/register a static m.row slot in init() — an each-item element has none', () => {
      const initSection = actual.brs.split('\n\n')[0];
      expect(initSection).to.not.include('m.row');
    });

    it('resolves the focused row via findNode + IsInFocusChain, recovers the item from _items, and dispatches specific-then-wildcard', () => {
      expect(actual.brs).to.include('for each ft_focusKey in m["$$ft_each_1_nodes"]');
      expect(actual.brs).to.include('ft_focusTarget = ft_focusItem.findNode("row_" + ft_focusKey)');
      expect(actual.brs).to.include('item = m["$$ft_each_1_items"][ft_focusKey]');
      expect(actual.brs).to.include('if key = "OK" then\n        private_selectItem(key, press, item)\n        return true\n      end if\n      fallback(key, press, item)\n      return true');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('control-flow-basic (for / for each / while / try-catch)', () => {
    const fixtureDir = '../golden/control-flow-basic';
    const actual = compileFixture(fixtureDir, 'ControlFlowBasicFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('prints a numeric for with an optional step, rewriting a field reference in its header', () => {
      expect(actual.brs).to.include('for i = 0 to m?.top?.limit step 1\n    result = result + i\n  end for');
    });

    it('prints a for each with the item variable left unrewritten', () => {
      expect(actual.brs).to.include('for each name in names\n    joined = joined + name + ","\n  end for');
    });

    it('prints a while loop', () => {
      expect(actual.brs).to.include('while ft_relationalGuard(i, 0, ">")\n    print i\n    i = i - 1\n  end while');
    });

    it('prints a try/catch with the caught variable left unrewritten', () => {
      expect(actual.brs).to.include('try\n    result = a / b\n  catch e\n    result = e?.number\n  end try');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('control-flow-nesting (regression: a DSL if nested inside a bracketed for, a bracketed for nested inside a bracketed while)', () => {
    const fixtureDir = '../golden/control-flow-nesting';
    const actual = compileFixture(fixtureDir, 'ControlFlowNestingFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('nests a DSL if correctly inside a for loop body, with the loop\'s own end for intact', () => {
      expect(actual.brs).to.include('for i = 0 to items?.Count?() - 1\n    if (ft_relationalGuard(items?[i], m?.top?.threshold, ">")) then\n      matches = matches + 1\n    end if\n  end for');
    });

    it('nests a bracketed for loop correctly inside a bracketed while loop', () => {
      expect(actual.brs).to.include('while ft_relationalGuard(i, items?.Count?(), "<")\n    for j = i to items?.Count?() - 1');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('anonymous-function-basic (function (...) { } expressions, Tier 1: whole assignment RHS)', () => {
    const fixtureDir = '../golden/anonymous-function-basic';
    const actual = compileFixture(fixtureDir, 'AnonymousFunctionBasicFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('prints a return-typed anonymous function as function(...) as Type ... end function', () => {
      expect(actual.brs).to.include('greet = function(name as string) as string\n    return "Hello, " + name\n  end function');
    });

    it('prints a return-less anonymous function as sub(...) ... end sub', () => {
      expect(actual.brs).to.include('onSelect = sub(key as string, press as boolean)\n    if (press) then\n      print m?.top?.prefix + key\n    end if\n  end sub');
    });

    it('rewrites a field reference inside the anonymous body via the ordinary m.top.<name> path', () => {
      expect(actual.brs).to.include('m?.top?.prefix + key');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('anonymous-function-nested (Tier 2: nested inside an arbitrary expression, e.g. a call argument)', () => {
    const fixtureDir = '../golden/anonymous-function-nested';
    const actual = compileFixture(fixtureDir, 'AnonymousFunctionNestedFixture');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('hoists a call-argument-nested anonymous function to a ft_anon_N temp var, splicing the bare name back into the call', () => {
      expect(actual.brs).to.include('ft_anon_1 = function(item as object) as boolean');
      expect(actual.brs).to.include('m.items = private_filterList(m?.items, ft_anon_1)');
    });

    it('resets the ft_anon_N counter per function — two different functions each hoisting one anon function both start at ft_anon_1', () => {
      expect(actual.brs).to.include('ft_anon_1 = function(item as object) as boolean');
      expect(actual.brs).to.include('ft_anon_1 = sub(item as object)');
    });

    it('supports full DSL statement sugar (if, state) inside a Tier-2 body, not just plain BrightScript', () => {
      expect(actual.brs).to.include('if (ft_relationalGuard(item?.value, m?.top?.threshold, ">")) then\n      m.matchCount = m?.matchCount + 1\n      return true\n    end if');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('anonymous-function expressions do not close over the enclosing function\'s own locals', () => {
    it('throws expression/unresolved-identifier for a name that is only a local in the ENCLOSING function, not a DSL binding', () => {
      const source = [
        '<script>',
        'private function f() {',
        '  multiplier = 5',
        '  add = function (value: integer): integer {',
        '    return value + multiplier',
        '  }',
        '}',
        '</script>',
        '<component>',
        '<LayoutGroup id="root" />',
        '</component>',
      ].join('\n');

      expect(() => compileThrSource(source, 'AnonClosureFixture')).to.throw(/Unresolved identifier "multiplier"/);
    });
  });

  describe('request-http-basic (request Http {} — no buildRequest — result/error fields, ft_runRequest() builds static options directly)', () => {
    const fixtureDir = '../golden/request-http-basic';
    const actual = compileFixture(fixtureDir, 'RequestHttpBasic');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('sets functionName to ft_runRequest and writes the unconditional resolvedOptions AA as the only two lines of init() when the component declares no children', () => {
      expect(actual.brs).to.include(
        'sub init()\n  m.top.functionName = "ft_runRequest"\n  m.top.resolvedOptions = { method: "GET", url: "https://jsonplaceholder.typicode.com/posts", headers: { }, query: { }, body: invalid, cache: { "disabled": false, "ttlSeconds": invalid }, buildSucceeded: true, buildErrorMessage: "" }\nend sub',
      );
    });

    it('always emits resolvedOptions/rawResponse/ft_isRequestComponent alongside result/error, with no value= attribute except ft_isRequestComponent\'s boolean default — but no requestData, no prepareRequest, since this fixture never declares buildRequest', () => {
      expect(actual.xml).to.not.include('<field id="requestData"');
      expect(actual.xml).to.not.include('<function name="prepareRequest"');
      expect(actual.xml).to.include('<field id="resolvedOptions" type="assocarray" />');
      expect(actual.xml).to.include('<field id="rawResponse" type="assocarray" />');
      expect(actual.xml).to.include('<field id="ft_isRequestComponent" type="boolean" value="true" />');
      expect(actual.xml).to.include('<field id="result" type="assocarray" />');
      expect(actual.xml).to.include('<field id="error" type="assocarray" />');
    });

    it('routes the success path through the declared (private) parseResponse hook by its compiled private_ name, and the failure path through the raw response (no parseError declared)', () => {
      expect(actual.brs).to.include('m.top.result = private_parseResponse(response)');
      expect(actual.brs).to.include('m.top.error = response');
      expect(actual.xml).to.not.include('<function name="parseResponse"');
    });

    it('sets usesTaskManager and usesHttpRequestHelper, even though the script never writes taskManager.* itself', () => {
      expect(actual.usesTaskManager).to.equal(true);
      expect(actual.usesHttpRequestHelper).to.equal(true);
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('request Http {} — parseResponse/parseError exceptions are caught, never crash the Task, and surface via rawResponse\'s parseSucceeded/parseErrorMessage', () => {
    it('wraps a declared parseResponse in try/catch, synthesizes a fallback error on a caught exception, and writes parseSucceeded/parseErrorMessage + rawResponse at the end of ft_runRequest()', () => {
      const source = [
        '<script>',
        'request Http { method: "GET", url: "https://example.com" }',
        'private function parseResponse(response: object): object {',
        '  return { items: response.data }',
        '}',
        '</script>',
        '<component extends="Task">',
        '</component>',
      ].join('\n');
      const result = compileThrSource(source, 'ParseResponseTryCatchFixture');

      expect(result.brs).to.include(
        [
          '  if response.isSuccess then',
          '    try',
          '      m.top.result = private_parseResponse(response)',
          '    catch ft_e',
          '      ft_parseSucceeded = false',
          '      ft_parseErrorMessage = ft_e.message',
          '      m.top.error = { message: "parseResponse threw: " + ft_e.message, parseFailed: true, httpStatusCode: response.httpStatusCode, raw: response }',
          '    end try',
          '  else',
          '    m.top.error = response',
          '  end if',
          '  response.parseSucceeded = ft_parseSucceeded',
          '  response.parseErrorMessage = ft_parseErrorMessage',
          '  m.top.rawResponse = response',
        ].join('\n'),
      );

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('wraps a declared parseError in try/catch on the failure branch too, independently of parseResponse', () => {
      const source = [
        '<script>',
        'request Http { method: "GET", url: "https://example.com" }',
        'private function parseError(response: object): object {',
        '  return { message: "failed: " + response.httpStatusCode.ToStr() }',
        '}',
        '</script>',
        '<component extends="Task">',
        '</component>',
      ].join('\n');
      const result = compileThrSource(source, 'ParseErrorTryCatchFixture');

      expect(result.brs).to.include('    m.top.result = response');
      expect(result.brs).to.include(
        [
          '  else',
          '    try',
          '      m.top.error = private_parseError(response)',
          '    catch ft_e',
          '      ft_parseSucceeded = false',
          '      ft_parseErrorMessage = ft_e.message',
          '      m.top.error = { message: "parseError threw: " + ft_e.message, parseFailed: true, httpStatusCode: response.httpStatusCode, raw: response }',
          '    end try',
          '  end if',
        ].join('\n'),
      );

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('emits ZERO try/catch anywhere when neither parseResponse nor parseError is declared — nothing that could throw, so nothing gets wrapped', () => {
      const source = ['<script>', 'request Http { method: "GET", url: "https://example.com" }', '</script>', '<component extends="Task">', '</component>'].join('\n');
      const result = compileThrSource(source, 'NoParseHooksFixture');

      expect(result.brs).to.not.include('try');
      expect(result.brs).to.not.include('catch');
      expect(result.brs).to.include('    m.top.result = response');
      expect(result.brs).to.include('    m.top.error = response');
      // parseSucceeded/parseErrorMessage/rawResponse are unconditional regardless of whether either
      // hook is declared — a caller can always tell a real HTTP failure (isSuccess: false) apart
      // from a parse-hook bug (parseSucceeded: false), even for a component with no hooks at all
      // (where parseSucceeded is trivially always true, since nothing here can ever throw).
      expect(result.brs).to.include('  ft_parseSucceeded = true');
      expect(result.brs).to.include('  response.parseSucceeded = ft_parseSucceeded');
      expect(result.brs).to.include('  response.parseErrorMessage = ft_parseErrorMessage');
      expect(result.brs).to.include('  m.top.rawResponse = response');

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });
  });

  describe('request Http {} — buildRequest resolves options via prepareRequest(), NOT inside the Task thread\'s ft_runRequest() (rendezvous avoidance)', () => {
    const source = [
      '<script>',
      'request Http {',
      '  method: "POST",',
      '  url: "https://example.com",',
      '  headers: { "X-Static": "1" },',
      '  query: { page: "1" },',
      '  body: { fixed: true }',
      '}',
      '',
      'private function buildRequest(requestData: object): object {',
      '  return { headers: { "X-Dynamic": "2" }, query: { userId: requestData.id }, body: { updated: true } }',
      '}',
      'private function parseResponse(response: object): object {',
      '  return response',
      '}',
      'private function parseError(response: object): object {',
      '  return response',
      '}',
      '</script>',
      '<component extends="Task">',
      '</component>',
    ].join('\n');
    const result = compileThrSource(source, 'BuildRequestFixture');

    it('declares resolvedOptions (assocarray) and a callFunc-reachable prepareRequest interface function, alongside result/error', () => {
      expect(result.xml).to.include('<field id="resolvedOptions" type="assocarray" />');
      expect(result.xml).to.include('<field id="result" type="assocarray" />');
      expect(result.xml).to.include('<field id="error" type="assocarray" />');
      expect(result.xml).to.include('<function name="prepareRequest" />');
    });

    it('prepareRequest(requestData) — an ordinary function taking requestData as a PARAMETER, never a stored field — builds base options, merges buildRequest\'s override key-by-key (query/headers) or wholesale (method/url/body), then stores the result on m.top.resolvedOptions', () => {
      expect(result.brs).to.include('function ft_buildBaseRequestOptions() as object');
      expect(result.brs).to.include(
        '  return { method: "POST", url: "https://example.com", headers: { "X-Static": "1" }, query: { "page": "1" }, body: { "fixed": true }, cache: { "disabled": false, "ttlSeconds": invalid }, buildSucceeded: true, buildErrorMessage: "" }',
      );
      expect(result.brs).to.include('function prepareRequest(requestData as object) as object');
      expect(result.brs).to.include('  options = ft_buildBaseRequestOptions()');
      expect(result.brs).to.include('  ft_overrides = private_buildRequest(requestData)');
      expect(result.brs).to.include('    options.headers[ft_headerKey] = ft_overrides.headers[ft_headerKey]');
      expect(result.brs).to.include('    options.query[ft_queryKey] = ft_overrides.query[ft_queryKey]');
      expect(result.brs).to.include('    if ft_overrides.body <> invalid then options.body = ft_overrides.body');
      expect(result.brs).to.include('  m.top.resolvedOptions = options');
    });

    it('ft_runRequest() (the Task-thread work function) reads the ALREADY-resolved m.top.resolvedOptions — it never calls buildRequest itself, so buildRequest never runs on the Task\'s own background thread', () => {
      expect(result.brs).to.include('sub ft_runRequest()\n  options = m.top.resolvedOptions\n  if options = invalid then options = ft_buildBaseRequestOptions()');
      const runRequestBody = result.brs.match(/sub ft_runRequest\(\)[\s\S]*?\nend sub/)![0];
      expect(runRequestBody).to.not.include('private_buildRequest');
      expect(result.brs).to.include('m.top.result = private_parseResponse(response)');
      expect(result.brs).to.include('m.top.error = private_parseError(response)');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('omits query/body from the base options AA when neither is declared, without requiring buildRequest at all', () => {
      const source = ['<script>', 'request Http { method: "GET", url: "https://example.com" }', '</script>', '<component extends="Task">', '</component>'].join('\n');
      const result = compileThrSource(source, 'NoQueryBodyFixture');
      expect(result.brs).to.include('m.top.resolvedOptions = { method: "GET", url: "https://example.com", headers: { }, query: { }, body: invalid, cache: { "disabled": false, "ttlSeconds": invalid }, buildSucceeded: true, buildErrorMessage: "" }');
      expect(result.brs).to.not.include('ft_overrides');
    });

    it('wraps the buildRequest call + override-merge logic in try/catch inside prepareRequest() — a thrown exception leaves options as the static base (no overrides applied) and sets buildSucceeded/buildErrorMessage, but the request still proceeds', () => {
      const throwingSource = [
        '<script>',
        'request Http { method: "GET", url: "https://example.com" }',
        'private function buildRequest(requestData: object): object {',
        '  return { query: { userId: requestData.missingField.id } }',
        '}',
        '</script>',
        '<component extends="Task">',
        '</component>',
      ].join('\n');
      const result = compileThrSource(throwingSource, 'BuildRequestTryCatchFixture');

      expect(result.brs).to.include(
        [
          'function prepareRequest(requestData as object) as object',
          '  options = ft_buildBaseRequestOptions()',
          '  try',
          '    ft_overrides = private_buildRequest(requestData)',
          '    if ft_overrides <> invalid then',
        ].join('\n'),
      );
      expect(result.brs).to.include(
        ['  catch ft_e', '    options.buildSucceeded = false', '    options.buildErrorMessage = ft_e.message', '  end try', '  m.top.resolvedOptions = options', '  return options', 'end function'].join(
          '\n',
        ),
      );

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('a buildRequest-declaring component with no override-merge exception still defaults buildSucceeded/buildErrorMessage to true/"" in the base options literal — resolvedOptions is never missing either key regardless of outcome', () => {
      const source = ['<script>', 'request Http { method: "GET", url: "https://example.com" }', '</script>', '<component extends="Task">', '</component>'].join('\n');
      const result = compileThrSource(source, 'DefaultBuildStatusFixture');
      expect(result.brs).to.include('buildSucceeded: true, buildErrorMessage: ""');
    });
  });

  describe('request Http { cache: ... } — caching is ON BY DEFAULT for GET, cache overrides ONLY force it off or force an exact ttl', () => {
    it('no cache key at all still prints cache: { "disabled": false, "ttlSeconds": invalid } — the default: cache automatically per the server\'s own Cache-Control', () => {
      const source = ['<script>', 'request Http { method: "GET", url: "https://example.com" }', '</script>', '<component extends="Task">', '</component>'].join('\n');
      const result = compileThrSource(source, 'DefaultCacheFixture');
      expect(result.brs).to.include('m.top.resolvedOptions = { method: "GET", url: "https://example.com", headers: { }, query: { }, body: invalid, cache: { "disabled": false, "ttlSeconds": invalid }, buildSucceeded: true, buildErrorMessage: "" }');
    });

    it('cache: {} prints the exact same thing as no cache key at all — a no-op, explicit spelling of the default', () => {
      const source = ['<script>', 'request Http { url: "https://example.com", cache: {} }', '</script>', '<component extends="Task">', '</component>'].join('\n');
      const result = compileThrSource(source, 'EmptyCacheFixture');
      expect(result.brs).to.include('cache: { "disabled": false, "ttlSeconds": invalid }');
    });

    it('cache: { ttlSeconds: <n> } prints a FORCED ttlSeconds, with no prepareRequest machinery (cache is not buildRequest-overridable)', () => {
      const source = ['<script>', 'request Http { method: "GET", url: "https://example.com", cache: { ttlSeconds: 300 } }', '</script>', '<component extends="Task">', '</component>'].join('\n');
      const result = compileThrSource(source, 'CachedGetFixture');
      expect(result.brs).to.include('m.top.resolvedOptions = { method: "GET", url: "https://example.com", headers: { }, query: { }, body: invalid, cache: { "disabled": false, "ttlSeconds": 300 }, buildSucceeded: true, buildErrorMessage: "" }');
      expect(result.xml).to.not.include('prepareRequest');
    });

    it('cache: false prints cache: { "disabled": true, "ttlSeconds": invalid } — forces caching off entirely', () => {
      const source = ['<script>', 'request Http { url: "https://example.com", cache: false }', '</script>', '<component extends="Task">', '</component>'].join('\n');
      const result = compileThrSource(source, 'CacheDisabledFixture');
      expect(result.brs).to.include('cache: { "disabled": true, "ttlSeconds": invalid }');
    });

    const validated = validateGeneratedBrs(compileThrSource(['<script>', 'request Http { cache: { ttlSeconds: 60 } }', '</script>', '<component extends="Task">', '</component>'].join('\n'), 'CacheDefaultGetFixture').brs);
    it('a cache config with no explicit method (defaults to GET) still compiles and produces valid BrightScript', () => {
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });
  });

  describe('request {} — compile-time validation errors', () => {
    function source(scriptBody: string, componentAttrs = 'extends="Task"'): string {
      return ['<script>', scriptBody, '</script>', `<component ${componentAttrs}>`, '<Node id="root" />', '</component>'].join('\n');
    }

    it('throws request/multiple-request-declarations for a second request {} in the same file', () => {
      const src = source(['request Http { url: "https://a.example.com" }', 'request Http { url: "https://b.example.com" }'].join('\n'));
      expect(() => compileThrSource(src, 'TwoRequests')).to.throw().with.property('diagnostic').that.deep.include({ code: 'request/multiple-request-declarations' });
    });

    it('throws request/declaration-requires-task-extends when request Http {} is declared without extends="Task"', () => {
      const src = source('request Http { url: "https://example.com" }', '');
      expect(() => compileThrSource(src, 'MissingTaskExtends')).to.throw().with.property('diagnostic').that.deep.include({ code: 'request/declaration-requires-task-extends' });
    });

    it('throws request/unknown-kind for a request Kind other than Http, at full compile time', () => {
      const src = source('request Bogus { command: "getCatalog" }', '');
      expect(() => compileThrSource(src, 'UnknownRequestKind')).to.throw().with.property('diagnostic').that.deep.include({ code: 'request/unknown-kind' });
    });

    it('throws request/cache-requires-get-method for cache combined with a non-GET method, at full compile time (not just the parseRequestConfig unit level)', () => {
      const src = source('request Http { method: "POST", url: "https://example.com", cache: { ttlSeconds: 60 } }');
      expect(() => compileThrSource(src, 'CachedPost')).to.throw().with.property('diagnostic').that.deep.include({ code: 'request/cache-requires-get-method' });
    });

    it('throws request/invalid-cache-config for a non-positive-integer ttlSeconds, at full compile time', () => {
      const src = source('request Http { url: "https://example.com", cache: { ttlSeconds: 0 } }');
      expect(() => compileThrSource(src, 'CacheZeroTtl')).to.throw().with.property('diagnostic').that.deep.include({ code: 'request/invalid-cache-config' });
    });

    it('does NOT throw for cache: {} with no ttlSeconds at all — it\'s a legitimate "trust the server\'s own headers only" config', () => {
      const src = source('request Http { url: "https://example.com", cache: {} }');
      expect(() => compileThrSource(src, 'CacheNoTtl')).to.not.throw();
    });
  });

  describe('animation — declares a named Animation/interpolator subtree, emitted into <children>', () => {
    function source(scriptBody: string): string {
      return ['<script>', scriptBody, '</script>', '<component>', '<Rectangle id="card" />', '</component>'].join('\n');
    }

    it('emits a simple (non-composed) animation as one <Animation> wrapping one interpolator, with id="ft_anim_<name>"', () => {
      const src = source('animation bounce {\n  target: card\n  duration: 400\n  easeFunction: "outCubic"\n  scale: [1, 1.15, 1]\n}');
      const result = compileThrSource(src, 'AnimationBasic');
      expect(result.xml).to.include(
        '<Animation id="ft_anim_bounce" duration="400" easeFunction="outCubic">\n      <Vector2DFieldInterpolator key="[0, 0.5, 1]" keyValue="[[1, 1], [1.15, 1.15], [1, 1]]" fieldToInterp="card.scale" />\n    </Animation>',
      );
    });

    it('emits a sequential composition as <SequentialAnimation> wrapping two <Animation> leaves, inheriting the outer target', () => {
      const src = source(
        [
          'animation intro {',
          '  target: card',
          '  sequential: true',
          '  steps: [',
          '    { opacity: [0, 1], duration: 300 },',
          '    { translation: [[0, 40], [0, 0]], duration: 300 }',
          '  ]',
          '}',
        ].join('\n'),
      );
      const result = compileThrSource(src, 'AnimationSequential');
      expect(result.xml).to.include('<SequentialAnimation id="ft_anim_intro">');
      expect(result.xml).to.include('<FloatFieldInterpolator key="[0, 1]" keyValue="[0, 1]" fieldToInterp="card.opacity" />');
      expect(result.xml).to.include('<Vector2DFieldInterpolator key="[0, 1]" keyValue="[[0, 40], [0, 0]]" fieldToInterp="card.translation" />');
    });

    it('supports multiple animation declarations in one file, each with its own id', () => {
      const src = source('animation fadeIn {\n  target: card\n  opacity: [0, 1]\n}\nanimation fadeOut {\n  target: card\n  opacity: [1, 0]\n}');
      const result = compileThrSource(src, 'AnimationMultiple');
      expect(result.xml).to.include('id="ft_anim_fadeIn"');
      expect(result.xml).to.include('id="ft_anim_fadeOut"');
    });

    it('caches the generated Animation node via findNode() in init(), same as any other statically-present id', () => {
      const src = source('animation bounce {\n  target: card\n  duration: 400\n  scale: [1, 1.15, 1]\n}');
      const result = compileThrSource(src, 'AnimationFindNodeCache');
      expect(result.brs).to.include('m["$$ft_anim_bounce"] = m.top.findNode("ft_anim_bounce")');
    });

    it('never emits a <field> for an animation — it is pure template-tree XML, not an interface field', () => {
      const src = source('animation fadeIn {\n  target: card\n  opacity: [0, 1]\n}');
      const result = compileThrSource(src, 'AnimationNoField');
      expect(result.xml).to.not.include('<field id="fadeIn"');
    });

    it('throws animation/unknown-target at full compile time when target references a nonexistent element id', () => {
      const src = source('animation bad {\n  target: doesNotExist\n  opacity: [0, 1]\n}');
      expect(() => compileThrSource(src, 'AnimationBadTarget')).to.throw().with.property('diagnostic').that.deep.include({ code: 'animation/unknown-target' });
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const src = source('animation bounce {\n  target: card\n  duration: 400\n  scale: [1, 1.15, 1]\n}');
      const result = compileThrSource(src, 'AnimationValidBrs');
      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });
  });

  describe('animation — transition:/in:/out: on a toggle-mode {#if} block', () => {
    it('emits a preset-backed enter/exit pair, deferring visible=false until the exit animation reports "stopped" (re-checking the condition, not just the completion)', () => {
      const src = [
        '<script>',
        'field showPanel: boolean = false',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if showPanel}',
        '<Rectangle id="panel" transition:fade="{{duration: 250}}" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'ToggleTransitionBasic');

      // Both directions synthesized as their own real <Animation> nodes, "out" reversed.
      expect(result.xml).to.include('id="ft_anim_if_1_in"');
      expect(result.xml).to.include('id="ft_anim_if_1_out"');
      expect(result.xml).to.include('reverse="true"');
      expect(result.xml).to.include('fieldToInterp="panel.opacity"');
      expect(result.brs).to.include('m["$$ft_anim_if_1_in"] = m.top.findNode("ft_anim_if_1_in")');
      expect(result.brs).to.include('m["$$ft_anim_if_1_out"] = m.top.findNode("ft_anim_if_1_out")');

      // Cascade: show cancels a stale exit, sets visible, starts the enter animation.
      expect(result.brs).to.include('m["$$ft_anim_if_1_out"].control = "stop"');
      expect(result.brs).to.include('m["$$ft_if_1"].visible = true');
      expect(result.brs).to.include('m["$$ft_anim_if_1_in"].control = "start"');
      // Hide defers visible=false — starts the exit animation instead of hiding immediately.
      expect(result.brs).to.include('m["$$ft_anim_if_1_out"].control = "start"');

      // The exit-animation observer is registered once, in init(), and its handler re-checks the
      // block's own condition before hiding (guards against a stale completion after a fast
      // hide→show).
      expect(result.brs).to.include('m["$$ft_anim_if_1_out"].ObserveFieldScoped("state", "on_if_1_out_StateChange")');
      expect(result.brs).to.include('sub on_if_1_out_StateChange(event as object)');
      expect(result.brs).to.include('if event.GetData() = "stopped" then');
      expect(result.brs).to.include('if not (m?.top?.showPanel) then');
      expect(result.brs).to.include('m["$$ft_if_1"].visible = false');

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('snaps the target field to the enter animation\'s own first keyframe BEFORE starting it — a real visual bug found live: without this, a freshly-shown target could render one frame at its bare Roku default before the animation\'s own snap applied, reading as "the animation played twice"', () => {
      const src = [
        '<script>',
        'field showPanel: boolean = false',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if showPanel}',
        '<Rectangle id="panel" transition:fade="{{duration: 0.25}}" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'ToggleTransitionInitialSnap');

      expect(result.brs).to.include('m.panel.opacity = 0');
      const snapIdx = result.brs.indexOf('m.panel.opacity = 0');
      const startIdx = result.brs.indexOf('m["$$ft_anim_if_1_in"].control = "start"');
      expect(snapIdx).to.be.greaterThan(-1);
      expect(snapIdx).to.be.lessThan(startIdx);

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('supports independent in:/out: with a custom animation on one side and a preset on the other', () => {
      const src = [
        '<script>',
        'field showPanel: boolean = false',
        'animation bounce {\n  target: panel\n  duration: 400\n  scale: [1, 1.15, 1]\n}',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if showPanel}',
        '<Rectangle id="panel" in:bounce="" out:fade="{{duration: 150}}" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'ToggleTransitionMixed');
      // bounce's own standalone declaration, plus the synthesized in-direction copy for this block.
      expect(result.xml).to.include('id="ft_anim_bounce"');
      expect(result.xml).to.include('id="ft_anim_if_1_in"');
      expect(result.xml).to.include('id="ft_anim_if_1_out"');

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('an out:-only block registers/unregisters its own focusable content around the deferred hide, but an in:-only block hides instantly with no register/unregister at all', () => {
      const outOnlySrc = [
        '<script>',
        'field showPanel: boolean = false',
        'private function noop(key: string, press: boolean) {}',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if showPanel}',
        '<Rectangle id="panel" out:fade="" focusable="true" on:key[OK]="{noop()}" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      const outOnly = compileThrSource(outOnlySrc, 'ToggleTransitionOutOnlyFocus');
      expect(outOnly.brs).to.include('m.global.ft_focus.callFunc("unregister", m.panel)');
      expect(outOnly.brs).to.include('m.global.ft_focus.callFunc("recoverFocusFor", m.top)');
      expect(outOnly.brs).to.include('m.global.ft_focus.callFunc("register", m.panel, m.top, false)');

      const inOnlySrc = outOnlySrc.replace('out:fade=""', 'in:fade=""');
      const inOnly = compileThrSource(inOnlySrc, 'ToggleTransitionInOnlyFocus');
      expect(inOnly.brs).to.not.include('callFunc("unregister"');
      expect(inOnly.brs).to.not.include('callFunc("recoverFocusFor"');
      // No exit animation at all here — hides instantly, same as a plain (non-transitioning) toggle block.
      expect(inOnly.brs).to.include('m["$$ft_if_1"]');
      expect(inOnly.xml).to.not.include('_out"');
    });

    it('throws animation/transition-outside-conditional-block when a transition attribute is on a non-conditional element', () => {
      const src = ['<script>', '</script>', '<component>', '<Rectangle id="panel" transition:fade="" />', '</component>'].join('\n');
      expect(() => compileThrSource(src, 'TransitionOutsideBlock')).to.throw().with.property('diagnostic').that.deep.include({ code: 'animation/transition-outside-conditional-block' });
    });

    it('throws animation/multiple-transitioning-children when two direct children of the same block both carry a transition attribute', () => {
      const src = [
        '<script>',
        'field showPanel: boolean = false',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if showPanel}',
        '<Rectangle id="a" transition:fade="" />',
        '<Rectangle id="b" transition:fade="" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      expect(() => compileThrSource(src, 'MultipleTransitioningChildren')).to.throw().with.property('diagnostic').that.deep.include({ code: 'animation/multiple-transitioning-children' });
    });

    it('throws animation/repeat-not-supported-for-exit-animation for "repeat: true" on a preset out: — found by code review, not yet device-reproduced: the deferred hide/removeChild only ever runs once the exit animation reports state="stopped", which a repeating animation never does on its own, leaving the block permanently visible', () => {
      const src = [
        '<script>',
        'field showPanel: boolean = false',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if showPanel}',
        '<Rectangle id="panel" out:fade="{{repeat: true}}" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      expect(() => compileThrSource(src, 'ExitRepeatPreset')).to.throw().with.property('diagnostic').that.deep.include({ code: 'animation/repeat-not-supported-for-exit-animation' });
    });

    it('throws animation/repeat-not-supported-for-exit-animation for "repeat: true" on a custom out: animation, including when nested inside a sequential/parallel composition', () => {
      const topLevelSrc = [
        '<script>',
        'field showPanel: boolean = false',
        'animation pulse {\n  target: panel\n  repeat: true\n  opacity: [1, 0.4, 1]\n}',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if showPanel}',
        '<Rectangle id="panel" out:pulse="" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      expect(() => compileThrSource(topLevelSrc, 'ExitRepeatCustomTopLevel'))
        .to.throw()
        .with.property('diagnostic')
        .that.deep.include({ code: 'animation/repeat-not-supported-for-exit-animation' });

      const nestedSrc = [
        '<script>',
        'field showPanel: boolean = false',
        'animation pulseSeq {\n  target: panel\n  sequential: true\n  steps: [\n    { opacity: [1, 0.4], duration: 0.2 },\n    { opacity: [0.4, 1], duration: 0.2, repeat: true }\n  ]\n}',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if showPanel}',
        '<Rectangle id="panel" out:pulseSeq="" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      expect(() => compileThrSource(nestedSrc, 'ExitRepeatCustomNested'))
        .to.throw()
        .with.property('diagnostic')
        .that.deep.include({ code: 'animation/repeat-not-supported-for-exit-animation' });
    });

    it('does NOT reject "repeat: true" on the in: side — only the exit (out:) animation depends on ever reaching state="stopped"', () => {
      const src = [
        '<script>',
        'field showPanel: boolean = false',
        'animation pulse {\n  target: panel\n  repeat: true\n  opacity: [1, 0.4, 1]\n}',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if showPanel}',
        '<Rectangle id="panel" in:pulse="" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      expect(() => compileThrSource(src, 'InRepeatAllowed')).to.not.throw();
    });
  });

  describe('animation — transition:/in:/out: on a destroy-mode {#if:destroy} block', () => {
    it('starts the enter animation as the last line of the create sub, after insertChild', () => {
      const src = [
        '<script>',
        'field showCard: boolean = false',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if:destroy showCard}',
        '<Rectangle id="card" transition:fade="{{duration: 200}}" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'DestroyTransitionBasic');

      expect(result.xml).to.include('id="ft_anim_if_1_in"');
      expect(result.xml).to.include('id="ft_anim_if_1_out"');
      expect(result.brs).to.include('sub DestroyTransitionBasic__create_if_1()');
      const createSub = result.brs.match(/sub DestroyTransitionBasic__create_if_1\(\)[\s\S]*?\nend sub/)![0];
      expect(createSub.trim().endsWith('m["$$ft_anim_if_1_in"].control = "start"\nend sub')).to.be.true;
      expect(createSub.indexOf('insertChild')).to.be.lessThan(createSub.indexOf('ft_anim_if_1_in'));

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('snaps the target field to the enter animation\'s own first keyframe BEFORE starting it — a Vector2D field (a real custom scale pop-in, not just a preset\'s opacity) prints its [x, y] array-shaped first keyframe correctly', () => {
      const src = [
        '<script>',
        'field showCard: boolean = false',
        'animation popIn {\n  target: card\n  duration: 0.3\n  scale: [0.5, 1]\n}',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if:destroy showCard}',
        '<Rectangle id="card" in:popIn="" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'DestroyTransitionInitialSnap');

      const createSub = result.brs.match(/sub DestroyTransitionInitialSnap__create_if_1\(\)[\s\S]*?\nend sub/)![0];
      expect(createSub).to.include('m.card.scale = [0.5, 0.5]');
      expect(createSub.indexOf('m.card.scale = [0.5, 0.5]')).to.be.lessThan(createSub.indexOf('control = "start"'));

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('defers removeChild: the cascade unregisters focusable content and starts the exit animation, WITHOUT calling the destroy sub directly', () => {
      const src = [
        '<script>',
        'field showCard: boolean = false',
        'private function noop(key: string, press: boolean) {}',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if:destroy showCard}',
        '<Rectangle id="card" transition:fade="{{duration: 200}}" focusable="true" on:key[OK]="{noop()}" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'DestroyTransitionFocus');

      // The ordinary cascade check (init()'s own initial-condition evaluation and any dependency
      // change) no longer calls the destroy sub directly — it unregisters + starts the exit
      // animation instead.
      expect(result.brs).to.include('m.global.ft_focus.callFunc("unregister", m.card)');
      expect(result.brs).to.include('m.global.ft_focus.callFunc("recoverFocusFor", m.top)');
      expect(result.brs).to.include('m["$$ft_anim_if_1_out"].control = "start"');

      // The destroy sub itself is only ever reached via the exit-animation handler now, and skips
      // re-doing the unregister/recoverFocusFor it already did at exit-start.
      expect(result.brs).to.include('sub on_if_1_out_StateChange(event as object)');
      expect(result.brs).to.include('if event.GetData() = "stopped" then');
      expect(result.brs).to.include('if not (m?.top?.showCard) then');
      expect(result.brs).to.include('if m["$$ft_if_1"] <> invalid then');
      expect(result.brs).to.include('DestroyTransitionFocus__destroy_if_1()');

      const destroySub = result.brs.match(/sub DestroyTransitionFocus__destroy_if_1\(\)[\s\S]*?\nend sub/)![0];
      expect(destroySub).to.not.include('callFunc("unregister"');
      expect(destroySub).to.not.include('callFunc("recoverFocusFor"');
      expect(destroySub).to.include('removeChild');

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('an in:-only destroy-mode block keeps the exact original instant-destroy shape — no exit-animation handler, no deferred removeChild', () => {
      const src = [
        '<script>',
        'field showCard: boolean = false',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if:destroy showCard}',
        '<Rectangle id="card" in:fade="" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'DestroyTransitionInOnly');
      expect(result.brs).to.not.include('ExitAnimationStateChange');
      expect(result.xml).to.not.include('_out"');

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('refreshes fieldToInterp on every create/hide — a real bug found live: Roku caches fieldToInterp\'s resolved target on first use, so a {#if:destroy} block\'s recreated target silently stopped animating on its second show without this', () => {
      const src = [
        '<script>',
        'field showCard: boolean = false',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if:destroy showCard}',
        '<Rectangle id="card" transition:fade="{{duration: 0.2}}" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'DestroyTransitionRefresh');

      // The interpolator gets its own id, distinct from the outer Animation node's id.
      expect(result.xml).to.include('id="ft_anim_if_1_in_ref_0"');
      expect(result.xml).to.include('id="ft_anim_if_1_out_ref_0"');

      // init() caches both refs via findNode, once — same pattern as the animation nodes themselves.
      expect(result.brs).to.include('m["$$ft_anim_if_1_in_ref_0"] = m.top.findNode("ft_anim_if_1_in_ref_0")');
      expect(result.brs).to.include('m["$$ft_anim_if_1_out_ref_0"] = m.top.findNode("ft_anim_if_1_out_ref_0")');

      // The create sub blanks fieldToInterp to "" THEN sets it back, immediately before starting
      // the enter animation — a single same-value reassignment was confirmed live to be a silent
      // Roku SetField no-op, so a genuine two-step reset is required, not just one re-assignment.
      const createSub = result.brs.match(/sub DestroyTransitionRefresh__create_if_1\(\)[\s\S]*?\nend sub/)![0];
      expect(createSub).to.include('m["$$ft_anim_if_1_in_ref_0"].fieldToInterp = ""\n  m["$$ft_anim_if_1_in_ref_0"].fieldToInterp = "card.opacity"');
      expect(createSub.indexOf('fieldToInterp = ""')).to.be.lessThan(createSub.indexOf('control = "start"'));

      // The hide branch (cascade check) does the same two-step reset before starting the exit animation.
      expect(result.brs).to.include('m["$$ft_anim_if_1_out_ref_0"].fieldToInterp = ""\n    m["$$ft_anim_if_1_out_ref_0"].fieldToInterp = "card.opacity"');
      const outRefreshIdx = result.brs.indexOf('m["$$ft_anim_if_1_out_ref_0"].fieldToInterp = ""');
      const outStartIdx = result.brs.indexOf('m["$$ft_anim_if_1_out"].control = "start"');
      expect(outRefreshIdx).to.be.greaterThan(-1);
      expect(outRefreshIdx).to.be.lessThan(outStartIdx);

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('a TOGGLE-mode {#if} block\'s transition never needs a fieldToInterp refresh — its target is never destroyed/recreated', () => {
      const src = [
        '<script>',
        'state showCard: boolean = false',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if showCard}',
        '<Rectangle id="card" transition:fade="{{duration: 0.2}}" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'ToggleTransitionNoRefresh');

      expect(result.brs).to.not.include('.fieldToInterp =');
      expect(result.xml).to.not.include('_ref_');
    });
  });

  describe('animation — fly/slide presets compute absolute keyframes relative to the target\'s own static resting translation, when it has one', () => {
    it('fly: a target with translation="[300, 450]" gets from=[resting + default offset], to=[resting] — not [0, 40]/[0, 0]', () => {
      const src = [
        '<script>',
        'state showCard: boolean = false',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if showCard}',
        '<Rectangle id="card" translation="[300, 450]" transition:fly="" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'FlyRestingTranslation');

      expect(result.xml).to.include('keyValue="[[300, 490], [300, 450]]"');
      // Deliberately UNscaled once a real resting position is known — see flyOrSlideInterpolator's
      // own doc comment for why (the resting literal itself is never touched by ft_scaleFactor).
      expect(result.brs).to.not.include('ft_scale(');

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('slide: an author-overridden x offset still adds against the target\'s own resting translation, not [0, 0]', () => {
      const src = [
        '<script>',
        'state showCard: boolean = false',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if showCard}',
        '<Rectangle id="card" translation="[100, 50]" transition:slide="{{x: -200}}" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'SlideRestingTranslationOverride');

      expect(result.xml).to.include('keyValue="[[-100, 50], [100, 50]]"');

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('a target with NO translation attribute at all keeps the exact original [0, 0]-resting, scaled:true behavior — the ordinary, unaffected case', () => {
      const src = [
        '<script>',
        'state showCard: boolean = false',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if showCard}',
        '<Rectangle id="card" transition:fly="" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'FlyNoRestingTranslation', { globalBindings: { theme: null, designResolutionConfigured: true } });

      // The static XML keeps the raw, unscaled [0, 40]/[0, 0] literal — actual scaling happens at
      // runtime in init(), same as any other "scaled: true" interpolator.
      expect(result.xml).to.include('keyValue="[[0, 40], [0, 0]]"');
      expect(result.xml).to.include('id="ft_anim_if_1_in_ref_0"');
      expect(result.brs).to.include('m.top.findNode("ft_anim_if_1_in_ref_0").keyValue = [ft_scale([0, 40], m.global.ft_scaleFactor), ft_scale([0, 0], m.global.ft_scaleFactor)]');

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('throws animation/preset-target-has-dynamic-translation when the target\'s own translation is dynamic, not static', () => {
      const src = [
        '<script>',
        'state showCard: boolean = false',
        'field offsetX: float = 10',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if showCard}',
        '<Rectangle id="card" translation="{[offsetX, 0]}" transition:fly="" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      expect(() => compileThrSource(src, 'FlyDynamicTranslation'))
        .to.throw()
        .with.property('diagnostic')
        .that.deep.include({ code: 'animation/preset-target-has-dynamic-translation' });
    });

    it('throws animation/preset-target-translation-not-a-pair when the target\'s own static translation is not a [x, y] number pair', () => {
      const src = [
        '<script>',
        'state showCard: boolean = false',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if showCard}',
        '<Rectangle id="card" translation="not-a-pair" transition:fly="" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      expect(() => compileThrSource(src, 'FlyMalformedTranslation'))
        .to.throw()
        .with.property('diagnostic')
        .that.deep.include({ code: 'animation/preset-target-translation-not-a-pair' });
    });

    it('fade/scale presets are unaffected by a target\'s own static translation — they never take a resting translation at all', () => {
      const src = [
        '<script>',
        'state showCard: boolean = false',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if showCard}',
        '<Rectangle id="card" translation="[300, 450]" transition:fade="" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'FadeIgnoresRestingTranslation');

      expect(result.xml).to.include('keyValue="[0, 1]"');

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });
  });

  describe('animation — Layer 1 target: inside a {#if:destroy} block gets a fieldToInterp refresh at every .start() call site', () => {
    it('injects the blank-then-reset lines immediately before .control = "start", not just on the first call', () => {
      const src = [
        '<script>',
        'field showCard: boolean = false',
        'animation popIn {\n  target: card\n  duration: 0.3\n  scale: [0.5, 1]\n}',
        'private function trigger() {\n  popIn.start()\n}',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if:destroy showCard}',
        '<Rectangle id="card" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'Layer1DestroyRefresh');

      // The interpolator gets its own id, same synthesized shape Layer 2 already uses.
      expect(result.xml).to.include('id="ft_anim_popIn_ref_0"');
      // init() caches it via findNode, once — the interpolator NODE is never destroyed/recreated,
      // only its fieldToInterp TARGET is.
      expect(result.brs).to.include('m["$$ft_anim_popIn_ref_0"] = m.top.findNode("ft_anim_popIn_ref_0")');

      // private_trigger()'s own .start() call gets the two-line reset immediately before it —
      // every single call, not just the first (there is no "first vs. later" call site distinction
      // here, unlike Layer 2's dedicated create/hide subs — this is the SAME statement, rewritten
      // once at compile time, that runs on every invocation).
      const triggerFn = result.brs.match(/sub private_trigger\(\)[\s\S]*?\nend sub/)![0];
      expect(triggerFn.trim()).to.equal(
        [
          'sub private_trigger()',
          '  m["$$ft_anim_popIn_ref_0"].fieldToInterp = ""',
          '  m["$$ft_anim_popIn_ref_0"].fieldToInterp = "card.scale"',
          '  m["$$ft_anim_popIn"].control = "start"',
          'end sub',
        ].join('\n'),
      );
      expect(triggerFn.indexOf('fieldToInterp = ""')).to.be.lessThan(triggerFn.indexOf('m["$$ft_anim_popIn"].control = "start"'));

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('does NOT inject a refresh for an animation whose target is NOT inside a {#if:destroy} block — the ordinary, unaffected case', () => {
      const src = [
        '<script>',
        'animation bounce {\n  target: card\n  duration: 0.3\n  scale: [1, 1.15, 1]\n}',
        'private function trigger() {\n  bounce.start()\n}',
        '</script>',
        '<component>',
        '<Rectangle id="card" />',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'Layer1NoDestroyNoRefresh');

      expect(result.brs).to.not.include('.fieldToInterp =');
      expect(result.xml).to.not.include('_ref_');
      const triggerFn = result.brs.match(/sub private_trigger\(\)[\s\S]*?\nend sub/)![0];
      expect(triggerFn.trim()).to.equal('sub private_trigger()\n  m["$$ft_anim_bounce"].control = "start"\nend sub'.trim());
    });

    it('only refreshes .start() — .stop()/.pause()/.resume()/.finish() act on an already-established target and never re-trigger Roku\'s own one-time fieldToInterp resolution', () => {
      const src = [
        '<script>',
        'field showCard: boolean = false',
        'animation popIn {\n  target: card\n  duration: 0.3\n  scale: [0.5, 1]\n}',
        'private function triggerStop() {\n  popIn.stop()\n}',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if:destroy showCard}',
        '<Rectangle id="card" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'Layer1StopNoRefresh');

      const stopFn = result.brs.match(/sub private_triggerStop\(\)[\s\S]*?\nend sub/)![0];
      expect(stopFn.trim()).to.equal('sub private_triggerStop()\n  m["$$ft_anim_popIn"].control = "stop"\nend sub'.trim());
    });

    it('a composed (sequential/parallel) Layer 1 animation refreshes every interpolator whose OWN effective target is inside the destroy block, not just the outermost', () => {
      const src = [
        '<script>',
        'field showCard: boolean = false',
        'animation combo {\n  target: card\n  sequential: true\n  steps: [\n    { opacity: [0, 1], duration: 0.2 },\n    { scale: [0.8, 1], duration: 0.2 }\n  ]\n}',
        'private function trigger() {\n  combo.start()\n}',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if:destroy showCard}',
        '<Rectangle id="card" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'Layer1ComposedDestroyRefresh');

      expect(result.xml).to.include('id="ft_anim_combo_ref_0"');
      expect(result.xml).to.include('id="ft_anim_combo_ref_1"');
      const triggerFn = result.brs.match(/sub private_trigger\(\)[\s\S]*?\nend sub/)![0];
      expect(triggerFn).to.include('m["$$ft_anim_combo_ref_0"].fieldToInterp = ""\n  m["$$ft_anim_combo_ref_0"].fieldToInterp = "card.opacity"');
      expect(triggerFn).to.include('m["$$ft_anim_combo_ref_1"].fieldToInterp = ""\n  m["$$ft_anim_combo_ref_1"].fieldToInterp = "card.scale"');
      expect(triggerFn).to.include('  m["$$ft_anim_combo"].control = "start"');

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });
  });

  describe('animation — animate:<field> auto-animates a reactive attribute write', () => {
    it('emits a per-site synthesized Animation node with a placeholder keyValue, and computes the real keyValue at the write site', () => {
      const src = [
        '<script>',
        'field opacityValue: float = 0.4',
        '</script>',
        '<component>',
        '<Poster id="poster" opacity="{opacityValue}" animate:opacity="{{duration: 200}}" />',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'AnimateBasic');

      expect(result.xml).to.include('id="ft_anim_animate_poster_opacity"');
      expect(result.xml).to.include('duration="200"');
      expect(result.xml).to.include('fieldToInterp="poster.opacity"');
      expect(result.brs).to.include('m["$$ft_anim_animate_poster_opacity"] = m.top.findNode("ft_anim_animate_poster_opacity")');

      // The reactive cascade handler (subsequent writes) never does a plain snap — only the
      // animated sequence. (init()'s own one-time initial assignment legitimately still snaps —
      // see the "still snaps instantly at the INITIAL value" test below.)
      const changeHandler = result.brs.match(/sub on_opacityValueChange\([\s\S]*?\nend sub/)![0];
      expect(changeHandler).to.not.include('m.poster.opacity = m.top.opacityValue');
      expect(changeHandler).to.include('ft_animate_from_poster_opacity = m.poster.opacity');
      expect(changeHandler).to.include('m["$$ft_anim_animate_poster_opacity"].GetChild(0).keyValue = [ft_animate_from_poster_opacity, m?.top?.opacityValue]');
      expect(changeHandler).to.include('m["$$ft_anim_animate_poster_opacity"].control = "start"');

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('still snaps instantly at the INITIAL value (init()), only subsequent cascade writes animate', () => {
      const src = [
        '<script>',
        'field opacityValue: float = 0.4',
        '</script>',
        '<component>',
        '<Poster id="poster" opacity="{opacityValue}" animate:opacity="" />',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'AnimateInitialSnap');
      const initSub = result.brs.match(/sub init\(\)[\s\S]*?\nend sub/)![0];
      expect(initSub).to.not.include('GetChild(0).keyValue');
      expect(initSub).to.include('m.poster.opacity =');
    });

    it('throws template/animate-without-dynamic-attribute when there is no matching dynamic attribute on the same element', () => {
      const src = ['<script>', '</script>', '<component>', '<Poster id="poster" animate:opacity="" />', '</component>'].join('\n');
      expect(() => compileThrSource(src, 'AnimateNoMatch')).to.throw().with.property('diagnostic').that.deep.include({ code: 'template/animate-without-dynamic-attribute' });
    });

    it('throws animation/unknown-animate-field for a field outside the known animatable set', () => {
      const src = ['<script>', 'field w: integer = 0', '</script>', '<component>', '<Rectangle id="r" width="{w}" animate:width="" />', '</component>'].join('\n');
      expect(() => compileThrSource(src, 'AnimateUnknownField')).to.throw().with.property('diagnostic').that.deep.include({ code: 'animation/unknown-animate-field' });
    });
  });

  describe('animation — .start()/.stop()/... trigger sugar reachable from on:key[...]', () => {
    it('lowers bounce.start() called from an on:key handler to a control field write on the generated Animation node', () => {
      const src = [
        '<script>',
        'animation bounce {\n  target: card\n  duration: 400\n  scale: [1, 1.15, 1]\n}',
        'private function play(key: string, press: boolean) {',
        '  bounce.start()',
        '}',
        '</script>',
        '<component>',
        '<Rectangle id="card" focusable="true" on:key[OK]="{play()}" />',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'AnimationTrigger');
      expect(result.brs).to.include('m["$$ft_anim_bounce"].control = "start"');
      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });
  });

  describe('animation — .onFinish(callback) hook', () => {
    it('lowers bounce.onFinish(onBounceDone) to a callback-storing field write, plus a shared state-change handler and a single init() registration', () => {
      const src = [
        '<script>',
        'animation bounce {\n  target: card\n  duration: 400\n  scale: [1, 1.15, 1]\n}',
        'private function play(key: string, press: boolean) {',
        '  bounce.start()',
        '  bounce.onFinish(onBounceDone)',
        '}',
        'private function onBounceDone() {}',
        '</script>',
        '<component>',
        '<Rectangle id="card" focusable="true" on:key[OK]="{play()}" />',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'AnimationOnFinishBasic');
      expect(result.brs).to.include('m["$$ft_animFinish_bounce"] = private_onBounceDone');
      expect(result.brs).to.include('sub on_bounce_StateChange(event as object)');
      expect(result.brs).to.include('if event.GetData() = "stopped" then');
      expect(result.brs).to.include('cb = m["$$ft_animFinish_bounce"]');
      expect(result.brs).to.include('if cb <> invalid then cb()');
      expect(result.brs).to.include('m["$$ft_anim_bounce"].ObserveFieldScoped("state", "on_bounce_StateChange")');
      // Registered exactly once in init(), not once per call site.
      expect(result.brs.split('ObserveFieldScoped("state", "on_bounce_StateChange")').length - 1).to.equal(1);
      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('accepts an inline anonymous function as the callback', () => {
      const src = [
        '<script>',
        'animation bounce {\n  target: card\n  duration: 400\n  scale: [1, 1.15, 1]\n}',
        'state bounced: boolean = false',
        'private function play(key: string, press: boolean) {',
        '  bounce.start()',
        '  bounce.onFinish(function() {',
        '    state bounced = true',
        '  })',
        '}',
        '</script>',
        '<component>',
        '<Rectangle id="card" focusable="true" on:key[OK]="{play()}" />',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'AnimationOnFinishInlineCallback');
      expect(result.brs).to.include('m["$$ft_animFinish_bounce"] = ft_anon_1');
      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('coexists with a Layer 2 out:/transition: attribute referencing the SAME declared animation name, without cross-wiring — the two mechanisms always act on distinct nodes (Layer 2 always synthesizes its own per-block copy, see animation-presets.ts\'s resolveTransitionAnimation), so each gets its own independent handler/registration', () => {
      const src = [
        '<script>',
        'field showPanel: boolean = false',
        'animation fade {\n  target: panel\n  duration: 300\n  opacity: [1, 0]\n}',
        'private function setup() {',
        '  fade.onFinish(onFadeDone)',
        '}',
        'private function onFadeDone() {}',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if showPanel}',
        '<Rectangle id="panel" out:fade="" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'AnimationOnFinishAlongsideTransition');
      // The onFinish callback fires from the REAL declared animation's own node/handler...
      expect(result.brs).to.include('m["$$ft_anim_fade"].ObserveFieldScoped("state", "on_fade_StateChange")');
      expect(result.brs).to.include('sub on_fade_StateChange(event as object)');
      expect(result.brs).to.include('cb = m["$$ft_animFinish_fade"]');
      expect(result.brs).to.include('if cb <> invalid then cb()');
      // ...while the out: transition drives its OWN synthesized per-block copy, on a DIFFERENT node,
      // via a DIFFERENTLY-named handler — never the literal "fade" node/handler above.
      expect(result.brs).to.include('m["$$ft_anim_if_1_out"].ObserveFieldScoped("state", "on_if_1_out_StateChange")');
      expect(result.brs).to.include('sub on_if_1_out_StateChange(event as object)');
      expect(result.brs).to.include('if not (m?.top?.showPanel) then');
      expect(result.brs).to.include('m["$$ft_if_1"].visible = false');
      // Neither handler's own body leaks the other's action.
      const fadeHandler = result.brs.match(/sub on_fade_StateChange\(event as object\)[\s\S]*?\nend sub/)![0];
      expect(fadeHandler).to.not.include('visible = false');
      const transitionHandler = result.brs.match(/sub on_if_1_out_StateChange\(event as object\)[\s\S]*?\nend sub/)![0];
      expect(transitionHandler).to.not.include('ft_animFinish_fade');
      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('two different blocks independently referencing the same declared animation name via out: each get their own synthesized node/handler (never share one, so there is nothing to clobber)', () => {
      const src = [
        '<script>',
        'field showA: boolean = false',
        'field showB: boolean = false',
        'animation fade {\n  target: a\n  duration: 300\n  opacity: [1, 0]\n}',
        '</script>',
        '<component>',
        '<LayoutGroup id="root">',
        '{#if showA}',
        '<Rectangle id="a" out:fade="" />',
        '{/if}',
        '{#if showB}',
        '<Rectangle id="b" out:fade="" />',
        '{/if}',
        '</LayoutGroup>',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'AnimationSharedOutNameTwoBlocks');
      expect(result.brs).to.include('sub on_if_1_out_StateChange(event as object)');
      expect(result.brs).to.include('sub on_if_2_out_StateChange(event as object)');
      expect(result.brs).to.include('if not (m?.top?.showA) then');
      expect(result.brs).to.include('if not (m?.top?.showB) then');
      expect(result.brs).to.include('m["$$ft_if_1"].visible = false');
      expect(result.brs).to.include('m["$$ft_if_2"].visible = false');
      // Each block's own registration targets its OWN synthesized node, never the shared "fade" one.
      expect(result.brs).to.include('m["$$ft_anim_if_1_out"].ObserveFieldScoped("state", "on_if_1_out_StateChange")');
      expect(result.brs).to.include('m["$$ft_anim_if_2_out"].ObserveFieldScoped("state", "on_if_2_out_StateChange")');
      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('throws animation/repeat-not-supported-with-onfinish when the target animation declares repeat: true anywhere in its step tree', () => {
      const src = [
        '<script>',
        'animation pulse {\n  target: card\n  duration: 400\n  repeat: true\n  scale: [1, 1.1, 1]\n}',
        'private function play(key: string, press: boolean) {',
        '  pulse.start()',
        '  pulse.onFinish(onPulseDone)',
        '}',
        'private function onPulseDone() {}',
        '</script>',
        '<component>',
        '<Rectangle id="card" focusable="true" on:key[OK]="{play()}" />',
        '</component>',
      ].join('\n');
      expect(() => compileThrSource(src, 'AnimationOnFinishRepeat')).to.throw().with.property('diagnostic').that.deep.include({ code: 'animation/repeat-not-supported-with-onfinish' });
    });

    it('throws expression/animation-onfinish-call-must-be-statement when nested inside a larger expression', () => {
      const src = [
        '<script>',
        'animation bounce {\n  target: card\n  duration: 400\n  scale: [1, 1.15, 1]\n}',
        'private function play(key: string, press: boolean) {',
        '  x = bounce.onFinish(onBounceDone)',
        '}',
        'private function onBounceDone() {}',
        '</script>',
        '<component>',
        '<Rectangle id="card" focusable="true" on:key[OK]="{play()}" />',
        '</component>',
      ].join('\n');
      expect(() => compileThrSource(src, 'AnimationOnFinishNested'))
        .to.throw()
        .with.property('diagnostic')
        .that.deep.include({ code: 'expression/animation-onfinish-call-must-be-statement' });
    });
  });

  describe('router outlet transitions — navigate-out:/navigate-in:/back-out:/back-in: on <FlashTheaterRouterOutlet>', () => {
    function outletSource(outletAttrs: string): string {
      return [
        '<script>',
        'animation slideOutLeft { target: outlet, duration: 0.25, translation: [[0, 0], [-1280, 0]] }',
        'animation slideInFromRight { target: outlet, duration: 0.25, translation: [[1280, 0], [0, 0]] }',
        'animation slideOutRight { target: outlet, duration: 0.25, translation: [[0, 0], [1280, 0]] }',
        'animation slideInFromLeft { target: outlet, duration: 0.25, translation: [[-1280, 0], [0, 0]] }',
        '</script>',
        '<component>',
        `<FlashTheaterRouterOutlet id="outlet" ${outletAttrs} />`,
        '</component>',
      ].join('\n');
    }

    it('a bare navigate-out:slideOutLeft (no ="") compiles identically to navigate-out:slideOutLeft=""', () => {
      const withEquals = outletSource('navigate-out:slideOutLeft=""');
      const bare = outletSource('navigate-out:slideOutLeft');
      const a = compileThrSource(withEquals, 'RouterOutletTransitionsBareEquals');
      const b = compileThrSource(bare, 'RouterOutletTransitionsBareBare');
      expect(a.xml.replace(/RouterOutletTransitionsBareEquals/g, 'X')).to.equal(b.xml.replace(/RouterOutletTransitionsBareBare/g, 'X'));
      expect(a.brs.replace(/RouterOutletTransitionsBareEquals/g, 'X')).to.equal(b.brs.replace(/RouterOutletTransitionsBareBare/g, 'X'));
    });

    it('wires all four resolved animations onto the outlet\'s own ft_*Anim fields in init(), caching each animation node once', () => {
      const src = outletSource(
        'navigate-out:slideOutLeft="" navigate-in:slideInFromRight="" back-out:slideOutRight="" back-in:slideInFromLeft=""',
      );
      const result = compileThrSource(src, 'RouterOutletTransitionsBasic');

      expect(result.xml).to.include('id="ft_anim_outlet_navigate_out"');
      expect(result.xml).to.include('id="ft_anim_outlet_navigate_in"');
      expect(result.xml).to.include('id="ft_anim_outlet_back_out"');
      expect(result.xml).to.include('id="ft_anim_outlet_back_in"');
      expect(result.xml).to.include('fieldToInterp="outlet.translation"');

      expect(result.brs).to.include('m["$$ft_anim_outlet_navigate_out"] = m.top.findNode("ft_anim_outlet_navigate_out")');
      expect(result.brs).to.include('m.outlet.ft_navigateOutAnim = m["$$ft_anim_outlet_navigate_out"]');
      expect(result.brs).to.include('m.outlet.ft_navigateInAnim = m["$$ft_anim_outlet_navigate_in"]');
      expect(result.brs).to.include('m.outlet.ft_backOutAnim = m["$$ft_anim_outlet_back_out"]');
      expect(result.brs).to.include('m.outlet.ft_backInAnim = m["$$ft_anim_outlet_back_in"]');

      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('does NOT reverse a declared animation used as navigate-out:/back-out: — each direction is its own independently-authored animation, unlike Layer 2\'s shared in:/out:', () => {
      const src = outletSource(
        'navigate-out:slideOutLeft="" navigate-in:slideInFromRight="" back-out:slideOutRight="" back-in:slideInFromLeft=""',
      );
      const result = compileThrSource(src, 'RouterOutletTransitionsNoAutoReverse');

      // Regression test for a live bug: resolveTransitionAnimation's Layer-2-only "reverse a
      // declared animation on out:" convention was, before this fix, also applied here — flipping
      // an already rest→off-screen animation (slideOutLeft) into an off-screen→rest one, which
      // manifested live as an instant snap off-screen followed by a visible slide back to rest
      // instead of a smooth slide-out. See resolveTransitionAnimation's own doc comment.
      expect(result.xml).to.not.include('reverse="true"');
    });

    it('still reverses a PRESET used as navigate-out:/back-out: (unaffected by the declared-animation fix above)', () => {
      const src = ['<script>', '</script>', '<component>', '<FlashTheaterRouterOutlet id="outlet" navigate-out:slide="" />', '</component>'].join('\n');
      const result = compileThrSource(src, 'RouterOutletTransitionsPresetStillReverses', { globalBindings: { theme: null, designResolutionConfigured: true } });

      expect(result.xml).to.include('reverse="true"');
    });

    it('leaves an unconfigured direction/phase\'s field untouched (no wiring line at all)', () => {
      const src = outletSource('navigate-out:slideOutLeft=""');
      const result = compileThrSource(src, 'RouterOutletTransitionsPartial');

      expect(result.brs).to.include('m.outlet.ft_navigateOutAnim = m["$$ft_anim_outlet_navigate_out"]');
      expect(result.brs).to.not.include('ft_navigateInAnim');
      expect(result.brs).to.not.include('ft_backOutAnim');
      expect(result.brs).to.not.include('ft_backInAnim');
    });

    it('passes width/height/loadingComponent/loadingMinDuration/loadingTimeout straight through as plain static XML attributes', () => {
      const src = outletSource('width="1280" height="720" loadingComponent="BusySpinner" loadingMinDuration="0.2" loadingTimeout="5"');
      const result = compileThrSource(src, 'RouterOutletLoadingAttrs');

      expect(result.xml).to.include('width="1280"');
      expect(result.xml).to.include('height="720"');
      expect(result.xml).to.include('loadingComponent="BusySpinner"');
      expect(result.xml).to.include('loadingMinDuration="0.2"');
      expect(result.xml).to.include('loadingTimeout="5"');
    });

    it('throws router/transition-outside-outlet when a navigate-out:/etc. attribute is on a non-outlet element', () => {
      const src = ['<script>', 'animation slide { target: panel, duration: 0.2, opacity: [0, 1] }', '</script>', '<component>', '<Rectangle id="panel" navigate-out:slide="" />', '</component>'].join(
        '\n',
      );
      expect(() => compileThrSource(src, 'RouterTransitionOutsideOutlet'))
        .to.throw()
        .with.property('diagnostic')
        .that.deep.include({ code: 'router/transition-outside-outlet' });
    });

    it('throws router/duplicate-transition-attribute when the same outlet declares two navigate-out: attributes', () => {
      const src = [
        '<script>',
        'animation a { target: outlet, duration: 0.2, opacity: [0, 1] }',
        'animation b { target: outlet, duration: 0.2, opacity: [1, 0] }',
        '</script>',
        '<component>',
        '<FlashTheaterRouterOutlet id="outlet" navigate-out:a="" navigate-out:b="" />',
        '</component>',
      ].join('\n');
      expect(() => compileThrSource(src, 'RouterTransitionDuplicate'))
        .to.throw()
        .with.property('diagnostic')
        .that.deep.include({ code: 'router/duplicate-transition-attribute' });
    });

    it('throws router/transition-target-must-be-outlet when a custom animation used as navigate-out: targets something other than the outlet itself', () => {
      const src = [
        '<script>',
        'animation slideAway { target: somethingElse, duration: 0.2, opacity: [1, 0] }',
        '</script>',
        '<component>',
        '<FlashTheaterRouterOutlet id="outlet" navigate-out:slideAway="" />',
        '<Rectangle id="somethingElse" />',
        '</component>',
      ].join('\n');
      expect(() => compileThrSource(src, 'RouterTransitionWrongTarget'))
        .to.throw()
        .with.property('diagnostic')
        .that.deep.include({ code: 'router/transition-target-must-be-outlet' });
    });

    it('throws router/repeat-not-supported-for-exit-transition for "repeat: true" on navigate-out:', () => {
      const src = [
        '<script>',
        'animation slideOutRepeat { target: outlet, duration: 0.25, repeat: true, translation: [[0, 0], [-1280, 0]] }',
        '</script>',
        '<component>',
        '<FlashTheaterRouterOutlet id="outlet" navigate-out:slideOutRepeat="" />',
        '</component>',
      ].join('\n');
      expect(() => compileThrSource(src, 'RouterExitRepeatNavigateOut'))
        .to.throw()
        .with.property('diagnostic')
        .that.deep.include({ code: 'router/repeat-not-supported-for-exit-transition' });
    });

    it('throws router/repeat-not-supported-for-exit-transition for "repeat: true" on back-out: too', () => {
      const src = [
        '<script>',
        'animation slideOutRepeat { target: outlet, duration: 0.25, repeat: true, translation: [[0, 0], [1280, 0]] }',
        '</script>',
        '<component>',
        '<FlashTheaterRouterOutlet id="outlet" back-out:slideOutRepeat="" />',
        '</component>',
      ].join('\n');
      expect(() => compileThrSource(src, 'RouterExitRepeatBackOut'))
        .to.throw()
        .with.property('diagnostic')
        .that.deep.include({ code: 'router/repeat-not-supported-for-exit-transition' });
    });

    it('throws router/repeat-not-supported-for-exit-transition for "repeat: true" nested inside a sequential/parallel composition used as navigate-out:', () => {
      const src = [
        '<script>',
        'animation slideOutSeq {\n  target: outlet\n  sequential: true\n  steps: [\n    { translation: [[0, 0], [-640, 0]], duration: 0.15 },\n    { translation: [[-640, 0], [-1280, 0]], duration: 0.15, repeat: true }\n  ]\n}',
        '</script>',
        '<component>',
        '<FlashTheaterRouterOutlet id="outlet" navigate-out:slideOutSeq="" />',
        '</component>',
      ].join('\n');
      expect(() => compileThrSource(src, 'RouterExitRepeatNested'))
        .to.throw()
        .with.property('diagnostic')
        .that.deep.include({ code: 'router/repeat-not-supported-for-exit-transition' });
    });

    it('throws router/repeat-not-supported-for-exit-transition for "repeat: true" on a preset override used as navigate-out:', () => {
      const src = ['<script>', '</script>', '<component>', '<FlashTheaterRouterOutlet id="outlet" navigate-out:slide="{{repeat: true}}" />', '</component>'].join('\n');
      expect(() => compileThrSource(src, 'RouterExitRepeatPreset', { globalBindings: { theme: null, designResolutionConfigured: true } }))
        .to.throw()
        .with.property('diagnostic')
        .that.deep.include({ code: 'router/repeat-not-supported-for-exit-transition' });
    });

    it('does NOT reject "repeat: true" on navigate-in:/back-in: — only the exit (out:) side depends on ever reaching state="stopped"', () => {
      const src = [
        '<script>',
        'animation slideInRepeat { target: outlet, duration: 0.25, repeat: true, translation: [[1280, 0], [0, 0]] }',
        '</script>',
        '<component>',
        '<FlashTheaterRouterOutlet id="outlet" navigate-in:slideInRepeat="" back-in:slideInRepeat="" />',
        '</component>',
      ].join('\n');
      expect(() => compileThrSource(src, 'RouterInRepeatAllowed')).to.not.throw();
    });
  });

  describe('router.markReady() — a plain field assignment, not a callFunc into the router singleton', () => {
    it('compiles to "m.top.ft_routeReady = true"', () => {
      const src = [
        '<script>',
        'private function onFetched() {',
        '  router.markReady()',
        '}',
        '</script>',
        '<component>',
        '<Label id="label" />',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'MarkReadyBasic');
      expect(result.brs).to.include('m.top.ft_routeReady = true');
      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('every compiled component declares ft_routeReady unconditionally, even one that never uses the router at all, defaulting to false', () => {
      const src = ['<script>', 'field label: string = "hi"', '</script>', '<component>', '<Label id="label" text="{label}" />', '</component>'].join('\n');
      const result = compileThrSource(src, 'NoRouterUsage');
      // false, not true: FlashTheaterRouterOutlet.brs's own loading gate relies on this default to
      // tell "setup() already called router.markReady() synchronously" apart from "never called it
      // at all" — both would read back `true` after setup() if the compiled default were also
      // `true`, which is exactly what caused a live bug (a synchronous markReady() call getting
      // silently lost). See that runtime asset's own _mountRouteImmediate doc comment and
      // findings/router-transitions.md.
      expect(result.xml).to.include('<field id="ft_routeReady" type="boolean" value="false" />');
    });

    it('throws expression/router-mark-ready-must-be-statement when nested inside a larger expression', () => {
      const src = ['<script>', 'private function onFetched() {', '  x = router.markReady()', '}', '</script>', '<component>', '<Label id="label" />', '</component>'].join('\n');
      expect(() => compileThrSource(src, 'MarkReadyNested'))
        .to.throw()
        .with.property('diagnostic')
        .that.deep.include({ code: 'expression/router-mark-ready-must-be-statement' });
    });

    it('throws expression/invalid-router-mark-ready-arguments when called with an argument', () => {
      const src = ['<script>', 'private function onFetched() {', '  router.markReady(true)', '}', '</script>', '<component>', '<Label id="label" />', '</component>'].join('\n');
      expect(() => compileThrSource(src, 'MarkReadyWithArgs'))
        .to.throw()
        .with.property('diagnostic')
        .that.deep.include({ code: 'expression/invalid-router-mark-ready-arguments' });
    });
  });

  describe('setTimeout / setInterval / clearTimeout / clearInterval', () => {
    function source(scriptBody: string): string {
      return ['<script>', scriptBody, '</script>', '<component>', '<Label id="out" />', '</component>'].join('\n');
    }

    it('lowers a literal-ms setTimeout(...) to CreateObject/duration/registry/ObserveFieldScoped/control="start" — the load-bearing ms->seconds conversion check', () => {
      const src = source(['state ready: boolean = false', 'public function setup() {', '  setTimeout(function() {', '    state ready = true', '  }, 1000)', '}'].join('\n'));
      const result = compileThrSource(src, 'TimerSetTimeoutBasic');
      expect(result.brs).to.include('ft_timer_1 = CreateObject("roSGNode", "Timer")');
      expect(result.brs).to.include('ft_timer_1.id = "ft_timer_1"');
      // The regression test for this repo's own prior seconds-vs-ms mistake (findings/animation.md) —
      // 1000ms must fold to exactly 1.0 seconds, not passed through unconverted.
      expect(result.brs).to.include('ft_timer_1.duration = 1.0');
      expect(result.brs).to.not.include('ft_timer_1.repeat');
      expect(result.brs).to.include('m["$$ft_timerCallbacks"]["ft_timer_1"] = { node: ft_timer_1, callback: ft_anon_1, repeat: false }');
      expect(result.brs).to.include('ft_timer_1.ObserveFieldScoped("fire", "on_timerFire")');
      expect(result.brs).to.include('ft_timer_1.control = "start"');
      // A bare, handle-discarded statement leaves nothing behind at the original call site.
      expect(result.brs).to.not.match(/\bft_timer_1\s*$/m);
    });

    it('captures the returned handle when setTimeout(...) is the RHS of a plain assignment', () => {
      const src = source(['public function setup() {', '  t = setTimeout(onFire, 500)', '}', 'private function onFire() {', '  print "fired"', '}'].join('\n'));
      const result = compileThrSource(src, 'TimerSetTimeoutHandle');
      expect(result.brs).to.include('t = ft_timer_1');
      expect(result.brs).to.include('m["$$ft_timerCallbacks"]["ft_timer_1"] = { node: ft_timer_1, callback: private_onFire, repeat: false }');
    });

    it('setInterval(...) sets repeat = true and stores repeat: true in the registry entry', () => {
      const src = source(['public function setup() {', '  m.pollHandle = setInterval(onPoll, 500)', '}', 'private function onPoll() {', '  print "poll"', '}'].join('\n'));
      const result = compileThrSource(src, 'TimerSetIntervalBasic');
      expect(result.brs).to.include('ft_timer_1.duration = 0.5');
      expect(result.brs).to.include('ft_timer_1.repeat = true');
      expect(result.brs).to.include('m["$$ft_timerCallbacks"]["ft_timer_1"] = { node: ft_timer_1, callback: private_onPoll, repeat: true }');
      expect(result.brs).to.include('m.pollHandle = ft_timer_1');
    });

    it('divides an arbitrary (non-literal) duration expression at runtime instead of folding it', () => {
      const src = source(
        ['field baseDelayMs: integer = 250', 'public function setup() {', '  setTimeout(onFire, baseDelayMs + 250)', '}', 'private function onFire() {', '  print "fired"', '}'].join('\n'),
      );
      const result = compileThrSource(src, 'TimerArbitraryDuration');
      expect(result.brs).to.include('ft_timer_1.duration = (m?.top?.baseDelayMs + 250) / 1000.0');
    });

    it('throws expression/invalid-timer-duration for a non-positive literal duration', () => {
      const src = source(['public function setup() {', '  setTimeout(onFire, 0)', '}', 'private function onFire() {', '  print "fired"', '}'].join('\n'));
      expect(() => compileThrSource(src, 'TimerZeroDuration')).to.throw().with.property('diagnostic').that.deep.include({ code: 'expression/invalid-timer-duration' });
    });

    it('throws expression/invalid-set-timeout-arguments for the wrong argument count', () => {
      const src = source(['public function setup() {', '  setTimeout(onFire)', '}', 'private function onFire() {', '  print "fired"', '}'].join('\n'));
      expect(() => compileThrSource(src, 'TimerWrongArgCount')).to.throw().with.property('diagnostic').that.deep.include({ code: 'expression/invalid-set-timeout-arguments' });
    });

    it('throws expression/timer-call-must-be-standalone-or-assignment-rhs when nested inside a larger expression', () => {
      const src = source(['public function setup() {', '  print setTimeout(onFire, 500)', '}', 'private function onFire() {', '  print "fired"', '}'].join('\n'));
      expect(() => compileThrSource(src, 'TimerNestedCall')).to.throw().with.property('diagnostic').that.deep.include({ code: 'expression/timer-call-must-be-standalone-or-assignment-rhs' });
    });

    it('throws expression/timer-call-in-reactive-expression when used inside a derived', () => {
      const src = source(['derived x: integer = setTimeout(onFire, 500)', 'private function onFire() {', '  print "fired"', '}'].join('\n'));
      expect(() => compileThrSource(src, 'TimerInDerived')).to.throw().with.property('diagnostic').that.deep.include({ code: 'expression/timer-call-in-reactive-expression' });
    });

    it('clearTimeout(...)/clearInterval(...) splice into the delete-then-stop colon-chain at full-compile time', () => {
      const src = source(
        ['public function setup() {', '  m.pollHandle = setInterval(onPoll, 500)', '}', 'private function onPoll() {', '  print "poll"', '}', 'private function halt() {', '  clearInterval(m.pollHandle)', '}'].join('\n'),
      );
      const result = compileThrSource(src, 'TimerClearInterval');
      expect(result.brs).to.include('ft_timerHandle = m?.pollHandle : m["$$ft_timerCallbacks"].Delete(ft_timerHandle?.id) : ft_timerHandle.control = "stop"');
    });

    it('a component using setTimeout gets the shared registry init line, the on_timerFire trampoline, and an unmount-time force-stop loop', () => {
      const src = source(['public function setup() {', '  setTimeout(onFire, 500)', '}', 'private function onFire() {', '  print "fired"', '}'].join('\n'));
      const result = compileThrSource(src, 'TimerUnmountIntegration');
      expect(result.brs).to.include('sub init()\n  m.out = m.top.findNode("out")\n  m["$$ft_timerCallbacks"] = {}\nend sub');
      expect(result.brs).to.include('sub on_timerFire(event as object)');
      expect(result.brs).to.include(
        ['sub ft_unmount()', '  for each ft_key in m["$$ft_timerCallbacks"]', '    ft_entry = m["$$ft_timerCallbacks"][ft_key]', '    if ft_entry.node <> invalid then ft_entry.node.control = "stop"', '  end for', '  m["$$ft_timerCallbacks"] = {}', '  if m.out <> invalid then m.out.callFunc("ft_unmount")', 'end sub'].join('\n'),
      );
    });

    it('a component that never uses a timer gets no registry/trampoline machinery, just the plain empty ft_unmount cascade', () => {
      const src = source(['public function setup() {', '  print "no timers here"', '}'].join('\n'));
      const result = compileThrSource(src, 'TimerUnused');
      expect(result.brs).to.not.include('ft_timerCallbacks');
      expect(result.brs).to.not.include('on_timerFire');
      expect(result.brs).to.include('sub ft_unmount()\n  if m.out <> invalid then m.out.callFunc("ft_unmount")\nend sub');
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const src = source(
        [
          'state ready: boolean = false',
          'public function setup() {',
          '  t = setTimeout(function() {',
          '    state ready = true',
          '  }, 1500)',
          '  m.pollHandle = setInterval(onPoll, 500)',
          '}',
          'private function onPoll() {',
          '  print "poll"',
          '}',
          'private function halt() {',
          '  clearTimeout(m.pollHandle)',
          '  clearInterval(m.pollHandle)',
          '}',
        ].join('\n'),
      );
      const result = compileThrSource(src, 'TimerValidBrs');
      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    // Regression tests for a live bug: a bare, handle-discarded setTimeout(...) shares its own
    // StatementRegion with any OTHER bare statement immediately next to it in source (the DSL's own
    // opaque-scan statement splitter bundles consecutive bare statements into one region — see
    // analysis/unused-locals.ts's elideUnusedLocalAssignments doc comment for the same documented
    // reality) — the elision check used to require the WHOLE region to reduce to just the temp name,
    // so any neighboring statement left a bare, invalid `ft_timer_N` reference sitting on its own
    // line in the generated .brs. validateGeneratedBrs's own lenient parser didn't catch it; Roku's
    // real device compiler rejected it outright. See findings/timer-statements.md.
    it('elides a bare setTimeout(...) even when a second statement immediately follows it in the same region', () => {
      const src = source(['public function setup() {', '  setTimeout(onFire, 500)', '  print "after"', '}', 'private function onFire() {', '  print "fired"', '}'].join('\n'));
      const result = compileThrSource(src, 'TimerElisionFollowedBySecondStatement');
      expect(result.brs).to.not.match(/^\s*ft_timer_1\s*$/m);
      expect(result.brs).to.include('print "after"');
      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('elides a bare setTimeout(...) even when a second statement immediately PRECEDES it in the same region', () => {
      const src = source(['public function setup() {', '  print "before"', '  setTimeout(onFire, 500)', '}', 'private function onFire() {', '  print "fired"', '}'].join('\n'));
      const result = compileThrSource(src, 'TimerElisionPrecededBySecondStatement');
      expect(result.brs).to.not.match(/^\s*ft_timer_1\s*$/m);
      expect(result.brs).to.include('print "before"');
      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('elides TWO bare setTimeout(...) calls sharing one region, each independently, with nothing else in the function', () => {
      const src = source(['public function setup() {', '  setTimeout(onFire, 500)', '  setTimeout(onFire, 700)', '}', 'private function onFire() {', '  print "fired"', '}'].join('\n'));
      const result = compileThrSource(src, 'TimerElisionTwoBareCalls');
      expect(result.brs).to.not.match(/^\s*ft_timer_1\s*$/m);
      expect(result.brs).to.not.match(/^\s*ft_timer_2\s*$/m);
      expect(result.brs).to.include('ft_timer_1.control = "start"');
      expect(result.brs).to.include('ft_timer_2.control = "start"');
      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });

    it('elides a bare setTimeout(...) next to router.markReady() — the exact shape that live-crashed on a real device', () => {
      const src = [
        '<script>',
        'public function setup() {',
        '  setTimeout(function() {',
        '    m.top.visible = true',
        '  }, 1500)',
        '  router.markReady()',
        '}',
        '</script>',
        '<component>',
        '<Label id="out" />',
        '</component>',
      ].join('\n');
      const result = compileThrSource(src, 'TimerElisionMarkReady');
      expect(result.brs).to.not.match(/^\s*ft_timer_1\s*$/m);
      expect(result.brs).to.include('m.top.ft_routeReady = true');
      const validated = validateGeneratedBrs(result.brs);
      expect(validated.diagnostics, JSON.stringify(validated.diagnostics)).to.deep.equal([]);
    });
  });

  describe('raw-block-basic (raw BrightScript passthrough — declaration-level and function-body statement-level)', () => {
    const fixtureDir = '../golden/raw-block-basic';
    const actual = compileFixture(fixtureDir, 'RawBlockBasic');

    it('matches expected.xml exactly', () => {
      expect(actual.xml).to.equal(readExpected(fixtureDir, 'expected.xml'));
    });

    it('matches expected.brs exactly', () => {
      expect(actual.brs).to.equal(readExpected(fixtureDir, 'expected.brs'));
    });

    it('appends a declaration-level raw block into init(), last, wrapped in both markers, completely unrewritten', () => {
      expect(actual.brs).to.include(['sub init()', '  m.root = m.top.findNode("root")'].join('\n'));
      expect(actual.brs).to.include(["  ' flash-theater:raw", '  m.top.limit = m.top.limit + 1', "  ' flash-theater:end-raw", 'end sub'].join('\n'));
    });

    it('prints a function-body raw block wrapped in both markers, with a reference to an undeclared name left completely untouched (no identifier-rewrite)', () => {
      expect(actual.brs).to.include(
        [
          'function private_describe() as string',
          "  ' flash-theater:raw",
          '  result = "limit is " + someUndeclaredHelperName().ToStr()',
          "  ' flash-theater:end-raw",
          '  return result',
          'end function',
        ].join('\n'),
      );
    });

    it('produces .brs that parses as valid BrightScript with zero diagnostics', () => {
      const result = validateGeneratedBrs(actual.brs);
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.deep.equal([]);
    });
  });

  describe('raw block — never reaches identifier-rewrite (regression)', () => {
    it('compiles successfully with a bare undeclared name inside a raw block, where the same name outside one would fail', () => {
      const withRaw = [
        '<script>',
        'private function f() {',
        "  ' flash-theater:raw",
        '  print totallyUndeclaredName',
        "  ' flash-theater:end-raw",
        '}',
        '</script>',
        '<component>',
        '<Rectangle id="a" />',
        '</component>',
        '',
      ].join('\n');
      expect(() => compileThrSource(withRaw, 'RawBlockBypassesRewrite')).to.not.throw();

      const withoutRaw = withRaw.replace(/' flash-theater:(end-)?raw\n/g, '');
      expect(() => compileThrSource(withoutRaw, 'RawBlockBypassesRewriteControl')).to.throw(CompileError);
    });
  });
});
