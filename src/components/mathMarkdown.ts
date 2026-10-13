export function preprocessLatex(content: string): string {
  if (!content) return '';
  let processed = content;
  processed = processed.replace(/\\\[([\s\S]*?)\\\]/g, (_match, math) => `\n\n$$\n${math.trim()}\n$$\n\n`);
  processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, (_match, math) => ` $${math.trim()}$ `);
  processed = processed.replace(/\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/g, (_match, math) => `\n\n$$\n${math.trim()}\n$$\n\n`);
  processed = processed.replace(/\\begin\{align\*?\}([\s\S]*?)\\end\{align\*?\}/g, (_match, math) => `\n\n$$\\begin{aligned}\n${math.trim()}\n\\end{aligned}$$\n\n`);
  processed = processed.replace(/\\begin\{gather\*?\}([\s\S]*?)\\end\{gather\*?\}/g, (_match, math) => `\n\n$$\\begin{gathered}\n${math.trim()}\n\\end{gathered}$$\n\n`);
  processed = processed.replace(/^\\section\*?\{([^}]+)\}/gm, '# $1');
  processed = processed.replace(/^\\subsection\*?\{([^}]+)\}/gm, '## $1');
  processed = processed.replace(/^\\subsubsection\*?\{([^}]+)\}/gm, '### $1');
  processed = processed.replace(/\\textbf\{([^}]+)\}/g, '**$1**');
  processed = processed.replace(/\\textit\{([^}]+)\}/g, '*$1*');
  processed = processed.replace(/\\emph\{([^}]+)\}/g, '*$1*');
  return processed;
}
