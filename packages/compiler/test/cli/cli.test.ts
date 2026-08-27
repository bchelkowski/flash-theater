import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { expect } from 'chai';
import { GENERATED_MARKER, runCli, withBrsMarker, withXmlMarker } from '../../src/cli.js';

const VALID_THR = [
  '<script>',
  'field enabled: boolean = false',
  '</script>',
  '',
  '<component>',
  '<Label id="a" text="{enabled}" />',
  '</component>',
  '',
].join('\n');

const INVALID_THR = ['<script>', 'bogus x = 0', '</script>', '', '<component>', '<Label id="a" />', '</component>', ''].join('\n');

/** Creates a fresh temp dir, `chdir`s into it (the CLI always operates on `process.cwd()` now — see cli.ts), and restores/cleans up afterward. */
function withProjectDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'flash-theater-cli-'));
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    fn(dir);
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function withSilencedConsole(fn: () => number): { exitCode: number; stderr: string[]; stdout: string[] } {
  const stderr: string[] = [];
  const stdout: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => stderr.push(args.join(' '));
  console.log = (...args: unknown[]) => stdout.push(args.join(' '));
  try {
    const exitCode = fn();
    return { exitCode, stderr, stdout };
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
}

describe('withXmlMarker / withBrsMarker', () => {
  it('inserts the marker as an XML comment right after the declaration line', () => {
    const xml = '<?xml version="1.0" encoding="utf-8" ?>\n<component name="Widget" extends="Group">\n</component>\n';
    const marked = withXmlMarker(xml, 'Widget');
    const lines = marked.split('\n');

    expect(lines[0]).to.equal('<?xml version="1.0" encoding="utf-8" ?>');
    expect(lines[1]).to.include(GENERATED_MARKER);
    expect(lines[1]).to.include('Widget.thr');
  });

  it('inserts the marker as the first line of a .brs file', () => {
    const brs = 'sub init()\nend sub\n';
    const marked = withBrsMarker(brs, 'Widget');
    const lines = marked.split('\n');

    expect(lines[0]).to.include(GENERATED_MARKER);
    expect(lines[0]).to.include('Widget.thr');
    expect(marked).to.include(brs);
  });
});

describe('runCli compile — basic src/ -> out/ compilation', () => {
  it('compiles a .thr file under src/components and writes marked .xml/.brs mirrored under out/components', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0);
      const xml = readFileSync(join(dir, 'out', 'components', 'Widget.xml'), 'utf8');
      const brs = readFileSync(join(dir, 'out', 'components', 'Widget.brs'), 'utf8');
      expect(xml).to.include(GENERATED_MARKER);
      expect(brs).to.include(GENERATED_MARKER);
    });
  });

  it('mirrors a nested src/components/Foo/Foo.thr into out/components/Foo/', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components', 'Foo'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Foo', 'Foo.thr'), VALID_THR.replace('Widget', 'Foo'));

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0);
      expect(existsSync(join(dir, 'out', 'components', 'Foo', 'Foo.xml'))).to.equal(true);
      expect(existsSync(join(dir, 'out', 'components', 'Foo', 'Foo.brs'))).to.equal(true);
    });
  });

  it('recompiles cleanly the second time (a clean rebuild, not incremental)', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);

      const first = withSilencedConsole(() => runCli(['compile']));
      const second = withSilencedConsole(() => runCli(['compile']));

      expect(first.exitCode).to.equal(0);
      expect(second.exitCode).to.equal(0);
    });
  });

  it('a clean rebuild removes a stale out/ file whose source .thr was since deleted', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);
      withSilencedConsole(() => runCli(['compile']));
      expect(existsSync(join(dir, 'out', 'components', 'Widget.xml'))).to.equal(true);

      rmSync(join(dir, 'src', 'components', 'Widget.thr'));
      writeFileSync(join(dir, 'src', 'components', 'Other.thr'), VALID_THR.replace('Widget', 'Other'));
      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0);
      expect(existsSync(join(dir, 'out', 'components', 'Widget.xml'))).to.equal(false);
      expect(existsSync(join(dir, 'out', 'components', 'Widget.brs'))).to.equal(false);
      expect(existsSync(join(dir, 'out', 'components', 'Other.xml'))).to.equal(true);
    });
  });

  it('with --check validates without writing any files, and out/ is never created', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);

      const { exitCode } = withSilencedConsole(() => runCli(['compile', '--check']));

      expect(exitCode).to.equal(0);
      expect(existsSync(join(dir, 'out'))).to.equal(false);
    });
  });

  it('reports a compile error with its diagnostic code and returns exit code 1', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Broken.thr'), INVALID_THR);

      const { exitCode, stderr } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(1);
      expect(stderr.join('\n')).to.include('dsl/unexpected-token');
    });
  });

  it('returns exit code 1 when src/ does not exist at all', () => {
    withProjectDir(() => {
      const { exitCode, stderr } = withSilencedConsole(() => runCli(['compile']));
      expect(exitCode).to.equal(1);
      expect(stderr.join('\n')).to.include('No such src directory');
    });
  });

  it('returns exit code 1 when src/ exists but is entirely empty', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src'));
      const { exitCode, stderr } = withSilencedConsole(() => runCli(['compile']));
      expect(exitCode).to.equal(1);
      expect(stderr.join('\n')).to.include('Nothing found');
    });
  });

  it('returns exit code 1 for an unknown command', () => {
    const { exitCode } = withSilencedConsole(() => runCli(['bogus']));
    expect(exitCode).to.equal(1);
  });
});

describe('runCli compile — pass-through copy of hand-written src/ files', () => {
  it('copies manifest and images/ verbatim into out/, unmarked', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      mkdirSync(join(dir, 'src', 'images'), { recursive: true });
      writeFileSync(join(dir, 'src', 'manifest'), 'title=Test\n');
      writeFileSync(join(dir, 'src', 'images', 'poster.png'), 'not-really-a-png');
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0);
      expect(readFileSync(join(dir, 'out', 'manifest'), 'utf8')).to.equal('title=Test\n');
      expect(readFileSync(join(dir, 'out', 'images', 'poster.png'), 'utf8')).to.equal('not-really-a-png');
    });
  });

  it('copies source/Main.brs verbatim into out/source/', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      mkdirSync(join(dir, 'src', 'source'), { recursive: true });
      writeFileSync(join(dir, 'src', 'source', 'Main.brs'), 'sub Main()\nend sub\n');
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0);
      expect(readFileSync(join(dir, 'out', 'source', 'Main.brs'), 'utf8')).to.equal('sub Main()\nend sub\n');
    });
  });

  it('copies a hand-written component with no .thr source (e.g. a hand-composed MainScene) through untouched, not compiled', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'MainScene.xml'), '<component name="MainScene" extends="Scene"></component>\n');
      writeFileSync(join(dir, 'src', 'components', 'MainScene.brs'), 'sub init()\nend sub\n');
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0);
      const xml = readFileSync(join(dir, 'out', 'components', 'MainScene.xml'), 'utf8');
      const brs = readFileSync(join(dir, 'out', 'components', 'MainScene.brs'), 'utf8');
      expect(xml).to.equal('<component name="MainScene" extends="Scene"></component>\n');
      expect(brs).to.equal('sub init()\nend sub\n');
      expect(xml).to.not.include(GENERATED_MARKER);
      expect(brs).to.not.include(GENERATED_MARKER);
    });
  });
});

describe('runCli compile — --src-dir / --out-dir overrides and flash-theater.config.json srcDir/outDir/exclude', () => {
  it('--src-dir and --out-dir override the src/out defaults', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'project', 'components'), { recursive: true });
      writeFileSync(join(dir, 'project', 'components', 'Widget.thr'), VALID_THR);

      const { exitCode } = withSilencedConsole(() => runCli(['compile', '--src-dir', join(dir, 'project'), '--out-dir', join(dir, 'generated')]));

      expect(exitCode).to.equal(0);
      expect(existsSync(join(dir, 'generated', 'components', 'Widget.xml'))).to.equal(true);
      expect(existsSync(join(dir, 'out'))).to.equal(false);
    });
  });

  it('flash-theater.config.json\'s srcDir/outDir are honored when no CLI override is given', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'project', 'components'), { recursive: true });
      writeFileSync(join(dir, 'project', 'components', 'Widget.thr'), VALID_THR);
      writeFileSync(join(dir, 'flash-theater.config.json'), JSON.stringify({ designResolution: 'hd', srcDir: 'project', outDir: 'generated' }));

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0);
      expect(existsSync(join(dir, 'generated', 'components', 'Widget.xml'))).to.equal(true);
    });
  });

  it('flash-theater.config.json\'s exclude patterns skip matching files/directories entirely', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components', 'Experimental'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);
      writeFileSync(join(dir, 'src', 'components', 'Experimental', 'Broken.thr'), INVALID_THR);
      writeFileSync(join(dir, 'flash-theater.config.json'), JSON.stringify({ designResolution: 'hd', exclude: ['components/Experimental/**'] }));

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0); // the excluded Broken.thr would fail to compile if it were ever discovered
      expect(existsSync(join(dir, 'out', 'components', 'Widget.xml'))).to.equal(true);
      expect(existsSync(join(dir, 'out', 'components', 'Experimental'))).to.equal(false);
    });
  });
});

describe('runCli compile — .flsh classes', () => {
  it('discovers a .flsh file under src/components and compiles it, writing only a .brs (no .xml), mirrored under out/', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components', 'Classes'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Classes', 'Counter.flsh'), ['class Counter {', '  private count: integer = 0', '}', ''].join('\n'));

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0);
      expect(existsSync(join(dir, 'out', 'components', 'Classes', 'Counter.xml'))).to.equal(false);
      const brs = readFileSync(join(dir, 'out', 'components', 'Classes', 'Counter.brs'), 'utf8');
      expect(brs).to.include(GENERATED_MARKER);
      expect(brs).to.include('function Counter(');
    });
  });

  it('wires a ./-relative-imported class into the importing component\'s XML, script uri mirrored under out/', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components', 'Classes'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Classes', 'Counter.flsh'), ['class Counter {', '  private count: integer = 0', '}', ''].join('\n'));
      writeFileSync(
        join(dir, 'src', 'components', 'Widget.thr'),
        ['<script>', 'import Counter from "./Classes/Counter.flsh"', '', 'private function build() {', '  x = Counter()', '}', '</script>', '', '<component>', '<Label id="a" />', '</component>', ''].join('\n'),
      );

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0);
      const xml = readFileSync(join(dir, 'out', 'components', 'Widget.xml'), 'utf8');
      expect(xml).to.include('uri="pkg:/components/Classes/Counter.brs"');
      expect(readFileSync(join(dir, 'out', 'components', 'Classes', 'Counter.brs'), 'utf8')).to.include(GENERATED_MARKER);
    });
  });

  it('wires an import with no ./ or ../ prefix against src/ (not the importing file\'s own directory)', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components', 'Classes'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Classes', 'Counter.flsh'), ['class Counter {', '  private count: integer = 0', '}', ''].join('\n'));
      writeFileSync(
        join(dir, 'src', 'components', 'Widget.thr'),
        ['<script>', 'import Counter from "components/Classes/Counter.flsh"', '', 'private function build() {', '  x = Counter()', '}', '</script>', '', '<component>', '<Label id="a" />', '</component>', ''].join('\n'),
      );

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0);
      const xml = readFileSync(join(dir, 'out', 'components', 'Widget.xml'), 'utf8');
      expect(xml).to.include('uri="pkg:/components/Classes/Counter.brs"');
    });
  });

  it('with --check validates .flsh classes too, without writing any files', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components', 'Classes'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Classes', 'Counter.flsh'), ['class Counter {', '  private count: integer = 0', '}', ''].join('\n'));

      const { exitCode, stdout } = withSilencedConsole(() => runCli(['compile', '--check']));

      expect(exitCode).to.equal(0);
      expect(stdout.some((l) => l.includes('Counter.flsh'))).to.equal(true);
      expect(existsSync(join(dir, 'out'))).to.equal(false);
    });
  });
});

describe('runCli compile — whole-app theme orchestration + built-in store wiring', () => {
  const WIDGET_USING_STORE_AND_THEME = [
    '<script>',
    'watch count = store(count)',
    'derived doubled: integer = count * 2',
    'derived size: integer = theme.fontSize',
    '</script>',
    '',
    '<component>',
    '<Label id="a" text="{doubled}" />',
    '</component>',
    '',
  ].join('\n');

  it('reports theme/multiple-templates and returns exit code 1 when two <theme-template> files exist', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      const themeThr = ['<theme-template>', 'fontSize: integer = 16', '</theme-template>'].join('\n');
      writeFileSync(join(dir, 'src', 'components', 'Theme1.thr'), themeThr);
      writeFileSync(join(dir, 'src', 'components', 'Theme2.thr'), themeThr);

      const { exitCode, stderr } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(1);
      expect(stderr.join('\n')).to.include('theme/multiple-templates');
    });
  });

  it('compiles a whole app with a theme and a component using both the store and theme, writing FlashTheaterTheme.xml/.brs (regardless of the source .thr filename), the copied runtime Store, and FlashTheaterGlobals.brs — all under out/', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      mkdirSync(join(dir, 'src', 'source'), { recursive: true });

      // Deliberately NOT named FlashTheaterTheme.thr — proves the compiled theme's name/location
      // don't depend on the source filename, since flash-parser finds it structurally by its
      // <theme-template> root tag, not by name.
      writeFileSync(join(dir, 'src', 'components', 'AppTheme.thr'), ['<theme-template>', 'fontSize: integer = 16', '</theme-template>'].join('\n'));
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), WIDGET_USING_STORE_AND_THEME);

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0);

      const themeXml = readFileSync(join(dir, 'out', 'components', 'FlashTheater', 'FlashTheaterTheme', 'FlashTheaterTheme.xml'), 'utf8');
      const themeBrs = readFileSync(join(dir, 'out', 'components', 'FlashTheater', 'FlashTheaterTheme', 'FlashTheaterTheme.brs'), 'utf8');
      const widgetBrs = readFileSync(join(dir, 'out', 'components', 'Widget.brs'), 'utf8');
      const globalsBrs = readFileSync(join(dir, 'out', 'source', 'FlashTheater', 'FlashTheaterGlobals.brs'), 'utf8');
      const storeXml = readFileSync(join(dir, 'out', 'components', 'FlashTheater', 'FlashTheaterStore', 'Store.xml'), 'utf8');
      const storeBrs = readFileSync(join(dir, 'out', 'components', 'FlashTheater', 'FlashTheaterStore', 'Store.brs'), 'utf8');

      expect(themeXml).to.include(GENERATED_MARKER).and.to.include('<field id="fontSize" type="assocarray" />');
      expect(themeXml).to.include('<component name="FlashTheaterTheme" extends="Node">');
      expect(themeXml).to.include('source: AppTheme.thr'); // marker still points at the real source file, even though the compiled name differs
      expect(themeBrs).to.include(GENERATED_MARKER);
      expect(widgetBrs).to.include('m.count = m.global.ft_store.count');
      expect(widgetBrs).to.include('m.doubled = m?.count * 2');
      expect(widgetBrs).to.include('m.size = m?.global?.ft_theme?.fontSize');
      expect(globalsBrs).to.include(GENERATED_MARKER);
      expect(globalsBrs).to.include('FlashTheaterSetupGlobals');
      expect(globalsBrs).to.include('CreateObject("roSGNode", "FlashTheaterStore")');
      expect(globalsBrs).to.include('CreateObject("roSGNode", "FlashTheaterTheme")');
      expect(storeXml).to.include(GENERATED_MARKER).and.to.include('<component name="FlashTheaterStore" extends="Node">');
      expect(storeBrs).to.include(GENERATED_MARKER).and.to.include('sub set(key as string, value as dynamic)');
    });
  });

  it('does not copy the runtime Store when no component uses it', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Theme.thr'), ['<theme-template>', 'fontSize: integer = 16', '</theme-template>'].join('\n'));

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0);
      expect(existsSync(join(dir, 'out', 'components', 'FlashTheater', 'FlashTheaterStore', 'Store.xml'))).to.equal(false);
    });
  });

  it('copies the runtime Stream helper (ft_createStream) into out/ when a component declares a stream', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      writeFileSync(
        join(dir, 'src', 'components', 'Widget.thr'),
        ['<script>', 'stream dataLoaded: string', '</script>', '<component>', '<Label id="a" />', '</component>'].join('\n'),
      );

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0);
      const streamBrs = readFileSync(join(dir, 'out', 'components', 'FlashTheater', 'Stream', 'FlashTheaterStream.brs'), 'utf8');
      expect(streamBrs).to.include(GENERATED_MARKER).and.to.include('function ft_createStream() as object');
      const widgetXml = readFileSync(join(dir, 'out', 'components', 'Widget.xml'), 'utf8');
      expect(widgetXml).to.include('uri="pkg:/components/FlashTheater/Stream/FlashTheaterStream.brs"');
    });
  });

  it('does not copy the runtime Stream helper when no component declares a stream', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0);
      expect(existsSync(join(dir, 'out', 'components', 'FlashTheater', 'Stream', 'FlashTheaterStream.brs'))).to.equal(false);
    });
  });

  it('copies the runtime FlashTheaterFocusManager and wires it into globalsBrs when a component has a focusable element', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      writeFileSync(
        join(dir, 'src', 'components', 'Widget.thr'),
        ['<script>', 'field enabled: boolean = false', '</script>', '<component>', '<Rectangle id="card" focusable="true" />', '</component>'].join('\n'),
      );

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0);
      const focusXml = readFileSync(join(dir, 'out', 'components', 'FlashTheater', 'FlashTheaterFocusManager', 'FlashTheaterFocusManager.xml'), 'utf8');
      const focusBrs = readFileSync(join(dir, 'out', 'components', 'FlashTheater', 'FlashTheaterFocusManager', 'FlashTheaterFocusManager.brs'), 'utf8');
      const globalsBrs = readFileSync(join(dir, 'out', 'source', 'FlashTheater', 'FlashTheaterGlobals.brs'), 'utf8');
      const widgetBrs = readFileSync(join(dir, 'out', 'components', 'Widget.brs'), 'utf8');

      expect(focusXml).to.include(GENERATED_MARKER).and.to.include('<component name="FlashTheaterFocusManager" extends="Node">');
      expect(focusBrs).to.include(GENERATED_MARKER).and.to.include('function navigate(key as string) as boolean');
      expect(globalsBrs).to.include('CreateObject("roSGNode", "FlashTheaterFocusManager")');
      expect(widgetBrs).to.include('m.global.ft_focus.callFunc("register", m.card, m.top, false)');
    });
  });

  it('does not copy the runtime FocusManager when no component has a focusable element', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0);
      expect(existsSync(join(dir, 'out', 'components', 'FlashTheater', 'FlashTheaterFocusManager', 'FlashTheaterFocusManager.xml'))).to.equal(false);
    });
  });

  it('copies both the runtime FlashTheaterRouter and FlashTheaterRouterOutlet, and wires the router into globalsBrs, when a component uses router.*', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      writeFileSync(
        join(dir, 'src', 'components', 'Widget.thr'),
        [
          '<script>',
          'private function goToBrowse(key: string, press: boolean) {',
          '  if (press) {',
          '    router.navigate("/browse")',
          '  }',
          '}',
          '</script>',
          '<component>',
          '<Label id="a" />',
          '</component>',
        ].join('\n'),
      );

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0);
      const routerXml = readFileSync(join(dir, 'out', 'components', 'FlashTheater', 'FlashTheaterRouter', 'FlashTheaterRouter.xml'), 'utf8');
      const routerBrs = readFileSync(join(dir, 'out', 'components', 'FlashTheater', 'FlashTheaterRouter', 'FlashTheaterRouter.brs'), 'utf8');
      const outletXml = readFileSync(join(dir, 'out', 'components', 'FlashTheater', 'FlashTheaterRouterOutlet', 'FlashTheaterRouterOutlet.xml'), 'utf8');
      const outletBrs = readFileSync(join(dir, 'out', 'components', 'FlashTheater', 'FlashTheaterRouterOutlet', 'FlashTheaterRouterOutlet.brs'), 'utf8');
      const globalsBrs = readFileSync(join(dir, 'out', 'source', 'FlashTheater', 'FlashTheaterGlobals.brs'), 'utf8');
      const widgetBrs = readFileSync(join(dir, 'out', 'components', 'Widget.brs'), 'utf8');

      expect(routerXml).to.include(GENERATED_MARKER).and.to.include('<component name="FlashTheaterRouter" extends="Node">');
      expect(routerBrs).to.include(GENERATED_MARKER).and.to.include('function back() as boolean');
      expect(outletXml).to.include(GENERATED_MARKER).and.to.include('<component name="FlashTheaterRouterOutlet" extends="Group">');
      expect(outletBrs).to.include(GENERATED_MARKER).and.to.include('function _findMatchingRoute(targetPath as string) as dynamic');
      expect(globalsBrs).to.include('CreateObject("roSGNode", "FlashTheaterRouter")');
      expect(globalsBrs).to.not.include('FlashTheaterRouterOutlet'); // never a global — an ordinary per-use component
      expect(widgetBrs).to.include('m.global.ft_router.callFunc("navigate", {path: "/browse", params: {}, skipInHistory: false})');
    });
  });

  it('does not copy the runtime Router/RouterOutlet when no component uses router.*', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0);
      expect(existsSync(join(dir, 'out', 'components', 'FlashTheater', 'FlashTheaterRouter', 'FlashTheaterRouter.xml'))).to.equal(false);
      expect(existsSync(join(dir, 'out', 'components', 'FlashTheater', 'FlashTheaterRouterOutlet', 'FlashTheaterRouterOutlet.xml'))).to.equal(false);
    });
  });

  it('defaults srcDir/outDir to src/out siblings of the current working directory when not given', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      mkdirSync(join(dir, 'src', 'source'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), WIDGET_USING_STORE_AND_THEME.replace('theme.fontSize', '1'));

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));
      expect(exitCode).to.equal(0);
      expect(readFileSync(join(dir, 'out', 'source', 'FlashTheater', 'FlashTheaterGlobals.brs'), 'utf8')).to.include('FlashTheaterSetupGlobals');
      expect(readFileSync(join(dir, 'out', 'components', 'FlashTheater', 'FlashTheaterStore', 'Store.xml'), 'utf8')).to.include('FlashTheaterStore');
    });
  });
});

/** Sets `FLASH_THEATER_ENV` for the duration of `fn`, restoring its prior value (usually undefined) afterward — mirrors `withProjectDir`'s own set-and-restore convention for `process.chdir`. */
function withEnvVar(value: string | undefined, fn: () => void): void {
  const original = process.env.FLASH_THEATER_ENV;
  try {
    if (value === undefined) delete process.env.FLASH_THEATER_ENV;
    else process.env.FLASH_THEATER_ENV = value;
    fn();
  } finally {
    if (original === undefined) delete process.env.FLASH_THEATER_ENV;
    else process.env.FLASH_THEATER_ENV = original;
  }
}

const WIDGET_USING_ENV = ['<script>', 'derived apiBaseUrlLabel: string = env.apiBaseUrl', '</script>', '', '<component>', '<Label id="a" text="{apiBaseUrlLabel}" />', '</component>', ''].join(
  '\n',
);

const SAMPLE_MANIFEST = ['title=Sample', 'major_version=1', 'minor_version=0', 'build_version=00001', ''].join('\n');

describe('runCli compile — --env / FLASH_THEATER_ENV', () => {
  it('a plain compile (no --env, no FLASH_THEATER_ENV) is unaffected by an environments/ directory merely existing', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      mkdirSync(join(dir, 'environments'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);
      writeFileSync(join(dir, 'environments', 'staging.config.json'), JSON.stringify({ variables: { unused: { value: 'x' } } }));

      const { exitCode } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(0);
      expect(existsSync(join(dir, 'out', 'components', 'Widget.xml'))).to.equal(true);
      expect(existsSync(join(dir, 'out-staging'))).to.equal(false);
    });
  });

  it('--env selects environments/<name>.config.json, compiling env.* reads and writing to out-<name>/', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      mkdirSync(join(dir, 'environments'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), WIDGET_USING_ENV);
      writeFileSync(join(dir, 'environments', 'staging.config.json'), JSON.stringify({ variables: { apiBaseUrl: { value: 'https://staging.example.com' } } }));

      const { exitCode } = withSilencedConsole(() => runCli(['compile', '--env', 'staging']));

      expect(exitCode).to.equal(0);
      expect(existsSync(join(dir, 'out'))).to.equal(false);
      const widgetBrs = readFileSync(join(dir, 'out-staging', 'components', 'Widget.brs'), 'utf8');
      expect(widgetBrs).to.include('m.apiBaseUrlLabel = m?.global?.ft_env?.apiBaseUrl');
      const globalsBrs = readFileSync(join(dir, 'out-staging', 'source', 'FlashTheater', 'FlashTheaterGlobals.brs'), 'utf8');
      expect(globalsBrs).to.include('ft_env: { "apiBaseUrl": "https://staging.example.com" }');
    });
  });

  it('FLASH_THEATER_ENV is honored as a fallback when --env is not passed', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      mkdirSync(join(dir, 'environments'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), WIDGET_USING_ENV);
      writeFileSync(join(dir, 'environments', 'staging.config.json'), JSON.stringify({ variables: { apiBaseUrl: { value: 'https://staging.example.com' } } }));

      withEnvVar('staging', () => {
        const { exitCode } = withSilencedConsole(() => runCli(['compile']));
        expect(exitCode).to.equal(0);
        expect(existsSync(join(dir, 'out-staging', 'components', 'Widget.brs'))).to.equal(true);
      });
    });
  });

  it('--env takes priority over FLASH_THEATER_ENV when both are given', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      mkdirSync(join(dir, 'environments'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);
      writeFileSync(join(dir, 'environments', 'staging.config.json'), '{}');

      withEnvVar('production', () => {
        const { exitCode, stderr } = withSilencedConsole(() => runCli(['compile', '--env', 'staging']));
        expect(exitCode).to.equal(0);
        expect(stderr).to.deep.equal([]);
        expect(existsSync(join(dir, 'out-staging'))).to.equal(true);
        expect(existsSync(join(dir, 'out-production'))).to.equal(false);
      });
    });
  });

  it('returns exit code 1 with environment-config/unknown-environment for a missing environment file', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);

      const { exitCode, stderr } = withSilencedConsole(() => runCli(['compile', '--env', 'doesnotexist']));

      expect(exitCode).to.equal(1);
      expect(stderr.join('\n')).to.include('No such environment');
    });
  });

  it("applies manifestOverrides to the active environment's out-<env>/manifest, leaving src/manifest itself untouched", () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      mkdirSync(join(dir, 'environments'), { recursive: true });
      writeFileSync(join(dir, 'src', 'manifest'), SAMPLE_MANIFEST);
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);
      writeFileSync(join(dir, 'environments', 'staging.config.json'), JSON.stringify({ manifestOverrides: { title: 'Staging Build' } }));

      const { exitCode } = withSilencedConsole(() => runCli(['compile', '--env', 'staging']));

      expect(exitCode).to.equal(0);
      expect(readFileSync(join(dir, 'src', 'manifest'), 'utf8')).to.equal(SAMPLE_MANIFEST); // source untouched
      const patched = readFileSync(join(dir, 'out-staging', 'manifest'), 'utf8');
      expect(patched).to.include('title=Staging Build');
      expect(patched).to.include('build_version=00001'); // every other key preserved
    });
  });

  it("throws expression/env-requires-active-environment when a component reads env.* with no --env/FLASH_THEATER_ENV active", () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), WIDGET_USING_ENV);

      const { exitCode, stderr } = withSilencedConsole(() => runCli(['compile']));

      expect(exitCode).to.equal(1);
      expect(stderr.join('\n')).to.include('expression/env-requires-active-environment');
    });
  });

  it('excludes a file by default, then include re-includes it only for the active environment', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'images', 'staging-only'), { recursive: true });
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      mkdirSync(join(dir, 'environments'), { recursive: true });
      writeFileSync(join(dir, 'src', 'images', 'staging-only', 'badge.png'), 'x');
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);
      writeFileSync(join(dir, 'flash-theater.config.json'), JSON.stringify({ designResolution: 'hd', exclude: ['images/staging-only/**'] }));
      writeFileSync(join(dir, 'environments', 'staging.config.json'), JSON.stringify({ include: ['images/staging-only/**'] }));

      const plain = withSilencedConsole(() => runCli(['compile']));
      expect(plain.exitCode).to.equal(0);
      expect(existsSync(join(dir, 'out', 'images', 'staging-only', 'badge.png'))).to.equal(false);

      const staged = withSilencedConsole(() => runCli(['compile', '--env', 'staging']));
      expect(staged.exitCode).to.equal(0);
      expect(existsSync(join(dir, 'out-staging', 'images', 'staging-only', 'badge.png'))).to.equal(true);
    });
  });

  it("a local override file (environments/<name>.local.config.json) wins over the committed environment config", () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      mkdirSync(join(dir, 'environments'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), WIDGET_USING_ENV);
      writeFileSync(join(dir, 'environments', 'staging.config.json'), JSON.stringify({ variables: { apiBaseUrl: { value: 'https://staging.example.com' } } }));
      writeFileSync(join(dir, 'environments', 'staging.local.config.json'), JSON.stringify({ variables: { apiBaseUrl: { value: 'http://localhost:3000' } } }));

      const { exitCode } = withSilencedConsole(() => runCli(['compile', '--env', 'staging']));

      expect(exitCode).to.equal(0);
      const globalsBrs = readFileSync(join(dir, 'out-staging', 'source', 'FlashTheater', 'FlashTheaterGlobals.brs'), 'utf8');
      expect(globalsBrs).to.include('"apiBaseUrl": "http://localhost:3000"');
      expect(globalsBrs).to.not.include('staging.example.com');
    });
  });

  it('a missing local override file is fine — falls back to the committed environment config alone', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      mkdirSync(join(dir, 'environments'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), WIDGET_USING_ENV);
      writeFileSync(join(dir, 'environments', 'staging.config.json'), JSON.stringify({ variables: { apiBaseUrl: { value: 'https://staging.example.com' } } }));

      const { exitCode } = withSilencedConsole(() => runCli(['compile', '--env', 'staging']));

      expect(exitCode).to.equal(0);
      const globalsBrs = readFileSync(join(dir, 'out-staging', 'source', 'FlashTheater', 'FlashTheaterGlobals.brs'), 'utf8');
      expect(globalsBrs).to.include('"apiBaseUrl": "https://staging.example.com"');
    });
  });
});

describe('runCli zip', () => {
  it('zips a freshly-compiled out/ into dist/<name>.zip, named from package.json\'s "name"', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-app' }));

      withSilencedConsole(() => runCli(['compile']));
      const { exitCode, stdout } = withSilencedConsole(() => runCli(['zip']));

      expect(exitCode).to.equal(0);
      const zipPath = join(dir, 'dist', 'my-app.zip');
      expect(existsSync(zipPath)).to.equal(true);
      expect(stdout.join('\n')).to.include(zipPath);

      const zip = new AdmZip(zipPath);
      expect(zip.getEntries().map((e) => e.entryName)).to.include('components/Widget.xml');
    });
  });

  it('returns exit code 1 with a helpful message when out/ does not exist yet', () => {
    withProjectDir((dir) => {
      const { exitCode, stderr } = withSilencedConsole(() => runCli(['zip']));
      expect(exitCode).to.equal(1);
      expect(stderr.join('\n')).to.include('No such output directory');
      expect(stderr.join('\n')).to.include('flash-theater compile');
      expect(existsSync(join(dir, 'dist'))).to.equal(false);
    });
  });

  it('--app-name overrides package.json\'s "name"', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-app' }));

      withSilencedConsole(() => runCli(['compile']));
      const { exitCode } = withSilencedConsole(() => runCli(['zip', '--app-name', 'renamed']));

      expect(exitCode).to.equal(0);
      expect(existsSync(join(dir, 'dist', 'renamed.zip'))).to.equal(true);
    });
  });

  it('--out-dir and flash-theater.config.json\'s outDir are honored, matching the same out dir compile wrote to', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'project', 'components'), { recursive: true });
      writeFileSync(join(dir, 'project', 'components', 'Widget.thr'), VALID_THR);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-app' }));

      withSilencedConsole(() => runCli(['compile', '--src-dir', join(dir, 'project'), '--out-dir', join(dir, 'generated')]));
      const { exitCode } = withSilencedConsole(() => runCli(['zip', '--out-dir', join(dir, 'generated')]));

      expect(exitCode).to.equal(0);
      expect(existsSync(join(dir, 'dist', 'my-app.zip'))).to.equal(true);
    });
  });

  it('--env zips out-<env>/ into an env-and-version-suffixed filename, reading the version from the compiled manifest', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      mkdirSync(join(dir, 'environments'), { recursive: true });
      writeFileSync(join(dir, 'src', 'manifest'), SAMPLE_MANIFEST);
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);
      writeFileSync(join(dir, 'environments', 'staging.config.json'), '{}');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-app' }));

      withSilencedConsole(() => runCli(['compile', '--env', 'staging']));
      const { exitCode } = withSilencedConsole(() => runCli(['zip', '--env', 'staging']));

      expect(exitCode).to.equal(0);
      expect(existsSync(join(dir, 'dist', 'my-app-staging-1.0.00001.zip'))).to.equal(true);
    });
  });

  it('zip --env does not require the environment config file to still exist, only that out-<env>/ was already produced', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      mkdirSync(join(dir, 'environments'), { recursive: true });
      writeFileSync(join(dir, 'src', 'manifest'), SAMPLE_MANIFEST);
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);
      writeFileSync(join(dir, 'environments', 'staging.config.json'), '{}');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-app' }));

      withSilencedConsole(() => runCli(['compile', '--env', 'staging']));
      rmSync(join(dir, 'environments', 'staging.config.json'));

      const { exitCode } = withSilencedConsole(() => runCli(['zip', '--env', 'staging']));

      expect(exitCode).to.equal(0);
      expect(existsSync(join(dir, 'dist', 'my-app-staging-1.0.00001.zip'))).to.equal(true);
    });
  });

  it('FLASH_THEATER_ENV is honored as a fallback when --env is not passed', () => {
    withProjectDir((dir) => {
      mkdirSync(join(dir, 'src', 'components'), { recursive: true });
      mkdirSync(join(dir, 'environments'), { recursive: true });
      writeFileSync(join(dir, 'src', 'manifest'), SAMPLE_MANIFEST);
      writeFileSync(join(dir, 'src', 'components', 'Widget.thr'), VALID_THR);
      writeFileSync(join(dir, 'environments', 'staging.config.json'), '{}');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-app' }));

      withEnvVar('staging', () => {
        withSilencedConsole(() => runCli(['compile']));
        const { exitCode } = withSilencedConsole(() => runCli(['zip']));
        expect(exitCode).to.equal(0);
        expect(existsSync(join(dir, 'dist', 'my-app-staging-1.0.00001.zip'))).to.equal(true);
      });
    });
  });
});
