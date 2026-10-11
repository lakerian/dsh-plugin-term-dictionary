# 词条包（packs）

这个目录里放**可以分享出去的词条包**，以及由它们生成的 `index.json`。它是仓库内容，不是 npm 包内容（`package.json` 的 `files` 白名单里没有它，所以不会随插件发布出去）。

## 目录里现在有什么

| 文件 | 条数 | 用途 |
|---|---|---|
| `term-pack-包测试.json` | 20 | 最早的测试包 |
| `term-pack-test-distributed.json` | 12 | 分布式系统术语：导入、搜索、分类、批量选择 |
| `term-pack-test-network.json` | 8 | 网络术语：按分类导出后再导入 |
| `term-pack-test-revive.json` | 3 | **专测「导入我删除过的词条」**：先删掉「墓碑探针」，再导入这个包把它带回来 |
| `index.json` | — | 上面四个包的索引（由下面的脚本生成，不要手改） |

测试步骤、以及导入 / 撤回删除 / 源这三条路的期望结果，写在 [`../test-fixtures/README.md`](../test-fixtures/README.md)。

## 怎么发一个包

1. 打开插件的「词条包」页 →「生成文件」→ 下载 `term-pack-<id>.json`；
2. 把这个文件放进本目录（文件名随意，`backend.json` 这类就行）；
3. 在仓库根目录跑：

   ```powershell
   node tools/make-pack-index.mjs --base https://cdn.jsdelivr.net/gh/lakerian/dsh-plugin-term-dictionary@main/packs/
   ```

   它会**读每个包、算各自的 sha256、写 `index.json`**，并把可以粘进面板「源」输入框的地址打出来。

4. 提交这两个文件（包 + `index.json`），推送；
5. 在面板的「词条包」页把那个地址加进「源」，点「刷新」——你的包就出现在列表里了。

## 两条硬规则

- **`--base` 必须是 https**，而且不带账号密码。用的就是插件自己取回前的那条规则（`lib/core/pack.js` 的 `refuseUrl`），所以不可能生成一个"读者会拒绝"的索引。
- **`index.json` 里每个包的 `sha256` 覆盖的是文件本身的字节**。改了包文件就必须重新生成索引，否则读者会拿到 `checksum-mismatch`。

索引是**确定性**的（`updatedAt` 取的是目录里最新的那个包的生成时间，不是"什么时候跑的脚本"），所以可以当检查用：

```powershell
node tools/make-pack-index.mjs --base <同一个 base> --check
```

它**不写任何东西**，只在 `index.json` 与当前包不一致时以非零退出码失败——适合放进 CI，或者提交前跑一次。

## 为什么用 jsDelivr 而不是 raw.githubusercontent.com

`https://cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>` 是静态、可缓存、带 CDN 的地址，而且在国内网络下可用。`raw.githubusercontent.com` 在部分网络环境下（包括开发这台机器的代理）会因为 TLS 中间人而取不到——插件的取回走的是 `node:https`，它信任的是 Node 自带的根证书。

`@<ref>` 用 `@main` 会跟着分支走（改完立刻生效，但有缓存延迟），用 `@<tag>` 或 `@<commit>` 则是固定的——发布给别人用的源建议用 tag。
