import { downloadBytes } from './download';

export type Row = Record<string, string | number | boolean | null | undefined>;

export function toCsv(rows: Row[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // BOM so Excel opens UTF-8 (Arabic) correctly
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
}

/** multi-sheet Excel workbook (SheetJS, loaded on demand) */
export async function downloadXlsx(name: string, sheets: { name: string; rows: Row[]; title?: string }[]) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = s.title ? XLSX.utils.aoa_to_sheet([[s.title], []]) : XLSX.utils.aoa_to_sheet([]);
    XLSX.utils.sheet_add_json(ws, s.rows, { origin: s.title ? 'A3' : 'A1' });
    const cols = Object.keys(s.rows[0] ?? {});
    (ws as any)['!cols'] = cols.map((c) => ({ wch: Math.min(50, Math.max(c.length + 2, ...s.rows.slice(0, 200).map((r) => String(r[c] ?? '').length + 1))) }));
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  await downloadBytes(name, new Uint8Array(out), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}
