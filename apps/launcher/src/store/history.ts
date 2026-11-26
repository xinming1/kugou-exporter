import { db } from '../db';
import { deleteExportFile } from './export-file';

export interface HistoryRow {
  id: number;
  user_id: number;
  kugou_account_id: number | null;
  playlist_name: string;
  format: string;
  count: number;
  content: string;
  quality: string;
  token: string;
  created_at: number;
}

export function listHistory(userId: number): HistoryRow[] {
  return db.prepare('SELECT * FROM export_history WHERE user_id=? ORDER BY id DESC LIMIT 50').all(userId) as unknown as HistoryRow[];
}

export function addHistory(
  userId: number,
  kugouAccountId: number | null,
  playlistName: string,
  format: string,
  count: number,
  content: string,
  quality = '',
  token = ''
): void {
  db.prepare(
    'INSERT INTO export_history(user_id, kugou_account_id, playlist_name, format, count, content, quality, token, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(userId, kugouAccountId, playlistName, format, count, content, quality, token, Date.now());
}

/** 删除历史记录。返回是否命中（0 行即无权/不存在）。删除成功时同步清理对应导出文件，防止磁盘堆积。 */
export function deleteHistory(id: number, userId: number): boolean {
  const row = db.prepare('SELECT token FROM export_history WHERE id=? AND user_id=?').get(id, userId) as
    | { token: string }
    | undefined;
  if (!row) return false;
  db.prepare('DELETE FROM export_history WHERE id=? AND user_id=?').run(id, userId);
  if (row.token) deleteExportFile(row.token);
  return true;
}
