import { useMemo, useState } from 'react';
import { compileThrSource } from 'flash-theater-compiler/compile';
import { CompileError } from 'flash-theater-compiler/dsl-ast';

const DEFAULT_SOURCE = `<script>
field enabled: boolean = false
field label: string = "Off"

derived statusText: string = pickLabel(enabled, label)

private function pickLabel(isEnabled: boolean, text: string): string {
  if (isEnabled) {
    return "ON: " + text
  }
  return "OFF"
}
</script>

<component>
<Rectangle id="box" color="0x1A1A1AFF" width="200" height="60">
  <Label id="statusLabel" text="{statusText}" />
</Rectangle>
</component>
`;

type Tab = 'xml' | 'brs';

export default function ThrPlayground() {
  const [source, setSource] = useState(DEFAULT_SOURCE);
  const [tab, setTab] = useState<Tab>('xml');

  const result = useMemo(() => {
    try {
      return { ok: true as const, compiled: compileThrSource(source, 'PlaygroundWidget') };
    } catch (err) {
      if (err instanceof CompileError) {
        const loc = err.diagnostic.span ? ` (line ${err.diagnostic.span.line + 1})` : '';
        return { ok: false as const, message: `[${err.diagnostic.code}] ${err.diagnostic.message}${loc}` };
      }
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) };
    }
  }, [source]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div>
        <div className="flex items-center gap-2 px-4 py-2 bg-[#161b22] border border-b-0 border-[#1f2c42] rounded-t-lg">
          <span className="text-xs text-slate-400 font-mono">Widget.thr</span>
        </div>
        <textarea
          value={source}
          onChange={(e) => setSource(e.target.value)}
          spellCheck={false}
          className="w-full h-96 bg-[#0d1117] border border-[#1f2c42] rounded-b-lg p-4 text-sm font-mono text-slate-200 resize-none focus:outline-none focus:ring-1 focus:ring-amber-500/50"
        />
      </div>
      <div>
        <div className="flex items-center gap-1 px-2 py-1.5 bg-[#161b22] border border-b-0 border-[#1f2c42] rounded-t-lg">
          {(['xml', 'brs'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3 py-1 rounded-md text-xs font-mono transition-colors cursor-pointer ${
                tab === t ? 'bg-amber-600/20 text-amber-300' : 'text-slate-400 hover:text-white hover:bg-white/5'
              }`}
            >
              {t === 'xml' ? 'Widget.xml' : 'Widget.brs'}
            </button>
          ))}
          <span className="ml-auto mr-1 text-xs text-slate-600">compiled in your browser</span>
        </div>
        <pre className="w-full h-96 bg-[#0d1117] border border-[#1f2c42] rounded-b-lg p-4 text-sm font-mono overflow-auto m-0">
          {result.ok ? <code className="text-slate-200">{result.compiled[tab]}</code> : <code className="text-red-400">{result.message}</code>}
        </pre>
      </div>
    </div>
  );
}
