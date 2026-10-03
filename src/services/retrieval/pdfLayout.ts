import { splitReference } from './references';
import type { PdfPageText, PdfSourceInfo } from './pdfTypes';

// PDF.js text items are an extraction order, not a guarantee of visual reading order.
export function textFromPdfItems(items: { str?: string; hasEOL?: boolean }[]): string {
  let text = '';
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    text += item.str + (item.hasEOL ? '\n' : ' ');
  }
  return text.trim();
}

export function assemblePdfPages(pages: PdfPageText[]) {
  let text = '';
  const locations: PdfSourceInfo['pages'] = [];
  const spans = [];
  for (const page of pages) {
    if (page.number > 1) text += '\n\n';
    const startOffset = text.length;
    text += page.text;
    locations.push({ number: page.number, startOffset, endOffset: text.length, status: page.text.trim() ? 'text' : 'empty' });
    for (const span of splitReference(page.text)) {
      spans.push({ ...span, page: page.number, startOffset: startOffset + span.startOffset, endOffset: startOffset + span.endOffset });
    }
  }
  return { text, locations, spans };
}
