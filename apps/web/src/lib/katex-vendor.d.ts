// 本地 vendored KaTeX ESM 构建的类型声明（未走 npm，避免 workspace 安装冲突）。
declare module '*/katex.mjs' {
  interface KatexOptions {
    displayMode?: boolean;
    throwOnError?: boolean;
    errorColor?: string;
    [key: string]: unknown;
  }
  const katex: {
    renderToString(tex: string, options?: KatexOptions): string;
  };
  export default katex;
}
