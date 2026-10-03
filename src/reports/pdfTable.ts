import { jsPDF } from 'jspdf';
import type { Row } from './tables';

const ascii = (v: unknown) => String(v ?? '').replace(/[^\x20-\x7e°±]/g, '?');

/** Simple multi-section PDF report with paginated tables (Latin text). */
export function pdfReport(title: string, subtitle: string, sections: { title: string; rows: Row[]; columns?: string[] }[]): Uint8Array {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const m = 10;
  let y = m;
  const header = () => {
    doc.setFontSize(14); doc.setTextColor(10, 40, 80); doc.text(ascii(title), m, y + 5);
    doc.setFontSize(8); doc.setTextColor(90); doc.text(ascii(subtitle), m, y + 10);
    doc.text(`FiberLens · ${new Date().toLocaleString()}`, W - m, y + 10, { align: 'right' } as any);
    doc.setDrawColor(10, 40, 80); doc.line(m, y + 12, W - m, y + 12);
    y += 16;
  };
  const footer = () => { doc.setFontSize(7); doc.setTextColor(120); doc.text(`Page ${doc.getNumberOfPages()}`, W - m, H - 5, { align: 'right' } as any); };
  header();
  for (const s of sections) {
    if (y > H - 30) { footer(); doc.addPage(); y = m; header(); }
    doc.setFontSize(11); doc.setTextColor(0); doc.text(ascii(s.title), m, y + 4); y += 7;
    const cols = s.columns ?? [...new Set(s.rows.flatMap((r) => Object.keys(r)))];
    if (!s.rows.length) { doc.setFontSize(8); doc.text('(no data)', m, y + 3); y += 7; continue; }
    const widths = cols.map((c) => Math.min(60, Math.max(ascii(c).length, ...s.rows.slice(0, 100).map((r) => ascii(r[c]).length)) * 1.7 + 4));
    const scale = Math.min(1, (W - 2 * m) / widths.reduce((a, b) => a + b, 0));
    const ws = widths.map((w) => w * scale);
    const rowH = 5.2;
    const drawHead = () => {
      doc.setFillColor(225, 233, 245); doc.rect(m, y, W - 2 * m, rowH, 'F');
      doc.setFontSize(7.5); doc.setTextColor(10, 40, 80);
      let x = m; cols.forEach((c, i) => { doc.text(ascii(c).slice(0, Math.floor(ws[i] / 1.5)), x + 1, y + 3.6); x += ws[i]; });
      y += rowH;
    };
    drawHead();
    doc.setTextColor(0);
    s.rows.forEach((r, ri) => {
      if (y > H - 12) { footer(); doc.addPage(); y = m; header(); drawHead(); doc.setTextColor(0); }
      if (ri % 2) { doc.setFillColor(246, 248, 251); doc.rect(m, y, W - 2 * m, rowH, 'F'); }
      doc.setFontSize(7.2);
      let x = m; cols.forEach((c, i) => { doc.text(ascii(r[c]).slice(0, Math.floor(ws[i] / 1.45)), x + 1, y + 3.6); x += ws[i]; });
      y += rowH;
    });
    y += 6;
  }
  footer();
  return new Uint8Array(doc.output('arraybuffer'));
}
