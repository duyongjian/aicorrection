import { Box } from '@mui/material';
import katex from '../lib/katex/katex.mjs';
import '../lib/katex/katex.min.css';

/**
 * 把文本中的 LaTeX 公式渲染为可读公式：
 *  - 行内公式用 `$...$` 包裹，随文字流式显示；
 *  - 独立公式/多步推导用 `$$...$$` 独占一行居中显示。
 * 无 `$` 包裹的纯文本按原样展示（保留换行与空格）。
 * 模型若未使用 LaTeX（直接输出 unicode 数学符号），则降级为纯文本，不报错。
 */

type Token = { type: 'text' | 'inline' | 'block'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const dollar = input.indexOf('$', i);
    if (dollar === -1) {
      tokens.push({ type: 'text', value: input.slice(i) });
      break;
    }
    if (dollar > i) {
      tokens.push({ type: 'text', value: input.slice(i, dollar) });
    }
    // 块级 $$...$$
    if (input[dollar + 1] === '$') {
      const end = input.indexOf('$$', dollar + 2);
      if (end !== -1 && end > dollar + 2) {
        tokens.push({ type: 'block', value: input.slice(dollar + 2, end) });
        i = end + 2;
        continue;
      }
    }
    // 行内 $...$
    const end = input.indexOf('$', dollar + 1);
    if (end !== -1 && end > dollar + 1) {
      tokens.push({ type: 'inline', value: input.slice(dollar + 1, end) });
      i = end + 1;
      continue;
    }
    // 孤立的 $，当普通字符
    tokens.push({ type: 'text', value: '$' });
    i = dollar + 1;
  }
  return tokens;
}

function renderMath(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      errorColor: '#d32f2f',
    });
  } catch {
    return tex;
  }
}

export default function MathText({ text }: { text: string }) {
  if (!text) return null;
  const tokens = tokenize(text);
  return (
    <Box
      component="span"
      sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
    >
      {tokens.map((t, idx) => {
        if (t.type === 'text') {
          return <span key={idx}>{t.value}</span>;
        }
        if (t.type === 'inline') {
          return (
            <span
              key={idx}
              dangerouslySetInnerHTML={{ __html: renderMath(t.value, false) }}
            />
          );
        }
        // block
        return (
          <Box
            key={idx}
            sx={{ my: 0.5, textAlign: 'center', overflowX: 'auto' }}
            dangerouslySetInnerHTML={{ __html: renderMath(t.value, true) }}
          />
        );
      })}
    </Box>
  );
}
