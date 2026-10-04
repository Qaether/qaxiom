import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeMathjax from 'rehype-mathjax/svg';

export default function MathJaxMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeMathjax]}>
      {content}
    </ReactMarkdown>
  );
}
