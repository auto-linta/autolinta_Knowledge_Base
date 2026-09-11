# 实现与验证记录

2026-09-11，本地开发与提交前验证完成；本记录不代表已部署。

## 已实现

- `KnowledgeBase.vue` 将确认后的文件、目录、标签和解析配置交给全局 Pinia 队列。应用内切页不销毁队列；同一页面连续选中的批次依次执行，每批最多 3 个并发上传。
- 浏览器每 2 MiB 分块计算 MD5，先拒绝批内相同内容，再按每组最多 200 个指纹进行知识库预检。全部检查成功才开始发送文件正文。
- 新增 `POST /api/v1/knowledge-bases/:id/knowledge/file/preflight`，复用文件上传的路由权限，服务层要求明确的 KB 写入授权，查询按有效租户和 KB 隔离。重复判断沿用正式上传的文件类型与非 failed 规则。
- 全局面板展示总数、检查进度、上传百分比、重复原因、失败原因和逐文档解析状态。上传 HTTP 成功不视作解析完成。
- 停止会终止派发、取消 HTTP 请求。已发出请求显示“结果待核实”，重试先预检。撤销只使用本批明确新建的文档 ID，分组提交删除并查询原始 ID 核实异步删除结果。
- 切换账号或空间停止并清除旧上下文的任务，禁止旧任务继续重试/撤销。活动队列包含离开页面提醒。
- 已有文件被拒绝重复时不再更新其创建时间。保留正式上传阶段的 409 校验。
- 中、英、日、韩、俄五种语言键一致；新增接口同步至 Markdown、Swagger JSON/YAML 和注册文档。

## 自动验证

前端以下 43 项测试全部通过：

```sh
cd frontend
npm exec -- tsx --test src/stores/knowledgeUploads.test.ts src/utils/knowledgeUploadQueue.test.ts src/utils/hashUploadFile.test.ts src/utils/knowledgeDeletion.test.ts src/views/knowledge/components/UploadConfirmDialog.test.ts src/i18n/localeKeyAudit.test.ts
npm run type-check
npm run build
```

覆盖 446 个文件完整执行、三并发上限、批内和服务端去重、同名不同内容、改名相同内容、无效预检结果、409、413、权限失效、连续网络故障、停止/重试、真实 Pinia 跨批次排队和空间切换、删除 ID 范围及异步删除验证。MD5 对照 Node crypto 校验空文件、中文内容和跨分块二进制文件。

后端以下包的相关用例分别通过：

```sh
go test ./internal/application/repository ./internal/application/service ./internal/handler ./internal/router ./docs -run 'Test(FindFileDuplicates|PreflightFileUploads|CreateKnowledgeFromFile|CheckKnowledgeExists|DocumentTagBodyRoute|KnowledgeBatchWriteRoutesDeclareIngestCapability|UploadPreflightContract)' -count=1
```

数据库测试使用 SQLite，覆盖其他租户、其他知识库、软删除、failed、pending、processing、completed、cancelled。权限测试覆盖有效写入授权、非所有者 Viewer 的实际路由拒绝、越界 KB API Key 和 retrieve-only API Key。

`openspec validate knowledge-upload-tasks --strict` 和 `git diff --check` 通过。前端构建仍提示已有大体积 chunk，未为本次上传任务做全站拆包。

## 浏览器验证

使用真实任务面板、队列和 MD5 实现，HTTP 边界替换为内存模拟；没有连接线上服务或调用模型。

- 446 条长路径任务可完整显示，面板滚动和收起可用。
- 停止后的数量为：已上传 5、拒绝重复 2、失败/待核实 4、已停止 435，合计 446。
- 已上传文档从解析等待更新为解析完成。
- 撤销确认只包含本批新建的 5 份文档；确认后显示已撤销 5，2 条重复记录保留。
- 浏览器未捕获组件运行错误。

## 部署与边界

- 需要前后端一起发布；新版前端遇到没有预检接口的旧后端会显示预检失败并停止，不能绕过检查直接上传。
- 本次没有新增数据库迁移。多实例同时上传同一个新文件时仍存在预检与写入之间的竞态；未新增跨实例原子唯一约束。
- 不将 PDF 正文持久化到浏览器；刷新、关闭页面不会自动续传。重新选择文件会先核实已上传部分。
- 请求被取消或响应丢失时，无法保证服务器未接收。撤销不会擅自删除这些状态不明请求所对应的文档。
- failed 文件沿用现有规则允许重新上传；已完成、处理中和其他非 failed 状态的相同文件会拒绝。
- 没有用本次本地验证解释线上历史“446 份只显示 7 份”的唯一根因，也没有进行线上上传、删除或付费模型测试。
