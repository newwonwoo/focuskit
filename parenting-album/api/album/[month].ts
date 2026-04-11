import type { VercelRequest, VercelResponse } from '@vercel/node';

import {
  queryRawEntriesByMonth,
  queryWeeklySummariesByMonth,
  listCommentsForEntries,
  listActiveUsers,
} from '../../lib/notion.js';
import { renderGallery, renderErrorPage } from '../../lib/gallery.js';

/**
 * /api/album/2026-04  →  해당 월의 디지털 앨범 HTML 페이지.
 *
 * vercel.json의 rewrite로 /album/2026-04 경로에서도 호출되도록 맵핑돼 있다.
 *
 * 응답은 60초 캐싱(Vercel Edge)을 힌트로 준다.
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  try {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'method not allowed' });
      return;
    }

    const monthParam = req.query.month;
    const monthStr = Array.isArray(monthParam) ? monthParam[0] : monthParam;
    if (!monthStr) {
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderErrorPage('잘못된 URL', '월을 지정해주세요. 예: /album/2026-04'));
      return;
    }

    const match = /^(\d{4})-(\d{2})$/.exec(monthStr);
    if (!match) {
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderErrorPage('잘못된 날짜', `'${monthStr}'는 올바른 형식이 아닙니다. 예: 2026-04`));
      return;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12) {
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderErrorPage('잘못된 월', `'${monthStr}'는 올바른 월이 아닙니다.`));
      return;
    }

    // Notion에서 필요한 데이터 병렬 조회
    const [entriesSummarized, entriesPrinted, weeklySummaries, activeUsers] =
      await Promise.all([
        queryRawEntriesByMonth(year, month, 'Summarized'),
        queryRawEntriesByMonth(year, month, 'Printed'),
        queryWeeklySummariesByMonth(year, month),
        listActiveUsers(),
      ]);

    const entries = [...entriesSummarized, ...entriesPrinted].sort(
      (a, b) => a.date.getTime() - b.date.getTime(),
    );
    const commentsByEntry = await listCommentsForEntries(entries.map((e) => e.pageId));

    const html = renderGallery({
      year,
      month,
      entries,
      weeklySummaries,
      commentsByEntry,
      activeUsers,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // 60초 edge 캐시, stale-while-revalidate 10분
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
    res.status(200).send(html);
  } catch (err) {
    console.error('[album] render error', err);
    res.status(500).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(
      renderErrorPage(
        '잠시 오류가 났어요',
        '앨범을 불러오는 중 문제가 생겼어요. 잠시 후 다시 시도해주세요.',
      ),
    );
  }
}
