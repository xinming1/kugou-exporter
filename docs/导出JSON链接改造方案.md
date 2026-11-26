# 导出 JSON 直链改造方案

> 需求：XiaoMusic 等格式导出后，除了「复制原文 / 下载 txt」之外，额外提供一个可直接访问的 JSON 链接，链接前缀使用已设置的服务器地址拼接，用户无需复制原文，直接取链接即可。
>
> 说明：本方案**只做分析与设计，不改动任何代码**。确认方案后再行实现。

---

## 一、需求分析

### 1.1 现状问题

当前导出流程（`apps/launcher/src/routes/export.ts` + `apps/web/src/components/ExportDialog.vue`）：

1. 前端调用 `POST /export`，后端实时拉取酷狗歌单并生成字符串内容（`content`）。
2. 后端把 `content` 写入 `export_history` 表（`store/history.ts` → `addHistory`）。
3. 后端把 `content` 直接以 JSON 形式返回给前端：`res.json({ success, content, count, ... })`。
4. 前端拿到 `content` 后，显示在一个只读 `textarea` 里，提供两个按钮：
   - **复制**：`copyResult()` 把文本复制到剪贴板。
   - **下载文件**：`downloadResult()` 用 `Blob` + `<a download>` 触发浏览器下载 `.json` / `.txt`。

**核心痛点**：内容只在「浏览器内存」和「数据库历史」里，没有任何一个 URL 可以让播放器/其他设备直接 GET 到。用户在手机端小爱音箱 / xiaomusic 里导入时，只能手动复制整段 JSON，非常麻烦。

### 1.2 需求本质

希望导出后，后端把「某一次导出的 JSON 内容」落到一个**可公开 GET 访问的 URL**上，例如：

```
http://<服务器地址>/exports/<token>.json
```

用户拿到这个链接，直接填入播放器即可，无需复制原文。

---

## 二、现状代码梳理（改造涉及点）

| 文件 | 作用 | 与需求关系 |
| --- | --- | --- |
| `apps/launcher/src/routes/export.ts` | `POST /export` 生成内容并返回 | 需在返回体中**追加 `url` 字段** |
| `apps/launcher/src/store/history.ts` | 历史记录读写 | 可复用，但需确定「链接 vs 历史」关系 |
| `apps/launcher/src/db.ts` | SQLite 建表 | 需**新增导出内容表**（或复用 history） |
| `apps/launcher/src/routes/history.ts` | 历史列表/删除接口 | 若链接基于历史，删除需联动 |
| `apps/launcher/src/index.ts` | 路由装配 + 静态资源 | 需**新增导出路由的装配** |
| `apps/launcher/src/routes/config.ts` / `store/settings.ts` | 服务器地址（serverUrl）存取 | 已有 `serverUrl`，直接复用 |
| `apps/web/src/components/ExportDialog.vue` | 导出结果弹窗 UI | 需**新增「复制链接」交互** |
| `apps/web/src/api/index.ts` | 前端 API 封装 | 需**扩展 `exportApi.run` 返回类型** |
| `apps/launcher/src/middleware/session.ts` | `requireAuth` 鉴权 | 决定链接**是否需要登录**（关键设计点，见 4.2） |

### 2.1 服务器地址的取值链

```
设置页保存 → POST /config/save → setServerUrl(userId, url) → settings 表 server_url 列
导出时 → export.ts 里：serverUrl = req.body.serverUrl || settings.serverUrl || ''
```

> 关键点：导出请求本身已经带上了 `serverUrl`（前端 `confirmExport` 里会把 `form.serverUrl` 存到配置，导出时再传）。因此后端**无需再去拼 `127.0.0.1`**，直接复用这份地址即可。

---

## 三、改造方案（推荐实现）

### 3.1 总体思路

采用「**导出即落地 → 返回永久链接**」的模式：

1. 后端 `POST /export` 生成内容后，把内容**写成一个真实文件**（或存库并生成 token），得到唯一标识 `token`。
2. 新增一个**公开 GET 路由** `GET /exports/:token`（或带 `.json` 后缀），根据 token 读取内容并返回 `application/json`。
3. 返回体新增 `url` 字段，值为 `serverUrl + '/exports/' + token`。
4. 前端在导出结果区**新增「复制链接」按钮**（以及可选的可点击链接）。

### 3.2 后端改动

#### （1）新增导出内容存储

**方案 A（推荐）：落磁盘文件**

- 新增目录 `apps/launcher/data/exports/`（与 SQLite `data/` 同级，天然被 Docker `./data:/app/data` 持久化，见 `docker-compose.yml` 第 9 行）。
- token 用 `crypto.randomUUID()`（Node 内置，无需新依赖）或带时间戳的随机串。
- 文件名 `<token>.json`，内容即 `content`。

```ts
// store/export-file.ts（新文件）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = path.join(__dirname, '..', 'data', 'exports');

export function saveExportFile(content: string): string {
  fs.mkdirSync(DIR, { recursive: true });
  const token = crypto.randomUUID();
  fs.writeFileSync(path.join(DIR, `${token}.json`), content, 'utf8');
  return token;
}

export function readExportFile(token: string): string | null {
  // 防御路径穿越：token 只允许 [a-zA-Z0-9-]
  if (!/^[a-zA-Z0-9-]+$/.test(token)) return null;
  const p = path.join(DIR, `${token}.json`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}
```

**方案 B（备选）：复用 export_history 表**

- 复用 `export_history` 已有 `content` 列，token 直接用历史记录 `id`（或另加 `token` 列）。
- 优点：少一张表、少一份文件；删除历史时可同步失效链接。
- 缺点：历史表有 `LIMIT 50` 的列表语义，且 `content` 可能很大（几千首歌），长期堆在 SQLite 里。

> 推荐 **方案 A**：文件天然适合「大文本 + 直接 serve」场景，且与已有 `data/` 持久化机制完美契合，历史记录可继续保留（只存元数据或继续存内容，互不影响）。

#### （2）新增公开 GET 路由

在 `apps/launcher/src/routes/` 下新增 `export-file.ts`（或在 `export.ts` 里扩展）：

```ts
// routes/export-file.ts（新文件）
import type { Express } from 'express';
import { readExportFile } from '../store/export-file';

export function attachExportFileRoutes(app: Express): void {
  // 公开访问，不要求登录（播放器直接 GET）
  app.get('/exports/:token', (req, res) => {
    const token = String(req.params.token).replace(/\.json$/, '');
    const content = readExportFile(token);
    if (content == null) {
      res.status(404).json({ error: '导出文件不存在或已过期' });
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(content);
  });
}
```

> 说明：路由兼容 `/exports/<token>` 和 `/exports/<token>.json` 两种写法，方便直接当链接用。

#### （3）在 `index.ts` 装配新路由

```ts
import { attachExportFileRoutes } from './routes/export-file';
// ...
attachExportRoutes(app);
attachExportFileRoutes(app);   // 新增
```

> 注意顺序：放在 `kugoumusicapi.setupStatic` 之前装配自定义路由，避免被静态中间件拦截（若 `setupStatic` 对不存在的路径做 SPA fallback）。

#### （4）`export.ts` 生成链接并返回

在 `POST /export` 成功分支里，`addHistory(...)` 之后：

```ts
const token = saveExportFile(content);
const url = `${serverUrl.replace(/\/+$/, '')}/exports/${token}`;
// 历史记录里可选地也存下 url，方便「历史」页直接复用链接
res.json({ success: true, content, count, playlistName, format, url, token });
```

> `serverUrl` 在函数内已取得（第 61 行），直接用；若为空则回退到默认本机地址（与前端 `confirmExport` 的兜底逻辑保持一致）。

### 3.3 前端改动

#### （1）`api/index.ts` 扩展返回类型

```ts
export const exportApi = {
  run: (payload) =>
    request.post<{
      success: boolean; content: string; count: number;
      playlistName: string; url?: string; token?: string;
    }>('/export', payload).then((r) => r.data),
};
```

#### （2）`ExportDialog.vue` 结果区新增「复制链接」

- 新增响应式变量 `exportUrl = ref('')`，在 `handleExport` 成功后赋值 `exportUrl.value = res.url || ''`。
- 在 `result-actions` 里，`format !== 'csv'` 时追加两个按钮：
  - **复制链接**：`toClipboard(exportUrl.value)`。
  - 可选的 **打开链接**（`window.open`）或一个只读的链接输入框，方便手动拷贝。

```html
<el-button v-if="exportUrl" type="primary" :icon="Link" @click="copyUrl">
  复制链接
</el-button>
```

```ts
async function copyUrl() {
  await toClipboard(exportUrl.value);
  ElMessage.success('链接已复制');
}
```

- 结果文本区可保留（兼容喜欢看原文的用户），链接作为「更省事」的附加通道。

#### （3）可选：历史记录联动

- 若希望「历史」里也能直接拿链接（而非重新下载），可在 `export_history` 表新增 `url` 列（或导出文件 token），前端历史项加「复制链接」按钮。
- 此为非必需项，可放二期。

---

## 四、关键设计决策（需你确认）

### 4.1 链接是否需要登录鉴权？

- **公开（推荐）**：`GET /exports/:token` 不带 `requireAuth`。因为链接是给「小爱音箱 / xiaomusic / 其它设备」直接抓取的，这些设备无法登录你的后台。token 本身足够长且不可猜（UUID），天然具备一定安全边界。
- **鉴权**：若担心 token 泄露，可要求登录；但这会让「播放器直接取链接」的目标失效，与需求初衷矛盾。

> 建议：**公开 + UUID token**。若后续想增强，可给 token 加有效期（定时清理 `data/exports/` 里的过期文件）。

### 4.2 token 的过期与清理

- 方案 A 会持续在磁盘累积文件。建议（可二期）：
  - 增加定时任务（复用 `index.ts` 里已有的 `setInterval` 机制），清理超过 N 天（如 30 天）的导出文件。
  - 或在每次导出时顺带清理目录中最旧的文件。
- 一期可先不做清理，仅提示「链接长期有效，服务器需保持运行」。

### 4.3 serverUrl 为空的兜底

- 与现有前端逻辑一致：`serverUrl` 为空时，回退 `http://127.0.0.1:3000`。
- 但需注意：若用户在公网/Docker 环境，`127.0.0.1` 链接对外不可用。**链接的可用性取决于用户填写的 `serverUrl` 是否是从外部可达的地址**（内网 IP / 域名 / 公网 IP），这点与现有「代理链接」同理，README 已有说明。

### 4.4 与「代理链接」的区别

| | 导出 JSON 直链 | 歌单内歌曲的代理链接 |
| --- | --- | --- |
| 指向内容 | 整份歌单 JSON 文件 | 单首歌的音频地址 |
| 目的 | 导入播放器时免复制原文 | 播放时实时取流 |
| 是否需要服务器在线 | 是（文件在服务器上） | 是 |

两者**互补**：代理链接解决「歌曲直链过期」，本需求解决「歌单 JSON 导入不便」。

---

## 五、改动清单汇总

### 后端（apps/launcher）
1. **新增** `src/store/export-file.ts`：`saveExportFile` / `readExportFile`（含路径穿越防护）。
2. **新增** `src/routes/export-file.ts`：`GET /exports/:token` 公开路由。
3. **修改** `src/routes/export.ts`：生成 token + `url`，追加进返回体。
4. **修改** `src/index.ts`：装配 `attachExportFileRoutes`。
5. （可选）`src/store/history.ts` / `db.ts`：历史记录增加 `url` 字段。

### 前端（apps/web）
6. **修改** `src/api/index.ts`：`exportApi.run` 返回类型加 `url` / `token`。
7. **修改** `src/components/ExportDialog.vue`：结果区新增「复制链接」按钮（+ 可选展示链接）。

### 文档 / 其他
8. **更新** `README.md`：补充「导出直链」用法与说明。
9. （可选）新增定时清理导出文件的逻辑。

---

## 六、风险与注意事项

1. **公网可达性**：链接拼的是用户填的 `serverUrl`，若用户填了 `127.0.0.1`，公网/其它设备访问不了。需在 UI 或文档里提示「请填写从目标设备可达的地址」。
2. **磁盘占用**：导出文件落地磁盘，需考虑清理机制（见 4.2）。
3. **路径穿越**：token 必须严格校验白名单字符（UUID 已天然满足，但 `readExportFile` 仍要做正则兜底）。
4. **并发/重复导出**：每次导出生成新 token，旧文件仍在，链接互不影响（符合预期）。
5. **静态资源 fallback**：若 `setupStatic` 对未知路径做了 SPA 回退（返回 index.html），`/exports/*` 必须在其之前注册（本方案已按此排序）。

---

## 七、工作量评估

| 项 | 复杂度 | 预估 |
| --- | --- | --- |
| 后端落文件 + 公开路由 + 返回 url | 低 | 1 个文件新增 + 2 个文件小改 |
| 前端复制链接按钮 | 低 | 1 个文件小改 |
| 文档更新 | 低 | README 补充 |
| 可选：过期清理、历史联动 | 中 | 二期 |

整体改动集中在 **4~5 个文件**，属于小型功能，符合你「应该不复杂」的预期。
