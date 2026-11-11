# 教材 / 笔记 入库目录（管理后台知识库的来源）

本目录用于存放 **可合法录入** 的学科笔记，由 `npm run rag:ingest-textbook` 切成知识点写入本地 `qbank_items`，
经向量索引后，归因系统在遇到本地小模型知识盲区时可检索参考，避免臆造错因。

## ⚠️ 版权 / 数据主权硬约束（必读）

**只接受以下三类来源的笔记，严禁录入盗版 PDF、未授权扫描件、或任何非法复制的教材内容：**

| 来源 | `source` 写法 | `license` 写法 |
|---|---|---|
| 开发者本人整理的结构化学习笔记 | `developer-notes` | `developer-own` |
| 正版购买教材的**合法摘录**（须注明书名/页码） | `正版摘录《xxx》p.123` | `fair-use-excerpt` |
| 公开可引用的教学大纲 / 官方考纲 | `public-outline` | `public` |

- 所有内容**仅存于本机 SQLite，绝不外发**到任何第三方（含联网搜索默认关闭）。
- 录入即视为你已确认拥有该内容的合法使用授权。

## Markdown 格式

每个 `.md` 文件对应一个学科 / 章节，可选 frontmatter：

```
---
subject: english          # english|politics|computer|math|logic|other（缺省按文件名前缀推断）
source: developer-notes   # 来源说明（满足上表三类之一）
license: developer-own
---
# 文档标题
引言（可选，放在首个 ## 之前）

## 知识点标题（= 该条 knowledge_point）
讲解正文……可多段。

## 另一个知识点
……
```

- 每个 `## ` 小节切成**一条**知识点；
- 正文过长（>800 字）会按空行分段再切，保证单条可检索；
- `item_id` 由 `subject + 文档标题 + 小节标题 + 段序号` 归一化哈希派生 → **重复运行幂等覆盖**，不会重复堆积。

## 用法

```bash
npm run rag:ingest-textbook            # 读本目录，仅写入（embedding_status='pending'）
npm run rag:ingest-textbook -- --index # 入库后立刻建向量索引
npm run rag:ingest-textbook -- --dry-run # 只打印将导入多少条，不写库
```

入库后通过管理后台「重建索引」或 `npm run rag:index` 生成向量，RAG 才会命中。
