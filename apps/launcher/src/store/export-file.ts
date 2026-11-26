import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 导出文件落地目录：与 SQLite 数据库同目录下的 exports/ 子目录，
// 跟随 KUGOU_DB_PATH（Docker 下为 /app/data → /app/data/exports，落入持久化卷；
// 本地为 apps/launcher/data → apps/launcher/data/exports，与 db.ts 的 DEFAULT_DB 同级）。
const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.join(here, '..', 'data');
const DATA_DIR = process.env.KUGOU_DB_PATH ? path.dirname(process.env.KUGOU_DB_PATH) : DEFAULT_DATA_DIR;
const EXPORT_DIR = path.join(DATA_DIR, 'exports');

// token 只允许 UUID 的字符集，杜绝路径穿越
const TOKEN_RE = /^[a-zA-Z0-9-]+$/;

export function saveExportFile(content: string): string {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const token = crypto.randomUUID();
  fs.writeFileSync(path.join(EXPORT_DIR, `${token}.json`), content, 'utf8');
  return token;
}

export function readExportFile(token: string): string | null {
  if (!TOKEN_RE.test(token)) return null;
  const p = path.join(EXPORT_DIR, `${token}.json`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

/** 删除导出文件，返回是否命中（文件不存在即视为未命中）。 */
export function deleteExportFile(token: string): boolean {
  if (!token || !TOKEN_RE.test(token)) return false;
  const p = path.join(EXPORT_DIR, `${token}.json`);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}
