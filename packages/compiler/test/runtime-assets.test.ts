import { expect } from 'chai';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseBrightScript, parseSceneGraphXml } from 'kopytko-brightscript-parser';

/**
 * Every hand-authored runtime asset under `packages/compiler/runtime-assets/` (Store,
 * FocusManager, Router, RouterOutlet, ...) must itself be valid BrightScript/SceneGraph XML —
 * these files are copied verbatim into an app's output by `cli.ts`, never compiled/validated by
 * this package's own pipeline the way a `.thr` file is, so nothing else in this test suite would
 * ever catch a syntax error in one of them.
 */
const RUNTIME_ASSETS_DIR = join(__dirname, '..', 'runtime-assets');

function listAssetDirs(): string[] {
  return readdirSync(RUNTIME_ASSETS_DIR).filter((name) => statSync(join(RUNTIME_ASSETS_DIR, name)).isDirectory());
}

describe('runtime-assets — every hand-authored .xml/.brs pair is valid', () => {
  for (const assetDir of listAssetDirs()) {
    const dirPath = join(RUNTIME_ASSETS_DIR, assetDir);
    const brsFiles = readdirSync(dirPath).filter((f) => f.endsWith('.brs'));
    const xmlFiles = readdirSync(dirPath).filter((f) => f.endsWith('.xml'));

    for (const brsFile of brsFiles) {
      it(`${assetDir}/${brsFile} parses as valid BrightScript with zero diagnostics`, () => {
        const source = readFileSync(join(dirPath, brsFile), 'utf8');
        const result = parseBrightScript(source);
        expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.have.lengthOf(0);
      });
    }

    for (const xmlFile of xmlFiles) {
      it(`${assetDir}/${xmlFile} parses as valid SceneGraph XML`, () => {
        const source = readFileSync(join(dirPath, xmlFile), 'utf8');
        const element = parseSceneGraphXml(source);
        expect(element, 'XML failed to parse').to.not.be.undefined;
      });
    }
  }
});

/**
 * A structural regression guard, not a behavioral test — this package has no BrightScript
 * execution harness, so the actual behavior below is verified live on a real device (see
 * findings/focus-system.md's "the vacuum rule" and findings/router.md). What CAN be checked here
 * is that the specific guard the fix depends on hasn't been silently deleted or rewritten away.
 */
describe('Router/FlashTheaterRouter.brs — no phantom first history entry', () => {
  const source = readFileSync(join(RUNTIME_ASSETS_DIR, 'Router', 'FlashTheaterRouter.brs'), 'utf8');

  it('never pushes a snapshot of the uninitialized sentinel route onto history', () => {
    // Confirmed live as a real bug before this guard existed: the very FIRST navigate() call in an
    // app's whole lifetime pushed a snapshot of the router's own init()-time sentinel (path = "")
    // onto history — nothing ever matches an empty path, so a single "back" press on the very
    // first screen popped it and left the entire app blank, with no way back or forward. See
    // findings/router.md.
    expect(source).to.match(/m\.top\.activatedRoute\.path\s*<>\s*""/);
  });
});

/**
 * Structural regression guard for `ft_scale`'s AA branch — see GRAMMAR.md's "scale" section and
 * findings/scale-config-and-codegen.md. No BrightScript execution harness exists in this package, so this stays a
 * text-structure assertion (mirrors the array branch immediately above it), not a behavior test.
 */
describe('Scale/FlashTheaterScale.brs — roAssociativeArray branch scales per-key, one level deep, without mutating the input', () => {
  const source = readFileSync(join(RUNTIME_ASSETS_DIR, 'Scale', 'FlashTheaterScale.brs'), 'utf8');

  it('branches on roAssociativeArray and builds a fresh AA rather than mutating the input in place', () => {
    expect(source).to.include('valueType = "roAssociativeArray"');
    const aaBranch = source.slice(source.indexOf('if valueType = "roAssociativeArray"'), source.indexOf('return value\nend function'));
    expect(aaBranch).to.include('result = {}');
    expect(aaBranch).to.include('return result');
  });
});

/**
 * A structural regression guard for the task manager's single-decrement-path invariant — see
 * findings/task-manager-core.md. `cancel()`'s running-task branch must only ever set `control = "STOP"`
 * and leave `m.active`/`runningCount` alone; the actual decrement happens exclusively in
 * `releaseSlotById` (reached via `onTaskStateChange` once the real `state` field confirms the task
 * left "run"). If `cancel()` ever starts mutating `m.active` directly too, a cancelled-but-not-yet-
 * stopped task could be double-counted or double-drained. No BrightScript execution harness exists
 * in this package, so this stays a text-structure assertion, not a behavior test.
 */
describe('TaskManager/FlashTheaterTaskManager.brs — cancel() never itself mutates m.active', () => {
  const source = readFileSync(join(RUNTIME_ASSETS_DIR, 'TaskManager', 'FlashTheaterTaskManager.brs'), 'utf8');

  it('the running-task branch only sets control = "STOP"', () => {
    const cancelBody = source.slice(source.indexOf('sub cancel('), source.indexOf('end sub', source.indexOf('sub cancel(')));
    expect(cancelBody).to.include('.control = "STOP"');
    expect(cancelBody).to.not.include('m.active.Delete');
    expect(cancelBody).to.not.include('m.top.runningCount');
  });

  it('m.active is only ever shrunk from releaseSlotById', () => {
    const shrinkSites = [...source.matchAll(/m\.active\.Delete\(/g)];
    expect(shrinkSites).to.have.lengthOf(1);
  });
});

/**
 * Structural regression guards for the priority queue and alert hysteresis — again a text-structure
 * check, not a behavior test (no BrightScript execution harness exists in this package). See
 * findings/task-manager-core.md.
 */
describe('TaskManager/FlashTheaterTaskManager.brs — priority draining order and alert hysteresis', () => {
  const source = readFileSync(join(RUNTIME_ASSETS_DIR, 'TaskManager', 'FlashTheaterTaskManager.brs'), 'utf8');

  it('dequeueNext checks queueHigh before queueNormal before queueLow', () => {
    const fnBody = source.slice(source.indexOf('function dequeueNext('), source.indexOf('end function', source.indexOf('function dequeueNext(')));
    const highIdx = fnBody.indexOf('m.queueHigh');
    const normalIdx = fnBody.indexOf('m.queueNormal');
    const lowIdx = fnBody.indexOf('m.queueLow');
    expect(highIdx).to.be.greaterThan(-1);
    expect(normalIdx).to.be.greaterThan(highIdx);
    expect(lowIdx).to.be.greaterThan(normalIdx);
  });

  it('reevaluateAlertLevel only writes alertLevel when it actually changed (hysteresis)', () => {
    const fnBody = source.slice(source.indexOf('sub reevaluateAlertLevel('), source.indexOf('end sub', source.indexOf('sub reevaluateAlertLevel(')));
    expect(fnBody).to.match(/if\s+newLevel\s*=\s*m\.alertLevel\s+then\s+return/);
  });

  it('setQueuedCount is the only writer of m.top.queuedCount outside init()', () => {
    const afterInit = source.slice(source.indexOf('end sub')); // past init()'s own closer
    const writeSites = [...afterInit.matchAll(/m\.top\.queuedCount\s*=/g)];
    expect(writeSites).to.have.lengthOf(1); // inside setQueuedCount itself
  });
});

/**
 * Structural regression guards for the global request/response interceptor firing points
 * (`taskManager.onRequestSent`/`onResponseReceived`, see GRAMMAR.md's "Task manager" section) —
 * again a text-structure check, not a behavior test. See findings/task-manager-request-interceptors.md.
 */
describe('TaskManager/FlashTheaterTaskManager.brs — request/response interceptor firing (startNode/on_ft_taskManagerRawResponse)', () => {
  const source = readFileSync(join(RUNTIME_ASSETS_DIR, 'TaskManager', 'FlashTheaterTaskManager.brs'), 'utf8');

  it('startNode() attaches the state observer unconditionally, BEFORE the ft_isRequestComponent-gated interceptor block, and sets control="RUN" last', () => {
    const fnBody = source.slice(source.indexOf('sub startNode('), source.indexOf('end sub', source.indexOf('sub startNode(')));
    const stateObserveIdx = fnBody.indexOf('ObserveFieldScoped("state"');
    const gateIdx = fnBody.indexOf('node.ft_isRequestComponent');
    const controlRunIdx = fnBody.indexOf('node.control = "RUN"');
    expect(stateObserveIdx).to.be.greaterThan(-1);
    expect(gateIdx).to.be.greaterThan(stateObserveIdx);
    expect(controlRunIdx).to.be.greaterThan(gateIdx);
  });

  it('startNode() only writes lastRequestSent / attaches the rawResponse observer inside the ft_isRequestComponent gate — never unconditionally', () => {
    const fnBody = source.slice(source.indexOf('sub startNode('), source.indexOf('end sub', source.indexOf('sub startNode(')));
    const gateBody = fnBody.slice(fnBody.indexOf('if node.ft_isRequestComponent'), fnBody.indexOf('end if', fnBody.indexOf('if node.ft_isRequestComponent')));
    expect(gateBody).to.include('m.top.lastRequestSent = node.resolvedOptions');
    expect(gateBody).to.include('ObserveFieldScoped("rawResponse"');
    // Neither write happens a second time outside the gate.
    expect(fnBody.split('lastRequestSent')).to.have.lengthOf(2);
    expect(fnBody.split('ObserveFieldScoped("rawResponse"')).to.have.lengthOf(2);
  });

  it('on_ft_taskManagerRawResponse unobserves rawResponse BEFORE writing lastResponseReceived — fire-once, mirrors the onResult trampolines\' own unobserve-before-invoke discipline', () => {
    const fnBody = source.slice(source.indexOf('sub on_ft_taskManagerRawResponse('), source.indexOf('end sub', source.indexOf('sub on_ft_taskManagerRawResponse(')));
    const unobserveIdx = fnBody.indexOf('UnobserveFieldScoped("rawResponse")');
    const writeIdx = fnBody.indexOf('m.top.lastResponseReceived =');
    expect(unobserveIdx).to.be.greaterThan(-1);
    expect(writeIdx).to.be.greaterThan(unobserveIdx);
  });

  it('lastRequestSent/lastResponseReceived are never hysteresis-gated — unlike alertLevel, every request/response is reported, not just distinct ones', () => {
    expect(source).to.not.match(/if\s+.*lastRequestSent.*=.*then\s+return/);
    expect(source).to.not.match(/if\s+.*lastResponseReceived.*=.*then\s+return/);
  });
});

/**
 * Structural regression guards for deferred focus restoration on a router navigation — see
 * findings/router-focus-integration.md. Again a text-structure check, not a behavior test (no
 * BrightScript execution harness exists in this package); real behavior is verified live on a
 * device (see that finding's own device-verification notes).
 */
describe('FlashTheaterFocusManager.brs — deferred focus restoration on a router navigation', () => {
  const source = readFileSync(join(RUNTIME_ASSETS_DIR, 'FocusManager', 'FlashTheaterFocusManager.brs'), 'utf8');

  it('declares the route-keyed memory and suppression fields in init()', () => {
    const initBody = source.slice(source.indexOf('sub init()'), source.indexOf('end sub', source.indexOf('sub init()')));
    expect(initBody).to.include('m.lastFocusedByRouteKey = []');
    expect(initBody).to.include('m.suppressedNavRouteKey = invalid');
  });

  it('defines captureRouteFocusMemory (routeKey, node — no root, no internal currentlyFocused() lookup), beginSuppressedNavigation, resolveRouteFocusTarget, and mostRecentlyFocusedWithin', () => {
    expect(source).to.match(/sub captureRouteFocusMemory\(routeKey as string, node as dynamic\)/);
    expect(source).to.match(/sub beginSuppressedNavigation\(routeKey as string\)/);
    expect(source).to.match(/function resolveRouteFocusTarget\(routeKey as string\) as dynamic/);
    expect(source).to.match(/function mostRecentlyFocusedWithin\(root as object\) as dynamic/);
  });

  it('mostRecentlyFocusedWithin matches by NODE ancestry (isDescendantOrSelf), not owner identity — finds content owned by a nested custom component too', () => {
    const fnBody = source.slice(
      source.indexOf('function mostRecentlyFocusedWithin('),
      source.indexOf('end function', source.indexOf('function mostRecentlyFocusedWithin(')),
    );
    expect(fnBody).to.include('isDescendantOrSelf(candidate, root)');
    expect(fnBody).to.not.include('.owner.IsSameNode(root)');
  });

  it('lastFocusedFor still exists and is still called by enterOwner — a real, pre-existing, load-bearing caller broken live once by an over-eager rename (mostRecentlyFocusedWithin is an ADDITION, not a replacement)', () => {
    expect(source).to.match(/function lastFocusedFor\(owner as object\) as dynamic/);
    const enterOwnerBody = source.slice(source.indexOf('function enterOwner('), source.indexOf('end function', source.indexOf('function enterOwner(')));
    expect(enterOwnerBody).to.include('lastFocusedFor(owner)');
  });

  it('captureRouteFocusMemory captures the NODE PASSED IN unconditionally — no isDescendantOrSelf/root scoping, no currentlyFocused() call of its own', () => {
    const fnBody = source.slice(source.indexOf('sub captureRouteFocusMemory('), source.indexOf('end sub', source.indexOf('sub captureRouteFocusMemory(')));
    expect(fnBody).to.not.include('isDescendantOrSelf');
    expect(fnBody).to.not.include('currentlyFocused()');
    expect(fnBody).to.include('if node = invalid then return');
    // Walks the PASSED-IN node all the way to the Scene — no "stop at root" boundary.
    expect(fnBody).to.include('walker = node');
    expect(fnBody).to.include('while walker <> invalid\n');
  });

  it('resolveRouteFocusTarget searches Scene-wide (m.sceneRef.FindNode), not a caller-supplied root', () => {
    const fnBody = source.slice(
      source.indexOf('function resolveRouteFocusTarget('),
      source.indexOf('end function', source.indexOf('function resolveRouteFocusTarget(')),
    );
    expect(fnBody).to.include('m.sceneRef.FindNode(id)');
    expect(fnBody).to.not.include('root.FindNode');
  });

  it('beginFocusTransition() clears any suppression left by a superseded navigation', () => {
    const fnBody = source.slice(source.indexOf('sub beginFocusTransition()'), source.indexOf('end sub', source.indexOf('sub beginFocusTransition()')));
    expect(fnBody).to.include('m.suppressedNavRouteKey = invalid');
  });

  it('applyPendingFocus() checks the suppression flag BEFORE falling back to recoverFocusFor() in its target = invalid branch', () => {
    const fnBody = source.slice(source.indexOf('sub applyPendingFocus()'), source.indexOf('end sub', source.indexOf('sub applyPendingFocus()')));
    const invalidBranch = fnBody.slice(fnBody.indexOf('if target = invalid then'), fnBody.indexOf('end if', fnBody.indexOf('if target = invalid then')));
    const suppressCheckIdx = invalidBranch.indexOf('if m.suppressedNavRouteKey <> invalid then return');
    const recoverIdx = invalidBranch.indexOf('recoverFocusFor(m.focusLostFromOwner)');
    expect(suppressCheckIdx).to.be.greaterThan(-1);
    expect(recoverIdx).to.be.greaterThan(suppressCheckIdx);
  });

  it('resolveRouteFocusTarget() only resolves a target for a matching, currently-suppressed routeKey, and never calls moveFocusTo()', () => {
    const fnBody = source.slice(
      source.indexOf('function resolveRouteFocusTarget('),
      source.indexOf('end function', source.indexOf('function resolveRouteFocusTarget(')),
    );
    expect(fnBody).to.include('if m.suppressedNavRouteKey = invalid then return invalid');
    expect(fnBody).to.include('if m.suppressedNavRouteKey <> routeKey then return invalid');
    expect(fnBody).to.not.include('moveFocusTo(');
  });
});

/**
 * Structural regression guards for the router-outlet side of the same feature. Suppression-arming
 * lives in FlashTheaterRouter's own navigate() (see the describe block below) — unconditional, for
 * every journey, keyed by the GLOBAL incoming route. Capture stayed at the outlet level (it needs
 * this outlet's own m.currentChild, which only the outlet has), but changed from "whatever holds
 * literal focus right now" to `lastFocusedFor(m.currentChild)` — the last element ACTUALLY focused
 * inside this outlet's own outgoing content, continuously tracked, immune to the user stepping back
 * to a persistent menu before actually pressing the navigation trigger. Keyed by
 * `m._renderedGlobalRouteKey`, a per-child-instance snapshot taken once in _mountRouteImmediate(),
 * not re-derived from m._router.activatedRoute at capture time (which has already moved on to the
 * INCOMING route by then, and isn't safe to re-read live under an interrupted/rapid re-navigation
 * either). See findings/router-focus-integration.md.
 */
describe('FlashTheaterRouterOutlet.brs — deferred focus restoration on a router navigation', () => {
  const source = readFileSync(join(RUNTIME_ASSETS_DIR, 'RouterOutlet', 'FlashTheaterRouterOutlet.brs'), 'utf8');

  it('_mountRoute no longer arms suppression itself — that responsibility moved to FlashTheaterRouter\'s own navigate()', () => {
    const fnBody = source.slice(
      source.indexOf('sub _mountRoute('),
      source.indexOf('end sub', source.indexOf('sub _mountRoute(')),
    );
    expect(fnBody).to.not.include('callFunc("beginSuppressedNavigation"');
  });

  it('_beginLoadingGate no longer arms suppression itself — that responsibility moved to _mountRoute', () => {
    const fnBody = source.slice(
      source.indexOf('sub _beginLoadingGate('),
      source.indexOf('end sub', source.indexOf('sub _beginLoadingGate(')),
    );
    expect(source).to.include('sub _beginLoadingGate(inAnim as dynamic, loadingComponent as string)');
    expect(fnBody).to.not.include('beginSuppressedNavigation');
  });

  it('_mountRouteImmediate threads viaAsyncBoundary through to the non-gated reveal branch, not a hardcoded false', () => {
    expect(source).to.include(
      'sub _mountRouteImmediate(route as object, fullPath as string, paramsJson as string, isBackJourney as boolean, viaAsyncBoundary as boolean)',
    );
    const fnBody = source.slice(
      source.indexOf('sub _mountRouteImmediate('),
      source.indexOf('end sub', source.indexOf('sub _mountRouteImmediate(')),
    );
    expect(fnBody).to.include('_revealMountedChild(inAnim, viaAsyncBoundary)');
    expect(fnBody).to.not.include('_revealMountedChild(inAnim, false)');
  });

  it('the synchronous _mountRoute branch passes viaAsyncBoundary = false; the post-animation continuation passes true', () => {
    expect(source).to.include('_mountRouteImmediate(route, fullPath, paramsJson, isBackJourney, false)');
    expect(source).to.include('_mountRouteImmediate(m._pendingRoute, m._pendingFullPath, m._pendingParamsJson, m._pendingIsBackJourney, true)');
  });

  it('both loading-gate settlement paths pass cameFromAsyncBoundary = true to _revealMountedChild', () => {
    const settleCalls = [...source.matchAll(/_revealMountedChild\(m\._pendingInAnim, true\)/g)];
    expect(settleCalls).to.have.lengthOf(2); // _settleLoadingGate's no-min-duration branch, and _onMinDurationElapsed
  });

  it('_revealMountedChild only calls applyPendingFocus() a second time when cameFromAsyncBoundary is true — never unconditionally', () => {
    expect(source).to.include('sub _revealMountedChild(inAnim as dynamic, cameFromAsyncBoundary as boolean)');
    const fnBody = source.slice(
      source.indexOf('sub _revealMountedChild(inAnim as dynamic, cameFromAsyncBoundary as boolean)'),
      source.indexOf('end sub', source.indexOf('sub _revealMountedChild(inAnim as dynamic, cameFromAsyncBoundary as boolean)')),
    );
    expect(fnBody).to.match(/if cameFromAsyncBoundary then ft_focus\.callFunc\("applyPendingFocus"\)/);
    // The unconditional call this replaced must be gone — applyPendingFocus is only ever reached
    // through the guarded line above within this sub.
    const applyPendingFocusSites = [...fnBody.matchAll(/callFunc\("applyPendingFocus"\)/g)];
    expect(applyPendingFocusSites).to.have.lengthOf(1);
  });

  it('resolveRouteFocusTarget is called unconditionally (not gated on cameFromAsyncBoundary), so it clears a stale suppression even on the synchronous path', () => {
    const fnBody = source.slice(
      source.indexOf('sub _revealMountedChild(inAnim as dynamic, cameFromAsyncBoundary as boolean)'),
      source.indexOf('end sub', source.indexOf('sub _revealMountedChild(inAnim as dynamic, cameFromAsyncBoundary as boolean)')),
    );
    const resolveIdx = fnBody.indexOf('callFunc("resolveRouteFocusTarget"');
    const guardIdx = fnBody.indexOf('if cameFromAsyncBoundary then');
    expect(resolveIdx).to.be.greaterThan(-1);
    expect(resolveIdx).to.be.lessThan(guardIdx); // unconditional call happens before the guarded one
  });

  it('_unregisterCurrentChildFocus captures mostRecentlyFocusedWithin(m.currentChild) — not currentlyFocused() — keyed by m._renderedGlobalRouteKey, before unregistering the subtree', () => {
    const fnBody = source.slice(
      source.indexOf('sub _unregisterCurrentChildFocus()'),
      source.indexOf('end sub', source.indexOf('sub _unregisterCurrentChildFocus()')),
    );
    const lastFocusedIdx = fnBody.indexOf('callFunc("mostRecentlyFocusedWithin", m.currentChild)');
    const captureIdx = fnBody.indexOf('callFunc("captureRouteFocusMemory"');
    const unregisterIdx = fnBody.indexOf('callFunc("unregisterSubtree"');
    expect(lastFocusedIdx).to.be.greaterThan(-1);
    expect(captureIdx).to.be.greaterThan(lastFocusedIdx);
    expect(unregisterIdx).to.be.greaterThan(captureIdx);
    expect(fnBody).to.include('m._renderedGlobalRouteKey');
    expect(fnBody).to.not.include('currentlyFocused()');
  });

  it('_mountRouteImmediate snapshots m._renderedGlobalRouteKey from the GLOBAL m._router.activatedRoute, once, alongside the other m._rendered* bookkeeping', () => {
    const fnBody = source.slice(
      source.indexOf('sub _mountRouteImmediate('),
      source.indexOf('end sub', source.indexOf('sub _mountRouteImmediate(')),
    );
    const renderedFullPathIdx = fnBody.indexOf('m._renderedFullPath = fullPath');
    const globalKeyIdx = fnBody.indexOf('m._renderedGlobalRouteKey = m._router.activatedRoute.path + "?" + FormatJson(m._router.activatedRoute.params)');
    expect(renderedFullPathIdx).to.be.greaterThan(-1);
    expect(globalKeyIdx).to.be.greaterThan(renderedFullPathIdx);
  });

  it('_revealMountedChild resolves restoration using m._renderedGlobalRouteKey, not a live re-read of m._router.activatedRoute', () => {
    const fnBody = source.slice(
      source.indexOf('sub _revealMountedChild(inAnim as dynamic, cameFromAsyncBoundary as boolean)'),
      source.indexOf('end sub', source.indexOf('sub _revealMountedChild(inAnim as dynamic, cameFromAsyncBoundary as boolean)')),
    );
    expect(fnBody).to.include('routeKey = m._renderedGlobalRouteKey');
  });

  it('no longer defines a standalone _routeKey() helper — both call sites read m._renderedGlobalRouteKey directly', () => {
    expect(source).to.not.match(/function _routeKey\(/);
  });
});

/**
 * Structural regression guard for FlashTheaterRouter's own navigate(): it still arms
 * FlashTheaterFocusManager's "stay vacant" suppression for the INCOMING route, unconditionally, for
 * every journey (forward or back) — the one piece of the redesign that stayed centralized here,
 * since only the router genuinely knows the INCOMING route for the whole app in one place, before
 * any outlet has reacted. Capture itself moved back to each outlet (see the RouterOutlet.brs
 * describe block above) once a live round trip showed a router-level, "whatever holds literal focus
 * right now" capture breaks for the ordinary "step back to the menu, then navigate" interaction —
 * see findings/router-focus-integration.md.
 */
describe('FlashTheaterRouter.brs — arms deferred-restoration suppression for every navigation', () => {
  const source = readFileSync(join(RUNTIME_ASSETS_DIR, 'Router', 'FlashTheaterRouter.brs'), 'utf8');

  function navigateBody(): string {
    return source.slice(source.indexOf('sub navigate('), source.indexOf('end sub', source.indexOf('sub navigate(')));
  }

  it('no longer captures route focus memory itself — that responsibility moved back to each outlet', () => {
    expect(navigateBody()).to.not.include('captureRouteFocusMemory');
  });

  it('arms suppression for the INCOMING route AFTER activatedRoute is reassigned, before changeToken bumps', () => {
    const fnBody = navigateBody();
    const reassignEndIdx = fnBody.indexOf('}', fnBody.indexOf('m.top.activatedRoute = {'));
    const armIdx = fnBody.indexOf('callFunc("beginSuppressedNavigation"');
    const changeTokenIdx = fnBody.indexOf('m.top.changeToken = m.top.changeToken + 1');
    expect(armIdx).to.be.greaterThan(reassignEndIdx);
    expect(armIdx).to.be.lessThan(changeTokenIdx);
    const armLine = fnBody.slice(fnBody.lastIndexOf('incomingRouteKey', armIdx), fnBody.indexOf('\n', armIdx));
    expect(armLine).to.include('m.top.activatedRoute.path');
    expect(armLine).to.include('FormatJson(m.top.activatedRoute.params)');
  });

  it('the arm is guarded on ft_focus being present', () => {
    const fnBody = navigateBody();
    expect(fnBody).to.match(/if hasFocus then[\s\S]{0,200}callFunc\("beginSuppressedNavigation"/);
  });
});
