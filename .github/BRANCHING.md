# Branching Strategy

## 分支命名规范

| 类型 | 命名格式 | 说明 |
|------|----------|------|
| 主分支 | `main` | 始终可部署，对应最新稳定版本 |
| 功能分支 | `feature/<简述>` | 新功能开发，从 main 切出，合入后删除 |
| 热修复分支 | `hotfix/<简述>` | 紧急线上修复，从 main 切出，合入后删除 |
| 发布分支（可选） | `release/<version>` | 版本发布前的集成测试 |

## 工作流

1. 从 `main` 创建功能/修复分支：`git checkout -b feature/xxx main`
2. 提交时使用 Conventional Commits 格式：`feat(scope): description` / `fix(scope): description` / `refactor(scope): description`
3. 通过 PR 合并回 `main`，禁止直接 push 到 main
4. 版本标记使用语义化版本号（SemVer）：`v0.1.0`、`v0.1.1`

## 版本策略

- `v0.x.x`：早期迭代阶段，允许破坏性变更
- 每次正式 release 打 tag：`git tag v0.1.0 && git push origin v0.1.0`
