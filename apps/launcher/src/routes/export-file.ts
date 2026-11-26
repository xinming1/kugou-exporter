import type { Express } from 'express';
import { readExportFile } from '../store/export-file';

export function attachExportFileRoutes(app: Express): void {
  // 公开访问：链接是给 XiaoMusic / 小爱音箱等外部播放器直接抓取的，不要求登录态。
  // token 为 UUID，足够长且不可猜，天然具备安全边界。
  // 兼容 /exports/<token> 与 /exports/<token>.json 两种写法。
  app.get('/exports/:token', (req, res) => {
    const token = String(req.params.token).replace(/\.json$/, '');
    const content = readExportFile(token);
    if (content == null) {
      res.status(404).json({ error: '导出文件不存在或已删除' });
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(content);
  });
}
