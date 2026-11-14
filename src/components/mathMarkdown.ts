function transformLatexOutsideCode(segment: string): string {
  let processed = segment;
  processed = processed.replace(/\\\[([\s\S]*?)\\\]/g, (_match, math) => `\n\n$$\n${math.trim()}\n$$\n\n`);
  processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, (_match, math) => `$${math.trim()}$`);
  processed = processed.replace(/\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/g, (_match, math) => `\n\n$$\n${math.trim()}\n$$\n\n`);
  processed = processed.replace(/\\begin\{align\*?\}([\s\S]*?)\\end\{align\*?\}/g, (_match, math) => `\n\n$$\\begin{aligned}\n${math.trim()}\n\\end{aligned}$$\n\n`);
  processed = processed.replace(/\\begin\{gather\*?\}([\s\S]*?)\\end\{gather\*?\}/g, (_match, math) => `\n\n$$\\begin{gathered}\n${math.trim()}\n\\end{gathered}$$\n\n`);
  processed = processed.replace(/^\\section\*?\{([^}]+)\}/gm, '# $1');
  processed = processed.replace(/^\\subsection\*?\{([^}]+)\}/gm, '## $1');
  processed = processed.replace(/^\\subsubsection\*?\{([^}]+)\}/gm, '### $1');
  processed = processed.replace(/\\textbf\{([^}]+)\}/g, '**$1**');
  processed = processed.replace(/\\textit\{([^}]+)\}/g, '*$1*');
  processed = processed.replace(/\\emph\{([^}]+)\}/g, '*$1*');
  // In GFM table rows, unescaped `|` inside inline math ($...$) breaks cell splitting.
  processed = processed.replace(/^(\s*\|.*\|)\s*$/gm, line =>
    line.replace(/\$([^$\n]+)\$/g, (_m, math: string) => `$${math.replace(/(?<!\\)\|/g, '\\vert ')}$`)
  );
  return processed;
}

export function preprocessLatex(content: string): string {
  if (!content) return '';
  // Preserve fenced code blocks and inline code spans untouched
  const parts = content.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return parts
    .map((part, idx) => (idx % 2 === 1 ? part : transformLatexOutsideCode(part)))
    .join('');
}
