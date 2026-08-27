import { expect } from 'chai';
import { parse as parseBrightScript, parseSceneGraphXml } from 'kopytko-brightscript-parser';
import {
  compileApp,
  emitFlashTheaterGlobalsBrs,
  AppFileInput,
  FLASH_THEATER_STORE_COMPONENT_NAME,
  FLASH_THEATER_THEME_COMPONENT_NAME,
  FLASH_THEATER_FOCUS_MANAGER_COMPONENT_NAME,
  FLASH_THEATER_ROUTER_COMPONENT_NAME,
  FLASH_THEATER_TASK_MANAGER_COMPONENT_NAME,
  FLASH_THEATER_SAFE_COMPARE_FILE_BASE_NAME,
  FLASH_THEATER_SAFE_NOT_FILE_BASE_NAME,
  FLASH_THEATER_STREAM_FILE_BASE_NAME,
  FLASH_THEATER_SCALE_FILE_BASE_NAME,
} from '../src/app-compiler.js';
import { CompileError } from '../src/dsl-parser/dsl-ast.js';

const COMPONENT_NO_GLOBALS: AppFileInput = {
  path: '/app/components/Widget.thr',
  componentName: 'Widget',
  source: ['<script>', 'field enabled: boolean = false', '</script>', '<component>', '<Label id="a" text="{enabled}" />', '</component>'].join('\n'),
};

function themeTemplateFile(path: string, componentName: string, body: string, defaultAttr = ''): AppFileInput {
  return { path, componentName, source: `<theme-template${defaultAttr}>\n${body}\n</theme-template>` };
}

function themeVariantFile(path: string, componentName: string, name: string, body: string): AppFileInput {
  return { path, componentName, source: `<theme name="${name}">\n${body}\n</theme>` };
}

function componentFile(path: string, componentName: string, scriptBody: string, template = '<Label id="a" />'): AppFileInput {
  return { path, componentName, source: `<script>\n${scriptBody}\n</script>\n<component>\n${template}\n</component>` };
}

describe('compileApp — an app with no store/theme usage', () => {
  it('degrades to compiling every component independently, with no globalsBrs', () => {
    const result = compileApp([COMPONENT_NO_GLOBALS]);
    expect(result.outputs).to.have.lengthOf(1);
    expect(result.outputs[0].path).to.equal(COMPONENT_NO_GLOBALS.path);
    expect(result.usesStore).to.be.false;
    expect(result.globalsBrs).to.equal(null);
  });
});

describe('compileApp — usesStore tally', () => {
  it('is true when any component uses read/watch/store(...)', () => {
    const files = [componentFile('/app/Widget.thr', 'Widget', 'watch count = store(count)\nderived doubled: integer = count * 2')];
    const result = compileApp(files);

    expect(result.usesStore).to.be.true;
    expect(result.outputs).to.have.lengthOf(1); // no separate store output — it's a built-in runtime primitive, not user-authored
    expect(result.globalsBrs).to.include(`CreateObject("roSGNode", "${FLASH_THEATER_STORE_COMPONENT_NAME}")`);
  });

  it('is false when no component touches the store, even alongside a theme', () => {
    const files = [themeTemplateFile('/app/Theme.thr', 'Theme', 'fontSize: integer = 16'), componentFile('/app/Widget.thr', 'Widget', 'derived c: integer = theme.fontSize')];
    const result = compileApp(files);

    expect(result.usesStore).to.be.false;
    expect(result.globalsBrs).to.not.include('store');
  });
});

describe('compileApp — usesFocusSystem tally', () => {
  it('is true when any component has a focusable element', () => {
    const files = [componentFile('/app/Widget.thr', 'Widget', 'field enabled: boolean = false', '<Rectangle id="card" focusable="true" />')];
    const result = compileApp(files);

    expect(result.usesFocusSystem).to.be.true;
    expect(result.globalsBrs).to.include(`CreateObject("roSGNode", "${FLASH_THEATER_FOCUS_MANAGER_COMPONENT_NAME}")`);
  });

  it('is false when no component has a focusable element, even alongside store/theme usage', () => {
    const files = [componentFile('/app/Widget.thr', 'Widget', 'watch count = store(count)\nderived doubled: integer = count * 2')];
    const result = compileApp(files);

    expect(result.usesFocusSystem).to.be.false;
    expect(result.globalsBrs).to.not.include('ft_focus:');
  });

  it('is true when a component calls focus(...) but declares no focusable element of its own', () => {
    const files = [
      componentFile('/app/Widget.thr', 'Widget', ['private function goToOther(key: string, press: boolean) {', '  if (press) {', '    focus("other")', '  }', '}'].join('\n')),
    ];
    const result = compileApp(files);

    expect(result.usesFocusSystem).to.be.true;
    expect(result.globalsBrs).to.include(`CreateObject("roSGNode", "${FLASH_THEATER_FOCUS_MANAGER_COMPONENT_NAME}")`);
  });
});

describe('compileApp — usesRouter tally', () => {
  it('is true when any component calls router.navigate(...)', () => {
    const files = [
      componentFile('/app/Widget.thr', 'Widget', ['private function goToBrowse(key: string, press: boolean) {', '  if (press) {', '    router.navigate("/browse")', '  }', '}'].join('\n')),
    ];
    const result = compileApp(files);

    expect(result.usesRouter).to.be.true;
    expect(result.outputs).to.have.lengthOf(1); // no separate router output — it's a built-in runtime primitive, not user-authored
    expect(result.globalsBrs).to.include(`CreateObject("roSGNode", "${FLASH_THEATER_ROUTER_COMPONENT_NAME}")`);
  });

  it('is true when a component only reads router.path/router.params, never calling an action', () => {
    const files = [componentFile('/app/Widget.thr', 'Widget', 'derived day: string = router.params.day', '<Label id="a" text="{day}" />')];
    const result = compileApp(files);

    expect(result.usesRouter).to.be.true;
  });

  it('is true when router.* only appears in a dynamic template attribute, never in script', () => {
    const files = [componentFile('/app/Widget.thr', 'Widget', 'field enabled: boolean = false', '<Label id="a" text="{router.path}" />')];
    const result = compileApp(files);

    expect(result.usesRouter).to.be.true;
  });

  it('is false when no component touches the router, even alongside store/theme/focus usage', () => {
    const files = [
      componentFile('/app/Widget.thr', 'Widget', ['watch count = store(count)', 'field enabled: boolean = false'].join('\n'), '<Rectangle id="card" focusable="true" />'),
    ];
    const result = compileApp(files);

    expect(result.usesRouter).to.be.false;
    expect(result.globalsBrs).to.not.include('ft_router:');
  });
});

describe('compileApp — usesTaskManager tally', () => {
  it('is true when any component calls taskManager.run(...)', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        ['private function startWork(key: string, press: boolean) {', '  if (press) {', '    node = CreateObject("roSGNode", "MyTask")', '    id = taskManager.run(node)', '  }', '}'].join(
          '\n',
        ),
      ),
    ];
    const result = compileApp(files);

    expect(result.usesTaskManager).to.be.true;
    expect(result.outputs).to.have.lengthOf(1); // no separate task-manager output — it's a built-in runtime primitive, not user-authored
    expect(result.globalsBrs).to.include(`CreateObject("roSGNode", "${FLASH_THEATER_TASK_MANAGER_COMPONENT_NAME}")`);
  });

  it('is true when a component only reads taskManager.runningCount/.queuedCount, never calling an action', () => {
    const files = [componentFile('/app/Widget.thr', 'Widget', 'derived running: integer = taskManager.runningCount', '<Label id="a" text="{running}" />')];
    const result = compileApp(files);

    expect(result.usesTaskManager).to.be.true;
  });

  it('is true when taskManager.* only appears in a dynamic template attribute, never in script', () => {
    const files = [componentFile('/app/Widget.thr', 'Widget', 'field enabled: boolean = false', '<Label id="a" text="{taskManager.queuedCount}" />')];
    const result = compileApp(files);

    expect(result.usesTaskManager).to.be.true;
  });

  it('is false when no component touches the task manager, even alongside store/theme/focus/router usage', () => {
    const files = [
      componentFile('/app/Widget.thr', 'Widget', ['watch count = store(count)', 'field enabled: boolean = false'].join('\n'), '<Rectangle id="card" focusable="true" />'),
    ];
    const result = compileApp(files);

    expect(result.usesTaskManager).to.be.false;
    expect(result.globalsBrs).to.not.include('ft_taskManager:');
  });
});

describe('compileApp — usesComparisonHelper tally and SafeCompare <script uri> wiring', () => {
  // The SafeCompare <script uri> is computed against `componentsBaseDir = join(appRoot, 'components')`
  // (mirroring cli.ts's own convention — see app-compiler.ts's `FLASH_THEATER_SAFE_COMPARE_DIR_NAME`
  // doc comment) — an explicit appRoot of '/app' is passed here so it actually lines up with these
  // fixtures' own '/app/components/...' paths, unlike the plain `./`-relative .flsh import tests
  // elsewhere in this file, which never need appRoot at all.
  const APP_ROOT = '/app';
  const EXPECTED_SCRIPT_TAG = `<script type="text/brightscript" uri="pkg:/components/FlashTheater/SafeCompare/${FLASH_THEATER_SAFE_COMPARE_FILE_BASE_NAME}.brs" />`;

  it('is true, and adds a <script> tag pointing at the shared SafeCompare .brs, when a component uses ==/!=', () => {
    const files = [componentFile('/app/components/Widget.thr', 'Widget', 'field count: integer = 0\nderived isFive: boolean = count == 5')];
    const result = compileApp(files, APP_ROOT, APP_ROOT);

    expect(result.usesComparisonHelper).to.be.true;
    expect(result.outputs[0].brs).to.include('ft_equals(');
    expect(result.outputs[0].xml).to.include(EXPECTED_SCRIPT_TAG);
  });

  it('is false, and adds no SafeCompare <script> tag, when no component uses ==/!=', () => {
    const files = [{ ...COMPONENT_NO_GLOBALS, path: '/app/components/Widget.thr' }];
    const result = compileApp(files, APP_ROOT, APP_ROOT);

    expect(result.usesComparisonHelper).to.be.false;
    expect(result.outputs[0].xml).to.not.include('SafeCompare');
  });

  it('is true, and wires the <script> tag into the IMPORTING component, when only an imported .flsh class uses ==/!=, never the component itself', () => {
    const files = [
      classFile('/app/components/Classes/Counter.flsh', ['class Counter {', '  private count: integer = 0', '', '  public function isFive(): boolean {', '    return m.count == 5', '  }', '}'].join('\n')),
      componentFile(
        '/app/components/Widget.thr',
        'Widget',
        ['import Counter from "./Classes/Counter.flsh"', '', 'private function build() {', '  x = Counter()', '}'].join('\n'),
      ),
    ];
    const result = compileApp(files, APP_ROOT, APP_ROOT);

    expect(result.usesComparisonHelper).to.be.true;
    expect(result.classOutputs[0].brs).to.include('ft_equals(');
    expect(result.outputs[0].xml).to.include(EXPECTED_SCRIPT_TAG);
  });
});

describe('compileApp — usesSafeNotHelper tally and SafeNot <script uri> wiring', () => {
  // Same appRoot/path-alignment reasoning as the SafeCompare describe block above.
  const APP_ROOT = '/app';
  const EXPECTED_SCRIPT_TAG = `<script type="text/brightscript" uri="pkg:/components/FlashTheater/SafeNot/${FLASH_THEATER_SAFE_NOT_FILE_BASE_NAME}.brs" />`;

  it('is true, and adds a <script> tag pointing at the shared SafeNot .brs, when a component uses !', () => {
    const files = [componentFile('/app/components/Widget.thr', 'Widget', 'field enabled: boolean = false\nderived isDisabled: boolean = !enabled')];
    const result = compileApp(files, APP_ROOT, APP_ROOT);

    expect(result.usesSafeNotHelper).to.be.true;
    expect(result.outputs[0].brs).to.include('ft_not(');
    expect(result.outputs[0].xml).to.include(EXPECTED_SCRIPT_TAG);
  });

  it('is false, and adds no SafeNot <script> tag, when no component uses !', () => {
    const files = [{ ...COMPONENT_NO_GLOBALS, path: '/app/components/Widget.thr' }];
    const result = compileApp(files, APP_ROOT, APP_ROOT);

    expect(result.usesSafeNotHelper).to.be.false;
    expect(result.outputs[0].xml).to.not.include('SafeNot');
  });

  it('is true, and wires the <script> tag into the IMPORTING component, when only an imported .flsh class uses !, never the component itself', () => {
    const files = [
      classFile(
        '/app/components/Classes/Counter.flsh',
        ['class Counter {', '  private isReady: boolean = false', '', '  public function isNotReady(): boolean {', '    return !m.isReady', '  }', '}'].join('\n'),
      ),
      componentFile(
        '/app/components/Widget.thr',
        'Widget',
        ['import Counter from "./Classes/Counter.flsh"', '', 'private function build() {', '  x = Counter()', '}'].join('\n'),
      ),
    ];
    const result = compileApp(files, APP_ROOT, APP_ROOT);

    expect(result.usesSafeNotHelper).to.be.true;
    expect(result.classOutputs[0].brs).to.include('ft_not(');
    expect(result.outputs[0].xml).to.include(EXPECTED_SCRIPT_TAG);
  });

  it('adds the SafeNot, SafeCompare, and Stream <script> tags, independently, when a component needs all three helpers', () => {
    const files = [
      componentFile(
        '/app/components/Widget.thr',
        'Widget',
        'field count: integer = 0\nstream dataLoaded: string\nderived isFive: boolean = count == 5\nderived isNotFive: boolean = !isFive',
      ),
    ];
    const result = compileApp(files, APP_ROOT, APP_ROOT);

    expect(result.usesStreamHelper).to.be.true;
    expect(result.usesComparisonHelper).to.be.true;
    expect(result.usesSafeNotHelper).to.be.true;
    expect(result.outputs[0].xml).to.include(`<script type="text/brightscript" uri="pkg:/components/FlashTheater/Stream/${FLASH_THEATER_STREAM_FILE_BASE_NAME}.brs" />`);
    expect(result.outputs[0].xml).to.include(`<script type="text/brightscript" uri="pkg:/components/FlashTheater/SafeCompare/${FLASH_THEATER_SAFE_COMPARE_FILE_BASE_NAME}.brs" />`);
    expect(result.outputs[0].xml).to.include(EXPECTED_SCRIPT_TAG);
  });
});

describe('compileApp — usesStreamHelper tally and Stream <script uri> wiring', () => {
  // Same appRoot/path-alignment reasoning as the SafeCompare describe block above.
  const APP_ROOT = '/app';
  const EXPECTED_SCRIPT_TAG = `<script type="text/brightscript" uri="pkg:/components/FlashTheater/Stream/${FLASH_THEATER_STREAM_FILE_BASE_NAME}.brs" />`;

  it('is true, and adds a <script> tag pointing at the shared Stream .brs, when a component declares a stream', () => {
    const files = [componentFile('/app/components/Widget.thr', 'Widget', 'stream dataLoaded: string')];
    const result = compileApp(files, APP_ROOT, APP_ROOT);

    expect(result.usesStreamHelper).to.be.true;
    expect(result.outputs[0].brs).to.include('ft_createStream(');
    expect(result.outputs[0].xml).to.include(EXPECTED_SCRIPT_TAG);
  });

  it('is false, and adds no Stream <script> tag, when no component declares a stream', () => {
    const files = [{ ...COMPONENT_NO_GLOBALS, path: '/app/components/Widget.thr' }];
    const result = compileApp(files, APP_ROOT, APP_ROOT);

    expect(result.usesStreamHelper).to.be.false;
    expect(result.outputs[0].xml).to.not.include('Stream');
  });

  it('is true, and wires the <script> tag into the IMPORTING component, when only an imported .flsh class declares a stream field, never the component itself', () => {
    const files = [
      classFile('/app/components/Classes/Notifier.flsh', ['class Notifier {', '  public stream onChanged: string', '}'].join('\n')),
      componentFile(
        '/app/components/Widget.thr',
        'Widget',
        ['import Notifier from "./Classes/Notifier.flsh"', '', 'private function build() {', '  x = Notifier()', '}'].join('\n'),
      ),
    ];
    const result = compileApp(files, APP_ROOT, APP_ROOT);

    expect(result.usesStreamHelper).to.be.true;
    expect(result.classOutputs[0].brs).to.include('ft_createStream(');
    expect(result.outputs[0].xml).to.include(EXPECTED_SCRIPT_TAG);
  });

  it('adds both the Stream and SafeCompare <script> tags, independently, when a component needs both helpers', () => {
    const files = [componentFile('/app/components/Widget.thr', 'Widget', 'field count: integer = 0\nstream dataLoaded: string\nderived isFive: boolean = count == 5')];
    const result = compileApp(files, APP_ROOT, APP_ROOT);

    expect(result.usesStreamHelper).to.be.true;
    expect(result.usesComparisonHelper).to.be.true;
    expect(result.outputs[0].xml).to.include(EXPECTED_SCRIPT_TAG);
    expect(result.outputs[0].xml).to.include(`<script type="text/brightscript" uri="pkg:/components/FlashTheater/SafeCompare/${FLASH_THEATER_SAFE_COMPARE_FILE_BASE_NAME}.brs" />`);
  });
});

describe('compileApp — scale config + usesScaleHelper tally', () => {
  const APP_ROOT = '/app';
  const EXPECTED_SCRIPT_TAG = `<script type="text/brightscript" uri="pkg:/components/FlashTheater/Scale/${FLASH_THEATER_SCALE_FILE_BASE_NAME}.brs" />`;

  it('throws dsl/scale-requires-config when a component uses scale but no config was passed', () => {
    const files = [componentFile('/app/components/Widget.thr', 'Widget', 'scale field width: integer = 100\nderived b: integer = 1')];
    expect(() => compileApp(files, APP_ROOT, APP_ROOT)).to.throw(CompileError).with.property('diagnostic').that.deep.include({ code: 'dsl/scale-requires-config' });
  });

  it('is true, wires ft_scaleFactor into globalsBrs off the configured design width, and adds a <script> tag pointing at the shared Scale .brs, when config is supplied', () => {
    const files = [componentFile('/app/components/Widget.thr', 'Widget', 'scale field width: integer = 100\nderived b: integer = 1')];
    const result = compileApp(files, APP_ROOT, APP_ROOT, { designResolution: 'fhd' });

    expect(result.usesScaleHelper).to.be.true;
    expect(result.outputs[0].brs).to.include('ft_scale(');
    expect(result.outputs[0].xml).to.include(EXPECTED_SCRIPT_TAG);
    expect(result.globalsBrs).to.include('CreateObject("roDeviceInfo").GetDisplaySize().w / 1920');
  });

  it('uses the HD pixel width (1280) when designResolution is "hd"', () => {
    const files = [componentFile('/app/components/Widget.thr', 'Widget', 'scale field width: integer = 100\nderived b: integer = 1')];
    const result = compileApp(files, APP_ROOT, APP_ROOT, { designResolution: 'hd' });

    expect(result.globalsBrs).to.include('CreateObject("roDeviceInfo").GetDisplaySize().w / 1280');
  });

  it('is false, and adds no Scale <script> tag or ft_scaleFactor wiring, when no component uses scale — even with config supplied', () => {
    const files = [{ ...COMPONENT_NO_GLOBALS, path: '/app/components/Widget.thr' }];
    const result = compileApp(files, APP_ROOT, APP_ROOT, { designResolution: 'fhd' });

    expect(result.usesScaleHelper).to.be.false;
    expect(result.outputs[0].xml).to.not.include('Scale');
    expect(result.globalsBrs).to.equal(null);
  });

  it('is true, and wires the <script> tag into the IMPORTING component, when only an imported .flsh class uses scale, never the component itself', () => {
    const files = [
      classFile('/app/components/Classes/Sizer.flsh', ['class Sizer {', '  public function computeWidth(): integer {', '    scale x = 100', '    return x', '  }', '}'].join('\n')),
      componentFile(
        '/app/components/Widget.thr',
        'Widget',
        ['import Sizer from "./Classes/Sizer.flsh"', '', 'private function build() {', '  x = Sizer()', '}'].join('\n'),
      ),
    ];
    const result = compileApp(files, APP_ROOT, APP_ROOT, { designResolution: 'fhd' });

    expect(result.usesScaleHelper).to.be.true;
    expect(result.classOutputs[0].brs).to.include('ft_scale(');
    expect(result.outputs[0].xml).to.include(EXPECTED_SCRIPT_TAG);
  });
});

describe('compileApp — automatic back-key fallthrough on the Scene-rooted component', () => {
  function sceneFile(path: string, componentName: string, scriptBody: string, template: string): AppFileInput {
    return { path, componentName, source: `<script>\n${scriptBody}\n</script>\n<component extends="Scene">\n${template}\n</component>` };
  }

  it('emits a guarded back-key fallthrough after explicit on:key dispatch, before the final return false', () => {
    const files = [sceneFile('/app/MainScene.thr', 'MainScene', 'field enabled: boolean = false', '<Label id="a" />')];
    const result = compileApp(files);
    const sceneOutput = result.outputs.find((o) => o.componentName === 'MainScene')!;

    expect(sceneOutput.brs).to.include('function onKeyEvent(key as string, press as boolean) as boolean');
    expect(sceneOutput.brs).to.include('if key = "back" and press then');
    expect(sceneOutput.brs).to.include('if m.global.hasField("ft_router") then');
    expect(sceneOutput.brs).to.include('if m.global.ft_router.callFunc("back") then');

    const bsResult = parseBrightScript(sceneOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
  });

  it('hands focus off after a successful back(), from the onKeyEvent itself — a deeper call would not route real key events', () => {
    const files = [sceneFile('/app/MainScene.thr', 'MainScene', 'field enabled: boolean = false', '<Label id="a" />')];
    const sceneOutput = compileApp(files).outputs.find((o) => o.componentName === 'MainScene')!;

    expect(sceneOutput.brs).to.include('if m.global.hasField("ft_focus") then m.global.ft_focus.callFunc("applyPendingFocus")');
    // The hand-off must sit inside the `back() succeeded` branch — an unhandled back (empty
    // history) must fall through unconsumed so Roku's own default exits the app.
    const backBranch = sceneOutput.brs.slice(sceneOutput.brs.indexOf('if m.global.ft_router.callFunc("back") then'));
    expect(backBranch.indexOf('applyPendingFocus')).to.be.lessThan(backBranch.indexOf('return true'));
  });

  it('still emits onKeyEvent for a Scene root with zero on:key/focusable content of its own', () => {
    const files = [sceneFile('/app/MainScene.thr', 'MainScene', 'field enabled: boolean = false', '<Label id="a" text="{enabled}" />')];
    const result = compileApp(files);
    const sceneOutput = result.outputs.find((o) => o.componentName === 'MainScene')!;
    expect(sceneOutput.brs).to.include('function onKeyEvent');
  });

  it('does not emit onKeyEvent at all for a plain (non-Scene) component with no on:key/focusable content', () => {
    const files = [componentFile('/app/Widget.thr', 'Widget', 'field enabled: boolean = false')];
    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;
    expect(widgetOutput.brs).to.not.include('function onKeyEvent');
  });

  it('an explicit on:key[back] on <component> still wins — dispatched before the automatic fallthrough', () => {
    const source = [
      '<script>',
      'state count: integer = 0',
      'private function handleBack(key: string, press: boolean) {',
      '  if (press) {',
      '    state count = 1',
      '  }',
      '}',
      '</script>',
      '<component extends="Scene" on:key[back]="{handleBack()}">',
      '<Label id="a" />',
      '</component>',
    ].join('\n');

    const result = compileApp([{ path: '/app/MainScene.thr', componentName: 'MainScene', source }]);
    const sceneOutput = result.outputs.find((o) => o.componentName === 'MainScene')!;

    const backHandlerIndex = sceneOutput.brs.indexOf('private_handleBack(');
    const fallthroughIndex = sceneOutput.brs.indexOf('if key = "back" and press then');
    expect(backHandlerIndex).to.be.greaterThan(-1);
    expect(fallthroughIndex).to.be.greaterThan(-1);
    expect(backHandlerIndex).to.be.lessThan(fallthroughIndex);

    const bsResult = parseBrightScript(sceneOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
  });
});

describe('compileApp — default-focus="true" threads through to the generated register() call', () => {
  it('passes isDefault=true for the element declaring default-focus="true"', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        'field enabled: boolean = false',
        ['<Rectangle id="a" focusable="true" />', '<Rectangle id="b" focusable="true" default-focus="true" />'].join('\n'),
      ),
    ];
    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;

    expect(widgetOutput.brs).to.include('m.global.ft_focus.callFunc("register", m.a, m.top, false)');
    expect(widgetOutput.brs).to.include('m.global.ft_focus.callFunc("register", m.b, m.top, true)');
  });
});

describe('compileApp — default-focus="true" never leaks into generated XML or a runtime field assignment', () => {
  // Regression test for a real "Install Failure: Compilation Failed" hit sideloading to an actual
  // Roku device — default-focus is a pure compiler-internal marker with no corresponding native
  // SceneGraph field, so emitting it as a literal XML attribute (or a runtime m.x.default-focus =
  // ... assignment) fails real Roku compilation even though it parses fine with
  // kopytko-brightscript-parser and any XML well-formedness check. See findings/router.md.

  it('a top-level (statically-present) default-focus element never appears in the XML or as a field assignment', () => {
    const files = [componentFile('/app/Widget.thr', 'Widget', 'field enabled: boolean = false', '<Rectangle id="a" focusable="true" default-focus="true" />')];
    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;

    expect(widgetOutput.xml).to.not.include('default-focus');
    expect(widgetOutput.brs).to.not.include('default-focus');
    expect(widgetOutput.brs).to.include('m.global.ft_focus.callFunc("register", m.a, m.top, true)');

    const bsResult = parseBrightScript(widgetOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
    const xmlElement = parseSceneGraphXml(widgetOutput.xml);
    expect(xmlElement, 'XML failed to parse').to.not.be.undefined;
  });

  it('a default-focus element inside an {#if:destroy} block never gets a runtime field assignment for it', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        'state ready: boolean = false',
        '<Rectangle id="root">\n{#if:destroy ready}\n<Rectangle id="a" focusable="true" default-focus="true" />\n{/if}\n</Rectangle>',
      ),
    ];
    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;

    expect(widgetOutput.brs).to.not.include('default-focus');
    expect(widgetOutput.brs).to.include('m.global.ft_focus.callFunc("register", m.a, m.top, true)');

    const bsResult = parseBrightScript(widgetOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
  });

  it('a default-focus element inside an {#each} block never gets a runtime field assignment for it', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        'state items: object = invalid',
        '<Rectangle id="root">\n{#each items as item (item.id)}\n<Rectangle id="row" focusable="true" default-focus="true" />\n{/each}\n</Rectangle>',
      ),
    ];
    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;

    expect(widgetOutput.brs).to.not.include('default-focus');

    const bsResult = parseBrightScript(widgetOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
  });
});

describe('compileApp — a `: node` function return/param type compiles to `as object`, never `as node`', () => {
  // Regression test for a real "Install Failure: Compilation Failed" hit sideloading to an actual
  // Roku device — bisected all the way down from a much larger, seemingly unrelated symptom (the
  // router feature's own HomeScreen demo) to this: `function foo() as node` is not valid real
  // BrightScript (only `as object` is), even though it parses cleanly through
  // kopytko-brightscript-parser and no existing golden fixture happened to exercise a `: node`
  // function param/return type. `field`/`state`/`derived`'s own `node` type is unaffected — that's
  // a completely different context (an XML `<field type="node">` attribute). See
  // findings/router.md for the full trace.
  it('emits "as object" for a function with a : node return type, never "as node"', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        ['private function buildContent(): node {', '  return invalid', '}'].join('\n'),
      ),
    ];
    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;

    expect(widgetOutput.brs).to.include('function private_buildContent() as object');
    expect(widgetOutput.brs).to.not.include('as node');

    const bsResult = parseBrightScript(widgetOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
  });

  it('emits "as object" for a : node function parameter, never "as node"', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        ['private function describe(content: node): string {', '  return "x"', '}'].join('\n'),
      ),
    ];
    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;

    expect(widgetOutput.brs).to.include('content as object');
    expect(widgetOutput.brs).to.not.include('as node');

    const bsResult = parseBrightScript(widgetOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
  });

  it('still emits type="node" (unaffected) for an ordinary field declaration', () => {
    const files = [componentFile('/app/Widget.thr', 'Widget', 'field itemContent: node = invalid')];
    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;

    expect(widgetOutput.xml).to.include('<field id="itemContent" type="node"');
  });
});

describe('compileApp — theme cardinality and variant validation', () => {
  it('throws theme/multiple-templates when two <theme-template> files exist', () => {
    const files = [themeTemplateFile('/app/T1.thr', 'T1', 'fontSize: integer = 16'), themeTemplateFile('/app/T2.thr', 'T2', 'fontSize: integer = 16')];
    expect(() => compileApp(files))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'theme/multiple-templates' });
  });

  it('throws theme/duplicate-variant-name when two <theme name="..."> files share a name', () => {
    const files = [
      themeTemplateFile('/app/Theme.thr', 'Theme', 'fontSize: integer = 16'),
      themeVariantFile('/app/ThemeDarkA.thr', 'ThemeDarkA', 'dark', 'fontSize: integer = 20'),
      themeVariantFile('/app/ThemeDarkB.thr', 'ThemeDarkB', 'dark', 'fontSize: integer = 22'),
    ];
    expect(() => compileApp(files))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'theme/duplicate-variant-name' });
  });

  it('throws theme/variant-unknown-member (with file context) when a variant declares an undeclared member', () => {
    const files = [themeTemplateFile('/app/Theme.thr', 'Theme', 'fontSize: integer = 16'), themeVariantFile('/app/ThemeDark.thr', 'ThemeDark', 'dark', 'nope: integer = 1')];
    try {
      compileApp(files);
      expect.fail('expected compileApp to throw');
    } catch (err) {
      expect(err).to.be.instanceOf(CompileError);
      expect((err as CompileError).diagnostic.code).to.equal('theme/variant-unknown-member');
      expect((err as CompileError).diagnostic.message).to.include('/app/Theme.thr');
    }
  });

  it('compiles cleanly with a template and variants, and a component may read a nested theme leaf', () => {
    const files = [
      themeTemplateFile('/app/Theme.thr', 'Theme', 'colors: {\n  primary: string = "#fff"\n}'),
      themeVariantFile('/app/ThemeDark.thr', 'ThemeDark', 'dark', 'colors: {\n  primary: string = "#000"\n}'),
      componentFile('/app/Widget.thr', 'Widget', 'derived c: string = theme.colors.primary'),
    ];
    const result = compileApp(files);

    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;
    expect(result.themeOutput!.xml).to.include('<field id="colors" type="assocarray" />');
    expect(widgetOutput.brs).to.include('m.c = m?.global?.ft_theme?.colors?.primary');
  });

  it('a <theme name="..."> variant file contributes no output of its own, and the template contributes only themeOutput, never a regular outputs entry', () => {
    const files = [themeTemplateFile('/app/Theme.thr', 'Theme', 'fontSize: integer = 16'), themeVariantFile('/app/ThemeDark.thr', 'ThemeDark', 'dark', 'fontSize: integer = 20')];
    const result = compileApp(files);
    expect(result.outputs).to.deep.equal([]);
    expect(result.themeOutput!.xml).to.include(`<component name="${FLASH_THEATER_THEME_COMPONENT_NAME}" extends="Node">`);
  });

  it('the compiled theme is always named/found via FLASH_THEATER_THEME_COMPONENT_NAME, regardless of what the app author named or where they placed the <theme-template> file', () => {
    const files = [themeTemplateFile('/some/nested/dir/AppColors.thr', 'AppColors', 'fontSize: integer = 16')];
    const result = compileApp(files);
    expect(result.themeOutput!.xml).to.include(`<component name="${FLASH_THEATER_THEME_COMPONENT_NAME}" extends="Node">`);
    expect(result.themeOutput!.sourcePath).to.equal('/some/nested/dir/AppColors.thr');
    expect(result.globalsBrs).to.include(`CreateObject("roSGNode", "${FLASH_THEATER_THEME_COMPONENT_NAME}")`);
  });
});

describe('compileApp — a component may use both the store and theme, and everything parses as valid BrightScript/XML', () => {
  it('generates a fully working theme + component app, with the built-in store wired via usesStore', () => {
    const files = [
      themeTemplateFile('/app/Theme.thr', 'Theme', 'colors: {\n  primary: string = "#fff"\n}', ' default="dark"'),
      themeVariantFile('/app/ThemeDark.thr', 'ThemeDark', 'dark', 'colors: {\n  primary: string = "#000"\n}'),
      componentFile(
        '/app/Widget.thr',
        'Widget',
        ['watch count = store(count)', 'derived c: string = theme.colors.primary', 'derived n: integer = count * 2', 'public function bump() {', '  store(count) = count + 1', '}'].join('\n'),
      ),
    ];

    const result = compileApp(files);
    expect(result.outputs).to.have.lengthOf(1); // just Widget — theme is result.themeOutput, store isn't user-authored
    expect(result.usesStore).to.be.true;
    expect(result.themeOutput).to.not.be.null;

    const allCompiled = [...result.outputs, result.themeOutput!];
    for (const output of allCompiled) {
      const bsResult = parseBrightScript(output.brs);
      expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
      const xmlElement = parseSceneGraphXml(output.xml);
      expect(xmlElement, 'XML failed to parse').to.not.be.undefined;
    }

    expect(result.globalsBrs).to.include(`CreateObject("roSGNode", "${FLASH_THEATER_STORE_COMPONENT_NAME}")`);
    expect(result.globalsBrs).to.include(`CreateObject("roSGNode", "${FLASH_THEATER_THEME_COMPONENT_NAME}")`);
    const globalsResult = parseBrightScript(result.globalsBrs!);
    expect(globalsResult.diagnostics, JSON.stringify(globalsResult.diagnostics)).to.have.lengthOf(0);
  });
});

describe('compileApp — a component using router.navigate/back/params, generating valid BrightScript', () => {
  it('rewrites every router.* form correctly and produces zero-diagnostic .brs', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        [
          'derived day: string = router.params.day',
          'private function goToSchedule(key: string, press: boolean) {',
          '  if (press) {',
          '    router.navigate("/browse/schedule", {day: "Mon"})',
          '  }',
          '}',
          'private function goBack(key: string, press: boolean) {',
          '  if (press) {',
          '    router.back()',
          '  }',
          '}',
        ].join('\n'),
        '<Label id="a" text="{day}" />',
      ),
    ];

    const result = compileApp(files);
    expect(result.usesRouter).to.be.true;

    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;
    expect(widgetOutput.brs).to.include('m.day = m?.global?.ft_router?.activatedRoute?.params?.day');
    expect(widgetOutput.brs).to.include('m.global.ft_router.callFunc("navigate", {path: "/browse/schedule", params: {day: "Mon"}, skipInHistory: false})');
    expect(widgetOutput.brs).to.include('m.global.ft_router.callFunc("back")');

    const bsResult = parseBrightScript(widgetOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
    const xmlElement = parseSceneGraphXml(widgetOutput.xml);
    expect(xmlElement, 'XML failed to parse').to.not.be.undefined;

    expect(result.globalsBrs).to.include(`CreateObject("roSGNode", "${FLASH_THEATER_ROUTER_COMPONENT_NAME}")`);
    const globalsResult = parseBrightScript(result.globalsBrs!);
    expect(globalsResult.diagnostics, JSON.stringify(globalsResult.diagnostics)).to.have.lengthOf(0);
  });
});

describe('compileApp — a component using taskManager.run/cancel/setMaxConcurrent, generating valid BrightScript', () => {
  it('rewrites every taskManager.* form correctly and produces zero-diagnostic .brs', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        [
          'derived running: integer = taskManager.runningCount',
          'private function startWork(key: string, press: boolean) {',
          '  if (press) {',
          '    node = CreateObject("roSGNode", "MyTask")',
          '    id = taskManager.run(node)',
          '    urgentNode = CreateObject("roSGNode", "MyTask")',
          '    urgentId = taskManager.run(urgentNode, "high")',
          '    taskManager.cancel(id)',
          '    taskManager.setMaxConcurrent(10)',
          '  }',
          '}',
        ].join('\n'),
        '<Label id="a" text="{running}" />',
      ),
    ];

    const result = compileApp(files);
    expect(result.usesTaskManager).to.be.true;

    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;
    expect(widgetOutput.brs).to.include('m.running = m?.global?.ft_taskManager?.runningCount');
    // `run` itself is spelled `runTask` at the runtime `callFunc` layer — BrightScript's own `Run`
    // statement is a reserved word, so a function literally named `run` can't parse. The DSL-facing
    // spelling (`taskManager.run(...)`) is unaffected — see global-bindings.ts's
    // `TASK_MANAGER_RUNTIME_METHOD_NAMES`. Omitting the priority argument defaults to the literal
    // "normal".
    expect(widgetOutput.brs).to.include('m?.global?.ft_taskManager?.callFunc?("runTask", node, "normal")');
    expect(widgetOutput.brs).to.include('m?.global?.ft_taskManager?.callFunc?("runTask", urgentNode, "high")');
    expect(widgetOutput.brs).to.include('m.global.ft_taskManager.callFunc("cancel", id)');
    expect(widgetOutput.brs).to.include('m.global.ft_taskManager.callFunc("setMaxConcurrent", 10)');

    const bsResult = parseBrightScript(widgetOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
    const xmlElement = parseSceneGraphXml(widgetOutput.xml);
    expect(xmlElement, 'XML failed to parse').to.not.be.undefined;

    expect(result.globalsBrs).to.include(`CreateObject("roSGNode", "${FLASH_THEATER_TASK_MANAGER_COMPONENT_NAME}")`);
    const globalsResult = parseBrightScript(result.globalsBrs!);
    expect(globalsResult.diagnostics, JSON.stringify(globalsResult.diagnostics)).to.have.lengthOf(0);
  });
});

describe('compileApp — taskManager.setAlertThresholds/.alertLevel', () => {
  it('rewrites setAlertThresholds and a bare alertLevel read correctly', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        [
          'derived level: string = taskManager.alertLevel',
          'public function setup() {',
          '  taskManager.setAlertThresholds({warning: 20, critical: 40})',
          '}',
        ].join('\n'),
        '<Label id="a" text="{level}" />',
      ),
    ];

    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;
    expect(widgetOutput.brs).to.include('m.level = m?.global?.ft_taskManager?.alertLevel');
    expect(widgetOutput.brs).to.include('m.global.ft_taskManager.callFunc("setAlertThresholds", {warning: 20, critical: 40})');

    const bsResult = parseBrightScript(widgetOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
  });
});

describe('compileApp — taskManager.onAlertChanged(...)', () => {
  it('generates the init()-time array + ONE ObserveFieldScoped registration, a .Push() at the call site, and the trampoline sub, and produces zero-diagnostic .brs', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        [
          'private function onAlert(level: string) {',
          '  m.top.backgroundColor = level',
          '}',
          'public function setup() {',
          '  taskManager.onAlertChanged(onAlert)',
          '}',
        ].join('\n'),
      ),
    ];

    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;

    // init() sets up the array and registers the observer exactly once — never inside setup().
    const initBody = widgetOutput.brs.slice(widgetOutput.brs.indexOf('sub init()'), widgetOutput.brs.indexOf('end sub'));
    expect(initBody).to.include('m["$$ft_taskManagerAlertCallbacks"] = []');
    expect(initBody).to.include('m.global.ft_taskManager.ObserveFieldScoped("alertLevel", "on_taskManagerAlertChange")');

    // The call site resolves the bare function reference through the ordinary identifier-rewrite
    // path (private_ prefix, exactly like a called function would) and only ever pushes onto the array.
    expect(widgetOutput.brs).to.include('m["$$ft_taskManagerAlertCallbacks"].Push(private_onAlert)');
    // setup() itself contains no ObserveFieldScoped call — only the single Push().
    const setupBody = widgetOutput.brs.slice(widgetOutput.brs.indexOf('sub setup()'), widgetOutput.brs.indexOf('end sub', widgetOutput.brs.indexOf('sub setup()')));
    expect(setupBody).to.not.include('ObserveFieldScoped');

    // The trampoline sub itself, appended once for this component, iterating every stored callback.
    expect(widgetOutput.brs).to.include('sub on_taskManagerAlertChange(event as object)');
    expect(widgetOutput.brs).to.include('for each cb in m["$$ft_taskManagerAlertCallbacks"]');
    expect(widgetOutput.brs).to.include('cb(level)');

    const bsResult = parseBrightScript(widgetOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
  });

  it('supports MULTIPLE independent subscribers in the same component — each Push()es, only ONE ObserveFieldScoped registration exists', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        [
          'private function onAlertA(level: string) {}',
          'private function onAlertB(level: string) {}',
          'public function setup() {',
          '  taskManager.onAlertChanged(onAlertA)',
          '  taskManager.onAlertChanged(onAlertB)',
          '}',
        ].join('\n'),
      ),
    ];

    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;

    expect(widgetOutput.brs).to.include('m["$$ft_taskManagerAlertCallbacks"].Push(private_onAlertA)');
    expect(widgetOutput.brs).to.include('m["$$ft_taskManagerAlertCallbacks"].Push(private_onAlertB)');
    // Exactly one ObserveFieldScoped registration for alertLevel in the whole file (in init()), no
    // matter how many onAlertChanged(...) calls this component has — neither subscriber's callback
    // is ever silently dropped, and the trampoline never fires more than once per real change.
    const registrations = [...widgetOutput.brs.matchAll(/ObserveFieldScoped\("alertLevel"/g)];
    expect(registrations).to.have.lengthOf(1);

    const bsResult = parseBrightScript(widgetOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
  });

  it('does NOT emit the trampoline sub or the array/registration for a component that never calls onAlertChanged, even if it uses other taskManager.* actions', () => {
    const files = [componentFile('/app/Widget.thr', 'Widget', 'private function startWork(key: string, press: boolean) {\n  if (press) {\n    taskManager.setMaxConcurrent(5)\n  }\n}')];
    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;
    expect(widgetOutput.brs).to.not.include('on_taskManagerAlertChange');
    expect(widgetOutput.brs).to.not.include('ft_taskManagerAlertCallbacks');
  });

  it('now compiles cleanly when nested inside a larger statement-mode expression (e.g. an assignment RHS) — no longer restricted to its own line', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        ['private function onAlert(level: string) {}', 'private function setup2(key: string, press: boolean) {', '  if (press) {', '    x = taskManager.onAlertChanged(onAlert)', '  }', '}'].join(
          '\n',
        ),
      ),
    ];
    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;
    expect(widgetOutput.brs).to.include('x = m?["$$ft_taskManagerAlertCallbacks"]?.Push?(private_onAlert)');
    const bsResult = parseBrightScript(widgetOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
  });

  it('throws expression/task-manager-on-alert-changed-in-reactive-expression when used inside a derived expression', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        ['private function onAlert(level: string) {}', 'derived x: boolean = taskManager.onAlertChanged(onAlert)'].join('\n'),
        '<Label id="a" text="{x}" />',
      ),
    ];
    expect(() => compileApp(files))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/task-manager-on-alert-changed-in-reactive-expression' });
  });

  it('throws expression/task-manager-on-alert-changed-in-reactive-expression when used inside a dynamic template attribute', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        ['private function onAlert(level: string) {}', 'field enabled: boolean = false'].join('\n'),
        '<Label id="a" text="{taskManager.onAlertChanged(onAlert)}" />',
      ),
    ];
    expect(() => compileApp(files))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/task-manager-on-alert-changed-in-reactive-expression' });
  });

  it('accepts an inline anonymous function expression as the callback', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        ['public function setup() {', '  taskManager.onAlertChanged(function (level: string) {', '    m.top.backgroundColor = level', '  })', '}'].join('\n'),
      ),
    ];
    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;
    const bsResult = parseBrightScript(widgetOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
    expect(widgetOutput.brs).to.include('m.global.ft_taskManager.ObserveFieldScoped("alertLevel", "on_taskManagerAlertChange")');
  });
});

describe('compileApp — taskManager.onResult(task, onSuccess, [onError]) — promise-style consumption', () => {
  it('expands to a hoisted ft_task local + a callbacks-AA assignment + two ObserveFieldScoped registrations, colon-chained onto one statement, and produces zero-diagnostic .brs', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        [
          'private function loadIt(key: string, press: boolean) {',
          '  if (press) {',
          '    task = CreateObject("roSGNode", "GetSomething")',
          '    taskManager.run(task)',
          '    taskManager.onResult(task, onSuccess, onFailure)',
          '  }',
          '}',
          'private function onSuccess(result: dynamic) {',
          '  m.top.backgroundColor = "0x00FF00FF"',
          '}',
          'private function onFailure(error: dynamic) {',
          '  m.top.backgroundColor = "0xFF0000FF"',
          '}',
        ].join('\n'),
      ),
    ];

    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;

    expect(widgetOutput.brs).to.include(
      'ft_task = task : m["$$ft_taskManagerResultCallbacks"][ft_task?.id] = { onSuccess: private_onSuccess, onError: private_onFailure } : ft_task.ObserveFieldScoped("result", "on_taskManagerResult") : ft_task.ObserveFieldScoped("error", "on_taskManagerResultError")',
    );
    // The shared callbacks AA is initialized once, in init() — never re-created per call site.
    const initBody = widgetOutput.brs.slice(widgetOutput.brs.indexOf('sub init()'), widgetOutput.brs.indexOf('end sub'));
    expect(initBody).to.include('m["$$ft_taskManagerResultCallbacks"] = {}');
    // Both trampoline subs are emitted exactly once for the component, not per call site.
    expect(widgetOutput.brs.split('sub on_taskManagerResult(event as object)')).to.have.lengthOf(2);
    expect(widgetOutput.brs.split('sub on_taskManagerResultError(event as object)')).to.have.lengthOf(2);

    const bsResult = parseBrightScript(widgetOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
  });

  it('defaults onError to the literal invalid when the DSL call omits it (2-argument form)', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        ['private function loadIt(key: string, press: boolean) {', '  if (press) {', '    task = CreateObject("roSGNode", "GetSomething")', '    taskManager.run(task)', '    taskManager.onResult(task, onSuccess)', '  }', '}', 'private function onSuccess(result: dynamic) {}'].join(
          '\n',
        ),
      ),
    ];
    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;
    expect(widgetOutput.brs).to.include(
      'ft_task = task : m["$$ft_taskManagerResultCallbacks"][ft_task?.id] = { onSuccess: private_onSuccess, onError: invalid } : ft_task.ObserveFieldScoped("result", "on_taskManagerResult") : ft_task.ObserveFieldScoped("error", "on_taskManagerResultError")',
    );
  });

  it('throws expression/invalid-task-manager-on-result-arguments for 1 or 4+ arguments', () => {
    const tooFew = componentFile('/app/Widget.thr', 'Widget', 'private function f(key: string, press: boolean) {\n  if (press) {\n    taskManager.onResult("x")\n  }\n}');
    expect(() => compileApp([tooFew]))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/invalid-task-manager-on-result-arguments' });

    const tooMany = componentFile('/app/Widget.thr', 'Widget', 'private function f(key: string, press: boolean) {\n  if (press) {\n    taskManager.onResult("x", "y", "z", "w")\n  }\n}');
    expect(() => compileApp([tooMany]))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/invalid-task-manager-on-result-arguments' });
  });

  it('accepts an inline anonymous function expression as either callback', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        [
          'private function loadIt(key: string, press: boolean) {',
          '  if (press) {',
          '    task = CreateObject("roSGNode", "GetSomething")',
          '    taskManager.run(task)',
          '    taskManager.onResult(task, function (result: dynamic) {',
          '      m.top.backgroundColor = "0x00FF00FF"',
          '    })',
          '  }',
          '}',
        ].join('\n'),
      ),
    ];
    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;
    const bsResult = parseBrightScript(widgetOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
  });

  it('does NOT emit the callbacks AA or either trampoline for a component that never calls onResult, even if it uses other taskManager.* actions', () => {
    const files = [componentFile('/app/Widget.thr', 'Widget', 'private function startWork(key: string, press: boolean) {\n  if (press) {\n    taskManager.setMaxConcurrent(5)\n  }\n}')];
    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;
    expect(widgetOutput.brs).to.not.include('on_taskManagerResult');
    expect(widgetOutput.brs).to.not.include('ft_taskManagerResultCallbacks');
  });

  it('throws expression/task-manager-on-result-in-reactive-expression when used inside a derived expression', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        ['private function onSuccess(result: dynamic) {}', 'derived x: boolean = taskManager.onResult(CreateObject("roSGNode", "GetSomething"), onSuccess)'].join('\n'),
        '<Label id="a" text="{x}" />',
      ),
    ];
    expect(() => compileApp(files))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/task-manager-on-result-in-reactive-expression' });
  });
});

describe('compileApp — taskManager.onRequestSent(cb)/onResponseReceived(cb) — global HTTP request/response interceptors', () => {
  it('onRequestSent: generates the init()-time array + ONE ObserveFieldScoped registration on lastRequestSent, a .Push() at the call site, and the trampoline sub, and produces zero-diagnostic .brs', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        ['private function onSent(req: dynamic) {', '  m.top.backgroundColor = req.url', '}', 'public function setup() {', '  taskManager.onRequestSent(onSent)', '}'].join('\n'),
      ),
    ];

    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;

    const initBody = widgetOutput.brs.slice(widgetOutput.brs.indexOf('sub init()'), widgetOutput.brs.indexOf('end sub'));
    expect(initBody).to.include('m["$$ft_taskManagerRequestSentCallbacks"] = []');
    expect(initBody).to.include('m.global.ft_taskManager.ObserveFieldScoped("lastRequestSent", "on_taskManagerRequestSent")');

    expect(widgetOutput.brs).to.include('m["$$ft_taskManagerRequestSentCallbacks"].Push(private_onSent)');
    const setupBody = widgetOutput.brs.slice(widgetOutput.brs.indexOf('sub setup()'), widgetOutput.brs.indexOf('end sub', widgetOutput.brs.indexOf('sub setup()')));
    expect(setupBody).to.not.include('ObserveFieldScoped');

    expect(widgetOutput.brs).to.include('sub on_taskManagerRequestSent(event as object)');
    expect(widgetOutput.brs).to.include('for each cb in m["$$ft_taskManagerRequestSentCallbacks"]');
    expect(widgetOutput.brs).to.include('cb(request)');

    const bsResult = parseBrightScript(widgetOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
  });

  it('onResponseReceived: generates the init()-time array + ONE ObserveFieldScoped registration on lastResponseReceived, a .Push() at the call site, and the trampoline sub, and produces zero-diagnostic .brs', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        ['private function onReceived(response: dynamic) {', '  m.top.backgroundColor = response.httpStatusCode.ToStr()', '}', 'public function setup() {', '  taskManager.onResponseReceived(onReceived)', '}'].join(
          '\n',
        ),
      ),
    ];

    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;

    const initBody = widgetOutput.brs.slice(widgetOutput.brs.indexOf('sub init()'), widgetOutput.brs.indexOf('end sub'));
    expect(initBody).to.include('m["$$ft_taskManagerResponseReceivedCallbacks"] = []');
    expect(initBody).to.include('m.global.ft_taskManager.ObserveFieldScoped("lastResponseReceived", "on_taskManagerResponseReceived")');

    expect(widgetOutput.brs).to.include('m["$$ft_taskManagerResponseReceivedCallbacks"].Push(private_onReceived)');

    expect(widgetOutput.brs).to.include('sub on_taskManagerResponseReceived(event as object)');
    expect(widgetOutput.brs).to.include('for each cb in m["$$ft_taskManagerResponseReceivedCallbacks"]');
    expect(widgetOutput.brs).to.include('cb(response)');

    const bsResult = parseBrightScript(widgetOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
  });

  it('supports MULTIPLE independent subscribers to the SAME hook in one component — each Push()es, only ONE ObserveFieldScoped registration exists', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        [
          'private function onSentA(req: dynamic) {}',
          'private function onSentB(req: dynamic) {}',
          'public function setup() {',
          '  taskManager.onRequestSent(onSentA)',
          '  taskManager.onRequestSent(onSentB)',
          '}',
        ].join('\n'),
      ),
    ];

    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;

    expect(widgetOutput.brs).to.include('m["$$ft_taskManagerRequestSentCallbacks"].Push(private_onSentA)');
    expect(widgetOutput.brs).to.include('m["$$ft_taskManagerRequestSentCallbacks"].Push(private_onSentB)');
    // Exactly one ObserveFieldScoped registration for lastRequestSent in the whole file (in init()),
    // no matter how many onRequestSent(...) calls this component has — mirrors onAlertChanged's own
    // regression coverage for the exact bug findings/task-manager-request-interceptors.md documents it shipping with once
    // (a second registration silently double-firing the trampoline).
    const registrations = [...widgetOutput.brs.matchAll(/ObserveFieldScoped\("lastRequestSent"/g)];
    expect(registrations).to.have.lengthOf(1);

    const bsResult = parseBrightScript(widgetOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
  });

  it('does NOT emit either trampoline/array for a component that never calls onRequestSent/onResponseReceived, even if it uses other taskManager.* actions', () => {
    const files = [componentFile('/app/Widget.thr', 'Widget', 'private function startWork(key: string, press: boolean) {\n  if (press) {\n    taskManager.setMaxConcurrent(5)\n  }\n}')];
    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;
    expect(widgetOutput.brs).to.not.include('on_taskManagerRequestSent');
    expect(widgetOutput.brs).to.not.include('ft_taskManagerRequestSentCallbacks');
    expect(widgetOutput.brs).to.not.include('on_taskManagerResponseReceived');
    expect(widgetOutput.brs).to.not.include('ft_taskManagerResponseReceivedCallbacks');
  });

  it('throws expression/invalid-task-manager-on-request-sent-arguments / ...-on-response-received-arguments for 0 or 2+ arguments', () => {
    const tooFew = componentFile('/app/Widget.thr', 'Widget', 'private function f(key: string, press: boolean) {\n  if (press) {\n    taskManager.onRequestSent()\n  }\n}');
    expect(() => compileApp([tooFew]))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/invalid-task-manager-on-request-sent-arguments' });

    const tooMany = componentFile('/app/Widget.thr', 'Widget', 'private function f(key: string, press: boolean) {\n  if (press) {\n    taskManager.onResponseReceived("x", "y")\n  }\n}');
    expect(() => compileApp([tooMany]))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/invalid-task-manager-on-response-received-arguments' });
  });

  it('throws expression/task-manager-on-request-sent-in-reactive-expression when used inside a derived expression', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        ['private function onSent(req: dynamic) {}', 'derived x: boolean = taskManager.onRequestSent(onSent)'].join('\n'),
        '<Label id="a" text="{x}" />',
      ),
    ];
    expect(() => compileApp(files))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/task-manager-on-request-sent-in-reactive-expression' });
  });

  it('throws expression/task-manager-on-response-received-in-reactive-expression when used inside a dynamic template attribute', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        ['private function onReceived(response: dynamic) {}', 'field enabled: boolean = false'].join('\n'),
        '<Label id="a" text="{taskManager.onResponseReceived(onReceived)}" />',
      ),
    ];
    expect(() => compileApp(files))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'expression/task-manager-on-response-received-in-reactive-expression' });
  });

  it('accepts an inline anonymous function expression as the callback for either hook', () => {
    const files = [
      componentFile(
        '/app/Widget.thr',
        'Widget',
        [
          'public function setup() {',
          '  taskManager.onRequestSent(function (req: dynamic) {',
          '    m.top.backgroundColor = req.url',
          '  })',
          '  taskManager.onResponseReceived(function (response: dynamic) {',
          '    m.top.borderColor = response.httpStatusCode.ToStr()',
          '  })',
          '}',
        ].join('\n'),
      ),
    ];
    const result = compileApp(files);
    const widgetOutput = result.outputs.find((o) => o.componentName === 'Widget')!;
    const bsResult = parseBrightScript(widgetOutput.brs);
    expect(bsResult.diagnostics, JSON.stringify(bsResult.diagnostics)).to.have.lengthOf(0);
    expect(widgetOutput.brs).to.include('m.global.ft_taskManager.ObserveFieldScoped("lastRequestSent", "on_taskManagerRequestSent")');
    expect(widgetOutput.brs).to.include('m.global.ft_taskManager.ObserveFieldScoped("lastResponseReceived", "on_taskManagerResponseReceived")');
  });
});

describe('emitFlashTheaterGlobalsBrs', () => {
  it('emits only the fields that actually exist', () => {
    expect(emitFlashTheaterGlobalsBrs('Store', null)).to.include('store:').and.to.not.include('theme:');
    expect(emitFlashTheaterGlobalsBrs(null, 'Theme')).to.include('theme:').and.to.not.include('store:');
  });

  it('wires the real fixed FLASH_THEATER_STORE_COMPONENT_NAME when given, not an arbitrary app-chosen name', () => {
    const result = emitFlashTheaterGlobalsBrs(FLASH_THEATER_STORE_COMPONENT_NAME, null);
    expect(result).to.include(`CreateObject("roSGNode", "${FLASH_THEATER_STORE_COMPONENT_NAME}")`);
  });

  it('wires the real fixed FLASH_THEATER_FOCUS_MANAGER_COMPONENT_NAME when given as the third arg', () => {
    const result = emitFlashTheaterGlobalsBrs(null, null, FLASH_THEATER_FOCUS_MANAGER_COMPONENT_NAME);
    expect(result).to.include(`CreateObject("roSGNode", "${FLASH_THEATER_FOCUS_MANAGER_COMPONENT_NAME}")`);
    expect(result).to.include('focus:');
  });

  it('omits the focus field when the third arg is null (the default)', () => {
    expect(emitFlashTheaterGlobalsBrs('Store', null)).to.not.include('focus:');
  });

  it('wires the real fixed FLASH_THEATER_ROUTER_COMPONENT_NAME when given as the fourth arg', () => {
    const result = emitFlashTheaterGlobalsBrs(null, null, null, FLASH_THEATER_ROUTER_COMPONENT_NAME);
    expect(result).to.include(`CreateObject("roSGNode", "${FLASH_THEATER_ROUTER_COMPONENT_NAME}")`);
    expect(result).to.include('router:');
  });

  it('omits the router field when the fourth arg is null (the default)', () => {
    expect(emitFlashTheaterGlobalsBrs('Store', null)).to.not.include('router:');
  });

  it('produces valid BrightScript for both, one, or neither global', () => {
    for (const [store, theme] of [
      ['Store', 'Theme'],
      ['Store', null],
      [null, 'Theme'],
    ] as const) {
      const result = parseBrightScript(emitFlashTheaterGlobalsBrs(store, theme));
      expect(result.diagnostics, JSON.stringify(result.diagnostics)).to.have.lengthOf(0);
    }
  });
});

function classFile(path: string, source: string): AppFileInput {
  return { path, componentName: '', source, kind: 'flsh' };
}

describe('compileApp — .flsh class import resolution', () => {
  it('compiles a single non-extending class with no imports at all', () => {
    const files = [classFile('/app/components/Classes/Counter.flsh', ['class Counter {', '  private count: integer = 0', '}'].join('\n'))];
    const result = compileApp(files);
    expect(result.classOutputs).to.have.lengthOf(1);
    expect(result.classOutputs[0].className).to.equal('Counter');
    expect(result.classOutputs[0].brs).to.include('function Counter(');
  });

  it('wires a single imported class into the importing component\'s <script> tags, relative to the component\'s own directory', () => {
    const files = [
      classFile('/app/components/Classes/Counter.flsh', ['class Counter {', '  private count: integer = 0', '}'].join('\n')),
      componentFile('/app/components/Widget.thr', 'Widget', ['import Counter from "./Classes/Counter.flsh"', '', 'private function build() {', '  x = Counter()', '}'].join('\n')),
    ];
    const result = compileApp(files, '/app', '/app');
    expect(result.outputs[0].xml).to.include('<script type="text/brightscript" uri="pkg:/components/Classes/Counter.brs" />');
  });

  it('dedupes a diamond import graph — a component importing two classes that both import the same shared base only gets one <script> tag for it', () => {
    const files = [
      classFile('/app/components/Classes/Base.flsh', ['class Base {', '  private x: integer = 0', '}'].join('\n')),
      classFile(
        '/app/components/Classes/A.flsh',
        ['import Base from "./Base.flsh"', '', 'class A extends Base {', '  override constructor() {', '    super()', '  }', '}'].join('\n'),
      ),
      classFile(
        '/app/components/Classes/B.flsh',
        ['import Base from "./Base.flsh"', '', 'class B extends Base {', '  override constructor() {', '    super()', '  }', '}'].join('\n'),
      ),
      componentFile(
        '/app/components/Widget.thr',
        'Widget',
        ['import A from "./Classes/A.flsh"', 'import B from "./Classes/B.flsh"', '', 'private function build() {', '  x = A()', '  y = B()', '}'].join('\n'),
      ),
    ];
    const result = compileApp(files);
    const scriptTags = (result.outputs[0].xml.match(/<script[^>]*\/>/g) ?? []).filter((t) => t.includes('Classes'));
    expect(scriptTags).to.have.lengthOf(3); // A.brs, B.brs, Base.brs — Base only once despite being imported by both A and B
    expect(scriptTags.filter((t) => t.includes('Base.brs'))).to.have.lengthOf(1);
  });

  it('throws class/import-cycle for a cyclic import graph', () => {
    const files = [
      classFile('/app/components/Classes/A.flsh', ['import B from "./B.flsh"', '', 'class A {', '  public function useB(): integer {', '    return 1', '  }', '}'].join('\n')),
      classFile('/app/components/Classes/B.flsh', ['import A from "./A.flsh"', '', 'class B {', '  public function useA(): integer {', '    return 1', '  }', '}'].join('\n')),
    ];
    expect(() => compileApp(files))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'class/import-cycle' });
  });

  it('throws class/unresolved-base when extends names a class with no matching import statement', () => {
    const files = [classFile('/app/components/Classes/Child.flsh', ['class Child extends Ghost {', '  override constructor() {', '    super()', '  }', '}'].join('\n'))];
    expect(() => compileApp(files))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'class/unresolved-base' });
  });

  it('throws class/name-file-mismatch when the file base name does not match the declared class name', () => {
    const files = [classFile('/app/components/Classes/Counter.flsh', ['class NotCounter {', '  private x: integer = 0', '}'].join('\n'))];
    expect(() => compileApp(files))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'class/name-file-mismatch' });
  });

  it('throws import/file-not-found when the resolved path does not exist among discovered .flsh files', () => {
    const files = [componentFile('/app/components/Widget.thr', 'Widget', ['import Missing from "./Classes/Missing.flsh"', '', 'private function build() {', '  x = Missing()', '}'].join('\n'))];
    expect(() => compileApp(files))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'import/file-not-found' });
  });

  it('throws import/class-name-mismatch when the resolved file declares a different class name', () => {
    const files = [
      classFile('/app/components/Classes/Counter.flsh', ['class Counter {', '  private x: integer = 0', '}'].join('\n')),
      componentFile(
        '/app/components/Widget.thr',
        'Widget',
        ['import WrongName from "./Classes/Counter.flsh"', '', 'private function build() {', '  x = WrongName()', '}'].join('\n'),
      ),
    ];
    expect(() => compileApp(files))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'import/class-name-mismatch' });
  });

  it('produces valid, zero-diagnostic BrightScript end to end for an extends chain wired into a real component', () => {
    const files = [
      classFile(
        '/app/components/Classes/Counter.flsh',
        ['class Counter {', '  constructor(start: integer) {', '    private count: integer = start', '  }', '  public function get(): integer {', '    return m.count', '  }', '}'].join(
          '\n',
        ),
      ),
      classFile(
        '/app/components/Classes/LabeledCounter.flsh',
        [
          'import Counter from "./Counter.flsh"',
          '',
          'class LabeledCounter extends Counter {',
          '  override constructor(start: integer, label: string) {',
          '    super(start)',
          '    private label: string = label',
          '  }',
          '  public function describe(): string {',
          '    return m.label + str(m.get())',
          '  }',
          '}',
        ].join('\n'),
      ),
      componentFile(
        '/app/components/Widget.thr',
        'Widget',
        ['import LabeledCounter from "./Classes/LabeledCounter.flsh"', '', 'private function build() {', '  x = LabeledCounter(0, "hits")', '}'].join('\n'),
      ),
    ];
    const result = compileApp(files);

    expect(result.classOutputs).to.have.lengthOf(2);
    for (const c of result.classOutputs) {
      const parsed = parseBrightScript(c.brs);
      expect(parsed.diagnostics, `${c.className}: ${JSON.stringify(parsed.diagnostics)}`).to.have.lengthOf(0);
    }
    const brsResult = parseBrightScript(result.outputs[0].brs);
    expect(brsResult.diagnostics, JSON.stringify(brsResult.diagnostics)).to.have.lengthOf(0);
    const xmlElement = parseSceneGraphXml(result.outputs[0].xml);
    expect(xmlElement, 'XML failed to parse').to.not.be.undefined;
  });
});

describe('compileApp — derived type-check resolves a ClassName(...).method() call against the whole app\'s class shapes', () => {
  it('a derived expression calling an imported class\'s method, matching its declared return type, compiles clean', () => {
    const files = [
      classFile('/app/components/Classes/Formatter.flsh', ['class Formatter {', '  public function describe(): string {', '    return "ok"', '  }', '}'].join('\n')),
      componentFile(
        '/app/components/Widget.thr',
        'Widget',
        ['import Formatter from "./Classes/Formatter.flsh"', '', 'derived label: string = Formatter().describe()'].join('\n'),
      ),
    ];
    expect(() => compileApp(files)).to.not.throw();
  });

  it('a derived expression calling an imported class\'s method, DISAGREEING with its declared return type, throws derived/type-mismatch', () => {
    const files = [
      classFile('/app/components/Classes/Formatter.flsh', ['class Formatter {', '  public function describe(): integer {', '    return 1', '  }', '}'].join('\n')),
      componentFile(
        '/app/components/Widget.thr',
        'Widget',
        ['import Formatter from "./Classes/Formatter.flsh"', '', 'derived label: string = Formatter().describe()'].join('\n'),
      ),
    ];
    expect(() => compileApp(files)).to.throw(CompileError).with.property('diagnostic').that.deep.include({ code: 'derived/type-mismatch' });
  });

  it('two UNRELATED .flsh files declaring the same class name never get silently conflated — the collision is excluded from resolution, falling back to unknown (never a wrong-class false positive/negative)', () => {
    const files = [
      classFile('/app/components/FeatureA/Formatter.flsh', ['class Formatter {', '  public function describe(): string {', '    return "a"', '  }', '}'].join('\n')),
      classFile('/app/components/FeatureB/Formatter.flsh', ['class Formatter {', '  public function describe(): integer {', '    return 1', '  }', '}'].join('\n')),
      componentFile(
        '/app/components/Widget.thr',
        'Widget',
        ['import Formatter from "./FeatureA/Formatter.flsh"', '', 'derived label: string = Formatter().describe()'].join('\n'),
      ),
    ];
    // Without the collision-safety fix, this could resolve against EITHER Formatter's shape
    // (whichever happened to be inserted last while building the app-wide name-keyed map) — here
    // that would mean either passing correctly (FeatureA's own string-returning describe()) or
    // incorrectly throwing derived/type-mismatch (FeatureB's integer-returning describe()),
    // depending on unrelated app-wide class compile order. It must never throw either way: a name
    // collision falls back to `unknown` (unchecked), not an arbitrary pick.
    expect(() => compileApp(files)).to.not.throw();
  });
});

describe('compileApp — .flsh import resolution, app-root-relative form', () => {
  it('resolves an import with no ./ or ../ prefix against the supplied appRoot, not the importing file\'s own directory', () => {
    const files = [
      classFile('/app/components/Classes/Counter.flsh', ['class Counter {', '  private count: integer = 0', '}'].join('\n')),
      componentFile(
        '/app/components/Widget.thr',
        'Widget',
        ['import Counter from "components/Classes/Counter.flsh"', '', 'private function build() {', '  x = Counter()', '}'].join('\n'),
      ),
    ];
    const result = compileApp(files, '/app', '/app');
    expect(result.outputs[0].xml).to.include('<script type="text/brightscript" uri="pkg:/components/Classes/Counter.brs" />');
  });

  it('a class importing its own base the app-root-relative way still extends correctly', () => {
    const files = [
      classFile('/app/components/Classes/Base.flsh', ['class Base {', '  private x: integer = 0', '}'].join('\n')),
      classFile(
        '/app/components/Classes/Child.flsh',
        ['import Base from "components/Classes/Base.flsh"', '', 'class Child extends Base {', '  override constructor() {', '    super()', '  }', '}'].join('\n'),
      ),
    ];
    const result = compileApp(files, '/app', '/app');
    expect(result.classOutputs).to.have.lengthOf(2);
    expect(result.classOutputs.find((c) => c.className === 'Child')!.brs).to.include('prototype = Base()');
  });

  it('mixes relative and app-root-relative imports in the same file without conflict', () => {
    const files = [
      classFile('/app/components/Classes/Base.flsh', ['class Base {', '  private x: integer = 0', '}'].join('\n')),
      classFile('/app/components/Classes/Helper.flsh', ['class Helper {', '  private y: integer = 0', '}'].join('\n')),
      componentFile(
        '/app/components/Widget.thr',
        'Widget',
        [
          'import Base from "./Classes/Base.flsh"',
          'import Helper from "components/Classes/Helper.flsh"',
          '',
          'private function build() {',
          '  a = Base()',
          '  b = Helper()',
          '}',
        ].join('\n'),
      ),
    ];
    const result = compileApp(files, '/app', '/app');
    const scriptTags = (result.outputs[0].xml.match(/<script[^>]*\/>/g) ?? []).filter((t) => t.includes('Classes'));
    expect(scriptTags).to.have.lengthOf(2);
    expect(scriptTags.some((t) => t.includes('Base.brs'))).to.equal(true);
    expect(scriptTags.some((t) => t.includes('Helper.brs'))).to.equal(true);
  });

  it('throws import/file-not-found for an app-root-relative import that resolves to nothing, using the same diagnostic as the relative form', () => {
    const files = [
      componentFile('/app/components/Widget.thr', 'Widget', ['import Missing from "components/Classes/Missing.flsh"', '', 'private function build() {', '  x = Missing()', '}'].join('\n')),
    ];
    expect(() => compileApp(files, '/app', '/app'))
      .to.throw(CompileError)
      .with.property('diagnostic')
      .that.deep.include({ code: 'import/file-not-found' });
  });

  it('defaults srcRoot/outRoot to "." (cwd-relative) when omitted, so an existing caller that never uses app-root-relative imports is unaffected', () => {
    const files = [classFile('/app/components/Classes/Counter.flsh', ['class Counter {', '  private count: integer = 0', '}'].join('\n'))];
    const result = compileApp(files);
    expect(result.classOutputs).to.have.lengthOf(1);
  });
});

describe('compileApp — srcRoot and outRoot may differ (the src/out project-layout split)', () => {
  // A bare (non-./) .flsh import still resolves against srcRoot (files are keyed/discovered by
  // their real source location), but the <script uri="..."> written into the importing
  // component's XML must point at where the compiler will actually WRITE the compiled .brs — under
  // outRoot, mirrored at the same relative directory — not at the source location itself. See
  // app-compiler.ts's `ownBrsPath` in `compileFlshClasses` and its own doc comment.
  it('wires a bare-imported class\'s <script uri> relative to outRoot, mirroring the class\'s own srcRoot-relative directory, not srcRoot itself', () => {
    const files = [
      classFile('/project/src/components/Classes/Counter.flsh', ['class Counter {', '  private count: integer = 0', '}'].join('\n')),
      componentFile(
        '/project/src/components/Widget.thr',
        'Widget',
        ['import Counter from "components/Classes/Counter.flsh"', '', 'private function build() {', '  x = Counter()', '}'].join('\n'),
      ),
    ];
    const result = compileApp(files, '/project/src', '/project/out');
    expect(result.outputs[0].xml).to.include('<script type="text/brightscript" uri="pkg:/components/Classes/Counter.brs" />');
  });

  it('wires a ./-relative-imported class\'s <script uri> the same mirrored way', () => {
    const files = [
      classFile('/project/src/components/Classes/Counter.flsh', ['class Counter {', '  private count: integer = 0', '}'].join('\n')),
      componentFile(
        '/project/src/components/Widget.thr',
        'Widget',
        ['import Counter from "./Classes/Counter.flsh"', '', 'private function build() {', '  x = Counter()', '}'].join('\n'),
      ),
    ];
    const result = compileApp(files, '/project/src', '/project/out');
    expect(result.outputs[0].xml).to.include('<script type="text/brightscript" uri="pkg:/components/Classes/Counter.brs" />');
  });

  it('wires the SafeCompare helper <script uri> relative to outRoot when srcRoot and outRoot differ', () => {
    const files = [componentFile('/project/src/components/Widget.thr', 'Widget', 'field count: integer = 0\nderived isFive: boolean = count == 5')];
    const result = compileApp(files, '/project/src', '/project/out');
    expect(result.outputs[0].xml).to.include(`<script type="text/brightscript" uri="pkg:/components/FlashTheater/SafeCompare/${FLASH_THEATER_SAFE_COMPARE_FILE_BASE_NAME}.brs" />`);
  });
});
