/** MTEXT formatting → plain lines (and simple style flags). */

export interface MTextParsed {
  lines: string[];
  bold: boolean;
  italic: boolean;
  font?: string;
  /** relative height override from \H…x; */
  heightFactor?: number;
}

export function parseMText(raw: string): MTextParsed {
  let bold = false, italic = false, font: string | undefined, heightFactor: number | undefined;
  let s = raw ?? '';
  // font switches \fArial|b1|i0|c0|p34;
  s = s.replace(/\\[fF]([^|;]*)((?:\|[^;]*)?);/g, (_m, name: string, flags: string) => {
    if (name) font = name;
    if (/\|b1/.test(flags)) bold = true;
    if (/\|i1/.test(flags)) italic = true;
    return '';
  });
  s = s.replace(/\\H([\d.]+)x;/g, (_m, f) => { heightFactor = parseFloat(f); return ''; });
  s = s.replace(/\\H[\d.]+;/g, '');
  // stacked fractions \S1/2; → 1/2
  s = s.replace(/\\S([^;]*);/g, (_m, t: string) => t.replace(/[#^]/g, '/'));
  // remove other formatting codes with arguments
  s = s.replace(/\\[ACQTWacqtw][^;]*;/g, '');
  s = s.replace(/\\p[^;]*;/g, '');
  // simple toggles
  s = s.replace(/\\[LlOoKk]/g, '');
  s = s.replace(/\\~/g, ' ');
  s = s.replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%%/g, '%');
  s = s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\[Pp]/g, '\n').replace(/\\N/g, '\n');
  s = s.replace(/\\\\/g, '\u0001').replace(/\\\{/g, '\u0002').replace(/\\\}/g, '\u0003');
  s = s.replace(/[{}]/g, '');
  s = s.replace(/\u0001/g, '\\').replace(/\u0002/g, '{').replace(/\u0003/g, '}');
  return { lines: s.split('\n'), bold, italic, font, heightFactor };
}

/** decode TEXT special codes */
export function decodeText(raw: string): string {
  return (raw ?? '')
    .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±')
    .replace(/%%[uUoO]/g, '').replace(/%%%/g, '%')
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

/** wrap plain lines to a width (approximate glyph width = 0.6·h) */
export function wrapLines(lines: string[], width: number, h: number, widthFactor = 1): string[] {
  if (!width || width <= 0) return lines;
  const charW = h * 0.6 * widthFactor;
  const maxChars = Math.max(1, Math.floor(width / charW));
  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= maxChars) { out.push(line); continue; }
    const words = line.split(' ');
    let cur = '';
    for (const w of words) {
      if ((cur + (cur ? ' ' : '') + w).length > maxChars && cur) { out.push(cur); cur = w; }
      else cur = cur ? cur + ' ' + w : w;
    }
    if (cur) out.push(cur);
  }
  return out;
}
