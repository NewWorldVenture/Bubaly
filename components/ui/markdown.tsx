'use client';

import { useMemo } from 'react';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code class="rounded bg-surface/80 px-1 py-0.5 text-xs font-mono">$1</code>');
}

function markdownToHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inList = false;
  let inOl = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^#{1,3}\s/.test(line)) {
      if (inList) { out.push('</ul>'); inList = false; }
      if (inOl) { out.push('</ol>'); inOl = false; }
      const level = line.match(/^(#+)/)![1].length;
      const text = escapeHtml(line.replace(/^#+\s*/, ''));
      const cls = level === 1 ? 'text-base font-bold mt-3 mb-1' : level === 2 ? 'text-sm font-bold mt-3 mb-1' : 'text-sm font-semibold mt-2 mb-0.5';
      out.push(`<p class="${cls}">${renderInline(text)}</p>`);
      continue;
    }

    const ulMatch = line.match(/^[\-\*]\s+(.*)/);
    if (ulMatch) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inList) { out.push('<ul class="list-disc pl-4 space-y-0.5">'); inList = true; }
      out.push(`<li>${renderInline(escapeHtml(ulMatch[1]))}</li>`);
      continue;
    }

    const olMatch = line.match(/^\d+\.\s+(.*)/);
    if (olMatch) {
      if (inList) { out.push('</ul>'); inList = false; }
      if (!inOl) { out.push('<ol class="list-decimal pl-4 space-y-0.5">'); inOl = true; }
      out.push(`<li>${renderInline(escapeHtml(olMatch[1]))}</li>`);
      continue;
    }

    if (inList) { out.push('</ul>'); inList = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }

    if (line.trim() === '') {
      out.push('<br/>');
    } else {
      out.push(`<p>${renderInline(escapeHtml(line))}</p>`);
    }
  }

  if (inList) out.push('</ul>');
  if (inOl) out.push('</ol>');
  return out.join('\n');
}

export function Markdown({ content }: { content: string }) {
  const html = useMemo(() => markdownToHtml(content), [content]);
  return (
    <div
      className="prose-sm space-y-1 [&_strong]:font-semibold [&_em]:italic [&_ul]:my-1 [&_ol]:my-1 [&_li]:text-sm [&_br]:h-1"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
