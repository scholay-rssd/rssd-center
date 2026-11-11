// Text helper of the work-centre view. This Center owns the view (see rssd/UI.md).
// The Center shows the Chinese source text; only {{placeholders}} are filled.
export function tr(source: string, vars?: Record<string, unknown>): string {
  return vars ? source.replace(/\{\{(\w+)\}\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : source;
}
